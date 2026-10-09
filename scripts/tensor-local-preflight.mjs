// Read-only remote snapshots; unsigned simulations only on a child-owned local validator.
// This is an availability probe, NOT a GoBuy purchase integration test.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, open, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const REMOTE = 'https://api.mainnet-beta.solana.com';
const LOCAL = 'http://127.0.0.1:18899';
const GOBUY = 'CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const programs = {
  tensor: 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp',
  metadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  authorizationRules: 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
};
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let result = '';
  while (n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}
function decode(text) {
  let n = 0n;
  for (const c of text) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) throw new Error('Invalid base58');
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const zeroes = text.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeroes), n ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const out = resolve(process.argv[2] ?? '.tmp-tensor-preflight');
const artifact = process.argv[3];
const snapshotOnly = process.argv.includes('--snapshot-only');
await mkdir(out, { recursive: true });
const report = {
  kind: 'availability-only', startedAt: new Date().toISOString(), remote: REMOTE,
  local: LOCAL, programs: [], integration: 'BLOCKED_NOT_EXECUTED',
  purchases: 0, signatures: [],
};
async function save(name, value) {
  await writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
}
async function rpc(url, method, params = []) {
  const allowed = url === REMOTE ? ['getAccountInfo']
    : url === LOCAL ? ['getHealth', 'getAccountInfo', 'getLatestBlockhash', 'simulateTransaction', 'getGenesisHash'] : [];
  if (!allowed.includes(method)) throw new Error(`RPC method or endpoint forbidden: ${method}`);
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
let validator;
let log;
try {
  for (const [name, address] of Object.entries(programs)) {
    const entry = { name, address };
    report.programs.push(entry);
    try {
      const account = await rpc(REMOTE, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
      await save(`${name}-program.json`, account);
      if (!account.value?.executable) throw new Error('Expected executable program');
      if (account.value.owner === 'BPFLoader2111111111111111111111111111111111') {
        const elf = Buffer.from(account.value.data[0], 'base64');
        if (!elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new Error('Not ELF bytecode');
        Object.assign(entry, { status: 'SNAPSHOTTED', loader: account.value.owner,
          slot: account.context.slot, sha256: hash(elf), bytes: elf.length });
        await writeFile(join(out, `${name}.so`), elf);
        continue;
      }
      if (account.value.owner !== LOADER) throw new Error('Unsupported program loader');
      const pointer = Buffer.from(account.value.data[0], 'base64');
      if (pointer.length !== 36 || pointer.readUInt32LE(0) !== 2) throw new Error('Invalid Program account');
      entry.programData = encode(pointer.subarray(4));
      const data = await rpc(REMOTE, 'getAccountInfo', [entry.programData, {
        encoding: 'base64', commitment: 'finalized', minContextSlot: account.context.slot,
      }]);
      if (!data.value || data.value.owner !== LOADER) throw new Error('Missing ProgramData');
      const bytes = Buffer.from(data.value.data[0], 'base64');
      if (bytes.readUInt32LE(0) !== 3 || bytes.length < 49) throw new Error('Invalid ProgramData');
      const elf = bytes.subarray(45);
      if (!elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new Error('Not ELF bytecode');
      Object.assign(entry, { status: 'SNAPSHOTTED', slot: data.context.slot,
        deploymentSlot: bytes.readBigUInt64LE(4).toString(), sha256: hash(elf), bytes: elf.length });
      await writeFile(join(out, `${name}.so`), elf);
      // Verify the pointer has not changed while acquiring this program's data.
      const recheck = await rpc(REMOTE, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized', minContextSlot: data.context.slot }]);
      if (recheck.value?.data[0] !== account.value.data[0]) throw new Error('Program pointer changed during snapshot');
    } catch (error) { entry.status = 'BLOCKED'; entry.error = error.message; }
    await save('report.json', report);
  }
  if (report.programs.some(p => p.status !== 'SNAPSHOTTED')) throw new Error('One or more real program snapshots unavailable');
  if (snapshotOnly) {
    report.availability = 'REMOTE_BINARIES_ONLY';
  } else {
    if (!artifact) throw new Error('Pass the successful CI gobuy_na.so as the second argument');
    const binary = await readFile(artifact);
    if (!binary.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || !binary.includes(decode(GOBUY))) throw new Error('GoBuy ELF/program identity check failed');
    report.gobuy = { programId: GOBUY, sha256: hash(binary), bytes: binary.length };
    const version = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8' });
    if (version.error || version.status !== 0) throw new Error('solana-test-validator unavailable; use Linux workflow');
    report.validatorVersion = version.stdout.trim();
    // Never connect to a pre-existing validator, even at the fixed loopback endpoint.
    let occupied = false;
    try { await fetch(LOCAL, { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
    if (occupied) throw new Error('Local RPC port already occupied');
    const ledger = await mkdtemp(join(tmpdir(), 'gobuy-tensor-'));
    const payerBytes = randomBytes(32); // public address only; no signing key exists or is read.
    const payer = encode(payerBytes);
    const args = ['--ledger', ledger, '--bind-address', '127.0.0.1', '--rpc-port', '18899',
      '--faucet-port', '18901', '--gossip-port', '18898', '--dynamic-port-range', '19000-19020',
      '--mint', payer, '--bpf-program', GOBUY, resolve(artifact)];
    for (const [name, address] of Object.entries(programs)) args.push('--bpf-program', address, join(out, `${name}.so`));
    log = await open(join(out, 'validator.log'), 'w');
    validator = spawn('solana-test-validator', args, { stdio: ['ignore', log.fd, log.fd] });
    let launchError;
    validator.on('error', error => { launchError = error; });
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (launchError || validator.exitCode !== null) throw launchError ?? new Error('Validator exited during startup');
      try { healthy = await rpc(LOCAL, 'getHealth') === 'ok'; } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new Error('Local validator startup timeout');
    report.genesisHash = await rpc(LOCAL, 'getGenesisHash');
    for (const address of [GOBUY, ...Object.values(programs)]) {
      const loaded = await rpc(LOCAL, 'getAccountInfo', [address, { encoding: 'base64' }]);
      if (!loaded.value?.executable) throw new Error(`Program not executable locally: ${address}`);
      await save(`local-${address}.json`, loaded);
    }
    const blockhash = (await rpc(LOCAL, 'getLatestBlockhash')).value.blockhash;
    const data = Buffer.alloc(18);
    Buffer.from('447f2b08d41ff972', 'hex').copy(data);
    data.writeBigUInt64LE(1n, 8);
    // Legacy message: payer + Tensor, one BuyLegacy instruction with NO accounts.
    // Expected Anchor account-validation failure establishes dispatch only, never a purchase.
    const transaction = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from([1, 0, 1, 2]),
      payerBytes, decode(programs.tensor), decode(blockhash), Buffer.from([1, 1, 0, data.length]), data]);
    const simulation = await rpc(LOCAL, 'simulateTransaction', [transaction.toString('base64'), {
      encoding: 'base64', sigVerify: false, commitment: 'confirmed',
    }]);
    await save('buy-legacy-dispatch-simulation.json', simulation);
    if (!simulation.value.err || !simulation.value.logs?.some(line => line.includes('Instruction: BuyLegacy'))
      || !simulation.value.logs.some(line => line.includes('AccountNotEnoughKeys'))) {
      throw new Error('Expected genuine BuyLegacy dispatch/account-validation evidence missing');
    }
    report.availability = 'LOCAL_BUY_LEGACY_DISPATCH_VERIFIED';
    report.limit = 'Unsigned direct Tensor simulation, missing accounts; no GoBuy CPI, listing, delivery, receipt, or rollback proof';
  }
} catch (error) {
  report.availability = 'BLOCKED';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (validator && validator.exitCode === null) {
    validator.kill('SIGTERM');
    await Promise.race([new Promise(resolve => validator.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (validator.exitCode === null) validator.kill('SIGKILL');
  }
  await log?.close();
  report.finishedAt = new Date().toISOString();
  await save('report.json', report);
  console.log(JSON.stringify(report, null, 2));
}

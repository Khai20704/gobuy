// Read-only remote snapshots; unsigned simulations only on a child-owned local validator.
// This is an availability probe, NOT a GoBuy purchase integration test.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, open, mkdtemp, readdir, copyFile } from 'node:fs/promises';
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
  validatorStarted: false, genuineProgramsLoaded: false, tensorDispatchExecuted: false,
  startupAttempts: [],
};
async function save(name, value) {
  await writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
}
async function rpc(url, method, params = [], timeoutMs = 30000) {
  const allowed = url === REMOTE ? ['getAccountInfo']
    : url === LOCAL ? ['getHealth', 'getAccountInfo', 'getLatestBlockhash', 'simulateTransaction', 'getGenesisHash'] : [];
  if (!allowed.includes(method)) throw new Error(`RPC method or endpoint forbidden: ${method}`);
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
let validator;
let log;
let activeAttempt;
let closed;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopValidator() {
  if (validator?.pid && validator.exitCode === null && validator.signalCode === null) {
    activeAttempt.cleanupSignal = 'SIGTERM';
    validator.kill('SIGTERM');
    await Promise.race([closed, delay(5000)]);
    if (validator.exitCode === null && validator.signalCode === null) {
      activeAttempt.cleanupSignal = 'SIGKILL';
      validator.kill('SIGKILL');
    }
  }
  if (closed) await Promise.race([closed, delay(5000)]);
  await log?.close();
  log = undefined;
  if (activeAttempt) {
    // Only logs: never copy a ledger directory or validator-generated keypairs.
    try {
      for (const file of await readdir(activeAttempt.ledger)) {
        if (/^validator(?:-\d+)?\.log$/.test(file)) {
          await copyFile(join(activeAttempt.ledger, file), join(out, `${activeAttempt.name}-ledger-${file}`));
        }
      }
    } catch (error) { activeAttempt.logCollectionError = error.message; }
    try {
      const lines = (await readFile(join(out, activeAttempt.logFile), 'utf8')).split(/\r?\n/);
      activeAttempt.firstErrorCandidate = lines.find(line => /error|panicked|fatal|invalid value|unexpected argument/i.test(line)) ?? null;
      activeAttempt.logTail = lines.slice(-40);
    } catch (error) { activeAttempt.logReadError = error.message; }
    await save(`${activeAttempt.name}-startup.json`, activeAttempt);
  }
  validator = undefined;
  closed = undefined;
}
async function startValidator(name, selectedPrograms, payer) {
  await stopValidator();
  let occupied = false;
  try { await fetch(LOCAL, { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
  if (occupied) throw new Error('Local RPC port already occupied');
  const ledger = await mkdtemp(join(tmpdir(), 'gobuy-tensor-'));
  // Arguments are constructed only from public IDs, local paths and fixed ports.
  // Never record process.env, credentials, CLI wallet configuration or arbitrary user arguments.
  const args = ['--log', '--ledger', ledger, '--bind-address', '127.0.0.1', '--rpc-port', '18899',
    '--faucet-port', '18901', '--gossip-port', '18898', '--dynamic-port-range', '19000-19050', '--mint', payer];
  for (const program of selectedPrograms) args.push('--bpf-program', program.address, program.path);
  activeAttempt = { name, ledger, command: 'solana-test-validator', args,
    logFile: name === 'full' ? 'validator.log' : `${name}-validator.log`,
    startedAt: new Date().toISOString(), programs: selectedPrograms,
    timeoutMs: 90000, healthChecks: [], status: 'STARTING' };
  const attempt = activeAttempt;
  report.startupAttempts.push(attempt);
  await save(`${name}-startup.json`, attempt);
  await save('report.json', report);
  log = await open(join(out, attempt.logFile), 'w');
  validator = spawn('solana-test-validator', args, { stdio: ['ignore', log.fd, log.fd] });
  attempt.pid = validator.pid;
  let launchError;
  validator.on('error', error => { launchError = error; attempt.spawnError = error.message; });
  closed = new Promise(resolve => validator.once('close', (code, signal) => {
    Object.assign(attempt, { exitCode: code, signal, exitedAt: new Date().toISOString() });
    resolve();
  }));
  try {
    const deadline = Date.now() + attempt.timeoutMs;
    while (Date.now() < deadline) {
      if (launchError || validator.exitCode !== null || validator.signalCode !== null) {
        throw launchError ?? new Error(`Validator exited during startup (code=${validator.exitCode}, signal=${validator.signalCode})`);
      }
      const check = { at: new Date().toISOString() };
      attempt.healthChecks.push(check);
      try { check.result = await rpc(LOCAL, 'getHealth', [], Math.min(2000, deadline - Date.now())); }
      catch (error) { check.error = error.message; }
      if (check.result === 'ok' && validator.exitCode === null && validator.signalCode === null) {
        attempt.status = 'HEALTHY';
        attempt.genesisHash = await rpc(LOCAL, 'getGenesisHash', [], 2000);
        await save(`${name}-startup.json`, attempt);
        return;
      }
      await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    throw new Error('Local validator startup timeout (90 seconds)');
  } catch (error) {
    attempt.status = 'FAILED';
    attempt.error = error.message;
    await stopValidator();
    throw error;
  }
}
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
    const payerBytes = randomBytes(32); // public address only; no signing key exists or is read.
    const payer = encode(payerBytes);
    const selected = [{ name: 'gobuy', address: GOBUY, path: resolve(artifact), sha256: hash(binary) },
      ...Object.entries(programs).map(([name, address]) => ({ name, address,
        path: join(out, `${name}.so`), sha256: report.programs.find(p => p.name === name).sha256 }))];
    if (process.argv.includes('--incremental-startup')) {
      await startValidator('baseline', [], payer);
      for (let count = 1; count < selected.length; count++) {
        await startValidator(`increment-${count}-${selected[count - 1].name}`, selected.slice(0, count), payer);
      }
    }
    await startValidator('full', selected, payer);
    report.validatorStarted = true;
    report.genesisHash = await rpc(LOCAL, 'getGenesisHash');
    report.loadedPrograms = [];
    for (const { address, sha256 } of selected) {
      const loaded = await rpc(LOCAL, 'getAccountInfo', [address, { encoding: 'base64' }]);
      if (!loaded.value?.executable) throw new Error(`Program not executable locally: ${address}`);
      await save(`local-${address}.json`, loaded);
      let bytes = Buffer.from(loaded.value.data[0], 'base64');
      if (loaded.value.owner === LOADER) {
        if (bytes.length !== 36 || bytes.readUInt32LE(0) !== 2) throw new Error(`Invalid local program pointer: ${address}`);
        const data = await rpc(LOCAL, 'getAccountInfo', [encode(bytes.subarray(4)), { encoding: 'base64' }]);
        if (data.value?.owner !== LOADER) throw new Error(`Invalid local ProgramData owner: ${address}`);
        bytes = Buffer.from(data.value.data[0], 'base64');
        if (bytes.readUInt32LE(0) !== 3) throw new Error(`Invalid local ProgramData: ${address}`);
        bytes = bytes.subarray(45);
      } else if (loaded.value.owner !== 'BPFLoader2111111111111111111111111111111111') {
        throw new Error(`Unexpected local loader: ${address}`);
      }
      if (hash(bytes) !== sha256) throw new Error(`Local bytecode hash mismatch: ${address}`);
      report.loadedPrograms.push({ address, sha256, executable: true, loader: loaded.value.owner });
    }
    report.genuineProgramsLoaded = true;
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
    report.tensorDispatchExecuted = true;
    report.limit = 'Unsigned direct Tensor simulation, missing accounts; no GoBuy CPI, listing, delivery, receipt, or rollback proof';
  }
} catch (error) {
  report.availability = 'BLOCKED';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try { await stopValidator(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await save('report.json', report);
  console.log(JSON.stringify(report, null, 2));
}

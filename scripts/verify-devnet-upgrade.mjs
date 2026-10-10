// Offline verification only. Inputs are public RPC snapshots and public ELF bytes.
// Usage: node scripts/verify-devnet-upgrade.mjs <baseline.json> <current.json> <target.so>
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const [baselinePath,currentPath,elfPath]=process.argv.slice(2);
if(!baselinePath||!currentPath||!elfPath) throw Error('Usage: node scripts/verify-devnet-upgrade.mjs <baseline.json> <current.json> <target.so>');
const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8').replace(/^\uFEFF/,''));
const current=JSON.parse(fs.readFileSync(currentPath,'utf8').replace(/^\uFEFF/,''));
const elf=fs.readFileSync(elfPath),hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(elf.length,298456);
assert.equal(hash(elf),'9c092a8d33903079f73d3ede303e71ea29ece86ff14f2f08a7f2d548943c902f');
assert.equal(current.genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
assert.equal(current.program,'CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE');
assert.equal(current.programData,'GocAbEB3CrykEu5wTyZ4w888cQn2krEtuuEiMJGwqGek');
assert.equal(current.authority,'6CndRMc647mRNyFLTXVefngq7kgouexvoVP6v4aZQ6JB');
assert.equal(current.programAccount.value.executable,true);
const loader='BPFLoaderUpgradeab1e11111111111111111111111';
assert.equal(current.programAccount.value.owner,loader);assert.equal(current.programDataAccount.value.owner,loader);
assert(current.deploymentSlot>baseline.deploymentSlot,'Deployment slot must advance');
const data=Buffer.from(current.programDataAccount.value.data[0],'base64');
assert.equal(hash(data.subarray(45,45+elf.length)),hash(elf),'Deployed ELF prefix mismatch');
const accounts=new Map(current.accounts.value.map(entry=>[entry.pubkey,entry.account]));
for(const entry of baseline.accounts.value) assert.deepEqual(accounts.get(entry.pubkey),entry.account,'Historical account changed: '+entry.pubkey);
assert.deepEqual(current.vault.value,baseline.vault.value,'Old Vault changed');
console.log('PASS: target ELF, ProgramData/authority, deployment slot and historical accounts/Vault verified.');
console.log('Additional capacity bytes:',data.length-45-elf.length);

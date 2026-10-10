// Public read-only RPC snapshot. No wallet, environment file, signer or transaction API.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
const endpoint='https://api.devnet.solana.com';
async function rpc(method,params=[]) {
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error('RPC HTTP '+response.status);
  const body=await response.json(); if(body.error) throw new Error(JSON.stringify(body.error)); return body.result;
}
const program='CHjdqooB7TrussJoZoboFP5TtdCspoHtvPpqoshbr5zE';
const config={encoding:'base64',commitment:'finalized'};
const info=await rpc('getAccountInfo',[program,config]);
const bytes=Buffer.from(info.value.data[0],'base64');
const programData=new PublicKey(bytes.subarray(4,36)).toBase58();
const data=await rpc('getAccountInfo',[programData,config]);
const raw=Buffer.from(data.value.data[0],'base64');
const authority=new PublicKey(raw.subarray(13,45)).toBase58();
const accounts=await rpc('getProgramAccounts',[program,{...config,withContext:true}]);
const vault='GfjKEqEPghVscwJ3piwGwQvbxtug7quUVZBpi1kQJZEC';
const rent={}; for(const size of [181,194,203,274,298493,298501]) rent[size]=await rpc('getMinimumBalanceForRentExemption',[size,{commitment:'finalized'}]);
const snapshot={capturedAt:new Date().toISOString(),endpoint,genesis:await rpc('getGenesisHash'),version:await rpc('getVersion'),program,programData,authority,deploymentSlot:Number(raw.readBigUInt64LE(4)),payloadBytes:raw.length-45,payloadSha256:createHash('sha256').update(raw.subarray(45)).digest('hex'),instructionStrings:raw.toString('latin1').match(/Instruction: [A-Za-z]+/g),programAccount:info,programDataAccount:data,accounts,vault:await rpc('getAccountInfo',[vault,config]),authorityBalance:await rpc('getBalance',[authority,{commitment:'finalized'}]),rent};
fs.writeFileSync(process.argv[2] ?? new URL('./devnet-snapshot.json',import.meta.url),JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({...snapshot,programAccount:undefined,programDataAccount:undefined,accounts:accounts.value.map(a=>({address:a.pubkey,bytes:Buffer.from(a.account.data[0],'base64').length})),vault:snapshot.vault.value.lamports},null,2));

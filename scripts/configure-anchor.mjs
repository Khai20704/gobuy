import { readFileSync, writeFileSync } from 'node:fs'
import { PublicKey, SystemProgram } from '@solana/web3.js'
const input = process.argv[2]
if (!input) throw new Error('Usage: npm run anchor:configure -- <ACTUAL_PROGRAM_PUBLIC_KEY>')
const address = new PublicKey(input)
if (address.equals(SystemProgram.programId) || !PublicKey.isOnCurve(address.toBytes())) {
  throw new Error('Provide the actual deployment program public key, not the undeployed sentinel or a PDA.')
}
for (const [path, pattern, replacement] of [
  ['anchor/programs/gobuy_na/src/lib.rs', /declare_id!\("[^"]+"\);/, 'declare_id!("' + address.toBase58() + '");'],
  ['anchor/Anchor.toml', /gobuy_na = "[^"]+"/, 'gobuy_na = "' + address.toBase58() + '"'],
]) {
  const content = readFileSync(path, 'utf8')
  if (!pattern.test(content)) throw new Error('Expected configuration missing: ' + path)
  writeFileSync(path, content.replace(pattern, replacement))
}
console.log('Configured public address only. This does not deploy or prove a deployment.')

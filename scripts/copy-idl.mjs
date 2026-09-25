import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
const idl = JSON.parse(readFileSync('anchor/target/idl/gobuy_na.json', 'utf8'))
if (!idl.address || idl.address === '11111111111111111111111111111111') throw new Error('Build with your actual program public key first.')
const config = readFileSync('anchor/Anchor.toml', 'utf8')
if (!config.includes('gobuy_na = "' + idl.address + '"')) throw new Error('IDL address differs from Anchor.toml.')
mkdirSync('frontend/public/idl', { recursive: true })
writeFileSync('frontend/public/idl/gobuy_na.json', JSON.stringify(idl, null, 2) + '\n')
console.log('Copied generated IDL. Set VITE_SOLANA_PROGRAM_ID=' + idl.address)

import { spawn } from 'node:child_process'
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run npm run dev:auth')
const env = { ...process.env, APP_STORAGE: process.env.APP_STORAGE || 'file',
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'gobuy_emulator', NFT_DATA_DIR: '.data/nft-demo-emulator', TWIN_DATA_DIR: '.data/twins-emulator', NODE_ENV: 'development', FIREBASE_PROJECT_ID: 'demo-na',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', ACCOUNT_DATA_DIR: '.data/accounts-emulator',
  VITE_FIREBASE_API_KEY: 'demo-api-key', VITE_FIREBASE_PROJECT_ID: 'demo-na',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-na.firebaseapp.com', VITE_FIREBASE_APP_ID: 'demo-na-web',
  VITE_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099' }
console.log('Application storage: ' + env.APP_STORAGE + (env.APP_STORAGE === 'mongo' ? ' (isolated emulator database)' : ' (explicit local emulator mode)'))
const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true; process.exitCode = code
  for (const child of children) if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  }
}
function run(args) {
  const child = spawn(process.execPath, [npm, ...args], { stdio: 'inherit', env, windowsHide: true, detached: process.platform !== 'win32' })
  children.push(child)
  child.on('error', error => { console.error(error.message); stop(1) })
  child.on('exit', code => stop(code ?? 1))
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
console.log('LOCAL AUTH TEST: no real Google account or SMS. OTP codes appear in the emulator terminal. Accounts reset when the emulator stops.')
run(['exec', '--yes', '--package=firebase-tools@15.32.1', '--', 'firebase', 'emulators:start', '--only', 'auth', '--project', 'demo-na'])
let ready = false
for (let attempt = 0; attempt < 180 && !stopping; attempt++) {
  try { ready = (await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-na/config', { signal: AbortSignal.timeout(1000) })).ok } catch {}
  if (ready) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}
if (!stopping && ready) run(['run', 'dev', '--', ...process.argv.slice(2)])
else if (!stopping) { console.error('Auth emulator did not start on port 9099.'); stop(1) }

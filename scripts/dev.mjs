import { spawn } from 'node:child_process'
const npm = process.env.npm_execpath
if (!npm) throw new Error('Run with npm run dev')
const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exitCode = code
}
for (const workspace of ['backend', 'frontend']) {
  const child = spawn(process.execPath, [npm, 'run', 'dev', '-w', workspace, ...(workspace === 'frontend' ? ['--', ...process.argv.slice(2)] : [])], { stdio: 'inherit', env: process.env })
  children.push(child)
  child.on('error', error => { console.error(error); stop(1) })
  child.on('exit', code => stop(code ?? 1))
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

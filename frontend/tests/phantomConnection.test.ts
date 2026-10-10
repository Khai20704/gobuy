import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectPhantom, type PhantomProvider } from '../src/services/solana/phantom.ts'

test('Phantom connection stops waiting when the extension never responds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const provider = { connect: () => new Promise(() => {}) } as unknown as PhantomProvider
  const rejected = assert.rejects(connectPhantom(provider), /30 giây/)
  context.mock.timers.tick(30000)
  await rejected
})

test('Phantom connection explains extension errors, rejected and pending requests', async () => {
  for (const [code, expected] of [[4001, /từ chối/], [-32002, /yêu cầu chờ/], [-32603, /mã -32603/]] as const) {
    const provider = { connect: async () => { throw { code, message: 'Unexpected error' } } } as unknown as PhantomProvider
    await assert.rejects(connectPhantom(provider), expected)
  }
})

test('Phantom connection returns the approved public key', async () => {
  const result = { publicKey: {} }
  const provider = { connect: async () => result } as unknown as PhantomProvider
  assert.equal(await connectPhantom(provider), result)
})

test('Phantom internal errors preserve the original cause without diagnosing a missing account', async () => {
  const original = { code: -32603, message: 'Unexpected error' }
  const provider = { connect: async () => { throw original } } as unknown as PhantomProvider
  await assert.rejects(connectPhantom(provider), (error: Error) => {
    assert.equal(error.cause, original)
    assert.match(error.message, /lỗi nội bộ/)
    assert.match(error.message, /Connected Apps/)
    assert.doesNotMatch(error.message, /mở khóa|địa chỉ Solana/)
    return true
  })
})

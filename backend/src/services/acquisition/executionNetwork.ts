export function assertNFTExecutionNetwork(candidate: { sourceNetwork: string }) {
  if (candidate.sourceNetwork === 'mainnet') {
    console.info('[NFT Execution]', JSON.stringify({ network: 'mainnet', allowed: false, reason: 'MAINNET_READ_ONLY' }))
    throw new Error('MAINNET_READ_ONLY: NFT Mainnet chỉ nghiên cứu, không được tạo giao dịch.')
  }
  // Existing mock mode remains explicitly isolated for tests/demo.
  if (candidate.sourceNetwork !== 'devnet' && candidate.sourceNetwork !== 'mock') throw new Error('NETWORK_MISMATCH')
}

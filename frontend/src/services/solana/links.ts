export const explorerTx = (signature: string) => 'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet'
export const explorerAccount = (address: string) => 'https://explorer.solana.com/address/' + encodeURIComponent(address) + '?cluster=devnet'

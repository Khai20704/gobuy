import type { PublicKey, Transaction } from '@solana/web3.js'
export type PhantomProvider = {
  isPhantom: boolean;
  publicKey: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  on(event: 'accountChanged' | 'disconnect', callback: () => void): void;
  removeListener(event: 'accountChanged' | 'disconnect', callback: () => void): void;
}
declare global { interface Window { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider } }
export class PhantomUnavailableError extends Error {}
export function findPhantomProvider(): PhantomProvider | undefined {
  // Only accept a provider identifying itself as Phantom, even with other wallets installed.
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana
  if (window.solana?.isPhantom) return window.solana
  return undefined
}
export async function phantomProvider(): Promise<PhantomProvider> {
  // Extensions can inject after React mounts. Recheck on each user-initiated connection.
  for (let attempt = 0; attempt < 8; attempt++) {
    const provider = findPhantomProvider()
    if (provider) return provider
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new PhantomUnavailableError('Phantom was not detected in this browser tab. Check the extension in this Chrome profile, then reload the page. A wallet on your phone alone cannot connect through this button.')
}

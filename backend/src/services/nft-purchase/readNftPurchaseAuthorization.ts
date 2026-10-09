import { PublicKey } from '@solana/web3.js'
import { InputError } from '../../schemas/search.js'
import { requiredMandateGuard } from '../mandate/MandateGuard.js'
import type { MandateProgramClient } from '../mandate/MandateProgramClient.js'
import { decodeNftPurchaseAuthorization, serializeNftPurchaseAuthorization } from './nftPurchaseAccounts.js'
import { nftAuthorizationAddress } from './nftPurchaseInstructions.js'

/**
 * Read-only access to the owner's on-chain purchase authorization.
 *
 * `null` means the owner has not authorized genuine purchases yet, which is a normal answer rather
 * than an error. A malformed account is an error: a policy the program cannot have written must
 * never be shown to the owner as if it were an approval.
 */

/** Fails closed when the Na Vault program is not configured, without building any transaction. */
export function mandatoryGuard() {
  return requiredMandateGuard()
}

export async function readNftPurchaseAuthorization(client: MandateProgramClient, owner: string) {
  const mandate = await client.read(owner)
  if (!mandate) return null
  const address = nftAuthorizationAddress(client.programId, new PublicKey(mandate.address))
  const info = await client.connection.getAccountInfo(address, 'confirmed')
  if (!info) return null
  if (!info.owner.equals(client.programId)) {
    throw new InputError('Tài khoản uỷ quyền mua NFT không thuộc chương trình Na Vault. Na từ chối sử dụng.')
  }
  return serializeNftPurchaseAuthorization(decodeNftPurchaseAuthorization(address.toBase58(), info.data))
}

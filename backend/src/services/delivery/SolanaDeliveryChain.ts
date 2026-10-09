import { createHmac } from 'node:crypto'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { AuthorityType, ExtensionType, LENGTH_SIZE, TYPE_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  createMintToCheckedInstruction, createSetAuthorityInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getMintLen, unpackMint, unpackAccount } from '@solana/spl-token'
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createSignerFromKeypair, publicKey } from '@metaplex-foundation/umi'
import { createV1, fetchAssetV1, mplCore, transferV1, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core'
import { toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters'
import { assertDevnet, base58Encode, solanaConfig } from '@gobuy/shared'
import { requireAgentKeypair } from '../mandate/agentKeypair.js'
import { decimalUnits } from './quantity.js'
import type { DeliveryAttempt, DeliveryChain, DeliveryPlan } from './DeliveryService.js'
import { walletHoldings } from './walletHoldings.js'
import { devnetRpc } from './rpc.js'
import { publicMetadataUrl, demoImageUrl, verifyPublicMetadata, validateCoreUrls } from './metadataUrl.js'

/** Never creates a Mainnet connection. The agent pays delivery rent/fees, not the owner's vault. */
export class SolanaDeliveryChain implements DeliveryChain {
  private readonly config = solanaConfig(process.env)
  private readonly connection: Connection
  private readonly umi: ReturnType<typeof createUmi>
  constructor(connection?: Connection, private readonly agent = requireAgentKeypair,
    private readonly metadataCheck = verifyPublicMetadata,
    private readonly liveEnabled = () => process.env.DEVNET_DELIVERY_LIVE_ENABLED === 'true') {
    if (connection && connection.rpcEndpoint !== this.config.rpcUrl) throw new Error('Delivery RPC must match Devnet configuration.')
    this.connection = connection ?? devnetRpc(this.config.rpcUrl)
    this.umi = createUmi(this.connection).use(mplCore())
  }
  private async devnet() { await assertDevnet(this.connection, this.config) }
  private mintKey(plan: DeliveryPlan) {
    return Keypair.fromSeed(createHmac('sha256', this.agent().secretKey).update('gobuy-delivery-v1:' + plan.metadataId).digest())
  }
  async assertNoExistingMint(plan: DeliveryPlan) {
    await this.devnet()
    if (await this.connection.getAccountInfo(this.mintKey(plan).publicKey, 'finalized')) throw new Error('Existing mint/marker requires reconciliation.')
  }
  async prepare(plan: DeliveryPlan): Promise<DeliveryAttempt> {
    await this.devnet()
    const agent = this.agent(), owner = new PublicKey(plan.owner)
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error('Recipient must be a Phantom wallet public key.')
    const signer = createSignerFromKeypair(this.umi, this.umi.eddsa.createKeypairFromSecretKey(agent.secretKey))
    // Unique to the immutable account-scoped plan. No private mint key is stored in MongoDB.
    const mintKey = this.mintKey(plan)
    if (await this.connection.getAccountInfo(mintKey.publicKey, 'finalized')) throw new Error('Existing delivery mint/marker requires reconciliation; do not recreate.')
    const block = await this.connection.getLatestBlockhash('finalized')
    const tx = new Transaction({ feePayer: agent.publicKey, ...block })
    let mint = mintKey.publicKey, standard: 'core' | 'spl' = 'spl', program: PublicKey | undefined
    const signers = [agent]
    const demo = plan.mode === 'DEVNET_DEMO_MINT'
    const transfer = ['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(plan.mode)
    if (demo && (plan.recipientWallet !== plan.owner || !plan.recipientVerifiedAt || plan.rawQuantity !== '1' || plan.decimals !== 0)) throw new Error('Verified NFT recipient and exact supply of one required.')
    const uri = plan.metadataUri ?? (transfer ? '' : publicMetadataUrl(plan.metadataId, demo ? demoImageUrl() : plan.image))
    if (plan.assetStandard === 'METAPLEX_CORE') {
      if (!demo || plan.kind !== 'NFT') throw new Error('Core requires a demo NFT plan.')
      validateCoreUrls(plan.metadataUri, plan.imageUri)
    }
    if (demo) await this.metadataCheck(uri, { name: `GoBuy Devnet Demo · ${plan.name}`.slice(0, 80), image: plan.imageUri ?? demoImageUrl() })
    if (plan.mode === 'DEMO_NFT' || plan.assetStandard === 'METAPLEX_CORE') {
      standard = 'core'
      const asset = createSignerFromKeypair(this.umi, this.umi.eddsa.createKeypairFromSecretKey(mintKey.secretKey))
      tx.add(...createV1(this.umi, { asset, payer: signer, authority: signer, owner: publicKey(plan.owner),
        updateAuthority: publicKey(plan.owner), name: plan.assetStandard === 'METAPLEX_CORE' ? `GoBuy Devnet Demo · ${plan.name}`.slice(0, 80) : `Devnet Demo · ${plan.name}`.slice(0, 80), uri }).getInstructions().map(toWeb3JsInstruction))
      signers.push(mintKey)
    } else if (plan.mode === 'RWA_TOKEN' || demo) {
      program = TOKEN_2022_PROGRAM_ID
      const name = `${demo ? 'GoBuy Demo' : 'DEMO RWA'} · ${plan.name}`.slice(0, 64), symbol = demo ? 'DEMO-NFT' : 'DEMO-RWA'
      const metadata = { mint, updateAuthority: agent.publicKey, name, symbol, uri, additionalMetadata: [] as [string, string][] }
      const space = getMintLen([ExtensionType.MetadataPointer])
      const rent = await this.connection.getMinimumBalanceForRentExemption(space + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length)
      const ata = getAssociatedTokenAddressSync(mint, owner, false, program)
      tx.add(SystemProgram.createAccount({ fromPubkey: agent.publicKey, newAccountPubkey: mint, space, lamports: rent, programId: program }),
        createInitializeMetadataPointerInstruction(mint, null, mint, program),
        createInitializeMintInstruction(mint, plan.decimals, agent.publicKey, null, program),
        createInitializeInstruction({ programId: program, metadata: mint, mint, mintAuthority: agent.publicKey,
          updateAuthority: agent.publicKey, name, symbol, uri }),
        createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, ata, owner, mint, program),
        createMintToCheckedInstruction(mint, ata, agent.publicKey, BigInt(plan.rawQuantity), plan.decimals, [], program),
        createSetAuthorityInstruction(mint, agent.publicKey, AuthorityType.MintTokens, null, [], program))
      // Creation + issuance + authority revocation are atomic; repeating can never mint twice.
      signers.push(mintKey)
    } else {
      // Atomic purchase marker prevents a second transfer even if historical RPC status is pruned.
      // The same account-scoped key is reused across every delivery attempt.
      tx.add(SystemProgram.createAccount({ fromPubkey: agent.publicKey, newAccountPubkey: mintKey.publicKey,
        space: 0, lamports: await this.connection.getMinimumBalanceForRentExemption(0), programId: SystemProgram.programId }))
      signers.push(mintKey)
      mint = new PublicKey(plan.sourceMint)
      const info = await this.connection.getAccountInfo(mint, 'confirmed')
      if (!info) throw new Error('Selected NFT does not exist on Devnet; no substitute NFT was minted.')
      if (info.owner.toBase58() === MPL_CORE_PROGRAM_ID) {
        standard = 'core'
        const asset = await fetchAssetV1(this.umi, publicKey(mint.toBase58()))
        const delegated = [asset.transferDelegate?.authority, asset.permanentTransferDelegate?.authority]
          .some(authority => authority?.type === 'Address' && authority.address === agent.publicKey.toBase58())
        if (asset.owner !== agent.publicKey.toBase58() && !delegated) throw new Error('NFT is in seller/marketplace custody. Agent has no transfer authority; escrow release is required.')
        tx.add(...transferV1(this.umi, { asset: asset.publicKey, payer: signer, authority: signer, newOwner: publicKey(plan.owner),
          ...(asset.updateAuthority.type === 'Collection' ? { collection: asset.updateAuthority.address } : {}) }).getInstructions().map(toWeb3JsInstruction))
      } else {
        program = info.owner
        if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Unsupported NFT program; cannot transfer safely.')
        const data = unpackMint(mint, info, program)
        if (data.decimals !== 0 || data.supply !== 1n) throw new Error('Selected mint is not a one-of-one NFT.')
        const largest = await this.connection.getTokenLargestAccounts(mint, 'confirmed')
        const source = largest.value.find(row => row.amount === '1')
        if (!source) throw new Error('NFT custody account unavailable.')
        const address = source.address, sourceInfo = await this.connection.getAccountInfo(address, 'confirmed')
        if (!sourceInfo) throw new Error('NFT custody account missing.')
        const account = unpackAccount(address, sourceInfo, program)
        if (account.isFrozen || (!account.owner.equals(agent.publicKey)
          && !(account.delegate?.equals(agent.publicKey) && account.delegatedAmount >= 1n))) {
          throw new Error('NFT is not transferable by Na Agent (seller/escrow custody or frozen). Delivery requires the authorized owner; payment will not repeat.')
        }
        const ata = getAssociatedTokenAddressSync(mint, owner, false, program)
        tx.add(createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, ata, owner, mint, program),
          createTransferCheckedInstruction(address, mint, ata, agent.publicKey, 1n, 0, [], program))
      }
    }
    tx.sign(...signers)
    return { mint: mint.toBase58(), signature: base58Encode(tx.signature!), wire: tx.serialize().toString('base64'),
      lastValidBlockHeight: block.lastValidBlockHeight, standard, ...(program ? { program: program.toBase58() } : {}) }
  }
  async inspect(plan: DeliveryPlan, attempt: DeliveryAttempt) {
    await this.devnet()
    const transaction = Transaction.from(Buffer.from(attempt.wire, 'base64'))
    if (!transaction.verifySignatures() || base58Encode(transaction.signature!) !== attempt.signature) throw new Error('Stored delivery transaction is invalid.')
    const expectedMarker = this.mintKey(plan).publicKey
    if (!transaction.signatures.some(row => row.publicKey.equals(expectedMarker))) return 'uncertain' as const
    const transfer = ['TRANSFER_NFT', 'ORIGINAL_NFT_TRANSFER'].includes(plan.mode)
    if (!transfer && expectedMarker.toBase58() !== attempt.mint) return 'uncertain' as const
    if (transfer && plan.sourceMint !== attempt.mint) return 'uncertain' as const
    const status = (await this.connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0]
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      if (status.err) return 'failed' as const
      // Verify the actual recipient, mint and quantity, never just the transaction status.
      if (attempt.standard === 'core') {
        const held = await this.holdings(plan, attempt)
        return held.ownership === 'verified' ? 'confirmed' as const : 'uncertain' as const
      }
      const receipt = await this.connection.getTransaction(attempt.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      if (!receipt?.meta || receipt.meta.err) return 'uncertain' as const
      const post = receipt.meta.postTokenBalances?.find(row => row.mint === attempt.mint && row.owner === plan.owner)
      const pre = receipt.meta.preTokenBalances?.find(row => row.accountIndex === post?.accountIndex)
      if (!post || post.uiTokenAmount.decimals !== plan.decimals
        || BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0') !== BigInt(plan.rawQuantity)) return 'uncertain' as const
      if (plan.mode === 'DEVNET_DEMO_MINT' && (await this.holdings(plan, attempt)).ownership !== 'verified') return 'uncertain' as const
      return 'confirmed' as const
    }
    if (status) return 'confirming' as const // Do not replace a processed/fork-uncertain transaction.
    if (await this.connection.getBlockHeight('finalized') <= attempt.lastValidBlockHeight) return 'pending' as const
    // Recheck after the finalized expiry boundary to avoid a status/height race.
    const after = (await this.connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0]
    if (after) return 'confirming' as const
    // A null history lookup alone is insufficient: RPC nodes may prune transaction history.
    const receipt = await this.connection.getTransaction(attempt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (receipt) return 'uncertain' as const
    const marker = this.mintKey(plan).publicKey
    if (!transfer && marker.toBase58() !== attempt.mint) return 'uncertain' as const
    const minContextSlot = await this.connection.getSlot('finalized')
    const exists = await this.connection.getAccountInfo(marker, { commitment: 'finalized', minContextSlot })
    return exists ? 'uncertain' as const : 'retryable' as const
  }
  async send(attempt: DeliveryAttempt) {
    if (!this.liveEnabled()) throw new Error('LIVE_DEVNET_DELIVERY_DISABLED: enable only after explicit approval.')
    await this.devnet()
    const tx = Transaction.from(Buffer.from(attempt.wire, 'base64'))
    if (!tx.verifySignatures() || base58Encode(tx.signature!) !== attempt.signature) throw new Error('Stored delivery transaction is invalid.')
    await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 })
  }
  async holdings(plan: DeliveryPlan, attempt: DeliveryAttempt) {
    await this.devnet()
    if (plan.assetStandard === 'METAPLEX_CORE') {
      if (attempt.standard !== 'core' || attempt.mint !== this.mintKey(plan).publicKey.toBase58()) throw new Error('Core identity mismatch.')
      const info = await this.connection.getAccountInfo(new PublicKey(attempt.mint), 'confirmed')
      if (!info || info.owner.toBase58() !== MPL_CORE_PROGRAM_ID) return { ownership: 'unknown' as const, balance: '0' }
      const asset = await fetchAssetV1(this.umi, publicKey(attempt.mint))
      const owned = asset.owner === plan.owner && asset.uri === plan.metadataUri && asset.name === `GoBuy Devnet Demo · ${plan.name}`.slice(0, 80)
      return { ownership: owned ? 'verified' as const : 'not_owned' as const, balance: owned ? '1' : '0' }
    }
    if (plan.mode === 'DEVNET_DEMO_MINT') {
      if (plan.recipientWallet !== plan.owner) throw new Error('Recipient mismatch.')
      const mint = new PublicKey(attempt.mint), owner = new PublicKey(plan.owner)
      const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID)
      const [mintInfo, accountInfo] = await this.connection.getMultipleAccountsInfo([mint, ata], 'confirmed')
      if (!mintInfo || !accountInfo) return { ownership: 'unknown' as const, balance: '0' }
      const data = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID), account = unpackAccount(ata, accountInfo, TOKEN_2022_PROGRAM_ID)
      const verified = data.supply === 1n && data.decimals === 0 && data.mintAuthority === null && data.freezeAuthority === null
        && account.owner.equals(owner) && account.mint.equals(mint) && account.amount === 1n
      return { ownership: verified ? 'verified' as const : 'not_owned' as const, balance: account.amount.toString() }
    }
    if (attempt.standard === 'core') {
      const asset = await fetchAssetV1(this.umi, publicKey(attempt.mint))
      const owned = asset.owner === plan.owner
      return { ownership: owned ? 'verified' as const : 'not_owned' as const, balance: owned ? '1' : '0' }
    }
    const rows = await walletHoldings(plan.owner, true)
    const amount = rows.filter(row => row.mint === attempt.mint && row.decimals === plan.decimals)
      .reduce((sum, row) => sum + BigInt(row.rawQuantity), 0n)
    return { ownership: amount > 0n ? 'verified' as const : 'not_owned' as const, balance: decimalUnits(amount.toString(), plan.decimals) }
  }
}

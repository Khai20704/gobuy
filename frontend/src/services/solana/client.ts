import { BN, BorshInstructionCoder, Program, type Idl } from '@anchor-lang/core'
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { assetCode, marketCode, canonicalProposal, policyHash, hex, REASONS,
  type Mandate, type MandateInput, type CommerceProposal, type AuditRecord } from '@gobuy/shared'
import type { PhantomProvider } from './phantom'
import { requireConfirmation, UnconfirmedTransactionError } from './confirmation'
import { requireDevnet } from './network'

type ChainMandate = { owner: PublicKey; version: BN; maxAmount: BN; currency: number; assetType: number;
  marketplace: number; requireVerifiedSeller: boolean; autonomy: boolean; policyHash: number[] }
type ChainRecord = { owner: PublicKey; mandate: PublicKey; proposalId: number[]; proposalHash: number[];
  mandateVersion: BN; currentVersion: BN; approved: boolean; reasonCode: number; checks: number; timestamp: BN }

export class NaClient {
  private constructor(readonly connection: Connection, readonly program: Program,
    private readonly wallet: PhantomProvider, readonly owner: PublicKey) {}
  static async create(wallet: PhantomProvider) {
    const configuredId = import.meta.env.VITE_SOLANA_PROGRAM_ID?.trim()
    if (!configuredId) throw new Error('Demo mode: set VITE_SOLANA_PROGRAM_ID and copy the generated IDL after deploying to Devnet.')
    const id = new PublicKey(configuredId)
    if (id.equals(SystemProgram.programId)) throw new Error('The undeployed sentinel cannot be used as a program ID.')
    const rpc = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'
    const connection = new Connection(rpc, 'confirmed')
    await requireDevnet(connection)
    const account = await connection.getAccountInfo(id, 'confirmed')
    if (!account?.executable) throw new Error('No executable program at this address on Devnet. Complete deployment first.')
    const response = await fetch(import.meta.env.VITE_ANCHOR_IDL_URL || '/idl/gobuy_na.json', { cache: 'no-store' })
    if (!response.ok) throw new Error('Generated Anchor IDL missing. Run npm run anchor:idl after anchor build.')
    const idl = await response.json() as Idl
    if (idl.address !== id.toBase58()) throw new Error('Program ID and generated IDL do not match.')
    if (!wallet.publicKey) throw new Error('Connect Phantom first.')
    return new NaClient(connection, new Program(idl, { connection }), wallet, wallet.publicKey)
  }
  mandateAddress() {
    return PublicKey.findProgramAddressSync([Buffer.from('mandate'), this.owner.toBuffer()], this.program.programId)[0]
  }
  actionAddress(id: Uint8Array) {
    return PublicKey.findProgramAddressSync([Buffer.from('action'), this.mandateAddress().toBuffer(), id], this.program.programId)[0]
  }
  private assertOwner() {
    if (!this.wallet.publicKey?.equals(this.owner)) throw new Error('Wallet changed. Reconnect before continuing.')
  }
  private async send(transaction: Transaction) {
    this.assertOwner()
    await requireDevnet(this.connection)
    const block = await this.connection.getLatestBlockhash('confirmed')
    transaction.feePayer = this.owner
    transaction.recentBlockhash = block.blockhash
    const signed = await this.wallet.signTransaction(transaction)
    this.assertOwner()
    const signature = await this.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
    await requireConfirmation(this.connection, signature, block)
    this.assertOwner()
    return signature
  }
  async fetchMandate(): Promise<Mandate | null> {
    const info = await this.connection.getAccountInfo(this.mandateAddress(), 'confirmed')
    if (!info) return null
    if (!info.owner.equals(this.program.programId)) throw new Error('Unexpected mandate account owner.')
    const value = this.program.coder.accounts.decode<ChainMandate>('mandate', info.data)
    if (!value.owner.equals(this.owner) || value.currency !== 1) throw new Error('Unexpected mandate data.')
    return { version: value.version.toNumber(), maxAmount: value.maxAmount.toString(),
      assetType: value.assetType === 1 ? 'NFT' : 'RWA', marketplace: value.marketplace === 1 ? 'DEMO_MARKET' : 'DEMO_GALLERY',
      requireVerifiedSeller: value.requireVerifiedSeller, autonomy: value.autonomy, policyHash: hex(Uint8Array.from(value.policyHash)) }
  }
  async saveMandate(input: MandateInput, currentVersion: number | null) {
    const args = { maxAmount: new BN(input.maxAmount), currency: 1, assetType: assetCode(input.assetType),
      marketplace: marketCode(input.marketplace), requireVerifiedSeller: input.requireVerifiedSeller,
      autonomy: input.autonomy, policyHash: Array.from(await policyHash(input)) }
    const accounts = { owner: this.owner, mandate: this.mandateAddress(), systemProgram: SystemProgram.programId }
    const transaction = currentVersion === null
      ? await this.program.methods.initializeMandate(args).accountsStrict(accounts).transaction()
      : await this.program.methods.updateMandate(args, new BN(currentVersion))
        .accountsStrict({ owner: this.owner, mandate: accounts.mandate }).transaction()
    const signature = await this.send(transaction)
    try {
      const mandate = await this.fetchMandate()
      if (!mandate) throw new Error('Mandate unavailable')
      return { mandate, signature }
    } catch { throw new UnconfirmedTransactionError(signature) }
  }
  private decodeRecord(address: PublicKey, data: Buffer, signature?: string): AuditRecord {
    const value = this.program.coder.accounts.decode<ChainRecord>('actionRecord', data)
    if (!value.owner.equals(this.owner) || !value.mandate.equals(this.mandateAddress())) throw new Error('Unexpected audit owner.')
    const reasonCode = REASONS[value.reasonCode]
    if (!reasonCode || value.approved !== (value.reasonCode === 0) || value.approved !== (value.checks === 511)) {
      throw new Error('Invalid audit result.')
    }
    return { address: address.toBase58(), proposalHash: hex(Uint8Array.from(value.proposalHash)),
      proposalId: hex(Uint8Array.from(value.proposalId)), mandateVersion: value.mandateVersion.toNumber(),
      currentVersion: value.currentVersion.toNumber(), approved: value.approved, reasonCode, checks: value.checks,
      timestamp: value.timestamp.toNumber(), signature }
  }
  async authorize(proposal: CommerceProposal, version: number): Promise<AuditRecord> {
    const p = await canonicalProposal(proposal)
    const address = this.actionAddress(p.proposalId)
    if (await this.connection.getAccountInfo(address, 'confirmed')) throw new Error('DUPLICATE_PROPOSAL: this proposal ID already has an audit record.')
    const args = { proposalId: Array.from(p.proposalId), amount: new BN(proposal.amount), currency: 1,
      assetType: assetCode(proposal.assetType), marketplace: marketCode(proposal.marketplace),
      sellerClaimedVerified: proposal.sellerEvidence.claimedVerified,
      assetIdHash: Array.from(p.assetIdHash), evidenceHash: Array.from(p.evidenceHash),
      metadataHash: Array.from(p.metadataHash), expiresAt: new BN(proposal.expiresAt), proposalHash: Array.from(p.hash) }
    const tx = await this.program.methods.authorizeProposal(args, new BN(version)).accountsStrict({
      owner: this.owner, mandate: this.mandateAddress(), actionRecord: address, systemProgram: SystemProgram.programId,
    }).transaction()
    const signature = await this.send(tx)
    try {
      const info = await this.connection.getAccountInfo(address, 'confirmed')
      if (!info?.owner.equals(this.program.programId)) throw new Error('Audit unavailable')
      const record = this.decodeRecord(address, info.data, signature)
      if (record.proposalHash !== hex(p.hash) || record.mandateVersion !== version) throw new Error('Audit mismatch')
      return record
    } catch { throw new UnconfirmedTransactionError(signature) }
  }
  async history(): Promise<AuditRecord[]> {
    const accounts = await this.connection.getProgramAccounts(this.program.programId, {
      commitment: 'confirmed',
      filters: [{ dataSize: 149 }, { memcmp: { offset: 8, bytes: this.mandateAddress().toBase58() } }],
    })
    const records = accounts.map(({ pubkey, account }) => this.decodeRecord(pubkey, account.data))
      .sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)
    return Promise.all(records.map(async record => {
      // Immutable action PDA has one successful creation transaction; failed replay attempts are ignored.
      const signatures = await this.connection.getSignaturesForAddress(new PublicKey(record.address), { limit: 50 }, 'confirmed')
        .catch(() => [])
      let signature: string | undefined
      for (const candidate of signatures.filter(item => !item.err)) {
        const transaction = await this.connection.getParsedTransaction(candidate.signature, {
          commitment: 'confirmed', maxSupportedTransactionVersion: 0,
        }).catch(() => null)
        if (!transaction || transaction.meta?.err || !transaction.meta) continue
        const created = transaction.transaction.message.instructions.some(instruction => {
          if (!instruction.programId.equals(this.program.programId) || !('data' in instruction)) return false
          if (!instruction.accounts.some(account => account.toBase58() === record.address)) return false
          return new BorshInstructionCoder(this.program.idl).decode(instruction.data, 'base58')?.name === 'authorizeProposal'
        })
        if (created) { signature = candidate.signature; break }
      }
      return { ...record, signature }
    }))
  }
}

import { useState, type FormEvent } from 'react'
import { purchaseIntentSchema, type PurchaseIntent, type ResearchResponse } from '@gobuy/shared'
import { researchProducts } from '../../../services/api/research'
export function StructuredSearch({ busy, onResult }: { busy: boolean; onResult: (r: ResearchResponse) => void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (pending || busy) return
    const form = new FormData(e.currentTarget)
    setPending(true); setError('')
    try {
      const intent: PurchaseIntent = purchaseIntentSchema.parse({ requestId: crypto.randomUUID(), query: form.get('query'), assetType: form.get('asset'),
        ...(form.get('budget') ? { budget: { amount: Number(form.get('budget')), currency: form.get('currency') } } : {}),
        preferences: form.get('collection') ? { collectionSymbol: form.get('collection') } : {} })
      onResult(await researchProducts(intent.query, undefined, intent))
    } catch (e) { setError(e instanceof Error ? e.message : 'Search unavailable.') } finally { setPending(false) }
  }
  return <details className="structured-search"><summary>Structured search · works without AI</summary><form className="mandate-form" onSubmit={e => void submit(e)}><fieldset disabled={pending || busy}>
    <label>Product or asset<input name="query" required maxLength={300}/></label>
    <label>Asset type<select name="asset"><option value="PHYSICAL">Physical product</option><option value="NFT">NFT</option><option value="RWA">RWA</option></select></label>
    <label>Maximum for this request (optional)<input name="budget" type="number" min="0" step="any"/></label>
    <label>Currency<select name="currency"><option>USD</option><option>USDC</option><option>SOL</option></select></label>
    <label>Magic Eden collection symbol (NFT only)<input name="collection" placeholder="mad_lads"/></label>
    <button className="primary">{pending ? 'Searching…' : 'Search sources'}</button></fieldset></form>{error && <p role="alert">{error}</p>}</details>
}

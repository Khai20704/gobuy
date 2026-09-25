import { useState, type FormEvent } from 'react'
import { mandateInputSchema, type Mandate, type MandateInput } from '@gobuy/shared'
export function MandateForm({ mandate, onChain, exists, busy, onSave }: {
  mandate: Mandate; onChain: boolean; exists: boolean; busy: boolean; onSave: (input: MandateInput) => Promise<void>
}) {
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = mandateInputSchema.safeParse({
      maxAmount: form.get('maxAmount'), assetType: form.get('assetType'), marketplace: form.get('marketplace'),
      requireVerifiedSeller: form.has('seller'), autonomy: form.has('autonomy'),
    })
    if (!value.success) { setError('Use a positive integer number of lamports within the u64 range.'); return }
    setError(''); await onSave(value.data)
  }
  return <div className="settings-page">
    <span className="eyeline">YOUR RULES COME FIRST</span><h1>Define your<br/><em>boundaries.</em></h1>
    <p className="muted">{onChain ? 'Phantom signs every change. The confirmed program account is your mandate.' : 'Demo boundaries apply only to this browser session.'}</p>
    <form className="mandate-form" onSubmit={submit} key={mandate.version + ':' + onChain}>
      <fieldset disabled={busy}>
        <label>Maximum value (integer lamports)<input name="maxAmount" inputMode="numeric" pattern="[1-9][0-9]{0,19}" defaultValue={mandate.maxAmount} required/><small>1 Devnet SOL = 1,000,000,000 lamports. Test values only.</small></label>
        <label>Asset type<select name="assetType" defaultValue={mandate.assetType}><option value="NFT">NFT demo</option><option value="RWA">RWA · read-only (never authorized)</option></select></label>
        <label>Allowed marketplace<select name="marketplace" defaultValue={mandate.marketplace}><option value="DEMO_MARKET">Demo Market</option><option value="DEMO_GALLERY">Demo Gallery</option></select></label>
        <label className="toggle-row"><span><strong>Require seller evidence claim</strong><small>Checks the adapter claim; does not verify the seller.</small></span><input name="seller" type="checkbox" defaultChecked={mandate.requireVerifiedSeller}/></label>
        <label className="toggle-row"><span><strong>Autonomous authorization</strong><small>Enable rule-based approval. You still sign each instruction in Phantom.</small></span><input name="autonomy" type="checkbox" defaultChecked={mandate.autonomy}/></label>
        <button className="primary" type="submit">{busy ? 'Awaiting confirmation…' : onChain ? (exists ? 'Sign mandate update ↗' : 'Create mandate with Phantom ↗') : 'Save demo boundaries ↗'}</button>
      </fieldset>
    </form>{error && <p className="error-text" role="alert">{error}</p>}
  </div>
}

import { useState, type FormEvent } from 'react'
import { twinPreferencesSchema, type CommerceTwin, type TwinPreferences } from '@gobuy/shared'

export function CommerceTwinPanel({ twin, busy, onSave }: { twin: CommerceTwin | null; busy: boolean; onSave: (preferences: TwinPreferences) => Promise<void> }) {
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setSaved(false)
    const form = new FormData(event.currentTarget)
    try {
      const premium = form.get('premium') as string
      const optionalNumber = (key: string) => form.get(key) === '' ? undefined : Number(form.get(key))
      const optionalText = (key: string) => String(form.get(key) ?? '').trim() || undefined
      const list = (key: string) => optionalText(key)?.split(',').map(value => value.trim()).filter(Boolean)
      await onSave(twinPreferencesSchema.parse({
        ...twin?.explicit,
        sellerReputationImportance: form.get('seller') || undefined, priceSensitivity: form.get('price') || undefined,
        acceptHigherPriceForTrustedSeller: premium === '' ? undefined : Number(premium) / 100,
        authentic: form.get('authentic') === '' ? undefined : form.get('authentic') === 'true',
        // Clear legacy defaults. A maximum belongs to one request, never this profile.
        maxPrice: undefined, currency: undefined,
        condition: optionalText('condition'), shippingCountry: optionalText('shippingCountry')?.toUpperCase(),
        minSellerTrust: optionalNumber('minSellerTrust'), preferredBrands: list('brands'), preferredStores: list('stores'),
      }))
      setSaved(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save preferences.') }
  }
  return <section className="twin-panel"><h2>Your Commerce Twin</h2>
    <p className="muted">Research preferences and the latest 200 decisions are saved for this browser. Explicit settings override learned preferences. Wallet connection does not change this anonymous profile.</p>
    {!twin ? <p>Commerce Twin is unavailable. Check the research API.</p> : <>
      <form className="mandate-form" onSubmit={submit} key={JSON.stringify(twin.explicit)}><fieldset disabled={busy}>
        <label>Seller reputation importance<select name="seller" defaultValue={twin.explicit.sellerReputationImportance ?? ''}><option value="">Learn from decisions (default: medium)</option>{['low', 'medium', 'high'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Price sensitivity<select name="price" defaultValue={twin.explicit.priceSensitivity ?? ''}><option value="">Learn from decisions (default: medium)</option>{['low', 'medium', 'high'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Preferred premium for a trusted seller (%)<input name="premium" type="number" min="0" max="20" step="0.1" placeholder="Learn from decisions" defaultValue={twin.explicit.acceptHigherPriceForTrustedSeller === undefined ? '' : twin.explicit.acceptHigherPriceForTrustedSeller * 100}/><small>This compares sellers and never increases your stated maximum budget.</small></label>
        <label>Authenticity preference<select name="authentic" defaultValue={twin.explicit.authentic === undefined ? '' : String(twin.explicit.authentic)}><option value="">Use each request</option><option value="true">Require strong authenticity evidence</option><option value="false">No standing preference</option></select></label>
        <p>Set a budget in each shopping request. Budgets are not saved as profile defaults.</p>
        <label>Required condition<select name="condition" defaultValue={twin.explicit.condition ?? ''}><option value="">Use each request</option>{['New', 'Used', 'Refurbished'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Shipping country code<input name="shippingCountry" maxLength={2} placeholder="VN, US" defaultValue={twin.explicit.shippingCountry ?? ''}/></label>
        <label>Minimum seller evidence score<input name="minSellerTrust" type="number" min="0" max="100" defaultValue={twin.explicit.minSellerTrust ?? ''}/><small>Listings below this score cannot be selected. Missing evidence earns no points.</small></label>
        <label>Preferred brands (comma separated)<input name="brands" defaultValue={twin.explicit.preferredBrands?.join(', ') ?? ''}/></label>
        <label>Preferred stores (comma separated)<input name="stores" defaultValue={twin.explicit.preferredStores?.join(', ') ?? ''}/></label>
        <button className="primary" type="submit">Save research preferences</button>
      </fieldset></form>
      {saved && <p className="decision-notice">Research preferences saved.</p>}
      <p className="muted">Effective preferences: seller reputation {twin.effective.sellerReputationImportance}; price sensitivity {twin.effective.priceSensitivity}; trusted seller premium up to {Math.round((twin.effective.acceptHigherPriceForTrustedSeller ?? 0) * 1000) / 10}%.</p>
      <ul className="muted">{twin.learningReasons.length ? twin.learningReasons.map(reason => <li key={reason}>{reason}</li>) : <li>No learned changes yet. Rules need at least three relevant decisions about real items.</li>}</ul>
      <p className="muted">Autonomy boundary: user approval and the existing signed mandate are required. Research cannot authorize a purchase. Mock decisions are recorded but excluded from learned preferences.</p>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>
}

export function ResearchHistory({ twin }: { twin: CommerceTwin | null }) {
  return <section className="twin-panel"><h2>Research decisions</h2><p className="muted">Preference history for this browser. These are not on-chain verdicts or purchases.</p>
    {!twin?.history.length ? <p className="muted">No research decisions saved.</p> : <div className="audit-list">{twin.history.map(decision => <article key={decision.id}>
      <strong>{decision.outcome === 'approve' ? 'Approval preference' : 'Rejected recommendation'} · {decision.item.mode === 'mock' ? 'MOCK DATA' : decision.item.source}</strong>
      <p>{decision.item.title}<br/>{new Date(decision.at).toLocaleString()}{decision.reason && ` · ${decision.reason}`}</p>
      <a href={decision.item.productUrl} target="_blank" rel="noopener noreferrer">View source ↗</a>
    </article>)}</div>}
  </section>
}

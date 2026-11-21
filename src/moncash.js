// ═══════════════════════════════════════════════════════════════════════════
//  MonCash (Digicel) — intégration serveur.
//  Porté depuis BackendDealPam (NestJS) vers ESM. Flux : token OAuth →
//  CreatePayment (redirection) → vérification par orderId/transactionId.
//
//  Config (backend/.env de la console) :
//    MONCASH_MODE=sandbox|live
//    MONCASH_CLIENT_ID=…          ← clé MonCash Business (jamais commitée)
//    MONCASH_CLIENT_SECRET=…
//    MONCASH_RETURN_URL=https://console…/pay/retour   (page où MonCash renvoie le client)
//
//  `fetchImpl` est injectable pour les tests (simuler MonCash sans réseau).
// ═══════════════════════════════════════════════════════════════════════════

const TIMEOUT = 8000

function hosts(mode) {
  const live = mode === 'live'
  return {
    api: live ? 'https://moncashbutton.digicelgroup.com/Api' : 'https://sandbox.moncashbutton.digicelgroup.com/Api',
    gateway: live ? 'https://moncashbutton.digicelgroup.com/Moncash-middleware' : 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware'
  }
}

export function makeMoncash(opts = {}) {
  const cfg = {
    mode: opts.mode || process.env.MONCASH_MODE || 'sandbox',
    clientId: opts.clientId || process.env.MONCASH_CLIENT_ID || '',
    clientSecret: opts.clientSecret || process.env.MONCASH_CLIENT_SECRET || '',
    payoutEnabled: String(opts.payoutEnabled ?? process.env.MONCASH_PAYOUT_ENABLED ?? 'false') === 'true'
  }
  const H = hosts(cfg.mode)
  const doFetch = opts.fetchImpl || globalThis.fetch
  let token = null, tokenExp = 0

  const configured = () => !!(cfg.clientId && cfg.clientSecret)

  async function f(url, options) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT)
    try { return await doFetch(url, { ...options, signal: ctrl.signal }) }
    catch (e) { if (e.name === 'AbortError') throw new Error('MonCash ne répond pas (timeout)'); throw e }
    finally { clearTimeout(t) }
  }

  async function getToken() {
    if (token && Date.now() < tokenExp) return token
    if (!configured()) throw Object.assign(new Error('MonCash non configuré (MONCASH_CLIENT_ID / SECRET)'), { code: 'MONCASH_OFF' })
    const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
    const res = await f(`${H.api}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'scope=read,write&grant_type=client_credentials'
    })
    if (!res.ok) throw new Error(`MonCash token ${res.status}: ${await res.text()}`)
    const data = await res.json()
    token = data.access_token; tokenExp = Date.now() + 49000
    return token
  }

  // orderId = identifiant interne (ici : id du paiement en base)
  async function createPayment(amount, orderId) {
    const tk = await getToken()
    const res = await f(`${H.api}/v1/CreatePayment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, orderId: String(orderId) })
    })
    if (!res.ok) throw new Error(`MonCash CreatePayment ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const paymentToken = data.payment_token.token
    return { redirectUrl: `${H.gateway}/Payment/Redirect?token=${paymentToken}`, paymentToken }
  }

  async function retrieve(path, body) {
    const tk = await getToken()
    const res = await f(`${H.api}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`MonCash ${path} ${res.status}: ${await res.text()}`)
    return (await res.json()).payment   // { reference, transaction_id, cost, message, payer }
  }
  const verifyByOrderId = orderId => retrieve('/v1/RetrieveOrderPayment', { orderId: String(orderId) })
  const verifyByTransactionId = transactionId => retrieve('/v1/RetrieveTransactionPayment', { transactionId })

  return { configured, getToken, createPayment, verifyByOrderId, verifyByTransactionId, mode: cfg.mode }
}

// Instance par défaut (lit l'environnement)
export const moncash = makeMoncash()

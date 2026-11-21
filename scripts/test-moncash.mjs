// Test MonCash : (1) portage du service avec fetch simulé ; (2) confirmation auto.
process.env.SAAS_DB_DIR = 'memory://mc'
process.env.NODE_ENV = 'test'
process.env.PRICE_1Y = '15000'

import { ensureSchema } from '../src/db.js'
import * as core from '../src/core.js'
import { makeMoncash } from '../src/moncash.js'
import { checkLicense } from '../shared/license.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const pub = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'keys', 'license-public.pem'), 'utf8')

let pass = 0, fail = 0
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ ÉCHEC:', n)) }

console.log('\n1) Portage du service (fetch simulé, aucune vraie clé)')
const calls = []
const fakeFetch = async (url, opt) => {
  calls.push({ url, auth: opt.headers.Authorization, body: opt.body })
  if (url.endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'TOK123' }) }
  if (url.endsWith('/v1/CreatePayment')) return { ok: true, status: 200, json: async () => ({ payment_token: { token: 'PT999' } }) }
  if (url.endsWith('/v1/RetrieveOrderPayment')) return { ok: true, status: 200, json: async () => ({ payment: { reference: '1', transaction_id: 'TX1', cost: 15000, message: 'successful', payer: '50912345678' } }) }
  return { ok: false, status: 500, text: async () => 'x' }
}
const mc = makeMoncash({ mode: 'sandbox', clientId: 'cid', clientSecret: 'csecret', fetchImpl: fakeFetch })
const tok = await mc.getToken()
ok('token récupéré', tok === 'TOK123')
ok('auth Basic = base64(cid:csecret)', calls[0].auth === 'Basic ' + Buffer.from('cid:csecret').toString('base64'))
const cp = await mc.createPayment(15000, 'order-1')
ok('redirectUrl sandbox + token', cp.redirectUrl === 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware/Payment/Redirect?token=PT999')
const v = await mc.verifyByOrderId('order-1')
ok('vérif renvoie le paiement', v.transaction_id === 'TX1' && /success/i.test(v.message))

console.log('\n2) Mode live → hôtes de production')
const live = makeMoncash({ mode: 'live', clientId: 'a', clientSecret: 'b', fetchImpl: async u => { calls.push({ url: u }); return { ok: true, status: 200, json: async () => ({ access_token: 't' }) } } })
await live.getToken()
ok('token appelé sur moncashbutton (live)', calls.at(-1).url.startsWith('https://moncashbutton.digicelgroup.com/Api'))

console.log('\n3) Confirmation automatique de bout en bout')
await ensureSchema()
const clinic = await core.createClinic({ name: 'Cab MonCash', email: 'mc@x.ht', seats: 1 })
// injecter un MonCash contrôlé par un état
let paid = false
core._setMoncash({
  createPayment: async (amount, orderId) => ({ redirectUrl: 'https://gw/Redirect?token=TK' + orderId, paymentToken: 'TK' + orderId }),
  verifyByOrderId: async () => paid ? { reference: '1', transaction_id: 'TXZ', cost: 15000, message: 'successful', payer: '509' } : null
})
const init = await core.initiateMoncash({ clinic_id: clinic.id, plan: '1y' })
ok('initiation : URL de redirection', /Redirect\?token=/.test(init.redirectUrl))
ok('montant = prix 1 an (15000)', init.amount === 15000)
const before = await core.verifyMoncash(init.payment_id)
ok('avant paiement : pending', before.status === 'pending')
paid = true
const after = await core.verifyMoncash(init.payment_id)
ok('après paiement : confirmed', after.status === 'confirmed')
const d = await core.getClinic(clinic.id)
ok('clinique passe active', d.clinic.status === 'active')
ok('abonnement 1 an ouvert', d.subscription.plan === '1y')
// l'hôte peut maintenant s'activer et obtenir une clé valable 1 an
const act = await core.activate({ code: clinic.activation_code, fingerprint: 'fp1' })
const lic = checkLicense(pub, act.token, { machineId: 'fp1' })
ok('clé active, plan 1 an', lic.status === 'active' && lic.payload.plan === '1y')

console.log(`\nRÉSULTAT : ${pass} réussis, ${fail} échoués\n`)
process.exit(fail ? 1 : 0)

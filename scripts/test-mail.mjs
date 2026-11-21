// Test du système d'email + entretien (fetch Resend simulé).
process.env.SAAS_DB_DIR = 'memory://mail'
process.env.NODE_ENV = 'test'
process.env.RESEND_API_KEY = 'test-key'
process.env.VITRINE_URL = 'https://dental-light.app'
process.env.MAIL_SUPPORT = 'support@dental-light.app'

import { ensureSchema, q } from '../src/db.js'
import * as core from '../src/core.js'
import { _setFetch } from '../src/mail.js'

const sent = []
_setFetch(async (url, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, text: async () => '' } })

let pass = 0, fail = 0
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ ÉCHEC:', n)) }
const lastTo = to => [...sent].reverse().find(m => m.to === to)
const sleep = ms => new Promise(r => setTimeout(r, ms))

await ensureSchema()

console.log('\n1) Création clinique → e-mail de bienvenue (code + étapes) + alerte équipe')
const c = await core.createClinic({ name: 'Cabinet Soleil', email: 'soleil@x.ht', seats: 2 })
await sleep(30)
const welcome = sent.find(m => m.to === 'soleil@x.ht')
ok('e-mail de bienvenue envoyé', !!welcome)
ok('personnalisé (nom de la clinique)', /Cabinet Soleil/.test(welcome.html))
ok('contient le code d’activation', welcome.html.includes(c.activation_code))
ok('sujet avec le code', welcome.subject.includes(c.activation_code))
ok('lien de téléchargement présent', /dental-light\.app/.test(welcome.html))
ok('alerte équipe envoyée', sent.some(m => /\[DENTAL\]/.test(m.subject)))

console.log('\n2) Paiement confirmé → reçu par e-mail')
const pay = await core.createPayment({ clinic_id: c.id, method: 'virement', plan: '1y', amount: 15000, currency: 'HTG', reference: 'VIR1' })
await core.confirmPayment(pay.id, 'admin@dl.ht'); await sleep(30)
const receipt = lastTo('soleil@x.ht')
ok('e-mail de paiement envoyé', /Paiement confirmé/.test(receipt.subject))
ok('montant présent', /15[\s  ]?000/.test(receipt.html))
ok('formule 1 an', /1 an/.test(receipt.html))

console.log('\n3) Suspension → e-mail « données conservées 90 jours » + rétention en base')
const r = await core.revokeClinic(c.id, 'impayé', 'admin@dl.ht'); await sleep(30)
const blk = lastTo('soleil@x.ht')
ok('e-mail de blocage envoyé', /suspendu/i.test(blk.subject))
ok('message « données conservées »', /conserv/i.test(blk.html))
ok('rétention ~90 jours en base', (() => { const d = Math.round((new Date(r.retention_until) - Date.now()) / 86400000); return d >= 89 && d <= 91 })())

console.log('\n4) Entretien : rappel d’expiration (clinique à 2 jours de l’échéance)')
const c2 = await core.createClinic({ name: 'Cab Expire', email: 'exp@x.ht', seats: 1 })
await q("update saas.subscriptions set period_end = now() + interval '2 days' where clinic_id=$1", [c2.id])
sent.length = 0
const m = await core.runMaintenance(); await sleep(30)
const remind = sent.find(s => s.to === 'exp@x.ht')
ok('rappel envoyé', !!remind && /expire/i.test(remind.subject))
ok('indique les jours restants', /2 jour/.test(remind.html) || /2 jour/.test(remind.subject))

console.log(`\nRÉSULTAT : ${pass} réussis, ${fail} échoués\n`)
process.exit(fail ? 1 : 0)

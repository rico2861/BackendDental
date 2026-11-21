// Test de bout en bout de la logique de la console (sans HTTP).
process.env.SAAS_DB_DIR = 'memory://test'
process.env.NODE_ENV = 'test'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ensureSchema } from '../src/db.js'
import * as core from '../src/core.js'
import { checkLicense } from '../shared/license.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pub = fs.readFileSync(path.join(here, '..', 'keys', 'license-public.pem'), 'utf8')
const lidOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).lid

let pass = 0, fail = 0
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ ÉCHEC:', n)) }

await ensureSchema()

console.log('\n1) Création clinique → essai 15 jours')
const clinic = await core.createClinic({ name: 'Cabinet Soleil', email: 'soleil@clinique.ht', seats: 2 })
ok('id sûr pour schéma (clinic_' + clinic.id + ')', /^[a-z0-9]{4,20}$/.test(clinic.id))
ok('code d\'activation généré', !!clinic.activation_code)
ok('statut trial', clinic.status === 'trial')

console.log('\n2) Activation du 1er poste avec le code')
const a1 = await core.activate({ code: clinic.activation_code, fingerprint: 'fp-A', hostname: 'PC-Accueil' })
const c1 = checkLicense(pub, a1.token, { machineId: 'fp-A' })
ok('clé valide et active', c1.status === 'active')
ok('plan = trial', c1.payload.plan === 'trial')
ok('expire ~15 j', Math.round((new Date(c1.payload.exp) - new Date(c1.payload.iss)) / 86400000) === 15)
ok('marque renvoyée (nom)', a1.brand.name === 'Cabinet Soleil')

console.log('\n3) 2e poste OK (2 sièges), 3e poste refusé')
const a2 = await core.activate({ code: clinic.activation_code, fingerprint: 'fp-B', hostname: 'PC-Cabinet' })
ok('2e poste activé', checkLicense(pub, a2.token, { machineId: 'fp-B' }).status === 'active')
let noSeat = false; try { await core.activate({ code: clinic.activation_code, fingerprint: 'fp-C' }) } catch (e) { noSeat = e.code === 'NO_SEATS' }
ok('3e poste refusé (sièges pleins)', noSeat)
ok('réactivation du poste A ne consomme pas de siège', !!(await core.activate({ code: clinic.activation_code, fingerprint: 'fp-A' })).token)

console.log('\n4) Révocation à distance du poste A')
const lidA = lidOf(a1.token)
ok('check avant révocation : non révoquée', (await core.check({ lid: lidA, fingerprint: 'fp-A' })).revoked === false)
await core.revokeLicense(lidA, 'test', 'admin@dl.ht')
ok('check après révocation : revoked=true', (await core.check({ lid: lidA, fingerprint: 'fp-A' })).revoked === true)

console.log('\n5) Paiement 1 an confirmé → abonnement actif + prolongation')
const pay = await core.createPayment({ clinic_id: clinic.id, method: 'virement', plan: '1y', amount: 15000, currency: 'HTG', reference: 'VIR-123' })
ok('paiement en attente', pay.status === 'pending')
await core.confirmPayment(pay.id, 'admin@dl.ht')
const after = await core.getClinic(clinic.id)
ok('clinique passe active', after.clinic.status === 'active')
ok('abonnement 1 an', after.subscription.plan === '1y')
// poste B interroge → reçoit une clé prolongée
const lidB = lidOf(a2.token)
const chk = await core.check({ lid: lidB, fingerprint: 'fp-B' })
ok('check renvoie une clé prolongée', !!chk.token)
const cB = checkLicense(pub, chk.token, { machineId: 'fp-B' })
ok('nouvelle clé = 1 an, active', cB.status === 'active' && cB.payload.plan === '1y')

console.log('\n6) Sauvegarde + vue globale')
await core.recordBackup({ clinic_id: clinic.id, fingerprint: 'fp-A', size_bytes: 1048576, sha256: 'abc', verified: true, location: 'supabase:clinic_' + clinic.id })
ok('sauvegarde enregistrée', (await core.listBackups()).length === 1)
const ov = await core.overview()
ok('vue globale : 1 clinique', ov.counts.total === 1)
ok('vue globale : hôtes actifs comptés', ov.counts.hosts >= 2)
ok('vue globale : revenus confirmés', ov.revenue.some(r => r.t === 15000))

console.log('\n7) Personnalisation + sièges')
await core.updateClinic(clinic.id, { brand_color: '#0d9488', display_name: 'Clinique Soleil', seats: 3 })
const upd = await core.getClinic(clinic.id)
ok('couleur enregistrée', upd.clinic.brand_color === '#0d9488')
ok('sièges portés à 3', upd.subscription.seats === 3)
ok('3e poste désormais activable', !!(await core.activate({ code: clinic.activation_code, fingerprint: 'fp-C' })).token)

console.log(`\nRÉSULTAT : ${pass} réussis, ${fail} échoués\n`)
process.exit(fail ? 1 : 0)

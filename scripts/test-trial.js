// Test : essai gratuit 15 jours + sièges (hôtes) + verrouillage par hôte.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { issueLicense, checkLicense, planLabel } from '../shared/license.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const priv = fs.readFileSync(path.join(dir, '..', 'keys', 'license-private.pem'), 'utf8')
const pub = fs.readFileSync(path.join(dir, '..', 'keys', 'license-public.pem'), 'utf8')

let pass = 0, fail = 0
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ ÉCHEC:', n)) }
const day = 86400000

console.log('\n1) Essai gratuit 15 jours pour une nouvelle clinique')
const trial = issueLicense(priv, { clinic_id: 'c7f3a9', clinic: 'Cabinet Soleil', plan: 'trial', machine_id: 'host-A', seats: 2 })
check('plan = trial', trial.payload.plan === 'trial')
check('marqué comme essai', trial.payload.trial === true)
check('expire dans ~15 jours', Math.round((new Date(trial.payload.exp) - new Date(trial.payload.iss)) / day) === 15)
check('libellé lisible', planLabel('trial') === 'essai 15 jours')
check('actif pendant l\'essai', checkLicense(pub, trial.token, { machineId: 'host-A', now: new Date() }).status === 'active')

console.log('\n2) Essai expiré + 4 jours → bloqué (auto, même hors ligne)')
const r2 = checkLicense(pub, trial.token, { machineId: 'host-A', now: new Date(new Date(trial.payload.exp).getTime() + 4 * day) })
check('statut = blocked', r2.status === 'blocked')

console.log('\n3) Sièges : 2 hôtes de la MÊME clinique, chacun sa clé')
const hostA = issueLicense(priv, { clinic_id: 'c7f3a9', clinic: 'Cabinet Soleil', plan: '1y', machine_id: 'host-A', seats: 2 })
const hostB = issueLicense(priv, { clinic_id: 'c7f3a9', clinic: 'Cabinet Soleil', plan: '1y', machine_id: 'host-B', seats: 2 })
check('même clinique (cid identique)', hostA.payload.cid === hostB.payload.cid)
check('clés différentes (lid différent)', hostA.payload.lid !== hostB.payload.lid)
check('chaque clé dit 2 sièges', hostA.payload.seats === 2 && hostB.payload.seats === 2)
check('hôte A valide sur A', checkLicense(pub, hostA.token, { machineId: 'host-A' }).status === 'active')
check('hôte A refusé sur B (chaque clé liée à son PC)', checkLicense(pub, hostA.token, { machineId: 'host-B' }).status === 'wrong_machine')
check('hôte B valide sur B', checkLicense(pub, hostB.token, { machineId: 'host-B' }).status === 'active')

console.log(`\nRÉSULTAT : ${pass} réussis, ${fail} échoués\n`)
process.exit(fail ? 1 : 0)

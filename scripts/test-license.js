// Test du moteur de licences : émission → vérification → machine → grâce → blocage.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { issueLicense, checkLicense } from '../shared/license.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const priv = fs.readFileSync(path.join(dir, '..', 'keys', 'license-private.pem'), 'utf8')
const pub = fs.readFileSync(path.join(dir, '..', 'keys', 'license-public.pem'), 'utf8')

let pass = 0, fail = 0
const check = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗ ÉCHEC:', name)) }

const MACHINE = 'abc123machine'
const OTHER = 'autreMachine99'
const day = 86400000

console.log('\n1) Licence 1 mois, verrouillée à la machine')
const { token, payload } = issueLicense(priv, { clinic_id: 'CLIN-001', clinic: 'Cabinet Soleil', plan: '1m', machine_id: MACHINE })
check('jeton émis au format DL1.…', token.startsWith('DL1.'))
check('licence unique (lid présent)', !!payload.lid)
check('expire ~30 jours plus tard', Math.round((new Date(payload.exp) - new Date(payload.iss)) / day) === 30)

console.log('\n2) Vérification sur la bonne machine, aujourd\'hui')
const now = new Date()
check('statut = active', checkLicense(pub, token, { machineId: MACHINE, now }).status === 'active')

console.log('\n3) Même licence sur une AUTRE machine (anti-copie)')
check('statut = wrong_machine', checkLicense(pub, token, { machineId: OTHER, now }).status === 'wrong_machine')

console.log('\n4) Jeton falsifié (un caractère changé)')
const tampered = token.slice(0, -3) + (token.slice(-3) === 'AAA' ? 'BBB' : 'AAA')
check('statut = invalid (signature)', checkLicense(pub, tampered, { machineId: MACHINE, now }).status === 'invalid')

console.log('\n5) Abonnement expiré depuis 1 jour → période de grâce (3 j)')
const r5 = checkLicense(pub, token, { machineId: MACHINE, now: new Date(new Date(payload.exp).getTime() + 1 * day) })
check('statut = grace', r5.status === 'grace')
check('il reste 2 jours de grâce', r5.grace_days_left === 2)

console.log('\n6) Expiré depuis 4 jours (au-delà des 3 j) → bloqué')
const r6 = checkLicense(pub, token, { machineId: MACHINE, now: new Date(new Date(payload.exp).getTime() + 4 * day) })
check('statut = blocked', r6.status === 'blocked')

console.log('\n7) Nouvelle clé après paiement → débloque pour la durée payée')
const renew = issueLicense(priv, { clinic_id: 'CLIN-001', clinic: 'Cabinet Soleil', plan: '1y', machine_id: MACHINE })
check('nouvelle licence = active', checkLicense(pub, renew.token, { machineId: MACHINE, now: new Date() }).status === 'active')
check('nouvelle licence ≠ ancienne (lid différent)', renew.payload.lid !== payload.lid)
check('formule 1 an ≈ 365 jours', Math.round((new Date(renew.payload.exp) - new Date(renew.payload.iss)) / day) === 365)

console.log(`\nRÉSULTAT : ${pass} réussis, ${fail} échoués\n`)
console.log('Exemple de clé (début) :', token.slice(0, 60) + '…', '\nLongueur totale :', token.length, 'caractères (livré en fichier licence.key)')
process.exit(fail ? 1 : 0)

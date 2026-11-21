// ═══════════════════════════════════════════════════════════════════════════
//  Génère LA paire de clés du SaaS (à lancer UNE SEULE FOIS).
//
//    node saas/scripts/keygen.js
//
//  • saas/keys/license-private.pem  → RESTE SUR LE SERVEUR SaaS. Jamais livrée,
//    jamais dans Git, jamais dans l'.exe. Qui l'a peut créer des licences.
//  • saas/keys/license-public.pem   → à embarquer dans l'app Dental (sert
//    uniquement à vérifier). Peut être public sans danger.
//
//  Si les clés existent déjà, le script refuse d'écraser (sauf --force) :
//  régénérer la paire invaliderait TOUTES les licences déjà émises.
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'keys')
const priv = path.join(dir, 'license-private.pem')
const pub = path.join(dir, 'license-public.pem')
const force = process.argv.includes('--force')

fs.mkdirSync(dir, { recursive: true })
if ((fs.existsSync(priv) || fs.existsSync(pub)) && !force) {
  console.error('⚠  Des clés existent déjà dans saas/keys/.')
  console.error('   Régénérer invaliderait toutes les licences émises. Utilisez --force si vous êtes sûr.')
  process.exit(1)
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }))
fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }))
try { fs.chmodSync(priv, 0o600) } catch {}

console.log('✓ Paire de clés générée dans saas/keys/')
console.log('  • license-private.pem  — SECRET, à garder sur le serveur SaaS uniquement')
console.log('  • license-public.pem   — à copier dans l\'app Dental (vérification)')
console.log('\n⚠  Sauvegardez license-private.pem en lieu sûr : sans elle, impossible d\'émettre de nouvelles licences.')

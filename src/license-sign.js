// Émission de jetons signés côté serveur (charge la clé privée une fois).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { issueLicense } from '../shared/license.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PRIV = null
function privateKey() {
  if (PRIV) return PRIV
  PRIV = process.env.LICENSE_PRIVATE_KEY
    ? process.env.LICENSE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : fs.readFileSync(path.join(ROOT, 'keys', 'license-private.pem'), 'utf8')
  return PRIV
}

// data = { clinic_id, clinic, plan, machine_id, seats, expires_at }
export function sign(data) { return issueLicense(privateKey(), data) }   // → { token, payload }

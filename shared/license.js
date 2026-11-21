// ═══════════════════════════════════════════════════════════════════════════
//  DENTAL LIGHT — Moteur de licences (signature Ed25519, 100 % hors ligne)
// ═══════════════════════════════════════════════════════════════════════════
//
//  Une licence est un JETON SIGNÉ. Il contient tout ce qu'il faut (clinique,
//  formule, dates, machine) et porte une signature cryptographique.
//
//  • La CLÉ PRIVÉE reste sur le serveur SaaS (jamais livrée). Elle seule peut
//    créer une licence valable → impossible à falsifier.
//  • La CLÉ PUBLIQUE est embarquée dans l'app Dental. Elle sert uniquement à
//    VÉRIFIER la signature. L'app n'a donc JAMAIS besoin d'Internet pour lire
//    une licence : tout se vérifie localement.
//
//  Format du jeton :  DL1.<payload base64url>.<signature base64url>
//
//  Ce fichier est PARTAGÉ : la console SaaS l'importe pour émettre, l'app
//  Dental l'importe pour vérifier. Aucune dépendance externe (crypto natif).
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto'
import os from 'os'
import fs from 'fs'
import path from 'path'

const MAGIC = 'DL1'
const GRACE_DEFAULT = 3            // jours de grâce après expiration (modifiable par licence)
const PLAN_DAYS = { 'trial': 15, '1m': 30, '1y': 365 }   // 'trial' = essai gratuit 15 jours (toute nouvelle clinique)

const b64u = buf => Buffer.from(buf).toString('base64url')
const unb64u = str => Buffer.from(str, 'base64url')

// ─── Émission d'un JETON D'ACTIVATION (serveur SaaS, avec la clé privée) ──────
// Un jeton est émis POUR UN HÔTE précis (machine_id) d'une clinique, au moment
// où cet hôte s'active en ligne. Une clinique a droit à `seats` hôtes : chaque
// activation consomme un siège, contrôlé côté serveur (voir la base SaaS).
// data = { clinic_id, clinic, plan:'trial'|'1m'|'1y', machine_id, seats?,
//          issued_at?, expires_at?, grace? }
// Si expires_at n'est pas fourni, il est calculé depuis issued_at + durée de la formule.
export function issueLicense(privateKeyPem, data) {
  if (!data.clinic_id) throw new Error('clinic_id requis')
  if (!PLAN_DAYS[data.plan]) throw new Error('plan invalide (attendu trial, 1m ou 1y)')

  const issued = data.issued_at ? new Date(data.issued_at) : new Date()
  const expires = data.expires_at
    ? new Date(data.expires_at)
    : new Date(issued.getTime() + PLAN_DAYS[data.plan] * 86400000)

  const payload = {
    v: 1,
    lid: data.license_id || crypto.randomUUID(),  // identifiant unique de CETTE licence (pour la révocation)
    cid: String(data.clinic_id),                  // à quelle clinique elle appartient
    clinic: data.clinic || '',                    // nom affiché
    plan: data.plan,                              // 'trial' | '1m' | '1y'
    trial: data.plan === 'trial',                 // essai gratuit ?
    seats: Math.max(1, parseInt(data.seats) || 1),// nombre d'hôtes autorisés pour la clinique
    mid: data.machine_id || null,                 // hôte verrouillé (null = non verrouillée)
    iss: issued.toISOString(),
    exp: expires.toISOString(),
    grace: Number.isFinite(data.grace) ? data.grace : GRACE_DEFAULT
  }

  const body = b64u(JSON.stringify(payload))
  const sig = b64u(crypto.sign(null, Buffer.from(body), privateKeyPem))
  return { token: `${MAGIC}.${body}.${sig}`, payload }
}

// ─── Lecture + vérification de signature (app Dental, avec la clé publique) ───
export function readLicense(publicKeyPem, token) {
  if (typeof token !== 'string') return { ok: false, reason: 'format' }
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[0] !== MAGIC) return { ok: false, reason: 'format' }
  const [, body, sig] = parts
  let valid = false
  try { valid = crypto.verify(null, Buffer.from(body), publicKeyPem, unb64u(sig)) } catch { valid = false }
  if (!valid) return { ok: false, reason: 'signature' }          // falsifiée ou mauvaise clé
  let payload
  try { payload = JSON.parse(unb64u(body).toString('utf8')) } catch { return { ok: false, reason: 'corrompue' } }
  return { ok: true, payload }
}

// ─── État complet de la licence (signature + machine + dates + grâce) ─────────
// Retourne un statut : 'active' | 'grace' | 'blocked' | 'wrong_machine' | 'invalid'
export function checkLicense(publicKeyPem, token, { machineId = null, now = new Date() } = {}) {
  const r = readLicense(publicKeyPem, token)
  if (!r.ok) return { status: 'invalid', reason: r.reason }
  const p = r.payload

  // Verrouillage machine : si la licence est liée à une machine, elle doit correspondre.
  if (p.mid && machineId && p.mid !== machineId) return { status: 'wrong_machine', payload: p }

  const exp = new Date(p.exp)
  const graceDays = Number.isFinite(p.grace) ? p.grace : GRACE_DEFAULT
  const graceEnd = new Date(exp.getTime() + graceDays * 86400000)
  const day = 86400000

  if (now <= exp)
    return { status: 'active', payload: p, days_left: Math.ceil((exp - now) / day) }
  if (now <= graceEnd)
    return { status: 'grace', payload: p, grace_days_left: Math.ceil((graceEnd - now) / day) }
  return { status: 'blocked', payload: p }
}

// ─── Empreinte de la machine (verrouillage anti-copie) ───────────────────────
// Combine des attributs matériels stables + un identifiant d'installation
// persistant. Copier le dossier de données sur un AUTRE PC change l'empreinte
// matérielle → la licence n'y fonctionne pas.
export function machineFingerprint(dataDir) {
  // 1) Partie matérielle : hostname + 1ʳᵉ adresse MAC physique + plateforme
  const nets = os.networkInterfaces()
  const mac = Object.values(nets).flat()
    .filter(n => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
    .map(n => n.mac).sort()[0] || ''
  const hw = [os.hostname(), mac, os.platform(), os.arch()].join('|')

  // 2) Identifiant d'installation : UUID aléatoire écrit une seule fois sur ce poste.
  let installId = ''
  if (dataDir) {
    try {
      const f = path.join(dataDir, 'machine.id')
      if (fs.existsSync(f)) installId = fs.readFileSync(f, 'utf8').trim()
      else { installId = crypto.randomUUID(); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, installId) }
    } catch { /* lecture seule : on se contente de la partie matérielle */ }
  }

  return crypto.createHash('sha256').update(hw + '|' + installId).digest('hex').slice(0, 24)
}

// ─── Petit util pour afficher proprement ─────────────────────────────────────
export function planLabel(plan) { return plan === '1y' ? '1 an' : plan === '1m' ? '1 mois' : plan === 'trial' ? 'essai 15 jours' : plan }
export const LICENSE_MAGIC = MAGIC
export const PLAN_DURATIONS = PLAN_DAYS

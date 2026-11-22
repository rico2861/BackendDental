// Authentification de la console (comptes admin, session par cookie signé).
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { q } from './db.js'

const SECRET = () => process.env.SAAS_JWT_SECRET || 'dev-console-secret-change-me'
const COOKIE = 'dlsaas'

export async function ensureAdmin() {
  const n = (await q('select count(*)::int c from saas.admins')).rows[0].c
  if (n > 0) return
  const email = process.env.SAAS_ADMIN_EMAIL, pwd = process.env.SAAS_ADMIN_PASSWORD
  if (!email || !pwd) { console.log('⚠  Aucun admin. Définissez SAAS_ADMIN_EMAIL et SAAS_ADMIN_PASSWORD pour créer le compte propriétaire.'); return }
  await q('insert into saas.admins(email,password_hash,role) values ($1,$2,$3)', [email.toLowerCase(), bcrypt.hashSync(pwd, 10), 'owner'])
  console.log('✓ Compte admin créé :', email)
}

export async function login(email, password) {
  const a = (await q('select * from saas.admins where email=$1', [String(email || '').toLowerCase()])).rows[0]
  if (!a || !bcrypt.compareSync(String(password || ''), a.password_hash)) throw Object.assign(new Error('E-mail ou mot de passe incorrect'), { status: 401 })
  return jwt.sign({ id: a.id, email: a.email, role: a.role, jti: crypto.randomUUID() }, SECRET(), { expiresIn: '12h' })
}

export function setCookie(res, token) {
  // Console hébergée sur un autre domaine que le backend → SameSite=None + Secure.
  const crossSite = process.env.SAAS_CROSS_SITE === 'true'
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: crossSite ? 'none' : 'lax', secure: crossSite || process.env.NODE_ENV === 'production', maxAge: 12 * 3600000 })
}
export function clearCookie(res) { res.clearCookie(COOKIE) }

export function requireAdmin(req, res, next) {
  try { req.admin = jwt.verify(req.cookies?.[COOKIE] || '', SECRET()); next() }
  catch { res.status(401).json({ error: 'Non connecté', code: 'AUTH' }) }
}

// ─── Espace CLIENT (vitrine) : jeton porteur (Bearer), stocké côté vitrine. ──
// On évite les cookies cross-site : la vitrine envoie Authorization: Bearer <token>.
export function clientToken(clinic) {
  return jwt.sign({ cid: clinic.id, email: clinic.email, role: 'client', jti: crypto.randomUUID() }, SECRET(), { expiresIn: '30d' })
}
export function requireClient(req, res, next) {
  try {
    const h = req.headers.authorization || ''
    const t = h.startsWith('Bearer ') ? h.slice(7) : ''
    const p = jwt.verify(t, SECRET())
    if (p.role !== 'client') throw new Error('bad role')
    req.client = p; next()
  } catch { res.status(401).json({ error: 'Session expirée, reconnectez-vous.', code: 'AUTH' }) }
}

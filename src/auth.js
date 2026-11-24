// Authentification de la console (comptes admin, session par cookie signé).
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { q } from './db.js'

const SECRET = () => process.env.SAAS_JWT_SECRET || 'dev-console-secret-change-me'
const COOKIE = 'dlsaas'

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')

export async function ensureAdmin() {
  const n = (await q('select count(*)::int c from saas.admins')).rows[0].c
  if (n > 0) { await q('delete from saas.bootstrap').catch(() => {}); return }   // admin présent → plus d'amorçage
  // Aucun mot de passe en environnement : amorçage par code à usage unique uniquement,
  // affiché UNE fois dans les logs, stocké haché (jamais en clair).
  const row = (await q('select token_hash from saas.bootstrap where id=1')).rows[0]
  if (!row?.token_hash) {
    const token = 'BOOT-' + crypto.randomBytes(18).toString('base64url')
    await q('insert into saas.bootstrap(id,token_hash,created_at) values (1,$1,now()) on conflict (id) do update set token_hash=$1, created_at=now()', [sha(token)])
    console.log('\n────────────────────────────────────────────────────────────')
    console.log('  AUCUN ADMIN PLATEFORME — créez le compte propriétaire :')
    console.log('  POST /admin/api/bootstrap  { email, password, token }')
    console.log('  Code à usage unique (ne sera plus affiché) :', token)
    console.log('────────────────────────────────────────────────────────────\n')
  } else {
    console.log('⚠  Aucun admin. Un code d’amorçage a déjà été émis (voir un log de démarrage précédent). Redéployez pour en générer un nouveau.')
  }
}

// Crée le 1er administrateur (propriétaire) via le code d'amorçage. Mot de passe haché en base, jamais stocké en clair ni en environnement.
export async function bootstrapAdmin({ email, password, token } = {}) {
  const n = (await q('select count(*)::int c from saas.admins')).rows[0].c
  if (n > 0) throw Object.assign(new Error('Amorçage déjà effectué : un administrateur existe.'), { status: 403 })
  const row = (await q('select token_hash from saas.bootstrap where id=1')).rows[0]
  if (!row?.token_hash) throw Object.assign(new Error('Amorçage indisponible. Redéployez le service pour générer un nouveau code.'), { status: 403 })
  const a = Buffer.from(sha(token || '')), b = Buffer.from(row.token_hash)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Code d’amorçage invalide.'), { status: 401 })
  const e = String(email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw Object.assign(new Error('E-mail valide requis'), { status: 400 })
  if (String(password || '').length < 10) throw Object.assign(new Error('Mot de passe de 10 caractères minimum'), { status: 400 })
  await q('insert into saas.admins(email,password_hash,role) values ($1,$2,$3)', [e, bcrypt.hashSync(String(password), 12), 'owner'])
  await q('delete from saas.bootstrap')
  return { ok: true, email: e }
}

// ─── Durées de session (expiration par inactivité + plafond absolu) ──────────
const nowSec = () => Math.floor(Date.now() / 1000)
const IDLE_ADMIN = () => (Number(process.env.ADMIN_IDLE_MIN) || 30) * 60          // 30 min d'inactivité
const MAX_ADMIN = () => (Number(process.env.ADMIN_MAX_HOURS) || 12) * 3600        // plafond 12 h
const IDLE_CLIENT = () => (Number(process.env.CLIENT_IDLE_MIN) || 120) * 60       // 2 h d'inactivité
const MAX_CLIENT = () => (Number(process.env.CLIENT_MAX_DAYS) || 30) * 86400      // plafond 30 j

// Coupe-sessions global : toute session émise avant cette date est rejetée (cache 30 s).
let CUT = { v: 0, at: 0 }
async function cutoff() {
  if (Date.now() - CUT.at < 30000) return CUT.v
  try { const r = await q("select v from saas.kv where k='sessions_valid_after'"); CUT = { v: Number(r.rows[0]?.v || 0), at: Date.now() } } catch { CUT.at = Date.now() }
  return CUT.v
}
export async function revokeAllSessions() {
  const t = String(nowSec())
  await q("insert into saas.kv(k,v,updated_at) values ('sessions_valid_after',$1,now()) on conflict (k) do update set v=$1, updated_at=now()", [t])
  CUT = { v: Number(t), at: Date.now() }
  return { ok: true }
}
export function adminTokenFor(a) { return jwt.sign({ id: a.id, email: a.email, role: a.role, sat: nowSec(), jti: crypto.randomUUID() }, SECRET(), { expiresIn: IDLE_ADMIN() }) }

export async function login(email, password) {
  const a = (await q('select * from saas.admins where email=$1', [String(email || '').toLowerCase()])).rows[0]
  if (!a || !bcrypt.compareSync(String(password || ''), a.password_hash)) throw Object.assign(new Error('E-mail ou mot de passe incorrect'), { status: 401 })
  if (a.blocked) throw Object.assign(new Error('Compte administrateur bloqué. Contactez un propriétaire.'), { status: 403 })
  return adminTokenFor(a)
}

// Réservé aux propriétaires (gestion des administrateurs).
export function requireOwner(req, res, next) {
  if (req.admin?.role === 'owner') return next()
  res.status(403).json({ error: 'Action réservée aux propriétaires', code: 'FORBIDDEN' })
}

export function setCookie(res, token) {
  // Console hébergée sur un autre domaine que le backend → SameSite=None + Secure.
  const crossSite = process.env.SAAS_CROSS_SITE === 'true'
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: crossSite ? 'none' : 'lax', secure: crossSite || process.env.NODE_ENV === 'production', maxAge: IDLE_ADMIN() * 1000 })
}
export function clearCookie(res) { res.clearCookie(COOKIE) }

export async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || ''
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : ''
    const p = jwt.verify(bearer || req.cookies?.[COOKIE] || '', SECRET())
    const now = nowSec()
    if (p.sat && now - p.sat > MAX_ADMIN()) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.', code: 'AUTH' })
    if (p.iat && p.iat < await cutoff()) return res.status(401).json({ error: 'Session close, reconnectez-vous.', code: 'AUTH' })
    req.admin = p
    setCookie(res, jwt.sign({ id: p.id, email: p.email, role: p.role, sat: p.sat || now, jti: crypto.randomUUID() }, SECRET(), { expiresIn: IDLE_ADMIN() }))  // glissant
    next()
  } catch { res.status(401).json({ error: 'Non connecté', code: 'AUTH' }) }
}

// ─── Espace CLIENT (vitrine) : jeton porteur (Bearer), stocké côté vitrine. ──
// On évite les cookies cross-site : la vitrine envoie Authorization: Bearer <token>.
export function clientToken(clinic) {
  return jwt.sign({ cid: clinic.id, email: clinic.email, role: 'client', sat: nowSec(), jti: crypto.randomUUID() }, SECRET(), { expiresIn: IDLE_CLIENT() })
}
export async function requireClient(req, res, next) {
  try {
    const h = req.headers.authorization || ''
    const t = h.startsWith('Bearer ') ? h.slice(7) : ''
    const p = jwt.verify(t, SECRET())
    if (p.role !== 'client') throw new Error('bad role')
    const now = nowSec()
    if (p.sat && now - p.sat > MAX_CLIENT()) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.', code: 'AUTH' })
    if (p.iat && p.iat < await cutoff()) return res.status(401).json({ error: 'Session close, reconnectez-vous.', code: 'AUTH' })
    req.client = p
    res.set('X-DL-Token', jwt.sign({ cid: p.cid, email: p.email, role: 'client', sat: p.sat || now, jti: crypto.randomUUID() }, SECRET(), { expiresIn: IDLE_CLIENT() }))  // glissant
    next()
  } catch { res.status(401).json({ error: 'Session expirée, reconnectez-vous.', code: 'AUTH' }) }
}

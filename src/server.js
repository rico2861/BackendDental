// ═══════════════════════════════════════════════════════════════════════════
//  DENTAL — Console SaaS (serveur)
//  Sert : l'API d'administration (/admin/api/*, protégée) + le frontend admin,
//  ET les endpoints appelés par l'app Dental (/api/activate, /api/check).
// ═══════════════════════════════════════════════════════════════════════════

import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { ensureSchema, dbKind, q } from './db.js'
import { ensureAdmin, bootstrapAdmin, login, setCookie, clearCookie, requireAdmin, requireClient, requireOwner } from './auth.js'
import * as core from './core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SAAS_PORT || process.env.PORT) || 4000
const app = express()
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false }))
// JSON 256 Ko partout, sauf l'upload de preuve (image) qui accepte jusqu'à 12 Mo.
const bigJson = express.json({ limit: '12mb' })
const smallJson = express.json({ limit: '256kb' })
app.use((req, res, next) => req.path === '/api/account/pay/proof' ? bigJson(req, res, next) : smallJson(req, res, next))
app.use(cookieParser())

// ─── CORS (pour une vitrine / console hébergées séparément du backend) ───────
// CORS_ORIGINS = liste d'origines autorisées séparées par des virgules.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.message || 'Erreur serveur', code: e.code }))
const limiter = rateLimit({ windowMs: 60000, max: 120 })

// ─── Endpoints appelés par l'APP DENTALE (pas d'auth admin) ──────────────────
app.post('/api/activate', limiter, wrap(async (req, res) => res.json(await core.activate(req.body || {}))))
// Connexion par OTP : licence → code e-mail (10 min) → activation
app.post('/api/activate/request-otp', limiter, wrap(async (req, res) => res.json(await core.requestLoginOtp(req.body || {}))))
app.post('/api/activate/verify-otp', limiter, wrap(async (req, res) => res.json(await core.verifyLoginOtp(req.body || {}))))
app.post('/api/check', limiter, wrap(async (req, res) => res.json(await core.check(req.body || {}))))
app.post('/api/backups/report', limiter, wrap(async (req, res) => res.json(await core.recordBackup(req.body || {}))))
app.post('/api/relay-mail', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => res.json(await core.relayMail(req.body || {}))))
app.post('/api/resend-code', rateLimit({ windowMs: 60000, max: 8 }), wrap(async (req, res) => res.json(await core.resendCode((req.body || {}).email))))
// Inscription d'essai (utilisée plus tard par le site vitrine)
app.post('/api/signup', limiter, wrap(async (req, res) => {
  const c = await core.createClinic(req.body || {})
  res.json({ clinic_id: c.id, activation_code: c.activation_code, name: c.name, trial: true })
}))
app.get('/api/health', (req, res) => res.json({ status: 'ok' }))
app.get('/api/prices', (req, res) => res.json(core.prices()))

// ─── ESPACE CLIENT (vitrine) : compte → plan → paiement → licence ────────────
const authLimit = rateLimit({ windowMs: 60000, max: 20 })
app.post('/api/account/register', authLimit, wrap(async (req, res) => res.json(await core.registerAccount(req.body || {}))))
app.post('/api/account/login', authLimit, wrap(async (req, res) => res.json(await core.loginAccount(req.body?.email, req.body?.password))))
app.get('/api/account/me', requireClient, wrap(async (req, res) => res.json(await core.accountMe(req.client.cid))))
app.post('/api/account/plan', requireClient, wrap(async (req, res) => res.json(await core.choosePlan(req.client.cid, req.body?.plan))))
app.post('/api/account/provision-admin', requireClient, wrap(async (req, res) => res.json(await core.provisionAdmin(req.client.cid, req.body || {}))))
app.post('/api/account/pay/moncash', requireClient, wrap(async (req, res) => res.json(await core.initiateMoncash({ clinic_id: req.client.cid, plan: req.body?.plan }))))
app.get('/api/account/pay/verify', requireClient, wrap(async (req, res) => res.json(await core.verifyMoncash(req.query.payment_id))))
app.post('/api/account/pay/virement', requireClient, wrap(async (req, res) => res.json(await core.requestVirement(req.client.cid, req.body?.plan))))
app.post('/api/account/pay/proof', requireClient, wrap(async (req, res) => res.json(await core.uploadProof(req.client.cid, req.body?.payment_id, req.body || {}))))
app.get('/api/bank-accounts', wrap(async (req, res) => res.json(await core.listBankAccounts(true))))
// Paiement MonCash : la clinique initie → on renvoie l'URL de redirection MonCash
app.post('/api/pay/moncash', limiter, wrap(async (req, res) => res.json(await core.initiateMoncash(req.body || {}))))
// Page de retour : MonCash renvoie le client ici (orderId = id du paiement)
app.get('/pay/retour', wrap(async (req, res) => {
  const orderId = req.query.orderId || req.query.pid
  let r = { status: 'pending' }
  try { if (orderId) r = await core.verifyMoncash(orderId) } catch (e) { r = { status: 'error', message: e.message } }
  const ok = r.status === 'confirmed'
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Paiement MonCash</title><body style="font-family:system-ui;background:#eef1f5;display:grid;place-items:center;min-height:100vh;margin:0">
  <div style="background:#fff;border-radius:16px;padding:34px;max-width:400px;text-align:center;box-shadow:0 10px 40px rgba(16,40,80,.1)">
    <div style="font-size:42px">${ok ? '✅' : r.status === 'error' ? '⚠️' : '⏳'}</div>
    <h2 style="margin:10px 0 6px">${ok ? 'Paiement confirmé' : r.status === 'error' ? 'Erreur' : 'Paiement en attente'}</h2>
    <p style="color:#5b6675;font-size:14px">${ok ? 'Votre abonnement est activé. Votre clé de licence est disponible dans l\'application.' : r.message || 'Nous vérifions votre paiement, revenez dans un instant.'}</p>
  </div></body>`)
}))

// ─── Authentification de la console ──────────────────────────────────────────
// Amorçage du 1er admin (si aucun) : la console affiche un formulaire quand needs_bootstrap=true.
app.get('/admin/api/state', wrap(async (req, res) => {
  const n = (await q('select count(*)::int c from saas.admins')).rows[0].c
  res.json({ needs_bootstrap: n === 0 })
}))
app.post('/admin/api/bootstrap', rateLimit({ windowMs: 60000, max: 8 }), wrap(async (req, res) => {
  const r = await bootstrapAdmin(req.body || {})
  const token = await login(r.email, req.body?.password); setCookie(res, token)
  res.json({ ok: true, token, email: r.email })
}))
app.post('/admin/api/login', rateLimit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const token = await login(req.body?.email, req.body?.password); setCookie(res, token); res.json({ ok: true, token })
}))
app.post('/admin/api/logout', (req, res) => { clearCookie(res); res.json({ ok: true }) })
app.get('/admin/api/me', requireAdmin, (req, res) => res.json({ email: req.admin.email, role: req.admin.role }))

// ─── API d'administration (protégée) ─────────────────────────────────────────
const admin = express.Router()
admin.use(requireAdmin)
// Un admin bloqué perd l'accès immédiatement (contrôle en base à chaque requête).
admin.use((req, res, next) => core.assertAdminActive(req.admin.id).then(() => next()).catch(e => res.status(e.status || 403).json({ error: e.message, code: e.code })))
admin.get('/overview', wrap(async (req, res) => res.json(await core.overview())))
admin.get('/clinics', wrap(async (req, res) => res.json(await core.listClinics())))
admin.post('/clinics', wrap(async (req, res) => res.json(await core.createClinic(req.body || {}))))
admin.get('/clinics/:id', wrap(async (req, res) => res.json(await core.getClinic(req.params.id))))
admin.patch('/clinics/:id', wrap(async (req, res) => res.json(await core.updateClinic(req.params.id, req.body || {}))))
admin.post('/clinics/:id/suspend', wrap(async (req, res) => res.json(await core.revokeClinic(req.params.id, req.body?.reason, req.admin.email))))
admin.post('/clinics/:id/reinstate', wrap(async (req, res) => res.json(await core.reinstateClinic(req.params.id, req.admin.email))))
admin.post('/clinics/:id/key', wrap(async (req, res) => res.json(await core.issueKeyForHost(req.params.id, req.body || {}))))
admin.post('/payments', wrap(async (req, res) => res.json(await core.createPayment(req.body || {}))))
admin.post('/payments/:id/confirm', wrap(async (req, res) => res.json(await core.confirmPayment(req.params.id, req.admin.email))))
admin.post('/payments/:id/reject', wrap(async (req, res) => res.json(await core.rejectPayment(req.params.id, req.admin.email))))
admin.post('/payments/:id/verify-moncash', wrap(async (req, res) => res.json(await core.verifyMoncash(req.params.id))))
admin.post('/licenses/:lid/revoke', wrap(async (req, res) => res.json(await core.revokeLicense(req.params.lid, req.body?.reason, req.admin.email))))
admin.get('/payments', wrap(async (req, res) => res.json(await core.listPayments(req.query.status))))
admin.get('/backups', wrap(async (req, res) => res.json(await core.listBackups())))
admin.get('/events', wrap(async (req, res) => res.json(await core.listEvents(req.query.limit))))
// Comptes bancaires (affichés aux clients pour le virement)
admin.get('/bank-accounts', wrap(async (req, res) => res.json(await core.listBankAccounts())))
admin.post('/bank-accounts', wrap(async (req, res) => res.json(await core.addBankAccount(req.body || {}))))
admin.patch('/bank-accounts/:id', wrap(async (req, res) => res.json(await core.updateBankAccount(req.params.id, req.body || {}))))
admin.delete('/bank-accounts/:id', wrap(async (req, res) => res.json(await core.deleteBankAccount(req.params.id))))
// Preuve de virement (URL signée temporaire)
admin.get('/payments/:id/proof-url', wrap(async (req, res) => res.json(await core.proofUrl(req.params.id))))
// Administrateurs (propriétaires uniquement)
admin.get('/admins', requireOwner, wrap(async (req, res) => res.json(await core.listAdmins())))
admin.post('/admins', requireOwner, wrap(async (req, res) => res.json(await core.createAdmin(req.body || {}, req.admin.email))))
admin.patch('/admins/:id/role', requireOwner, wrap(async (req, res) => res.json(await core.setAdminRole(req.params.id, req.body?.role, req.admin.email))))
admin.post('/admins/:id/block', requireOwner, wrap(async (req, res) => res.json(await core.blockAdmin(req.params.id, req.body?.blocked !== false, req.admin.email, req.admin.id))))
admin.post('/admins/:id/reset-password', requireOwner, wrap(async (req, res) => res.json(await core.resetAdminPassword(req.params.id, req.body?.password, req.admin.email))))
admin.delete('/admins/:id', requireOwner, wrap(async (req, res) => res.json(await core.deleteAdmin(req.params.id, req.admin.id, req.admin.email))))
// Compte client (clinique) : réinitialiser le mot de passe + accès manuel immédiat
admin.post('/clinics/:id/reset-password', wrap(async (req, res) => res.json(await core.resetClinicPassword(req.params.id, req.body?.password, req.admin.email))))
admin.post('/clinics/:id/grant', wrap(async (req, res) => res.json(await core.grantAccess(req.params.id, req.body?.plan, req.admin.email))))
app.use('/admin/api', admin)

// ─── Frontend de la console (optionnel : absent si la console est hébergée à part)
import fs from 'fs'
const WEB = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : path.join(ROOT, 'web')
if (fs.existsSync(path.join(WEB, 'index.html'))) {
  app.use(express.static(WEB, { setHeaders: (res, f) => { if (/\.(js|css|html)$/.test(f)) res.setHeader('Cache-Control', 'no-cache') } }))
  app.get('*', (req, res) => res.sendFile(path.join(WEB, 'index.html')))
} else {
  app.get('/', (req, res) => res.json({ service: 'DENTAL — SaaS API', status: 'ok' }))
}

// Prépare la base + l'admin + les tâches de fond, SANS écouter de port.
// Appelé soit par start() (service autonome), soit par le service unique (src/index.js).
export async function init() {
  await ensureSchema()
  await ensureAdmin()
  console.log('Base de la console :', await dbKind())
  // Entretien quotidien : rappels d'expiration, blocages, rétention 90 j
  const maint = () => core.runMaintenance().then(r => r.reminded + r.blocked && console.log('Entretien :', r)).catch(e => console.error('Entretien :', e.message))
  setTimeout(maint, 10000); setInterval(maint, 24 * 3600000).unref?.()
  // MonCash : vérification automatique du statut des paiements en attente
  const mcPoll = () => core.autoVerifyMoncash().then(r => (r.confirmed || r.failed) && console.log('MonCash auto :', r)).catch(() => {})
  setInterval(mcPoll, 90000).unref?.()
}
export async function start() { await init(); return app.listen(PORT, () => console.log('Console SaaS prête sur le port', PORT)) }

// Démarrage autonome uniquement : en service unique (MOUNTED=1) c'est src/index.js qui pilote.
if (process.env.NODE_ENV !== 'test' && !process.env.MOUNTED) start().catch(e => { console.error('Démarrage console:', e); process.exit(1) })

export { app }

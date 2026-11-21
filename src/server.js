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
import { ensureSchema, dbKind } from './db.js'
import { ensureAdmin, login, setCookie, clearCookie, requireAdmin } from './auth.js'
import * as core from './core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SAAS_PORT || process.env.PORT) || 4000
const app = express()
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '256kb' }))
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.message || 'Erreur serveur', code: e.code }))
const limiter = rateLimit({ windowMs: 60000, max: 120 })

// ─── Endpoints appelés par l'APP DENTALE (pas d'auth admin) ──────────────────
app.post('/api/activate', limiter, wrap(async (req, res) => res.json(await core.activate(req.body || {}))))
app.post('/api/check', limiter, wrap(async (req, res) => res.json(await core.check(req.body || {}))))
app.post('/api/backups/report', limiter, wrap(async (req, res) => res.json(await core.recordBackup(req.body || {}))))
app.post('/api/relay-mail', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => res.json(await core.relayMail(req.body || {}))))
// Inscription d'essai (utilisée plus tard par le site vitrine)
app.post('/api/signup', limiter, wrap(async (req, res) => {
  const c = await core.createClinic(req.body || {})
  res.json({ clinic_id: c.id, activation_code: c.activation_code, name: c.name, trial: true })
}))
app.get('/api/health', (req, res) => res.json({ status: 'ok' }))
app.get('/api/prices', (req, res) => res.json(core.prices()))
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
app.post('/admin/api/login', rateLimit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const token = await login(req.body?.email, req.body?.password); setCookie(res, token); res.json({ ok: true })
}))
app.post('/admin/api/logout', (req, res) => { clearCookie(res); res.json({ ok: true }) })
app.get('/admin/api/me', requireAdmin, (req, res) => res.json({ email: req.admin.email, role: req.admin.role }))

// ─── API d'administration (protégée) ─────────────────────────────────────────
const admin = express.Router()
admin.use(requireAdmin)
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

export async function start() {
  await ensureSchema()
  await ensureAdmin()
  console.log('Base de la console :', await dbKind())
  // Entretien quotidien : rappels d'expiration, blocages, rétention 90 j
  const maint = () => core.runMaintenance().then(r => r.reminded + r.blocked && console.log('Entretien :', r)).catch(e => console.error('Entretien :', e.message))
  setTimeout(maint, 10000); setInterval(maint, 24 * 3600000).unref?.()
  return app.listen(PORT, () => console.log('Console SaaS prête sur le port', PORT))
}

if (process.env.NODE_ENV !== 'test') start().catch(e => { console.error('Démarrage console:', e); process.exit(1) })

export { app }

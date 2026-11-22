// ═══════════════════════════════════════════════════════════════════════════
//  Logique métier de la console SaaS.
//  Provisioning des cliniques, essai 15 j, activation d'hôte (sièges),
//  paiements → abonnements + clés, révocation, prolongation, sauvegardes.
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { q } from './db.js'
import { sign } from './license-sign.js'
import { clientToken } from './auth.js'
import { PLAN_DURATIONS } from '../shared/license.js'
import { moncash } from './moncash.js'
import { mail } from './mail.js'
import { putObject, presignGet, r2Ready } from './r2.js'

const RETENTION_DAYS = 90   // données conservées 90 jours après blocage
const safe = p => { try { return Promise.resolve(p).catch(e => console.error('[mail]', e.message)) } catch (e) { console.error('[mail]', e.message) } }

// MonCash injectable (tests)
let MC = moncash
export function _setMoncash(m) { MC = m }

// Prix des formules (HTG), surchargeables par env
export function prices() {
  return {
    currency: process.env.PRICE_CURRENCY || 'HTG',
    '1m': parseInt(process.env.PRICE_1M) || 1500,
    '1y': parseInt(process.env.PRICE_1Y) || 15000
  }
}

const DAY = 86400000
const now = () => new Date()
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY)
const err = (status, message, code) => Object.assign(new Error(message), { status, code })

const genId = () => 'c' + crypto.randomBytes(3).toString('hex')          // ex. c7f3a9 (6 car.)
const genCode = name => (String(name || 'DL').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'DL') + '-' +
  crypto.randomBytes(2).toString('hex').toUpperCase()                     // ex. SOLEIL-4F2A
const refOf = (prefix, id) => `${prefix}-${String(id).padStart(6, '0')}`  // id plateforme unique (PAY-000123 / VIR-000123)
// Mot de passe temporaire lisible (sans caractères ambigus)
const genPassword = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', a = 'abcdefghijkmnpqrstuvwxyz', d = '23456789'
  const pick = s => s[crypto.randomInt(s.length)]
  let p = pick(A) + pick(a) + pick(d)
  for (let i = 0; i < 7; i++) p += pick(A + a + d)
  return p + '!'
}

// ─── Clés de licence FORTES ─────────────────────────────────────────────────
// Alphabet de 32 symboles sans caractères ambigus (ni I, O, 0, 1). Format
// DNTL-XXXXX-XXXXX-XXXXX-XXXXX = 20 symboles = ~100 bits d'entropie. Unique en base.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const keyGroup = (n = 5) => { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += KEY_ALPHABET[b[i] & 31]; return s }
const makeLicenseKey = () => 'DNTL-' + [keyGroup(), keyGroup(), keyGroup(), keyGroup()].join('-')
// Émet une clé (après paiement ou essai), l'inscrit en base avec début → fin.
async function issueLicenseKey(clinicId, plan, startsAt, endsAt, paymentId = null) {
  let key
  for (let i = 0; i < 8; i++) { key = makeLicenseKey(); if (!(await q('select 1 from saas.license_keys where key=$1', [key])).rows.length) break }
  await q(`insert into saas.license_keys(key,clinic_id,plan,starts_at,ends_at,status,payment_id)
           values ($1,$2,$3,$4,$5,'active',$6)`, [key, clinicId, plan, startsAt, endsAt, paymentId])
  await event(clinicId, 'license_issued', { plan, key, ends_at: endsAt })
  return key
}

// ─── Statut effectif d'un abonnement ────────────────────────────────────────
export function effectiveStatus(sub, at = now()) {
  if (!sub) return 'none'
  const end = new Date(sub.period_end), graceEnd = addDays(end, sub.grace_days ?? 3)
  if (at <= end) return sub.plan === 'trial' ? 'trial' : 'active'
  if (at <= graceEnd) return 'grace'
  return 'expired'
}

async function latestSub(clinicId) {
  return (await q('select * from saas.subscriptions where clinic_id=$1 order by period_end desc limit 1', [clinicId])).rows[0]
}
async function event(clinicId, type, data = {}) {
  await q('insert into saas.events(clinic_id,type,data) values ($1,$2,$3)', [clinicId, type, JSON.stringify(data)])
}
// Profil complet renvoyé à l'app lors de l'activation (1re fois) : nom, email,
// adresse, ville, téléphone, logo, couleur. L'app le stocke et l'affiche.
function brandOf(c) {
  return {
    clinic_id: c.id,
    color: c.brand_color || null,
    name: c.display_name || c.name,
    legal_name: c.name,
    logo: c.logo_url || null,
    email: c.email || null,
    phone: c.phone || null,
    city: c.city || null,
    address: c.address || null
  }
}

// ─── Créer une clinique (+ essai gratuit 15 jours) ──────────────────────────
export async function createClinic({ name, email, phone, city, address, seats = 2 }) {
  if (!name || !email) throw err(400, 'Nom et e-mail requis')
  let id, code
  for (let i = 0; i < 6; i++) { id = genId(); if (!(await q('select 1 from saas.clinics where id=$1', [id])).rows.length) break }
  for (let i = 0; i < 6; i++) { code = genCode(name); if (!(await q('select 1 from saas.clinics where activation_code=$1', [code])).rows.length) break }
  try {
    await q(`insert into saas.clinics(id,name,email,phone,city,address,status,activation_code,display_name)
             values ($1,$2,$3,$4,$5,$6,'trial',$7,$2)`, [id, name, email, phone || null, city || null, address || null, code])
  } catch (e) { if (/unique/i.test(e.message) && /email/i.test(e.message)) throw err(409, 'Un compte existe déjà avec cet e-mail'); throw e }
  const end = addDays(now(), PLAN_DURATIONS.trial)
  await q(`insert into saas.subscriptions(clinic_id,plan,seats,period_start,period_end,status)
           values ($1,'trial',$2,now(),$3,'active')`, [id, seats, end])
  await event(id, 'clinic_created', { trial_until: end })
  // E-mails : bienvenue + code à la clinique, alerte à l'équipe
  safe(mail.welcomeTrial({ to: email, clinic: name, code, trialEnd: end }))
  safe(mail.teamAlert({ subject: 'Nouvelle clinique (essai)', html: `${esc(name)} — ${esc(email)} — code ${code}` }))
  return (await q('select * from saas.clinics where id=$1', [id])).rows[0]
}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

// ═══════════════════════════════════════════════════════════════════════════
//  ESPACE CLIENT (vitrine) : compte (mot de passe) → plan → paiement → licence
// ═══════════════════════════════════════════════════════════════════════════
function publicClinic(c) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone, city: c.city, address: c.address, status: c.status, display_name: c.display_name, logo_url: c.logo_url, brand_color: c.brand_color }
}

// Créer un compte (aucune licence émise ici : elle vient du plan/paiement).
export async function registerAccount({ name, email, password, phone, city, address }) {
  if (!name || !email || !password) throw err(400, 'Nom, e-mail et mot de passe requis')
  if (String(password).length < 6) throw err(400, 'Mot de passe trop court (6 caractères minimum)')
  const e = String(email).trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw err(400, 'E-mail invalide')
  if ((await q('select 1 from saas.clinics where lower(email)=$1', [e])).rows.length) throw err(409, 'Un compte existe déjà avec cet e-mail')
  let id
  for (let i = 0; i < 8; i++) { id = genId(); if (!(await q('select 1 from saas.clinics where id=$1', [id])).rows.length) break }
  const hash = bcrypt.hashSync(String(password), 10)
  await q(`insert into saas.clinics(id,name,email,phone,city,address,status,display_name,password_hash)
           values ($1,$2,$3,$4,$5,$6,'registered',$2,$7)`, [id, name, e, phone || null, city || null, address || null, hash])
  await event(id, 'account_created', {})
  safe(mail.teamAlert({ subject: 'Nouveau compte', html: `${esc(name)} — ${esc(e)}` }))
  const clinic = (await q('select * from saas.clinics where id=$1', [id])).rows[0]
  return { token: clientToken(clinic), clinic: publicClinic(clinic) }
}

export async function loginAccount(email, password) {
  const e = String(email || '').trim().toLowerCase()
  const c = (await q('select * from saas.clinics where lower(email)=$1', [e])).rows[0]
  if (!c || !c.password_hash || !bcrypt.compareSync(String(password || ''), c.password_hash)) throw err(401, 'E-mail ou mot de passe incorrect')
  return { token: clientToken(c), clinic: publicClinic(c) }
}

// Espace client : infos + ses licences + ses paiements.
export async function accountMe(clinicId) {
  const c = (await q('select * from saas.clinics where id=$1', [clinicId])).rows[0]
  if (!c) throw err(404, 'Compte introuvable')
  const sub = await latestSub(clinicId)
  const licenses = (await q('select key,plan,starts_at,ends_at,status,created_at from saas.license_keys where clinic_id=$1 order by created_at desc', [clinicId])).rows
  const payments = (await q('select id,method,plan,amount,currency,status,created_at from saas.payments where clinic_id=$1 order by created_at desc limit 20', [clinicId])).rows
  const hasTrial = (await q("select 1 from saas.subscriptions where clinic_id=$1 and plan='trial'", [clinicId])).rows.length > 0
  return { clinic: publicClinic(c), subscription: sub ? { plan: sub.plan, period_end: sub.period_end, status: effectiveStatus(sub) } : null, prices: prices(), trial_used: hasTrial, licenses, payments }
}

// Choix du plan. Essai = licence immédiate (gratuit). Payant = paiement d'abord.
export async function choosePlan(clinicId, plan) {
  if (plan === 'trial') return claimTrial(clinicId)
  if (plan !== '1m' && plan !== '1y') throw err(400, 'Formule invalide (trial, 1m ou 1y)')
  const pr = prices()
  return { needs_payment: true, plan, amount: pr[plan], currency: pr.currency }
}

// Ouvrir l'essai gratuit 15 j (une seule fois) → licence immédiate, sans paiement.
export async function claimTrial(clinicId) {
  const c = (await q('select * from saas.clinics where id=$1', [clinicId])).rows[0]
  if (!c) throw err(404, 'Compte introuvable')
  if ((await q("select 1 from saas.subscriptions where clinic_id=$1 and plan='trial'", [clinicId])).rows.length) throw err(409, 'Essai déjà utilisé pour ce compte')
  const start = now(), end = addDays(start, PLAN_DURATIONS.trial)
  await q(`insert into saas.subscriptions(clinic_id,plan,seats,period_start,period_end,status) values ($1,'trial',2,$2,$3,'active')`, [clinicId, start, end])
  await q("update saas.clinics set status='trial', updated_at=now() where id=$1", [clinicId])
  const key = await issueLicenseKey(clinicId, 'trial', start, end, null)
  safe(mail.licenseKey({ to: c.email, clinic: c.name, key, plan: 'trial', startsAt: start, endsAt: end }))
  return { plan: 'trial', license_key: key, starts_at: start, ends_at: end }
}

// Demande de paiement par virement bancaire (confirmé ensuite depuis la console).
export async function requestVirement(clinicId, plan) {
  if (plan !== '1m' && plan !== '1y') throw err(400, 'Formule invalide (1m ou 1y)')
  const pr = prices()
  const p = (await q(`insert into saas.payments(clinic_id,method,plan,amount,currency,status)
                      values ($1,'virement',$2,$3,$4,'pending') returning *`, [clinicId, plan, pr[plan], pr.currency])).rows[0]
  const ref = refOf('VIR', p.id)
  await q('update saas.payments set ref=$2 where id=$1', [p.id, ref])
  await event(clinicId, 'virement_requested', { payment_id: p.id, ref, plan })
  safe(mail.teamAlert({ subject: 'Virement en attente', html: `Clinique ${clinicId} — ${plan} — réf ${ref}` }))
  return { payment_id: p.id, reference: ref, ref, amount: pr[plan], currency: pr.currency }
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMPTES BANCAIRES (configurés par l'admin, affichés aux clients) + PREUVES
// ═══════════════════════════════════════════════════════════════════════════
export async function listBankAccounts(activeOnly = false) {
  return (await q(`select * from saas.bank_accounts ${activeOnly ? 'where active=true' : ''} order by created_at desc`)).rows
}
export async function addBankAccount({ bank_name, holder, number, currency = 'HTG', note }) {
  if (!bank_name || !holder || !number) throw err(400, 'Banque, titulaire et n° de compte requis')
  const r = (await q(`insert into saas.bank_accounts(bank_name,holder,number,currency,note) values ($1,$2,$3,$4,$5) returning *`, [bank_name, holder, number, currency, note || null])).rows[0]
  await event(null, 'bank_account_added', { bank: bank_name })
  return r
}
export async function updateBankAccount(id, patch = {}) {
  const sets = [], vals = [id]
  for (const [k, col] of [['bank_name', 'bank_name'], ['holder', 'holder'], ['number', 'number'], ['currency', 'currency'], ['note', 'note'], ['active', 'active']])
    if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`) }
  if (sets.length) await q(`update saas.bank_accounts set ${sets.join(',')} where id=$1`, vals)
  return (await q('select * from saas.bank_accounts where id=$1', [id])).rows[0]
}
export async function deleteBankAccount(id) { await q('delete from saas.bank_accounts where id=$1', [id]); return { ok: true } }

// Le client téléverse sa preuve de virement → stockée sur R2, visible par l'admin.
export async function uploadProof(clinicId, paymentId, { filename, contentType, dataBase64 }) {
  const pay = (await q('select * from saas.payments where id=$1 and clinic_id=$2', [paymentId, clinicId])).rows[0]
  if (!pay) throw err(404, 'Paiement introuvable')
  if (pay.status === 'confirmed') throw err(409, 'Ce paiement est déjà confirmé')
  if (!dataBase64) throw err(400, 'Fichier manquant')
  if (!r2Ready()) throw err(503, 'Stockage des preuves non configuré (R2)')
  const buf = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64')
  if (!buf.length) throw err(400, 'Fichier illisible')
  if (buf.length > 8 * 1024 * 1024) throw err(413, 'Fichier trop lourd (8 Mo maximum)')
  const ext = ((filename && filename.includes('.') ? filename.split('.').pop() : (contentType || '').split('/')[1]) || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
  const key = `proofs/${clinicId}/${(pay.ref || paymentId)}-${crypto.randomBytes(4).toString('hex')}.${ext}`
  await putObject(key, buf, contentType || 'application/octet-stream')
  await q('update saas.payments set proof_url=$2 where id=$1', [paymentId, key])
  await event(clinicId, 'proof_uploaded', { payment_id: paymentId, ref: pay.ref })
  safe(mail.teamAlert({ subject: 'Preuve de virement reçue', html: `Clinique ${clinicId} — paiement ${pay.ref || paymentId} — à valider` }))
  return { ok: true }
}
// URL signée temporaire pour que l'admin consulte la preuve.
export async function proofUrl(paymentId) {
  const pay = (await q('select proof_url from saas.payments where id=$1', [paymentId])).rows[0]
  if (!pay || !pay.proof_url) throw err(404, 'Aucune preuve pour ce paiement')
  const url = await presignGet(pay.proof_url, 600)
  if (!url) throw err(503, 'Stockage non configuré')
  return { url }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GESTION DES UTILISATEURS (admin) : administrateurs, comptes clients, accès
// ═══════════════════════════════════════════════════════════════════════════
// — Administrateurs de la console —
export async function listAdmins() {
  return (await q('select id,email,role,blocked,created_at from saas.admins order by created_at')).rows
}
export async function assertAdminActive(id) {
  const a = (await q('select blocked from saas.admins where id=$1', [id])).rows[0]
  if (!a) throw err(401, 'Compte administrateur introuvable', 'AUTH')
  if (a.blocked) throw err(403, 'Votre compte administrateur est bloqué.', 'BLOCKED')
}
export async function createAdmin({ email, password, role = 'staff' }, byEmail) {
  if (!email || !password) throw err(400, 'E-mail et mot de passe requis')
  if (String(password).length < 8) throw err(400, 'Mot de passe trop court (8 caractères minimum)')
  const e = String(email).trim().toLowerCase()
  if ((await q('select 1 from saas.admins where email=$1', [e])).rows.length) throw err(409, 'Un administrateur existe déjà avec cet e-mail')
  const r = (await q('insert into saas.admins(email,password_hash,role) values ($1,$2,$3) returning id,email,role,blocked,created_at',
    [e, bcrypt.hashSync(String(password), 10), role === 'owner' ? 'owner' : 'staff'])).rows[0]
  await event(null, 'admin_created', { email: e, role: r.role, by: byEmail })
  return r
}
export async function setAdminRole(id, role, byEmail) {
  await q('update saas.admins set role=$2 where id=$1', [id, role === 'owner' ? 'owner' : 'staff'])
  await event(null, 'admin_role_changed', { admin_id: id, role, by: byEmail })
  return (await q('select id,email,role,blocked from saas.admins where id=$1', [id])).rows[0]
}
export async function blockAdmin(id, blocked, byEmail, selfId) {
  if (String(id) === String(selfId)) throw err(400, 'Vous ne pouvez pas vous bloquer vous-même')
  if (blocked) {
    const a = (await q('select role from saas.admins where id=$1', [id])).rows[0]
    if (a?.role === 'owner') {
      const n = (await q("select count(*)::int n from saas.admins where role='owner' and blocked=false and id<>$1", [id])).rows[0].n
      if (n === 0) throw err(400, 'Impossible de bloquer le dernier propriétaire actif')
    }
  }
  await q('update saas.admins set blocked=$2 where id=$1', [id, !!blocked])
  await event(null, blocked ? 'admin_blocked' : 'admin_unblocked', { admin_id: id, by: byEmail })
  return { ok: true }
}
export async function resetAdminPassword(id, newPassword, byEmail) {
  const pwd = newPassword && String(newPassword).length >= 8 ? String(newPassword) : genPassword()
  await q('update saas.admins set password_hash=$2 where id=$1', [id, bcrypt.hashSync(pwd, 10)])
  await event(null, 'admin_password_reset', { admin_id: id, by: byEmail })
  return { password: pwd }
}
export async function deleteAdmin(id, selfId, byEmail) {
  if (String(id) === String(selfId)) throw err(400, 'Vous ne pouvez pas supprimer votre propre compte')
  const a = (await q('select role from saas.admins where id=$1', [id])).rows[0]
  if (a?.role === 'owner') {
    const n = (await q("select count(*)::int n from saas.admins where role='owner' and id<>$1", [id])).rows[0].n
    if (n === 0) throw err(400, 'Impossible de supprimer le dernier propriétaire')
  }
  await q('delete from saas.admins where id=$1', [id])
  await event(null, 'admin_deleted', { admin_id: id, by: byEmail })
  return { ok: true }
}

// — Compte client (clinique) : réinitialiser le mot de passe —
export async function resetClinicPassword(clinicId, newPassword, byEmail) {
  const c = (await q('select email,name from saas.clinics where id=$1', [clinicId])).rows[0]
  if (!c) throw err(404, 'Clinique inconnue')
  const pwd = newPassword && String(newPassword).length >= 6 ? String(newPassword) : genPassword()
  await q('update saas.clinics set password_hash=$2, updated_at=now() where id=$1', [clinicId, bcrypt.hashSync(pwd, 10)])
  await event(clinicId, 'client_password_reset', { by: byEmail })
  return { password: pwd, email: c.email }
}

// — Accès manuel immédiat à un plan (sans paiement) : crée l'abonnement + la clé —
export async function grantAccess(clinicId, plan, byEmail) {
  if (plan !== '1m' && plan !== '1y') throw err(400, 'Formule invalide (1m ou 1y)')
  const c = (await q('select * from saas.clinics where id=$1', [clinicId])).rows[0]
  if (!c) throw err(404, 'Clinique inconnue')
  const cur = await latestSub(clinicId)
  const start = cur && new Date(cur.period_end) > now() ? new Date(cur.period_end) : now()
  const end = addDays(start, PLAN_DURATIONS[plan])
  const seats = cur ? cur.seats : 2
  await q(`insert into saas.subscriptions(clinic_id,plan,seats,period_start,period_end,status) values ($1,$2,$3,$4,$5,'active')`, [clinicId, plan, seats, start, end])
  await q("update saas.clinics set status='active', data_retention_until=null, updated_at=now() where id=$1", [clinicId])
  const key = await issueLicenseKey(clinicId, plan, start, end, null)
  safe(mail.licenseKey({ to: c.email, clinic: c.name, key, plan, startsAt: start, endsAt: end }))
  await event(clinicId, 'access_granted', { plan, by: byEmail, ends_at: end })
  return { license_key: key, plan, ends_at: end }
}

// Vérifie automatiquement auprès de MonCash les paiements encore en attente.
export async function autoVerifyMoncash() {
  const pend = (await q(`select id from saas.payments where method='moncash' and status='pending' and created_at > now() - interval '2 hours'`)).rows
  let confirmed = 0, failed = 0
  for (const p of pend) { try { const r = await verifyMoncash(p.id); if (r.status === 'confirmed') confirmed++; else if (r.status === 'failed') failed++ } catch {} }
  return { checked: pend.length, confirmed, failed }
}

// ─── Activer un hôte pour une clinique donnée (contrôle des sièges) ──────────
async function activateForClinic(clinic, { fingerprint, hostname, app_version }) {
  if (!fingerprint) throw err(400, 'Empreinte machine manquante')
  const sub = await latestSub(clinic.id)
  const eff = effectiveStatus(sub)
  if (eff === 'expired' || eff === 'none') throw err(402, 'Abonnement expiré : renouvelez avant d\'activer ce poste.', 'EXPIRED')

  let host = (await q('select * from saas.hosts where clinic_id=$1 and fingerprint=$2', [clinic.id, fingerprint])).rows[0]
  if (host) {
    await q("update saas.hosts set status='active', hostname=$2, app_version=$3, last_seen_at=now() where id=$1", [host.id, hostname || host.hostname, app_version || host.app_version])
  } else {
    const used = (await q("select count(*)::int n from saas.hosts where clinic_id=$1 and status='active'", [clinic.id])).rows[0].n
    if (used >= sub.seats) throw err(409, `Tous les sièges sont utilisés (${used}/${sub.seats}). Ajoutez un siège pour activer un poste de plus.`, 'NO_SEATS')
    host = (await q('insert into saas.hosts(clinic_id,fingerprint,hostname,app_version) values ($1,$2,$3,$4) returning *',
      [clinic.id, fingerprint, hostname || null, app_version || null])).rows[0]
  }

  const { token, payload } = sign({ clinic_id: clinic.id, clinic: clinic.display_name || clinic.name, plan: sub.plan, machine_id: fingerprint, seats: sub.seats, expires_at: sub.period_end })
  await q(`insert into saas.licenses(lid,clinic_id,host_id,subscription_id,plan,issued_at,expires_at)
           values ($1,$2,$3,$4,$5,now(),$6)`, [payload.lid, clinic.id, host.id, sub.id, sub.plan, sub.period_end])
  await event(clinic.id, 'activation', { host_id: host.id, fingerprint, plan: sub.plan })
  return { token, brand: brandOf(clinic), host_id: host.id, expires_at: sub.period_end }
}

// Appelé par l'app Dental (POST /api/activate) : via la CLÉ DE LICENCE.
export async function activate({ key, code, fingerprint, hostname, app_version }) {
  const raw = String(key || code || '').trim()
  if (!raw) throw err(400, 'Clé de licence manquante')
  const norm = raw.toUpperCase()
  // 1) Nouvelle clé de licence forte (license_keys)
  const lk = (await q('select * from saas.license_keys where upper(key)=$1', [norm])).rows[0]
  if (lk) {
    if (lk.status === 'revoked') throw err(403, 'Licence révoquée. Contactez votre fournisseur.', 'REVOKED')
    if (new Date(lk.ends_at) < now()) throw err(402, 'Licence expirée : renouvelez pour réactiver ce poste.', 'EXPIRED')
    const clinic = (await q('select * from saas.clinics where id=$1', [lk.clinic_id])).rows[0]
    if (!clinic) throw err(404, 'Clinique inconnue')
    if (clinic.status === 'suspended') throw err(403, 'Compte suspendu. Contactez votre fournisseur.', 'SUSPENDED')
    const r = await activateForClinic(clinic, { fingerprint, hostname, app_version })
    return { token: r.token, brand: r.brand }
  }
  // 2) Repli : ancien code d'activation de clinique (compat)
  const clinic = (await q('select * from saas.clinics where upper(activation_code)=$1', [norm])).rows[0]
  if (!clinic) throw err(404, 'Clé de licence inconnue', 'BAD_CODE')
  if (clinic.status === 'suspended') throw err(403, 'Compte suspendu. Contactez votre fournisseur.', 'SUSPENDED')
  const r = await activateForClinic(clinic, { fingerprint, hostname, app_version })
  return { token: r.token, brand: r.brand }
}

// Généré depuis la console (clé manuelle pour un poste dont on a l'empreinte).
export async function issueKeyForHost(clinicId, { fingerprint, hostname }) {
  const clinic = (await q('select * from saas.clinics where id=$1', [clinicId])).rows[0]
  if (!clinic) throw err(404, 'Clinique inconnue')
  return activateForClinic(clinic, { fingerprint, hostname, app_version: 'console' })
}

// ─── Contrôle en ligne (POST /api/check) : révocation + prolongation ────────
export async function check({ lid, clinic_id, fingerprint }) {
  const lic = (await q('select * from saas.licenses where lid=$1', [lid])).rows[0]
  if (!lic) return { revoked: true, reason: 'Licence inconnue' }
  if (fingerprint) await q('update saas.hosts set last_seen_at=now() where clinic_id=$1 and fingerprint=$2', [lic.clinic_id, fingerprint])
  await event(lic.clinic_id, 'check', { lid, fingerprint })
  if (lic.revoked) return { revoked: true, reason: lic.revoked_reason || 'Licence suspendue' }

  const clinic = (await q('select * from saas.clinics where id=$1', [lic.clinic_id])).rows[0]
  const sub = await latestSub(lic.clinic_id)
  const brand = clinic ? brandOf(clinic) : undefined

  // Prolongation : l'abonnement a été renouvelé au-delà de la clé actuelle → nouvelle clé.
  if (sub && new Date(sub.period_end) > new Date(lic.expires_at) && lic.host_id) {
    const host = (await q('select * from saas.hosts where id=$1', [lic.host_id])).rows[0]
    if (host && host.status === 'active') {
      const { token, payload } = sign({ clinic_id: clinic.id, clinic: clinic.display_name || clinic.name, plan: sub.plan, machine_id: host.fingerprint, seats: sub.seats, expires_at: sub.period_end })
      await q(`insert into saas.licenses(lid,clinic_id,host_id,subscription_id,plan,issued_at,expires_at)
               values ($1,$2,$3,$4,$5,now(),$6)`, [payload.lid, clinic.id, host.id, sub.id, sub.plan, sub.period_end])
      await event(clinic.id, 'renew', { host_id: host.id, until: sub.period_end })
      return { revoked: false, token, exp: sub.period_end, brand }
    }
  }
  return { revoked: false, exp: lic.expires_at, brand }
}

// ─── Paiements ──────────────────────────────────────────────────────────────
export async function createPayment({ clinic_id, method, plan, amount, currency = 'HTG', reference, status = 'pending' }) {
  if (!PLAN_DURATIONS[plan] || plan === 'trial') throw err(400, 'Formule invalide (1m ou 1y)')
  const p = (await q(`insert into saas.payments(clinic_id,method,plan,amount,currency,reference,status)
                      values ($1,$2,$3,$4,$5,$6,$7) returning *`, [clinic_id, method, plan, amount, currency, reference || null, status])).rows[0]
  const ref = refOf(method === 'moncash' ? 'PAY' : 'VIR', p.id)
  await q('update saas.payments set ref=$2 where id=$1', [p.id, ref])
  p.ref = ref
  await event(clinic_id, 'payment_created', { method, plan, amount, status, ref })
  if (status === 'confirmed') await openSubscriptionFromPayment(p)
  return p
}

export async function confirmPayment(paymentId, adminEmail) {
  const p = (await q('select * from saas.payments where id=$1', [paymentId])).rows[0]
  if (!p) throw err(404, 'Paiement introuvable')
  if (p.status === 'confirmed') return p
  await q("update saas.payments set status='confirmed', confirmed_by=$2, confirmed_at=now() where id=$1", [paymentId, adminEmail || null])
  const sub = await openSubscriptionFromPayment(p)
  await event(p.clinic_id, 'payment_confirmed', { payment_id: p.id, plan: p.plan, by: adminEmail })
  return { payment: { ...p, status: 'confirmed' }, subscription: sub }
}

export async function rejectPayment(paymentId, adminEmail) {
  await q("update saas.payments set status='rejected', confirmed_by=$2, confirmed_at=now() where id=$1", [paymentId, adminEmail || null])
  const p = (await q('select clinic_id from saas.payments where id=$1', [paymentId])).rows[0]
  if (p) await event(p.clinic_id, 'payment_rejected', { payment_id: paymentId, by: adminEmail })
  return { ok: true }
}

async function openSubscriptionFromPayment(p) {
  const days = PLAN_DURATIONS[p.plan]
  const cur = await latestSub(p.clinic_id)
  const start = cur && new Date(cur.period_end) > now() ? new Date(cur.period_end) : now()  // prolonge si encore actif
  const end = addDays(start, days)
  const seats = cur ? cur.seats : 2
  const sub = (await q(`insert into saas.subscriptions(clinic_id,plan,seats,period_start,period_end,status,payment_id)
                        values ($1,$2,$3,$4,$5,'active',$6) returning *`, [p.clinic_id, p.plan, seats, start, end, p.id])).rows[0]
  await q("update saas.clinics set status='active', data_retention_until=null, updated_at=now() where id=$1", [p.clinic_id])
  // La CLÉ de licence n'est générée QU'ICI, une fois le paiement confirmé — jamais avant.
  const key = await issueLicenseKey(p.clinic_id, p.plan, start, end, p.id)
  const c = (await q('select name, email from saas.clinics where id=$1', [p.clinic_id])).rows[0]
  if (c) {
    safe(mail.paymentConfirmed({ to: c.email, clinic: c.name, plan: p.plan, amount: p.amount, currency: p.currency, periodEnd: end, method: p.method }))
    safe(mail.licenseKey({ to: c.email, clinic: c.name, key, plan: p.plan, startsAt: start, endsAt: end }))
  }
  sub.license_key = key
  return sub
}

// ─── Révocation / suspension ────────────────────────────────────────────────
export async function revokeLicense(lid, reason, adminEmail) {
  await q("update saas.licenses set revoked=true, revoked_at=now(), revoked_reason=$2 where lid=$1", [lid, reason || 'révoquée'])
  const l = (await q('select clinic_id from saas.licenses where lid=$1', [lid])).rows[0]
  if (l) await event(l.clinic_id, 'revoke', { lid, reason, by: adminEmail })
  return { ok: true }
}
export async function revokeClinic(clinicId, reason, adminEmail) {
  const retention = addDays(now(), RETENTION_DAYS)
  await q("update saas.licenses set revoked=true, revoked_at=now(), revoked_reason=$2 where clinic_id=$1 and revoked=false", [clinicId, reason || 'suspendue'])
  await q("update saas.clinics set status='suspended', data_retention_until=$2, updated_at=now() where id=$1", [clinicId, retention])
  await event(clinicId, 'suspend', { reason, by: adminEmail, retention_until: retention })
  const c = (await q('select name, email from saas.clinics where id=$1', [clinicId])).rows[0]
  if (c) safe(mail.blocked({ to: c.email, clinic: c.name, retentionUntil: retention }))
  return { ok: true, retention_until: retention }
}
export async function reinstateClinic(clinicId, adminEmail) {
  await q("update saas.clinics set status='active', updated_at=now() where id=$1", [clinicId])
  await event(clinicId, 'reinstate', { by: adminEmail })
  return { ok: true }
}

// ─── Mise à jour (personnalisation + sièges) ────────────────────────────────
export async function updateClinic(clinicId, patch = {}) {
  const sets = [], vals = [clinicId]
  for (const [k, col] of [['brand_color', 'brand_color'], ['display_name', 'display_name'], ['logo_url', 'logo_url'], ['name', 'name'], ['phone', 'phone'], ['email', 'email'], ['city', 'city'], ['address', 'address']]) {
    if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`) }
  }
  if (sets.length) await q(`update saas.clinics set ${sets.join(',')}, updated_at=now() where id=$1`, vals)
  if (patch.seats !== undefined) {
    const sub = await latestSub(clinicId)
    if (sub) await q('update saas.subscriptions set seats=$2 where id=$1', [sub.id, Math.max(1, parseInt(patch.seats) || 1)])
  }
  await event(clinicId, 'updated', { fields: Object.keys(patch) })
  return (await q('select * from saas.clinics where id=$1', [clinicId])).rows[0]
}

// ─── Sauvegardes (rapport envoyé par l'app) ─────────────────────────────────
export async function recordBackup({ clinic_id, fingerprint, size_bytes, sha256, verified, location }) {
  const host = fingerprint ? (await q('select id from saas.hosts where clinic_id=$1 and fingerprint=$2', [clinic_id, fingerprint])).rows[0] : null
  await q(`insert into saas.backups(clinic_id,host_id,size_bytes,sha256,verified,location)
           values ($1,$2,$3,$4,$5,$6)`, [clinic_id, host?.id || null, size_bytes || null, sha256 || null, !!verified, location || null])
  await event(clinic_id, 'backup', { verified: !!verified, size_bytes })
  return { ok: true }
}

// ─── Lectures pour la console ───────────────────────────────────────────────
export async function listClinics() {
  const rows = (await q(`
    select c.*, s.plan, s.seats, s.period_end, s.grace_days,
      (select count(*) from saas.hosts h where h.clinic_id=c.id and h.status='active') as hosts_used,
      (select max(b.created_at) from saas.backups b where b.clinic_id=c.id and b.verified) as last_backup
    from saas.clinics c
    left join lateral (select * from saas.subscriptions s2 where s2.clinic_id=c.id order by s2.period_end desc limit 1) s on true
    order by c.created_at desc`)).rows
  return rows.map(c => ({ ...c, effective: effectiveStatus({ period_end: c.period_end, grace_days: c.grace_days, plan: c.plan }) }))
}

export async function getClinic(id) {
  const clinic = (await q('select * from saas.clinics where id=$1', [id])).rows[0]
  if (!clinic) throw err(404, 'Clinique inconnue')
  const sub = await latestSub(id)
  const subs = (await q('select * from saas.subscriptions where clinic_id=$1 order by period_end desc limit 12', [id])).rows
  const hosts = (await q('select * from saas.hosts where clinic_id=$1 order by activated_at desc', [id])).rows
  const licenses = (await q('select * from saas.licenses where clinic_id=$1 order by issued_at desc limit 20', [id])).rows
  const payments = (await q('select * from saas.payments where clinic_id=$1 order by created_at desc limit 20', [id])).rows
  const backups = (await q('select * from saas.backups where clinic_id=$1 order by created_at desc limit 20', [id])).rows
  const events = (await q('select * from saas.events where clinic_id=$1 order by created_at desc limit 40', [id])).rows
  return { clinic, subscription: sub, effective: effectiveStatus(sub), brand: brandOf(clinic), subs, hosts, licenses, payments, backups, events }
}

export async function overview() {
  const pr = prices()
  // Toutes les requêtes indépendantes en parallèle (1 aller-retour au lieu de ~8).
  const [clinics, hostsR, revenueR, backups24R, pendingR, eventsR, revByMonthR, signByMonthR] = await Promise.all([
    listClinics(),
    q("select count(*)::int n from saas.hosts where status='active'"),
    q("select coalesce(sum(amount),0)::float t, currency from saas.payments where status='confirmed' group by currency"),
    q("select count(*)::int ok from saas.backups where verified and created_at > now() - interval '24 hours'"),
    q("select p.*, c.name clinic_name from saas.payments p join saas.clinics c on c.id=p.clinic_id where p.status='pending' order by p.created_at desc"),
    q(`select e.*, c.name clinic_name from saas.events e left join saas.clinics c on c.id=e.clinic_id order by e.created_at desc limit 40`),
    q(`select to_char(date_trunc('month', confirmed_at),'YYYY-MM') m, coalesce(sum(amount),0)::float t
       from saas.payments where status='confirmed' and confirmed_at > now() - interval '6 months' group by 1`),
    q(`select to_char(date_trunc('month', created_at),'YYYY-MM') m, count(*)::int n
       from saas.clinics where created_at > now() - interval '6 months' group by 1`)
  ])
  const hosts = hostsR.rows[0].n, revenue = revenueR.rows, backups24 = backups24R.rows[0].ok
  const pendingPayments = pendingR.rows, recentEvents = eventsR.rows, revByMonth = revByMonthR.rows, signByMonth = signByMonthR.rows
  const byStatus = { trial: 0, active: 0, grace: 0, expired: 0, suspended: 0 }
  for (const c of clinics) { const k = c.status === 'suspended' ? 'suspended' : c.effective; byStatus[k] = (byStatus[k] || 0) + 1 }
  const expiringSoon = clinics.filter(c => c.period_end && new Date(c.period_end) > now() && new Date(c.period_end) < addDays(now(), 7) && c.status !== 'suspended')
    .map(c => ({ id: c.id, name: c.name, period_end: c.period_end, effective: c.effective }))
  const seatsFull = clinics.filter(c => c.seats && c.hosts_used >= c.seats).map(c => ({ id: c.id, name: c.name, hosts_used: c.hosts_used, seats: c.seats }))
  const months = []
  for (let i = 5; i >= 0; i--) { const d = new Date(now().getFullYear(), now().getMonth() - i, 1); months.push(d.toISOString().slice(0, 7)) }
  const revMap = Object.fromEntries(revByMonth.map(r => [r.m, r.t])), signMap = Object.fromEntries(signByMonth.map(r => [r.m, r.n]))
  const revenueSeries = months.map(m => ({ m, t: revMap[m] || 0 }))
  const signupsSeries = months.map(m => ({ m, n: signMap[m] || 0 }))
  // ── Revenu du mois courant + MRR (revenu mensuel récurrent estimé) ──
  const nowMonth = now().toISOString().slice(0, 7)
  const revenueMonth = revMap[nowMonth] || 0
  let mrr = 0
  for (const c of clinics) { if (c.effective === 'active' && c.plan === '1m') mrr += pr['1m']; else if (c.effective === 'active' && c.plan === '1y') mrr += pr['1y'] / 12 }
  const conversion = clinics.length ? Math.round((byStatus.active / clinics.length) * 100) : 0
  return {
    counts: { ...byStatus, total: clinics.length, hosts },
    revenue, revenueMonth, mrr: Math.round(mrr), currency: pr.currency, conversion,
    backups24, expiringSoon, seatsFull, pendingPayments, recentEvents, revenueSeries, signupsSeries
  }
}

// ─── MonCash : initiation + vérification automatique ────────────────────────
export async function initiateMoncash({ clinic_id, plan }) {
  if (!PLAN_DURATIONS[plan] || plan === 'trial') throw err(400, 'Formule invalide (1m ou 1y)')
  const clinic = (await q('select * from saas.clinics where id=$1', [clinic_id])).rows[0]
  if (!clinic) throw err(404, 'Clinique inconnue')
  const pr = prices(), amount = pr[plan]
  const pay = (await q(`insert into saas.payments(clinic_id,method,plan,amount,currency,status)
                        values ($1,'moncash',$2,$3,$4,'pending') returning *`, [clinic_id, plan, amount, pr.currency])).rows[0]
  await q('update saas.payments set ref=$2, moncash_order_id=$3 where id=$1', [pay.id, refOf('PAY', pay.id), String(pay.id)])
  const { redirectUrl, paymentToken } = await MC.createPayment(amount, pay.id)
  await q('update saas.payments set reference=$2 where id=$1', [pay.id, paymentToken])
  await event(clinic_id, 'moncash_initiated', { payment_id: pay.id, ref: refOf('PAY', pay.id), amount, plan })
  return { payment_id: pay.id, ref: refOf('PAY', pay.id), amount, currency: pr.currency, redirectUrl }
}

// Vérifie un paiement MonCash (par orderId = id du paiement) et confirme si réussi.
export async function verifyMoncash(paymentId) {
  const pay = (await q('select * from saas.payments where id=$1', [paymentId])).rows[0]
  if (!pay) throw err(404, 'Paiement introuvable')
  if (pay.status === 'confirmed') return { status: 'confirmed', already: true }
  const p = await MC.verifyByOrderId(pay.id)
  if (!p) return { status: 'pending', message: 'Paiement non encore effectué', ref: pay.ref }
  const paid = /success/i.test(p.message || '') && Number(p.cost) >= Number(pay.amount)
  if (!paid) {
    // MonCash signale un échec explicite → marquer le paiement en échec (visible en admin)
    if (/fail|denied|cancel|error/i.test(p.message || '')) {
      await q("update saas.payments set status='failed', details=$2 where id=$1 and status='pending'", [pay.id, JSON.stringify(p)])
      await event(pay.clinic_id, 'moncash_failed', { payment_id: pay.id, ref: pay.ref, message: p.message })
      return { status: 'failed', ref: pay.ref, message: p.message || 'Paiement échoué' }
    }
    return { status: 'pending', ref: pay.ref, message: p.message || 'En attente', cost: p.cost }
  }
  // Anti-doublon : le transaction_id MonCash ne doit jamais avoir servi à un autre paiement
  const txid = p.transaction_id || null
  if (txid) {
    const dup = (await q('select id from saas.payments where moncash_transaction_id=$1 and id<>$2', [txid, pay.id])).rows[0]
    if (dup) throw err(409, 'Cette transaction MonCash a déjà été utilisée pour un autre paiement.', 'DUP_TX')
  }
  await q(`update saas.payments set moncash_transaction_id=$2, payer=$3, paid_at=now(), details=$4,
           reference=coalesce($2, reference) where id=$1`, [pay.id, txid, p.payer || null, JSON.stringify(p)])
  const r = await confirmPayment(pay.id, 'moncash')
  await event(pay.clinic_id, 'moncash_confirmed', { payment_id: pay.id, ref: pay.ref, transaction_id: txid, payer: p.payer, amount: p.cost })
  return { status: 'confirmed', ref: pay.ref, transaction_id: txid, subscription: r.subscription }
}

// ─── Entretien quotidien : rappels d'expiration + blocage + rétention 90 j ───
async function recentEvent(clinicId, type, days) {
  return (await q(`select 1 from saas.events where clinic_id=$1 and type=$2 and created_at > now() - ($3 || ' days')::interval limit 1`, [clinicId, type, String(days)])).rows.length > 0
}
export async function runMaintenance() {
  const clinics = await listClinics()
  let reminded = 0, blocked = 0
  for (const c of clinics) {
    if (!c.period_end) continue
    const eff = c.effective, dleft = Math.ceil((new Date(c.period_end) - now()) / DAY)
    // Rappel d'expiration (1 à 3 jours avant), une seule fois
    if ((eff === 'active' || eff === 'trial') && dleft >= 1 && dleft <= 3 && !(await recentEvent(c.id, 'remind_sent', 2))) {
      safe(mail.expiringSoon({ to: c.email, clinic: c.name, daysLeft: dleft, periodEnd: c.period_end }))
      await event(c.id, 'remind_sent', { days_left: dleft }); reminded++
    }
    // Grâce dépassée → expiré : blocage + rétention 90 j + e-mail (une fois)
    if (eff === 'expired' && c.status !== 'suspended' && c.status !== 'expired') {
      const graceEnd = addDays(new Date(c.period_end), c.grace_days || 3)
      const retention = addDays(graceEnd, RETENTION_DAYS)
      await q("update saas.clinics set status='expired', data_retention_until=$2, updated_at=now() where id=$1", [c.id, retention])
      await event(c.id, 'expired', { retention_until: retention })
      safe(mail.blocked({ to: c.email, clinic: c.name, retentionUntil: retention })); blocked++
    }
    // Fin de rétention (90 j) → signalé pour purge manuelle (jamais supprimé automatiquement)
    if (c.data_retention_until && new Date(c.data_retention_until) < now() && !(await recentEvent(c.id, 'retention_expired', 7))) {
      await event(c.id, 'retention_expired', { since: c.data_retention_until })
    }
  }
  return { reminded, blocked, clinics: clinics.length }
}

// Relais e-mail pour l'app clinique (la clé Resend reste côté serveur).
export async function relayMail({ clinic_id, fingerprint, to, subject, text, html }) {
  if (!clinic_id || !to || !/^[^@\s]+@[^@\s]+$/.test(String(to))) throw err(400, 'Requête invalide')
  const clinic = (await q('select status from saas.clinics where id=$1', [clinic_id])).rows[0]
  if (!clinic || clinic.status === 'suspended') throw err(403, 'Clinique non autorisée')
  const host = (await q("select 1 from saas.hosts where clinic_id=$1 and fingerprint=$2 and status='active'", [clinic_id, fingerprint])).rows[0]
  if (!host) throw err(403, 'Poste non reconnu')
  await mail.sendRaw({ to, subject: subject || 'DENTAL', html, text })
  await event(clinic_id, 'relay_mail', { to: String(to).replace(/^(.{1,2})[^@]*(@.*)$/, '$1•••$2') })
  return { ok: true }
}

// Récupération du code d'activation par e-mail (depuis la vitrine). Ne révèle pas si le compte existe.
export async function resendCode(email) {
  const e = String(email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw err(400, 'E-mail invalide')
  const c = (await q('select id, name, email, activation_code, status from saas.clinics where lower(email)=$1', [e])).rows[0]
  if (c && c.status !== 'suspended') {
    const lk = (await q("select key,plan,starts_at,ends_at from saas.license_keys where clinic_id=$1 and status='active' order by created_at desc limit 1", [c.id])).rows[0]
    if (lk) { safe(mail.licenseKey({ to: c.email, clinic: c.name, key: lk.key, plan: lk.plan, startsAt: lk.starts_at, endsAt: lk.ends_at })); await event(c.id, 'code_resent', {}) }
    else if (c.activation_code) { safe(mail.codeReminder({ to: c.email, clinic: c.name, code: c.activation_code })); await event(c.id, 'code_resent', {}) }
  }
  return { ok: true, message: 'Si un compte existe avec cet e-mail, la clé vient d’être envoyée.' }
}

export async function listEvents(limit = 100) {
  return (await q(`select e.*, c.name clinic_name from saas.events e left join saas.clinics c on c.id=e.clinic_id order by e.created_at desc limit $1`, [Math.min(500, limit)])).rows
}
export async function listPayments(status) {
  const where = status ? 'where p.status=$1' : ''
  return (await q(`select p.*, c.name clinic_name from saas.payments p join saas.clinics c on c.id=p.clinic_id ${where} order by p.created_at desc limit 200`, status ? [status] : [])).rows
}
export async function listBackups() {
  return (await q(`select b.*, c.name clinic_name from saas.backups b join saas.clinics c on c.id=b.clinic_id order by b.created_at desc limit 200`)).rows
}

// ═══════════════════════════════════════════════════════════════════════════
//  DENTAL — E-mails transactionnels (Resend, API HTTPS)
//  Porté de BackendDealPam. Envoi via https://api.resend.com (port 443, jamais
//  bloqué) — pas de SMTP. Clé dans l'environnement : RESEND_API_KEY.
//  Si la clé est absente : les e-mails sont seulement journalisés (pas d'erreur).
//  Templates personnalisés par scénario, mise en page responsive.
// ═══════════════════════════════════════════════════════════════════════════

const B = { name: 'Dental Assist', teal: '#0ea5a4', dark: '#0d1b2a', text: '#374151', muted: '#6b7280', border: '#e5e7eb', coral: '#ff5d4d' }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const env = k => process.env[k]
const FROM = () => ({
  client: `"Dental Assist" <${env('MAIL_FROM') || 'dentalassist@gmail.com'}>`,
  admin: `"Dental Assist" <${env('MAIL_FROM_ADMIN') || env('MAIL_FROM') || 'dentalassist@gmail.com'}>`
})
const SUPPORT = () => env('MAIL_SUPPORT') || 'dentalassist@gmail.com'
const PHONE = () => env('CONTACT_PHONE') || '+509 3454 6896'
const SITE = () => (env('VITRINE_URL') || '').replace(/\/+$/, '')
const fdate = d => d ? new Date(d).toLocaleDateString('fr-FR', { timeZone: 'America/Port-au-Prince', dateStyle: 'long' }) : ''

// Permet d'injecter un faux "fetch" dans les tests.
let fetchImpl = (...a) => globalThis.fetch(...a)
export function _setFetch(f) { fetchImpl = f }

// ── Envoi bas niveau ─────────────────────────────────────────────────────────
async function send(to, subject, html, as = 'client') {
  if (!env('RESEND_API_KEY')) { console.log(`[mail] (non configuré) → ${to} : ${subject}`); return { skipped: true } }
  if (!to) return { skipped: 'no_to' }
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM()[as], to, subject, html })
  })
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[mail] échec', r.status, t); return { ok: false, status: r.status } }
  return { ok: true }
}

// ── Composants de mise en page ───────────────────────────────────────────────
const layout = (preheader, body) => `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
  <tr><td style="padding-bottom:22px;text-align:center"><span style="font-size:24px;font-weight:800;color:${B.dark};letter-spacing:-.5px">${B.name}</span></td></tr>
  <tr><td style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.07);border:1px solid ${B.border}">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:40px 44px 36px">${body}</td></tr></table>
  </td></tr>
  <tr><td style="padding:22px 0 8px;text-align:center">
    <p style="margin:0 0 6px;color:#64748b;font-size:12.5px">© ${new Date().getFullYear()} Dental Assist · Haïti · ${PHONE()} · <a href="mailto:${SUPPORT()}" style="color:#64748b">${SUPPORT()}</a></p>
    <p style="margin:0;color:#94a3b8;font-size:11.5px">E-mail automatique — merci de ne pas répondre directement.</p>
  </td></tr>
</table></td></tr></table></body></html>`

const hero = (icon, bg, title, sub) => `<div style="text-align:center;margin-bottom:30px">
  <div style="width:70px;height:70px;background:${bg};border-radius:50%;margin:0 auto 16px;font-size:30px;line-height:70px">${icon}</div>
  <h1 style="margin:0 0 8px;color:${B.dark};font-size:23px;font-weight:800;letter-spacing:-.5px">${title}</h1>
  ${sub ? `<p style="margin:0;color:${B.muted};font-size:15px">${sub}</p>` : ''}</div>`
const greet = n => `<p style="margin:0 0 18px;color:${B.text};font-size:15.5px">Bonjour <strong>${esc(n)}</strong>,</p>`
const para = t => `<p style="margin:0 0 16px;color:${B.text};font-size:15px;line-height:1.75">${t}</p>`
const btn = (t, u, c = B.teal) => `<table cellpadding="0" cellspacing="0" style="margin:26px auto 0"><tr><td style="background:${c};border-radius:10px;padding:14px 34px"><a href="${u}" style="color:#fff;text-decoration:none;font-weight:700;font-size:15px">${t}</a></td></tr></table>`
const alertBox = (t, type = 'info') => { const C = { info: ['#eff6ff', '#1d4ed8'], warning: ['#fffbeb', '#92400e'], success: ['#f0fdf4', '#166534'], error: ['#fff1f2', '#991b1b'] }[type]; return `<div style="background:${C[0]};border-radius:10px;padding:15px 18px;margin:0 0 22px"><p style="margin:0;color:${C[1]};font-size:13.5px;line-height:1.7">${t}</p></div>` }
const codeBox = (label, code) => `<div style="background:#f0fdfb;border:2px solid ${B.teal};border-radius:14px;padding:22px;text-align:center;margin:0 0 22px">
  <p style="margin:0 0 6px;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:2px;font-weight:700">${label}</p>
  <p style="margin:0;font-size:30px;font-weight:900;color:${B.dark};letter-spacing:4px;font-family:monospace">${esc(code)}</p></div>`
const kv = rows => `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;border:1px solid ${B.border};margin:0 0 22px">${rows.map(([k, v]) => `<tr><td style="padding:10px 16px;background:#f9fafb;font-size:13px;color:${B.muted};border-bottom:1px solid ${B.border};width:42%">${k}</td><td style="padding:10px 16px;font-size:13.5px;color:${B.dark};font-weight:600;border-bottom:1px solid ${B.border}">${v}</td></tr>`).join('')}</table>`

const steps = () => `<ol style="color:${B.text};font-size:14.5px;line-height:1.9;padding-left:20px;margin:0 0 22px">
  <li>Téléchargez et installez le logiciel Dental.</li>
  <li>À l'ouverture, entrez votre <strong>code d'activation</strong>.</li>
  <li>Changez le mot de passe du propriétaire, et commencez à travailler.</li></ol>`

// ── Scénarios ────────────────────────────────────────────────────────────────

// 1) Nouvelle clinique — essai gratuit 15 jours (avec code + étapes)
export function welcomeTrial({ to, clinic, code, trialEnd }) {
  const dl = SITE() ? SITE() : (env('DOWNLOAD_URL') || '#')
  const body = `${hero('🎉', '#f0fdfb', `Bienvenue, ${esc(clinic)} !`, 'Votre essai gratuit de 15 jours a commencé')}
    ${greet(clinic)}
    ${para('Votre compte DENTAL est prêt. Voici votre code d’activation — gardez-le précieusement, il sert à activer chaque poste de votre clinique.')}
    ${codeBox("Code d'activation", code)}
    ${steps()}
    ${trialEnd ? alertBox(`Votre essai se termine le <strong>${fdate(trialEnd)}</strong>. Passez à un abonnement avant cette date pour continuer sans interruption.`, 'info') : ''}
    ${btn('Télécharger le logiciel', dl)}
    <hr style="border:none;border-top:1px solid ${B.border};margin:26px 0">
    <p style="margin:0;color:${B.muted};font-size:12.5px;text-align:center">Une question ? Écrivez-nous à <a href="mailto:${SUPPORT()}">${SUPPORT()}</a></p>`
  return send(to, `Bienvenue sur DENTAL — votre code : ${code}`, layout(`Votre essai DENTAL est prêt. Code : ${code}`, body), 'client')
}

// 2) Paiement confirmé — reçu + nouvelle échéance
export function paymentConfirmed({ to, clinic, plan, amount, currency = 'HTG', periodEnd, method }) {
  const planL = plan === '1y' ? '1 an' : '1 mois'
  const body = `${hero('✅', '#f0fdf4', 'Paiement confirmé', 'Votre abonnement est actif')}
    ${greet(clinic)}
    ${para('Merci ! Nous avons bien reçu votre paiement. Votre abonnement est prolongé.')}
    ${kv([['Formule', planL], ['Montant', `${new Intl.NumberFormat('fr-FR').format(amount)} ${currency}`], ['Méthode', method === 'moncash' ? 'MonCash' : 'Virement'], ['Valable jusqu’au', fdate(periodEnd)]])}
    ${alertBox('La prolongation s’applique automatiquement à vos postes dès leur prochaine connexion à Internet.', 'success')}
    <p style="margin:0;color:${B.muted};font-size:12.5px;text-align:center">Un reçu officiel peut vous être fourni sur demande à <a href="mailto:${SUPPORT()}">${SUPPORT()}</a></p>`
  return send(to, `Paiement confirmé — abonnement ${planL} (DENTAL)`, layout(`Paiement reçu. Abonnement valable jusqu'au ${fdate(periodEnd)}.`, body), 'client')
}

// 3) Abonnement expire bientôt
export function expiringSoon({ to, clinic, daysLeft, periodEnd }) {
  const body = `${hero('⏳', '#fffbeb', 'Votre abonnement expire bientôt', `Plus que ${daysLeft} jour(s)`)}
    ${greet(clinic)}
    ${para(`Votre abonnement DENTAL arrive à échéance le <strong>${fdate(periodEnd)}</strong>. Renouvelez-le pour éviter toute interruption.`)}
    ${alertBox('Après l’échéance, vous disposez de <strong>3 jours de grâce</strong>, puis l’accès est bloqué jusqu’au renouvellement.', 'warning')}
    ${SITE() ? btn('Renouveler maintenant', SITE() + '/#tarifs') : ''}`
  return send(to, `Votre abonnement expire dans ${daysLeft} jour(s) — DENTAL`, layout(`Votre abonnement expire le ${fdate(periodEnd)}.`, body), 'client')
}

// 4) Blocage pour non-paiement — données conservées 90 jours
export function blocked({ to, clinic, retentionUntil }) {
  const body = `${hero('🔒', '#fff1f2', 'Accès suspendu', 'Abonnement non renouvelé')}
    ${greet(clinic)}
    ${para('Faute de renouvellement, l’accès à DENTAL a été suspendu sur vos postes.')}
    ${alertBox(`<strong>Vos données ne sont pas perdues.</strong> Elles restent sur votre ordinateur et sont conservées${retentionUntil ? ` jusqu’au <strong>${fdate(retentionUntil)}</strong>` : ' pendant 90 jours'}. Dès votre paiement, tout est rétabli immédiatement, sans aucune perte.`, 'info')}
    ${SITE() ? btn('Renouveler et débloquer', SITE() + '/#tarifs', B.coral) : ''}
    <p style="margin:18px 0 0;color:${B.muted};font-size:12.5px;text-align:center">Besoin d’aide ? <a href="mailto:${SUPPORT()}">${SUPPORT()}</a></p>`
  return send(to, 'Accès suspendu — vos données sont conservées (DENTAL)', layout('Accès suspendu. Vos données sont conservées 90 jours.', body), 'client')
}

// 5) Alerte interne (équipe)
export function teamAlert({ subject, html, to }) {
  const dest = to || env('MAIL_FROM_ADMIN') || env('MAIL_FROM') || SUPPORT()
  return send(dest, `[DENTAL] ${subject}`, layout(subject, `${hero('🔔', '#eff6ff', subject)}<div style="color:${B.text};font-size:14.5px;line-height:1.75">${html}</div>`), 'admin')
}

// Rappel du code d'activation (récupération depuis la vitrine)
export function codeReminder({ to, clinic, code }) {
  const body = `${hero('🔑', '#f0fdfb', 'Votre code d’activation', esc(clinic))}
    ${greet(clinic)}
    ${para('Voici le code d’activation de votre clinique. Entrez-le dans le logiciel DENTAL pour activer chaque poste.')}
    ${codeBox("Code d'activation", code)}
    ${SITE() ? btn('Télécharger le logiciel', (env('DOWNLOAD_URL') || SITE())) : ''}
    <p style="margin:18px 0 0;color:${B.muted};font-size:12.5px;text-align:center">Vous n’êtes pas à l’origine de cette demande ? Ignorez cet e-mail.</p>`
  return send(to, 'Votre code d’activation DENTAL', layout('Votre code d’activation DENTAL', body), 'client')
}

// 6) Clé de licence remise au client (après paiement OU essai gratuit)
export function licenseKey({ to, clinic, key, plan, startsAt, endsAt }) {
  const planL = plan === '1y' ? 'Abonnement 1 an' : plan === '1m' ? 'Abonnement 1 mois' : 'Essai gratuit 15 jours'
  const dl = env('DOWNLOAD_URL') || SITE() || '#'
  const body = `${hero('🔑', '#f0fdfb', 'Votre clé de licence', esc(clinic))}
    ${greet(clinic)}
    ${para('Voici votre clé de licence DENTAL. Saisissez-la dans le logiciel pour activer vos postes. Elle est unique à votre clinique — gardez-la confidentielle.')}
    ${codeBox('Clé de licence', key)}
    ${kv([['Formule', planL], ['Valable du', fdate(startsAt)], ['Jusqu’au', fdate(endsAt)]])}
    ${steps()}
    ${btn('Télécharger le logiciel', dl)}
    <p style="margin:18px 0 0;color:${B.muted};font-size:12.5px;text-align:center">Besoin d’aide ? <a href="mailto:${SUPPORT()}">${SUPPORT()}</a></p>`
  return send(to, `Votre clé de licence DENTAL — ${planL}`, layout(`Votre clé DENTAL : ${key}`, body), 'client')
}

// Envoi « brut » (relais depuis l'app clinique : codes de connexion, etc.) — garde le HTML de l'app.
export async function sendRaw({ to, subject, html, text }) {
  return send(to, subject, html || esc(text || '').replace(/\n/g, '<br>'), 'client')
}

export const mail = { welcomeTrial, paymentConfirmed, expiringSoon, blocked, teamAlert, sendRaw, codeReminder, licenseKey }

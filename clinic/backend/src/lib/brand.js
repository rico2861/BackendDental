// Personnalisation par clinique : identité (nom, logo, coordonnées) + e-mails de marque.
// Les e-mails partent par l'expéditeur de la plateforme (Resend), mais portent le nom,
// le logo et les coordonnées de la clinique concernée.
import { mailCfg } from '../routes/security.js'
import { deliver, resendReady } from './mail.js'

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Identité de la clinique, avec repli raisonnable.
export async function clinicBrand(q, clinicId) {
  const c = (await q('select name,address,phone,email,website,logo from clinics where id=$1', [clinicId])).rows[0] || {}
  return {
    name: c.name || 'Votre cabinet dentaire',
    address: c.address || '', phone: c.phone || '', email: c.email || '',
    website: c.website || '', logo: c.logo || ''
  }
}

// Gabarit HTML de marque : en-tête (logo/nom), contenu, pied avec coordonnées.
export function brandedEmail(brand, { heading, bodyHtml, accent = '#107a6d' }) {
  const b = brand || {}
  const logo = b.logo
    ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" style="max-height:46px;max-width:180px;display:block;margin:0 auto 6px">`
    : `<div style="width:44px;height:44px;border-radius:12px;background:${accent};color:#fff;font:700 22px Georgia,serif;line-height:44px;text-align:center;margin:0 auto 8px">${esc((b.name || 'D')[0])}</div>`
  const contact = [b.phone, b.email, b.address].filter(Boolean).map(esc).join(' · ')
  return `<div style="background:#eef3f1;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d4e2dd;border-radius:16px;overflow:hidden">
      <div style="padding:22px 28px 10px;text-align:center;border-bottom:1px solid #eef4f2">
        ${logo}<div style="font-weight:700;font-size:17px;color:#0f2e2a">${esc(b.name)}</div>
      </div>
      <div style="padding:24px 28px;color:#1b2430;font-size:15px;line-height:1.55">
        ${heading ? `<h2 style="margin:0 0 12px;font-size:19px;color:#0f2e2a">${esc(heading)}</h2>` : ''}
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;border-top:1px solid #eef4f2;color:#5d6f6a;font-size:12px;text-align:center">
        ${contact ? esc('') + contact + '<br>' : ''}${b.website ? `<a href="${esc(b.website)}" style="color:${accent}">${esc(b.website)}</a><br>` : ''}
        <span style="color:#99a3b2">Envoyé via Dental Assist</span>
      </div>
    </div></div>`
}

// Envoi d'un e-mail de marque au nom d'une clinique (expéditeur plateforme, identité clinique).
// Repli silencieux si aucun moyen d'envoi n'est configuré (ne bloque jamais l'action métier).
export async function sendBrandedMail(q, clinicId, { to, subject, heading, bodyHtml, text }) {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) return { skipped: true, reason: 'no_email' }
  const brand = await clinicBrand(q, clinicId)
  const cfg = await mailCfg(q, clinicId).catch(() => null)   // SMTP propre à la clinique si configuré
  if (!cfg && !resendReady() && !process.env.SAAS_URL) return { skipped: true, reason: 'no_mailer' }
  const html = brandedEmail(brand, { heading, bodyHtml })
  const body = text || String(bodyHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const replyTo = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(brand.email || '') ? brand.email : undefined  // le patient répond À LA CLINIQUE
  try {
    await deliver({ cfg, relay: { clinic_id: clinicId }, fromName: brand.name, replyTo, to, subject, text: body, html })
    return { ok: true }
  } catch (e) { return { skipped: true, reason: e.message } }
}

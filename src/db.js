// ═══════════════════════════════════════════════════════════════════════════
//  Connexion à la base de la console.
//  • En production : Postgres / Supabase via SAAS_DB_URL (paquet `pg`).
//  • En local / test : base embarquée PGlite (SAAS_DB_DIR, défaut ./data).
//  Expose q(sql, params) → { rows }, compatible avec les deux.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = () => fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8')

let impl = null

async function init() {
  if (impl) return impl
  const url = process.env.SAAS_DB_URL
  if (url) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: url, ssl: /supabase|railway|render/.test(url) ? { rejectUnauthorized: false } : undefined, max: 8 })
    impl = { kind: 'pg', query: (t, p) => pool.query(t, p), exec: t => pool.query(t), end: () => pool.end() }
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    const dir = process.env.SAAS_DB_DIR || path.join(ROOT, 'data')
    const db = dir.startsWith('memory://') ? new PGlite() : new PGlite(dir)
    impl = { kind: 'pglite', query: (t, p) => db.query(t, p), exec: t => db.exec(t), end: () => db.close?.() }
  }
  return impl
}

export async function q(sql, params = []) { return (await init()).query(sql, params) }
export async function dbKind() { return (await init()).kind }

// Applique le schéma + colonnes manquantes (idempotent).
export async function ensureSchema() {
  const i = await init()
  await i.exec(SCHEMA_SQL())
  // garde-fous si une base existait avant l'ajout de colonnes
  await i.exec("alter table saas.clinics add column if not exists activation_code text")
  await i.exec("alter table saas.clinics add column if not exists data_retention_until timestamptz")
  await i.exec("alter table saas.clinics add column if not exists password_hash text")
  await i.exec("alter table saas.clinics add column if not exists address text")
  // Paiements : id plateforme unique + traçabilité MonCash + anti-doublon
  for (const c of ['ref text', 'moncash_order_id text', 'moncash_transaction_id text', 'payer text', 'paid_at timestamptz', 'details jsonb', 'proof_url text'])
    await i.exec(`alter table saas.payments add column if not exists ${c}`)
  await i.exec("create unique index if not exists uq_pay_ref on saas.payments(ref)")
  await i.exec("create unique index if not exists uq_pay_moncash_tx on saas.payments(moncash_transaction_id) where moncash_transaction_id is not null")
  await i.exec("alter table saas.admins add column if not exists blocked boolean not null default false")
}

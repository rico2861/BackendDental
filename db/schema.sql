-- ═══════════════════════════════════════════════════════════════════════════
--  DENTAL — Base de la plateforme SaaS (console d'administration)
--  Postgres / Supabase. C'est la SOURCE DE VÉRITÉ côté serveur : qui est
--  abonné, quelles licences sont émises, quels hôtes sont activés, l'état des
--  sauvegardes et des paiements. L'app clinique, elle, ne voit jamais ces tables.
--
--  À appliquer sur le projet Supabase du SaaS :  psql "$SAAS_DB_URL" -f schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists saas;
set search_path to saas;

-- ─── Cliniques (les abonnés) ────────────────────────────────────────────────
create table if not exists clinics (
  -- ID court, unique, SÛR comme nom de schéma Postgres : minuscules + chiffres,
  -- sans tiret ni majuscule (ex. 'c7f3a9'). D'où backup_schema = 'clinic_c7f3a9'.
  id            text primary key check (id ~ '^[a-z0-9]{4,20}$'),
  name          text not null,
  email         text not null unique,
  phone         text,
  city          text,
  status        text not null default 'trial',    -- trial | active | grace | expired | suspended | cancelled
  -- Personnalisation renvoyée à l'app (couleur, nom affiché, logo)
  brand_color   text default '#12408f',
  display_name  text,
  logo_url      text,
  -- Code d'activation remis à la clinique (saisi dans l'app pour activer un poste)
  activation_code text unique,
  -- Mot de passe du compte client (bcrypt). NULL = compte créé par la console (sans portail).
  password_hash text,
  -- Isolation des données de sauvegarde : schéma dédié dans le Supabase de sauvegarde
  backup_schema text generated always as ('clinic_' || id) stored,
  -- Conservation des données après blocage (90 jours) : rien n'est supprimé avant cette date
  data_retention_until timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── Abonnements / droits (ce que la clinique a payé) ───────────────────────
-- Un abonnement = une période payée (ou l'essai). seats = nombre d'hôtes permis.
create table if not exists subscriptions (
  id            bigserial primary key,
  clinic_id     text not null references clinics(id) on delete cascade,
  plan          text not null,                    -- trial | 1m | 1y
  seats         int  not null default 2,          -- nombre d'hôtes autorisés (voir hosts)
  period_start  timestamptz not null default now(),
  period_end    timestamptz not null,
  status        text not null default 'active',   -- active | grace | expired | cancelled
  grace_days    int  not null default 3,
  payment_id    bigint,                           -- paiement qui l'a ouverte (null pour l'essai)
  created_at    timestamptz not null default now()
);
create index if not exists idx_sub_clinic on subscriptions(clinic_id);
create index if not exists idx_sub_end    on subscriptions(period_end);

-- ─── Hôtes (les PC serveurs installés d'une clinique) ───────────────────────
-- Chaque PC qui fait tourner l'app s'active une fois en ligne : il consomme un
-- siège. Les tablettes/téléphones qui se connectent en navigateur sur le LAN
-- ne sont PAS des hôtes et ne consomment pas de siège.
create table if not exists hosts (
  id            bigserial primary key,
  clinic_id     text not null references clinics(id) on delete cascade,
  fingerprint   text not null,                    -- empreinte machine (anti-copie)
  hostname      text,
  app_version   text,
  status        text not null default 'active',   -- active | revoked
  activated_at  timestamptz not null default now(),
  last_seen_at  timestamptz,                       -- dernier contrôle en ligne de l'app
  unique (clinic_id, fingerprint)
);
create index if not exists idx_hosts_clinic on hosts(clinic_id);

-- ─── Licences émises (jetons d'activation signés) ───────────────────────────
-- Une ligne par jeton remis à un hôte. Sert à la RÉVOCATION : si revoked = true,
-- l'app est bloquée dès son prochain contrôle en ligne, même si le jeton local
-- n'est pas encore expiré (coupure à distance).
create table if not exists licenses (
  lid           text primary key,                 -- = payload.lid du jeton signé
  clinic_id     text not null references clinics(id) on delete cascade,
  host_id       bigint references hosts(id) on delete set null,
  subscription_id bigint references subscriptions(id) on delete set null,
  plan          text not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked       boolean not null default false,
  revoked_at    timestamptz,
  revoked_reason text
);
create index if not exists idx_lic_clinic  on licenses(clinic_id);
create index if not exists idx_lic_revoked on licenses(revoked);

-- ─── Paiements ──────────────────────────────────────────────────────────────
-- MonCash (confirmé automatiquement par webhook) ou virement (confirmé à la
-- main depuis la console). Un paiement confirmé ouvre un abonnement + une clé.
create table if not exists payments (
  id            bigserial primary key,
  clinic_id     text not null references clinics(id) on delete cascade,
  method        text not null,                    -- moncash | virement
  plan          text not null,                    -- 1m | 1y
  amount        numeric(12,2) not null,
  currency      text not null default 'HTG',
  reference     text,                             -- n° de transaction MonCash / référence du virement
  status        text not null default 'pending',  -- pending | confirmed | rejected
  confirmed_by  text,                             -- admin ayant confirmé (virement)
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_pay_clinic on payments(clinic_id);
create index if not exists idx_pay_status on payments(status);

-- ─── Clés de licence remises au client (après paiement / essai) ─────────────
-- LA clé FORTE que le client saisit dans le logiciel. Lettres+chiffres aléatoires
-- (alphabet sans caractères ambigus), unique, ~100 bits d'entropie. Générée
-- UNIQUEMENT après paiement confirmé (ou à l'ouverture de l'essai gratuit),
-- jamais avant. Horodatée début → fin.
create table if not exists license_keys (
  key          text primary key,                   -- ex. DNTL-XXXXX-XXXXX-XXXXX-XXXXX
  clinic_id    text not null references clinics(id) on delete cascade,
  plan         text not null,                       -- trial | 1m | 1y
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz not null,
  status       text not null default 'active',      -- active | expired | revoked
  payment_id   bigint references payments(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_lk_clinic on license_keys(clinic_id, created_at desc);

-- ─── Registre des sauvegardes (pour « voir si la sauvegarde a réussi ») ──────
create table if not exists backups (
  id            bigserial primary key,
  clinic_id     text not null references clinics(id) on delete cascade,
  host_id       bigint references hosts(id) on delete set null,
  created_at    timestamptz not null default now(),
  size_bytes    bigint,
  sha256        text,
  verified      boolean not null default false,   -- sauvegarde vérifiée (intègre) ?
  location      text                              -- ex. 'supabase:clinic_7F3A.dl_backups'
);
create index if not exists idx_bak_clinic on backups(clinic_id, created_at desc);

-- ─── Journal d'activité (fil visible dans la console) ───────────────────────
create table if not exists events (
  id            bigserial primary key,
  clinic_id     text references clinics(id) on delete cascade,
  type          text not null,                    -- activation | check | backup | payment | block | renew …
  data          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists idx_evt_clinic on events(clinic_id, created_at desc);

-- ─── Comptes admin de la console ────────────────────────────────────────────
create table if not exists admins (
  id            bigserial primary key,
  email         text not null unique,
  password_hash text not null,                    -- argon2/bcrypt
  role          text not null default 'owner',    -- owner | staff
  created_at    timestamptz not null default now()
);

-- ─── Vue pratique : état courant de chaque clinique ─────────────────────────
create or replace view clinic_overview as
select
  c.id, c.name, c.email, c.status, c.backup_schema,
  s.plan, s.seats, s.period_end,
  (select count(*) from hosts h where h.clinic_id = c.id and h.status = 'active') as hosts_used,
  (select max(b.created_at) from backups b where b.clinic_id = c.id and b.verified) as last_verified_backup
from clinics c
left join lateral (
  select * from subscriptions s2
  where s2.clinic_id = c.id
  order by s2.period_end desc
  limit 1
) s on true;

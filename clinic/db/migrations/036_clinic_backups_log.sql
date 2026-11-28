-- Journal des sauvegardes manuelles (plateforme hébergée)
create table if not exists clinic_backups(
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id),
  created_at timestamptz default now(),
  created_by text,
  bytes bigint,
  tables int,
  row_count int,
  kind text default 'export'
);
create index if not exists clinic_backups_cid on clinic_backups(clinic_id, created_at desc);

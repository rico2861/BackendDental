-- Personnalisation par clinique : logo, e-mail et site, repris sur les documents et les e-mails.
alter table clinics add column if not exists logo text;        -- data URL (image base64) ou URL
alter table clinics add column if not exists email text;       -- e-mail de contact de la clinique
alter table clinics add column if not exists website text;     -- site / page de la clinique

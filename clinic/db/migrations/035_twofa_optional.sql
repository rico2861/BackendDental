-- 2FA en opt-in : plus imposée par défaut. Le propriétaire peut l'activer dans Paramètres → Sécurité.
alter table clinics alter column require_2fa set default false;
update clinics set require_2fa = false;

-- Index complémentaires pour les comptages du tableau de bord (dashboard/owner).
-- Ces requêtes filtrent par clinic_id + statut/état ; sans index elles font un scan
-- (négligeable à petite échelle, utile quand une clinique grossit).
create index if not exists treatment_plans_clinic_status on treatment_plans(clinic_id, status);
create index if not exists prostheses_clinic_step on prostheses(clinic_id, step);
create index if not exists product_lots_clinic_expiry on product_lots(clinic_id, expiry) where qty_remaining > 0;
-- Patients actifs/nouveaux : filtre clinic_id + statut + date d'inscription
create index if not exists patients_clinic_status_reg on patients(clinic_id, status, registered_at);

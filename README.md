# DENTAL LIGHT — Backend SaaS (BackendDental)

Backend **unique** de la plateforme : serveur de licences, base des abonnés, paiements (MonCash + virement), **e-mails transactionnels** (Resend) et API d'administration. Sert aussi les endpoints appelés par le logiciel installé dans les cliniques.

Node.js (Express) · PostgreSQL (Supabase en production, PGlite en local).

## Démarrage local
```bash
npm install
SAAS_ADMIN_EMAIL=vous@exemple.ht SAAS_ADMIN_PASSWORD=motdepasse npm start
# → http://localhost:4000   (PGlite local, aucune base à installer)
```
Copiez `.env.example` → `.env` et remplissez les valeurs.

## Points clés
- **Licences** : signées Ed25519. La clé privée se fournit via `LICENSE_PRIVATE_KEY` (jamais committée). Ne régénérez pas la paire (la clé publique est embarquée dans l'app).
- **MonCash** : `MONCASH_MODE/CLIENT_ID/SECRET/RETURN_URL`. Vérification automatique + confirmation.
- **E-mails** : Resend (`RESEND_API_KEY`), templates personnalisés — bienvenue/essai (avec code), reçu de paiement, rappel d'expiration, blocage (données conservées 90 j).
- **Rétention** : tâche quotidienne (rappels, blocage, conservation 90 jours). Aucune donnée supprimée automatiquement.
- **Frontends séparés** : `CORS_ORIGINS` + `SAAS_CROSS_SITE=true`.

## Endpoints app (appelés par le logiciel clinique)
`POST /api/activate` · `POST /api/check` · `POST /api/signup` · `POST /api/pay/moncash` · `GET /pay/retour` · `POST /api/backups/report` · `GET /api/prices`

## Structure
`src/` (server, core, db, auth, moncash, mail, license-sign) · `shared/license.js` · `db/schema.sql` · `scripts/` (keygen + tests).

Tests : `npm run test:console`, `test:moncash`, `test:license`, `test:trial`, et `node scripts/test-mail.mjs`.

## Déploiement (Railway + Supabase)
1. `SAAS_DB_URL` = Supabase.
2. Variables d'env (`.env.example`), dont `LICENSE_PRIVATE_KEY`, `MONCASH_*`, `RESEND_API_KEY`.
3. Domaine public → `SAAS_URL` du logiciel, `CORS_ORIGINS` pour vitrine/console.

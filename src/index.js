// ═══════════════════════════════════════════════════════════════════════════
//  Dental Assist — SERVICE UNIQUE (un seul backend Render)
//
//  Un seul process, un seul port, deux applications montées côte à côte :
//    •  /saas/*   → cerveau SaaS (licences, paiements, console, provisioning)
//    •  /*        → logiciel clinique (API + interface web), à la racine
//
//  Les deux parlent à la même base Supabase, dans des schémas séparés
//  (saas / app) : aucune collision. Les cookies sont distincts (dlsaas / dl).
//
//  MOUNTED=1 est posé AVANT d'importer les apps (imports dynamiques) pour que
//  chacune n'ouvre PAS son propre port : c'est ce fichier qui écoute.
// ═══════════════════════════════════════════════════════════════════════════
process.env.MOUNTED = '1'

const express = (await import('express')).default
const { app: saasApp, init: saasInit } = await import('./server.js')     // SaaS (schéma saas)
const { app: clinicApp } = await import('../clinic/backend/src/server.js') // clinique (schéma app)

const PORT = process.env.PORT || process.env.SAAS_PORT || 3000
const root = express()

// Sonde de santé pour l'hébergeur
root.get('/healthz', (_req, res) => res.type('text').send('ok'))

// Le SaaS d'abord (préfixe /saas), puis le clinique à la racine.
root.use('/saas', saasApp)
root.use('/', clinicApp)

// Tâches de fond du SaaS (admin, entretien quotidien, vérif MonCash) sans écouter de port.
await saasInit()

root.listen(PORT, () => {
  console.log('Dental Assist — service unique sur le port ' + PORT)
  console.log('  SaaS      : /saas/*')
  console.log('  Logiciel  : /*')
})

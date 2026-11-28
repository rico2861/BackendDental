// Sauvegardes sur la plateforme hébergée (Postgres/Supabase) : export SQL manuel,
// téléchargement, journal, et restauration par téléversement — le tout limité à la
// clinique de l'utilisateur (données isolées). Format : .sql portable (données en JSON
// base64 réinjectées via json_populate_recordset → sûr pour tous les types).
const EXCL = new Set(['login_codes', 'user_sessions', 'intel_results', 'intel_metrics', 'notification_reads', 'password_resets'])
const INS = /INSERT INTO app\."([a-z_]+)" SELECT \* FROM json_populate_recordset\(NULL::app\."([a-z_]+)", convert_from\(decode\('([A-Za-z0-9+/=]+)','base64'\),'UTF8'\)::json\);/g

export default function (app, { pool, q, need, audit, fail, wrap }) {
  if (!process.env.DATABASE_URL) return   // uniquement en mode hébergé (Postgres)
  const owner = (req, res) => req.user.role === 'OWNER' ? true : (fail(res, 403, 'Réservé au propriétaire'), false)
  const tableList = async () => (await q("select table_name t from information_schema.columns where table_schema='app' and column_name='clinic_id'")).rows.map(r => r.t).filter(t => !EXCL.has(t)).sort()

  // Journal des sauvegardes
  app.get('/api/backups-hosted', need(), wrap(async (req, res) => {
    if (!owner(req, res)) return
    res.json((await q('select id,created_at,created_by,bytes,tables,row_count,kind from clinic_backups where clinic_id=$1 order by created_at desc limit 100', [req.user.clinic_id])).rows)
  }))

  // Créer une sauvegarde : génère le .sql des données de la clinique, journalise, renvoie le contenu à télécharger
  app.post('/api/backups-hosted', need(), wrap(async (req, res) => {
    if (!owner(req, res)) return
    const cid = req.user.clinic_id, tables = await tableList()
    const parts = [`-- Dental Assist — sauvegarde clinique`, `-- clinique: ${cid}`, `-- date: ${new Date().toISOString()}`, 'BEGIN;', 'SET session_replication_role = replica;']
    const counts = {}; let total = 0
    for (const t of tables) {
      const r = (await q(`select coalesce(json_agg(x),'[]'::json) j, count(*)::int n from (select * from app."${t}" where clinic_id=$1) x`, [cid])).rows[0]
      counts[t] = r.n; total += r.n
      parts.push(`\nDELETE FROM app."${t}" WHERE clinic_id = '${cid}';`)
      if (r.n) { const b64 = Buffer.from(JSON.stringify(r.j), 'utf8').toString('base64'); parts.push(`INSERT INTO app."${t}" SELECT * FROM json_populate_recordset(NULL::app."${t}", convert_from(decode('${b64}','base64'),'UTF8')::json);`) }
    }
    parts.push('\nSET session_replication_role = DEFAULT;', 'COMMIT;', '')
    const sql = parts.join('\n'), bytes = Buffer.byteLength(sql)
    const id = (await q('insert into clinic_backups(clinic_id,created_by,bytes,tables,row_count,kind) values($1,$2,$3,$4,$5,$6) returning id', [cid, `${req.user.first_name} ${req.user.last_name}`, bytes, Object.keys(counts).length, total, 'export'])).rows[0].id
    await audit(req, 'BACKUP_EXPORT', 'clinic_backups', id, { bytes, total })
    res.json({ id, sql, filename: `dental-sauvegarde-${new Date().toISOString().slice(0, 10)}.sql`, bytes, total, tables: counts })
  }))

  // Restaurer depuis un fichier téléversé : validé et limité à la clinique courante (aucune exécution de SQL arbitraire)
  app.post('/api/backups-hosted/restore', need(), wrap(async (req, res) => {
    if (!owner(req, res)) return
    const cid = req.user.clinic_id, sql = String(req.body?.sql || '')
    if (!/Dental Assist — sauvegarde/.test(sql)) return fail(res, 400, 'Fichier non reconnu : ce n\'est pas une sauvegarde Dental Assist.')
    const allow = new Set(await tableList()); const items = []; let m
    INS.lastIndex = 0
    while ((m = INS.exec(sql))) {
      if (m[1] !== m[2] || !allow.has(m[1])) return fail(res, 400, 'Table non autorisée dans le fichier : ' + m[1])
      let data; try { data = JSON.parse(Buffer.from(m[3], 'base64').toString('utf8')) } catch { return fail(res, 400, 'Données illisibles pour ' + m[1]) }
      if (!Array.isArray(data)) return fail(res, 400, 'Format invalide pour ' + m[1])
      for (const row of data) if (row && row.clinic_id && row.clinic_id !== cid) return fail(res, 403, 'Cette sauvegarde appartient à une autre clinique.')
      items.push([m[1], data])
    }
    if (!items.length) return fail(res, 400, 'Aucune donnée exploitable dans ce fichier.')
    const c = await pool.connect()
    try {
      await c.query('begin'); await c.query('set session_replication_role = replica')
      for (const [t] of items) await c.query(`delete from app."${t}" where clinic_id=$1`, [cid])
      for (const [t, data] of items) if (data.length) await c.query(`insert into app."${t}" select * from json_populate_recordset(NULL::app."${t}", $1::json)`, [JSON.stringify(data)])
      await c.query('set session_replication_role = default'); await c.query('commit')
    } catch (e) { await c.query('rollback').catch(() => {}); return fail(res, 500, 'Restauration annulée, aucune donnée perdue : ' + e.message) } finally { c.release() }
    await audit(req, 'BACKUP_RESTORE', 'clinic_backups', null, { tables: items.length })
    res.json({ ok: true, tables: items.length })
  }))
}

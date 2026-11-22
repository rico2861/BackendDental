// ═══════════════════════════════════════════════════════════════════════════
//  Cloudflare R2 (compatible S3) — stockage des preuves de virement.
//  Clés reprises de l'environnement (R2_*), comme sur BackendDealPam.
//  Rien n'est public : l'admin consulte via une URL signée temporaire.
// ═══════════════════════════════════════════════════════════════════════════
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const env = k => process.env[k]
function cfg() {
  const accountId = env('R2_ACCOUNT_ID')
  const endpoint = (env('R2_ENDPOINT') || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '')
  return {
    endpoint,
    bucket: env('R2_DOCS_BUCKET_NAME') || env('R2_BUCKET_NAME'),
    ak: env('R2_ACCESS_KEY_ID'),
    sk: env('R2_SECRET_ACCESS_KEY')
  }
}
export function r2Ready() { const c = cfg(); return !!(c.endpoint && c.bucket && c.ak && c.sk) }

let _client
function client() {
  const c = cfg()
  if (!_client) _client = new S3Client({ region: 'auto', endpoint: c.endpoint, credentials: { accessKeyId: c.ak, secretAccessKey: c.sk }, forcePathStyle: true })
  return _client
}

// Dépose un objet (Buffer) et renvoie sa clé.
export async function putObject(key, body, contentType = 'application/octet-stream') {
  if (!r2Ready()) throw new Error('Stockage R2 non configuré')
  await client().send(new PutObjectCommand({ Bucket: cfg().bucket, Key: key, Body: body, ContentType: contentType }))
  return key
}

// URL signée temporaire pour consulter un objet (admin).
export async function presignGet(key, expiresIn = 600) {
  if (!r2Ready() || !key) return null
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: cfg().bucket, Key: key }), { expiresIn })
}

export async function deleteObject(key) {
  if (!r2Ready() || !key) return
  try { await client().send(new DeleteObjectCommand({ Bucket: cfg().bucket, Key: key })) } catch {}
}

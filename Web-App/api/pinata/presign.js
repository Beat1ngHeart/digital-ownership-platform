import { PinataSDK } from 'pinata'

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
const DEFAULT_EXPIRY_SECONDS = 60
const MIN_EXPIRY_SECONDS = 15
const MAX_EXPIRY_SECONDS = 600
const MAX_METADATA_BYTES = 512 * 1024
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const ALLOWED_UPLOAD_KINDS = new Set(['content', 'preview', 'metadata'])

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function normalizeUploadKind(kind) {
  const normalized = String(kind || 'content').trim().toLowerCase()
  return ALLOWED_UPLOAD_KINDS.has(normalized) ? normalized : null
}

function normalizeAllowedOrigins() {
  return String(process.env.UPLOAD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function allowsOpenOriginForLocalDev() {
  return process.env.UPLOAD_ALLOW_ANY_ORIGIN === 'true'
}

function resolveCorsOrigin(requestOrigin, allowedOrigins) {
  if (!requestOrigin) return ''
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin
  if (allowedOrigins.length === 0 && allowsOpenOriginForLocalDev()) return requestOrigin
  return ''
}

function applyCorsHeaders(response, corsOrigin) {
  if (!corsOrigin) return

  response.setHeader('Access-Control-Allow-Origin', corsOrigin)
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Vary', 'Origin')
}

function sanitizeFileName(fileName) {
  const trimmed = String(fileName || 'upload.bin').trim() || 'upload.bin'
  return trimmed.replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 120)
}

function isAllowedMimeType(contentType) {
  const normalized = String(contentType || '').trim().toLowerCase().split(';')[0]
  if (!normalized) return true

  return (
    normalized.startsWith('image/') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    normalized.startsWith('text/') ||
    [
      'application/json',
      'application/pdf',
      'application/octet-stream',
      'application/epub+zip',
      'application/zip',
    ].includes(normalized)
  )
}

function resolveMaxFileBytes(kind, configuredMaxFileBytes) {
  if (kind === 'metadata') return Math.min(configuredMaxFileBytes, MAX_METADATA_BYTES)
  if (kind === 'preview') return Math.min(configuredMaxFileBytes, MAX_PREVIEW_BYTES)
  return configuredMaxFileBytes
}

function resolveContentNetwork(value) {
  return String(value || '').trim().toLowerCase() === 'private' ? 'private' : 'public'
}

function resolveUploadNetwork(kind, contentNetwork) {
  if (kind === 'content') {
    return resolveContentNetwork(contentNetwork)
  }

  return 'public'
}

function createPinataClient(pinataJwt) {
  return new PinataSDK({
    pinataJwt,
  })
}

async function createSignedUploadUrl(pinata, { network, date, expires, fileName, maxFileSize, mimeTypes, keyvalues }) {
  const uploader = network === 'private' ? pinata.upload.private : pinata.upload.public

  return uploader.createSignedURL({
    date,
    expires,
    name: fileName,
    maxFileSize,
    ...(mimeTypes.length > 0 ? { mimeTypes } : {}),
    keyvalues,
  })
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store')

  const allowedOrigins = normalizeAllowedOrigins()
  const requestOrigin = String(request.headers.origin || '')
  const corsOrigin = resolveCorsOrigin(requestOrigin, allowedOrigins)

  applyCorsHeaders(response, corsOrigin)

  if (requestOrigin && !corsOrigin) {
    return response.status(403).json({
      error: 'Origin not allowed for upload signing. Configure UPLOAD_ALLOWED_ORIGINS or set UPLOAD_ALLOW_ANY_ORIGIN=true for local development only.',
    })
  }

  if (request.method === 'OPTIONS') {
    response.setHeader('Allow', 'POST, OPTIONS')
    return response.status(204).end()
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST, OPTIONS')
    return response.status(405).json({ error: 'Method not allowed' })
  }

  if (!process.env.PINATA_JWT) {
    return response.status(500).json({
      error: 'Missing server-side PINATA_JWT. Configure it in Vercel project settings.',
    })
  }

  let body

  try {
    body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body || {}
  } catch {
    return response.status(400).json({ error: 'Invalid JSON payload.' })
  }

  const fileName = sanitizeFileName(body.fileName)
  const contentType = String(body.contentType || '').trim()
  const kind = normalizeUploadKind(body.kind)
  const size = Number(body.size || 0)
  const configuredMaxFileBytes = normalizePositiveNumber(process.env.PINATA_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES)
  const expirySeconds = clamp(
    normalizePositiveNumber(process.env.PINATA_PRESIGN_TTL, DEFAULT_EXPIRY_SECONDS),
    MIN_EXPIRY_SECONDS,
    MAX_EXPIRY_SECONDS,
  )
  const signedAt = Math.floor(Date.now() / 1000)

  if (!kind) {
    return response.status(400).json({ error: 'Invalid upload kind.' })
  }

  const network = resolveUploadNetwork(kind, process.env.PINATA_CONTENT_NETWORK)
  const maxFileBytes = resolveMaxFileBytes(kind, configuredMaxFileBytes)

  if (!Number.isFinite(size) || size <= 0) {
    return response.status(400).json({ error: 'Invalid upload size.' })
  }

  if (size > maxFileBytes) {
    return response.status(400).json({
      error: `File exceeds ${Math.round(maxFileBytes / (1024 * 1024))} MB upload limit.`,
    })
  }

  if (!isAllowedMimeType(contentType)) {
    return response.status(400).json({ error: `Unsupported content type: ${contentType}` })
  }

  try {
    const pinata = createPinataClient(process.env.PINATA_JWT)
    const signedUrl = await createSignedUploadUrl(pinata, {
      network,
      date: signedAt,
      expires: expirySeconds,
      fileName,
      maxFileSize: size,
      mimeTypes: contentType ? [contentType] : [],
      keyvalues: {
        app: 'content-certificate-market',
        kind,
        network,
      },
    })

    return response.status(200).json({ url: signedUrl, network })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown signing error.'
    return response.status(502).json({ error: `Pinata signing failed: ${message}` })
  }
}

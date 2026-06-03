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

function json(value, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')

  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  })
}

function normalizeAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function allowsOpenOriginForLocalDev(env) {
  return env.UPLOAD_ALLOW_ANY_ORIGIN === 'true'
}

function resolveCorsOrigin(requestOrigin, allowedOrigins, env) {
  if (!requestOrigin) return ''
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin
  if (allowedOrigins.length === 0 && allowsOpenOriginForLocalDev(env)) return requestOrigin
  return ''
}

function buildCorsHeaders(corsOrigin) {
  if (!corsOrigin) return {}

  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
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

export async function onRequestPost(context) {
  const { request, env } = context
  const allowedOrigins = normalizeAllowedOrigins(env.UPLOAD_ALLOWED_ORIGINS)
  const requestOrigin = String(request.headers.get('Origin') || '')
  const corsOrigin = resolveCorsOrigin(requestOrigin, allowedOrigins, env)
  const responseHeaders = buildCorsHeaders(corsOrigin)

  if (requestOrigin && !corsOrigin) {
    return json(
      {
        error: 'Origin not allowed for upload signing. Configure UPLOAD_ALLOWED_ORIGINS or set UPLOAD_ALLOW_ANY_ORIGIN=true for local development only.',
      },
      { status: 403 },
    )
  }

  if (!env.PINATA_JWT) {
    return json(
      {
        error: 'Missing server-side PINATA_JWT. Configure it in Cloudflare Pages Variables and Secrets.',
      },
      { status: 500, headers: responseHeaders },
    )
  }

  let body

  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON payload.' }, { status: 400, headers: responseHeaders })
  }

  const fileName = sanitizeFileName(body.fileName)
  const contentType = String(body.contentType || '').trim()
  const kind = normalizeUploadKind(body.kind)
  const size = Number(body.size || 0)
  const configuredMaxFileBytes = normalizePositiveNumber(env.PINATA_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES)
  const expirySeconds = clamp(
    normalizePositiveNumber(env.PINATA_PRESIGN_TTL, DEFAULT_EXPIRY_SECONDS),
    MIN_EXPIRY_SECONDS,
    MAX_EXPIRY_SECONDS,
  )
  const signedAt = Math.floor(Date.now() / 1000)

  if (!kind) {
    return json({ error: 'Invalid upload kind.' }, { status: 400, headers: responseHeaders })
  }

  const network = resolveUploadNetwork(kind, env.PINATA_CONTENT_NETWORK)
  const maxFileBytes = resolveMaxFileBytes(kind, configuredMaxFileBytes)

  if (!Number.isFinite(size) || size <= 0) {
    return json({ error: 'Invalid upload size.' }, { status: 400, headers: responseHeaders })
  }

  if (size > maxFileBytes) {
    return json(
      {
        error: `File exceeds ${Math.round(maxFileBytes / (1024 * 1024))} MB upload limit.`,
      },
      { status: 400, headers: responseHeaders },
    )
  }

  if (!isAllowedMimeType(contentType)) {
    return json({ error: `Unsupported content type: ${contentType}` }, { status: 400, headers: responseHeaders })
  }

  try {
    const pinata = createPinataClient(env.PINATA_JWT)
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

    return json({ url: signedUrl, network }, { headers: responseHeaders })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown signing error.'
    return json({ error: `Pinata signing failed: ${message}` }, { status: 502, headers: responseHeaders })
  }
}

export function onRequestOptions(context) {
  const { request, env } = context
  const allowedOrigins = normalizeAllowedOrigins(env.UPLOAD_ALLOWED_ORIGINS)
  const requestOrigin = String(request.headers.get('Origin') || '')
  const corsOrigin = resolveCorsOrigin(requestOrigin, allowedOrigins, env)

  if (requestOrigin && !corsOrigin) {
    return json(
      {
        error: 'Origin not allowed for upload signing. Configure UPLOAD_ALLOWED_ORIGINS or set UPLOAD_ALLOW_ANY_ORIGIN=true for local development only.',
      },
      { status: 403 },
    )
  }

  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Cache-Control': 'no-store',
      ...buildCorsHeaders(corsOrigin),
    },
  })
}

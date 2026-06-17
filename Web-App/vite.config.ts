import { PinataSDK } from 'pinata'
import { defineConfig, loadEnv } from 'vite'

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
const DEFAULT_EXPIRY_SECONDS = 60
const MIN_EXPIRY_SECONDS = 15
const MAX_EXPIRY_SECONDS = 600
const MAX_METADATA_BYTES = 512 * 1024
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const ALLOWED_UPLOAD_KINDS = new Set(['content', 'preview', 'metadata'])
const DEFAULT_LOCAL_IPFS_API_URL = 'http://127.0.0.1:5001'
const DEFAULT_LOCAL_IPFS_GATEWAY_BASE = 'http://127.0.0.1:8080/ipfs'

function normalizePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function normalizeUploadKind(kind: unknown) {
  const normalized = String(kind || 'content').trim().toLowerCase()
  return ALLOWED_UPLOAD_KINDS.has(normalized) ? normalized : null
}

function sanitizeFileName(fileName: unknown) {
  const trimmed = String(fileName || 'upload.bin').trim() || 'upload.bin'
  return trimmed.replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 120)
}

function isAllowedMimeType(contentType: string) {
  const normalized = contentType.trim().toLowerCase().split(';')[0]
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

function resolveContentNetwork(value: string | undefined) {
  return String(value || '').trim().toLowerCase() === 'private' ? 'private' : 'public'
}

function resolveUploadNetwork(kind: string, contentNetwork: string | undefined) {
  return kind === 'content' ? resolveContentNetwork(contentNetwork) : 'public'
}

function resolveMaxFileBytes(kind: string, configuredMaxFileBytes: number) {
  if (kind === 'metadata') return Math.min(configuredMaxFileBytes, MAX_METADATA_BYTES)
  if (kind === 'preview') return Math.min(configuredMaxFileBytes, MAX_PREVIEW_BYTES)
  return configuredMaxFileBytes
}

function sendJson(response: any, statusCode: number, value: object) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

async function readRawBody(request: any) {
  const chunks: Uint8Array[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
  }

  return Buffer.concat(chunks)
}

async function readJsonBody(request: any) {
  const rawBody = (await readRawBody(request)).toString('utf8')
  return rawBody ? JSON.parse(rawBody) : {}
}

function normalizeBaseUrl(value: string | undefined, fallback: string) {
  const baseUrl = String(value || fallback).trim()
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value || ''
}

function parseKuboAddResponse(rawText: string) {
  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const payload = JSON.parse(lines[index]) as {
        Hash?: string
        cid?: string
      }
      const cid = payload.Hash || payload.cid

      if (cid) return cid
    } catch {
      continue
    }
  }

  return null
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    server: {
      port: 5173,
    },
    plugins: [
      {
        name: 'local-dev-api',
        configureServer(server) {
        server.middlewares.use('/api/ipfs/add', async (request, response) => {
          if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST')
            sendJson(response, 405, { error: 'Method not allowed' })
            return
          }

          const contentType = firstHeaderValue(request.headers['content-type'])

          if (!contentType.includes('multipart/form-data')) {
            sendJson(response, 400, { error: 'Expected multipart/form-data upload.' })
            return
          }

          const rawBody = await readRawBody(request)
          const maxFileBytes = normalizePositiveNumber(
            env.LOCAL_IPFS_MAX_FILE_BYTES || env.PINATA_MAX_FILE_BYTES,
            DEFAULT_MAX_FILE_BYTES,
          )

          if (rawBody.byteLength <= 0) {
            sendJson(response, 400, { error: 'Empty upload body.' })
            return
          }

          if (rawBody.byteLength > maxFileBytes) {
            sendJson(response, 400, {
              error: `File exceeds ${Math.round(maxFileBytes / (1024 * 1024))} MB upload limit.`,
            })
            return
          }

          try {
            const ipfsApiBase = normalizeBaseUrl(env.LOCAL_IPFS_API_URL, DEFAULT_LOCAL_IPFS_API_URL)
            const gatewayBase = normalizeBaseUrl(
              env.VITE_IPFS_GATEWAY_BASE,
              DEFAULT_LOCAL_IPFS_GATEWAY_BASE,
            )
            const addUrl = `${ipfsApiBase}/api/v0/add?pin=true&cid-version=1&wrap-with-directory=false`
            const ipfsResponse = await fetch(addUrl, {
              method: 'POST',
              headers: {
                'Content-Type': contentType,
              },
              body: rawBody,
            })
            const rawText = await ipfsResponse.text()

            if (!ipfsResponse.ok) {
              sendJson(response, ipfsResponse.status, {
                error: `Local IPFS add failed: ${rawText}`,
              })
              return
            }

            const cid = parseKuboAddResponse(rawText)

            if (!cid) {
              sendJson(response, 502, {
                error: `Local IPFS add did not return a CID: ${rawText}`,
              })
              return
            }

            // Also copy into MFS so IPFS Desktop "Files" tab can display it
            try {
              const mfsPath = `/数字内容平台/${cid}`
              const cpUrl = `${ipfsApiBase}/api/v0/files/cp?arg=${encodeURIComponent(`/ipfs/${cid}`)}&arg=${encodeURIComponent(mfsPath)}&parents=true`
              await fetch(cpUrl, { method: 'POST' })
            } catch {
              // Non-fatal: file is still pinned even if MFS copy fails
            }

            sendJson(response, 200, {
              cid,
              Hash: cid,
              url: `${gatewayBase}/${cid}`,
              ipfsUri: `ipfs://${cid}`,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown IPFS error.'
            sendJson(response, 502, {
              error: `Local IPFS API unavailable. Keep IPFS Desktop running and check LOCAL_IPFS_API_URL. ${message}`,
            })
          }
        })

        server.middlewares.use('/api/pinata/presign', async (request, response) => {
          if (request.method === 'OPTIONS') {
            response.statusCode = 204
            response.setHeader('Allow', 'POST, OPTIONS')
            response.end()
            return
          }

          if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST, OPTIONS')
            sendJson(response, 405, { error: 'Method not allowed' })
            return
          }

          if (!env.PINATA_JWT) {
            sendJson(response, 500, {
              error:
                'Missing local server-side PINATA_JWT. Add PINATA_JWT to Web-App/.env.local, or use VITE_PINATA_JWT for local-only direct browser uploads.',
            })
            return
          }

          let body: Record<string, unknown>

          try {
            body = await readJsonBody(request)
          } catch {
            sendJson(response, 400, { error: 'Invalid JSON payload.' })
            return
          }

          const fileName = sanitizeFileName(body.fileName)
          const contentType = String(body.contentType || '').trim()
          const kind = normalizeUploadKind(body.kind)

          if (!kind) {
            sendJson(response, 400, { error: 'Invalid upload kind.' })
            return
          }

          const size = Number(body.size || 0)
          const configuredMaxFileBytes = normalizePositiveNumber(
            env.PINATA_MAX_FILE_BYTES,
            DEFAULT_MAX_FILE_BYTES,
          )
          const maxFileBytes = resolveMaxFileBytes(kind, configuredMaxFileBytes)

          if (!Number.isFinite(size) || size <= 0) {
            sendJson(response, 400, { error: 'Invalid upload size.' })
            return
          }

          if (size > maxFileBytes) {
            sendJson(response, 400, {
              error: `File exceeds ${Math.round(maxFileBytes / (1024 * 1024))} MB upload limit.`,
            })
            return
          }

          if (!isAllowedMimeType(contentType)) {
            sendJson(response, 400, { error: `Unsupported content type: ${contentType}` })
            return
          }

          try {
            const network = resolveUploadNetwork(kind, env.PINATA_CONTENT_NETWORK)
            const pinata = new PinataSDK({ pinataJwt: env.PINATA_JWT })
            const uploader = network === 'private' ? pinata.upload.private : pinata.upload.public
            const signedUrl = await uploader.createSignedURL({
              date: Math.floor(Date.now() / 1000),
              expires: clamp(
                normalizePositiveNumber(env.PINATA_PRESIGN_TTL, DEFAULT_EXPIRY_SECONDS),
                MIN_EXPIRY_SECONDS,
                MAX_EXPIRY_SECONDS,
              ),
              name: fileName,
              maxFileSize: size,
              ...(contentType ? { mimeTypes: [contentType] } : {}),
              keyvalues: {
                app: 'content-certificate-market',
                kind,
                network,
              },
            })

            sendJson(response, 200, { url: signedUrl, network })
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown signing error.'
            sendJson(response, 502, { error: `Pinata signing failed: ${message}` })
          }
        })
        },
      },
    ],
  }
})

export type PinataCredentials = {
  pinataJWT?: string
  pinataKey?: string
  pinataSecret?: string
}

export type IPFSUploadResult = {
  cid: string
  url: string
  ipfsUri: string
}

const PINATA_FILE_URL = 'https://uploads.pinata.cloud/v3/files'
const DEFAULT_GATEWAY_BASE = 'https://gateway.pinata.cloud/ipfs'
const LOCAL_GATEWAY_BASE = 'http://127.0.0.1:8080/ipfs'
const FALLBACK_GATEWAY_BASES = [
  'http://127.0.0.1:8080/ipfs',
  'https://gateway.pinata.cloud/ipfs',
  'https://cloudflare-ipfs.com/ipfs',
  'https://ipfs.io/ipfs',
  'https://dweb.link/ipfs',
]
const PRESIGN_ENDPOINT = import.meta.env.VITE_PINATA_PRESIGN_ENDPOINT || '/api/pinata/presign'
const LOCAL_IPFS_UPLOAD_ENDPOINT = import.meta.env.VITE_LOCAL_IPFS_UPLOAD_ENDPOINT || '/api/ipfs/add'

type UploadKind = 'content' | 'preview' | 'metadata'
type UploadNetwork = 'public' | 'private'
type UploadProvider = 'pinata' | 'local'

type PresignRequestPayload = {
  fileName: string
  contentType: string
  size: number
  kind: UploadKind
}

type PresignResponsePayload = {
  url?: string
}

type UploadApiResponse =
  | {
      IpfsHash?: string
      Hash?: string
    }
  | {
      cid?: string
      data?: {
        cid?: string
      }
    }

function buildPinataHeaders(credentials: PinataCredentials) {
  const headers: Record<string, string> = {}

  if (credentials.pinataJWT) {
    headers.Authorization = `Bearer ${credentials.pinataJWT}`
    return headers
  }

  if (credentials.pinataKey && credentials.pinataSecret) {
    headers.pinata_api_key = credentials.pinataKey
    headers.pinata_secret_api_key = credentials.pinataSecret
    return headers
  }

  throw new Error('缺少 Pinata 凭据。请配置 VITE_PINATA_JWT 或 VITE_PINATA_KEY/VITE_PINATA_SECRET。')
}

function resolveUploadProvider(): UploadProvider {
  return String(import.meta.env.VITE_IPFS_UPLOAD_PROVIDER || '').trim().toLowerCase() === 'local'
    ? 'local'
    : 'pinata'
}

export function getPinataCredentialsFromEnv(): PinataCredentials {
  const jwt = import.meta.env.VITE_PINATA_JWT
  const key = import.meta.env.VITE_PINATA_KEY
  const secret = import.meta.env.VITE_PINATA_SECRET

  return {
    ...(jwt ? { pinataJWT: jwt } : {}),
    ...(key ? { pinataKey: key } : {}),
    ...(secret ? { pinataSecret: secret } : {}),
  }
}

export function hasPinataCredentials(credentials: PinataCredentials) {
  return Boolean(credentials.pinataJWT || (credentials.pinataKey && credentials.pinataSecret))
}

function resolveGatewayBase() {
  const configured =
    import.meta.env.VITE_IPFS_GATEWAY_BASE ||
    (resolveUploadProvider() === 'local' ? LOCAL_GATEWAY_BASE : DEFAULT_GATEWAY_BASE)
  return configured.endsWith('/') ? configured.slice(0, -1) : configured
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function parseUploadResponse(payload: UploadApiResponse): IPFSUploadResult {
  const normalizedPayload = payload as {
    IpfsHash?: string
    Hash?: string
    cid?: string
    data?: {
      cid?: string
    }
  }
  const cid =
    normalizedPayload.IpfsHash ||
    normalizedPayload.Hash ||
    normalizedPayload.cid ||
    normalizedPayload.data?.cid

  if (!cid) {
    throw new Error('IPFS 上传已完成，但没有返回 CID。')
  }

  const gatewayBase = resolveGatewayBase()

  return {
    cid,
    url: `${gatewayBase}/${cid}`,
    ipfsUri: `ipfs://${cid}`,
  }
}

function normalizeUploadNetwork(value: string | undefined): UploadNetwork {
  return String(value || '').trim().toLowerCase() === 'private' ? 'private' : 'public'
}

function resolveUploadNetwork(kind: UploadKind): UploadNetwork {
  if (kind !== 'content') return 'public'
  return normalizeUploadNetwork(import.meta.env.VITE_PINATA_CONTENT_NETWORK)
}

async function requestPresignedUploadUrl(payload: PresignRequestPayload) {
  let response: Response

  try {
    response = await fetch(PRESIGN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(
      'Pinata 上传签名接口不可用。本地 Vite 调试可配置 VITE_PINATA_JWT；线上部署请配置 /api 签名接口和服务端 PINATA_JWT。',
      { cause: error },
    )
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Pinata 签名接口失败：${response.status} ${response.statusText} - ${errorText}`)
  }

  const body = (await response.json()) as PresignResponsePayload
  if (!body.url) {
    throw new Error('Pinata 签名接口没有返回上传地址。')
  }

  return body.url
}

async function uploadFileToLocalIpfs(file: File): Promise<IPFSUploadResult> {
  const formData = new FormData()
  formData.append('file', file, file.name)

  const response = await fetch(LOCAL_IPFS_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`本地 IPFS 上传失败：${response.status} ${response.statusText} - ${errorText}`)
  }

  const payload = (await response.json()) as UploadApiResponse
  return parseUploadResponse(payload)
}

export async function uploadFileToPinata(
  file: File,
  credentials: PinataCredentials,
  kind: UploadKind = 'content',
): Promise<IPFSUploadResult> {
  if (resolveUploadProvider() === 'local') {
    return uploadFileToLocalIpfs(file)
  }

  const useDirectClientCredentials = hasPinataCredentials(credentials)
  const headers = useDirectClientCredentials ? buildPinataHeaders(credentials) : {}
  const formData = new FormData()
  formData.append('file', file)

  if (useDirectClientCredentials) {
    formData.append('network', resolveUploadNetwork(kind))
  }

  const uploadEndpoint = useDirectClientCredentials
    ? PINATA_FILE_URL
    : await requestPresignedUploadUrl({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        kind,
      })

  const timeoutMs = kind === 'content' ? 120_000 : 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  console.log(`[IPFS] 开始上传 ${file.name} (${(file.size / 1024).toFixed(1)} KB) 到 ${uploadEndpoint}`)

  try {
    const response = await fetch(uploadEndpoint, {
      method: 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    })

    console.log(`[IPFS] 响应状态: ${response.status}`)

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Pinata 上传失败：${response.status} ${response.statusText} - ${errorText}`)
    }

    const payload = (await response.json()) as UploadApiResponse
    return parseUploadResponse(payload)
  } catch (error) {
    console.error('[IPFS] 上传失败:', error)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Pinata 上传超时（${timeoutMs / 1000}秒）。请检查网络连接或文件大小。`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function uploadJsonToPinata(
  value: object,
  credentials: PinataCredentials,
  fileName = 'metadata.json',
): Promise<IPFSUploadResult> {
  const jsonFile = new File([JSON.stringify(value, null, 2)], fileName, {
    type: 'application/json',
  })

  return uploadFileToPinata(jsonFile, credentials, 'metadata')
}

export function resolveIpfsUri(uri: string) {
  if (!uri) return ''
  if (uri.startsWith('ipfs://')) {
    return `${resolveGatewayBase()}/${uri.slice('ipfs://'.length)}`
  }
  return uri
}

export function resolveIpfsUriCandidates(uri: string) {
  if (!uri) return []
  if (!uri.startsWith('ipfs://')) return [uri]

  const cidPath = uri.slice('ipfs://'.length)
  const gateways = uniqueValues([resolveGatewayBase(), ...FALLBACK_GATEWAY_BASES])
  return gateways.map((gateway) => `${gateway}/${cidPath}`)
}

export async function fetchJsonFromUri<T>(uri: string): Promise<T | null> {
  if (!uri) return null

  const urls = resolveIpfsUriCandidates(uri)
  let lastError: unknown = null

  for (const url of urls) {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`读取 JSON 元数据失败：${url}，状态码 ${response.status}`)
      }

      return (await response.json()) as T
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('无法从 IPFS 读取 JSON 元数据。')
}

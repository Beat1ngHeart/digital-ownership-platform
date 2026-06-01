type AccessKeyPackage = {
  algorithm: 'AES-GCM-256'
  key: string
  fileName: string
  mimeType: string
}

export type EncryptionResult = {
  encryptedFile: File
  accessKey: string
  contentHash: `0x${string}`
  encryptionScheme: 'AES-GCM-256'
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''

  buffer.forEach((value) => {
    binary += String.fromCharCode(value)
  })

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

async function hashBuffer(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hex = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')

  return `0x${hex}` as `0x${string}`
}

export async function encryptFile(file: File): Promise<EncryptionResult> {
  const originalBuffer = await file.arrayBuffer()
  const contentHash = await hashBuffer(originalBuffer)

  const key = await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt'],
  )

  const rawKey = await crypto.subtle.exportKey('raw', key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    originalBuffer,
  )

  const encryptedPayload = new Uint8Array(iv.length + cipherBuffer.byteLength)
  encryptedPayload.set(iv, 0)
  encryptedPayload.set(new Uint8Array(cipherBuffer), iv.length)

  const encryptedFile = new File([encryptedPayload], `${file.name}.enc`, {
    type: 'application/octet-stream',
  })

  const accessKeyPackage: AccessKeyPackage = {
    algorithm: 'AES-GCM-256',
    key: toBase64Url(rawKey),
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
  }

  return {
    encryptedFile,
    accessKey: JSON.stringify(accessKeyPackage, null, 2),
    contentHash,
    encryptionScheme: 'AES-GCM-256',
  }
}

export async function decryptFileFromUrl(url: string, accessKey: string) {
  const parsed = JSON.parse(accessKey) as AccessKeyPackage
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`加密文件下载失败：${response.status}`)
  }

  const payload = new Uint8Array(await response.arrayBuffer())
  const iv = payload.slice(0, 12)
  const cipherBytes = payload.slice(12)
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(parsed.key),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )

  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    cipherBytes,
  )

  return {
    blob: new Blob([plainBuffer], { type: parsed.mimeType }),
    fileName: parsed.fileName,
  }
}

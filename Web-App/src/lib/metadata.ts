type CertificateImageInput = {
  title: string
  contentTypeLabel: string
  creatorAddress: string
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''

  bytes.forEach((value) => {
    binary += String.fromCharCode(value)
  })

  return btoa(binary)
}

function sanitizeForXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function shortenAddress(address: string) {
  if (address.length < 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function buildCertificateImageDataUri(input: CertificateImageInput) {
  const title = sanitizeForXml(input.title || 'Untitled Content')
  const typeLabel = sanitizeForXml(input.contentTypeLabel)
  const creator = sanitizeForXml(shortenAddress(input.creatorAddress))

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" role="img" aria-label="Content certificate">
      <defs>
        <linearGradient id="certificate-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#14532d" />
        </linearGradient>
      </defs>
      <rect width="1200" height="1200" rx="72" fill="url(#certificate-gradient)" />
      <rect x="48" y="48" width="1104" height="1104" rx="56" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="4" />
      <text x="96" y="170" fill="#bbf7d0" font-family="Georgia, serif" font-size="42">内容所有权证书</text>
      <text x="96" y="270" fill="#f8fafc" font-family="Georgia, serif" font-size="88">${title}</text>
      <text x="96" y="374" fill="#cbd5e1" font-family="monospace" font-size="34">类型：${typeLabel}</text>
      <text x="96" y="428" fill="#cbd5e1" font-family="monospace" font-size="34">创作者：${creator}</text>
      <circle cx="930" cy="280" r="150" fill="rgba(255,255,255,0.12)" />
      <circle cx="1020" cy="210" r="88" fill="rgba(187,247,208,0.18)" />
      <path d="M96 930 L1104 930" stroke="rgba(255,255,255,0.24)" stroke-width="3" />
      <text x="96" y="1015" fill="#e2e8f0" font-family="monospace" font-size="30">链上记录所有权，加密源文件存储在 IPFS。</text>
    </svg>
  `.trim()

  const encoded = encodeBase64(new TextEncoder().encode(svg))
  return `data:image/svg+xml;base64,${encoded}`
}

import { formatEther } from 'viem'
import { contentTypeOptions } from '../types/content'

export function shortenAddress(value?: string | null) {
  if (!value) return '未连接'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function formatEth(value: bigint) {
  const numeric = Number(formatEther(value))
  return `${numeric.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: numeric >= 1 ? 4 : 6,
  })} ETH`
}

export function formatTimestamp(seconds: bigint) {
  return new Date(Number(seconds) * 1000).toLocaleString('zh-CN')
}

export function formatBytes(bytes?: number) {
  if (!bytes || Number.isNaN(bytes)) return '未知大小'

  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

export function getContentTypeLabel(index: number) {
  return contentTypeOptions[index] ?? contentTypeOptions[contentTypeOptions.length - 1]
}

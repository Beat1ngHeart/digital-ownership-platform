/**
 * 感知哈希 — 从文件头部字节提取 64-bit 指纹。
 * 不依赖图片解码，瞬间完成。
 */

const SIMILARITY_THRESHOLD = 10

/**
 * 计算文件的快速感知哈希。
 * 读取文件头部 128 字节，通过相邻字节比较生成 64-bit 指纹。
 * @returns 64-bit 哈希值
 */
export async function computePHash(file: File): Promise<bigint> {
  const slice = file.slice(0, 128)
  const buffer = await slice.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  let hash = 0n
  for (let i = 0; i < bytes.length - 1 && i < 64; i++) {
    if (bytes[i] > bytes[i + 1]) {
      hash |= 1n << BigInt(i)
    }
  }

  return hash
}

/**
 * 计算两个感知哈希的汉明距离（不同的 bit 数）。
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b
  let count = 0
  while (xor > 0n) {
    count += Number(xor & 1n)
    xor >>= 1n
  }
  return count
}

/**
 * 检查两个感知哈希是否表示相似内容。
 */
export function isSimilar(a: bigint, b: bigint): boolean {
  if (a === 0n || b === 0n) return false
  return hammingDistance(a, b) <= SIMILARITY_THRESHOLD
}

/**
 * 从已有资产列表中查找与给定 pHash 相似的资产。
 */
export function findSimilarAssets(
  pHash: bigint,
  assets: Array<{ tokenId: bigint; metadata: { name?: string } | null; contractMetadata: { perceptualHash: bigint } }>,
): Array<{ tokenId: bigint; name: string; distance: number }> {
  if (pHash === 0n) return []

  return assets
    .map((asset) => ({
      tokenId: asset.tokenId,
      name: asset.metadata?.name || `证书 #${asset.tokenId.toString()}`,
      distance: hammingDistance(pHash, asset.contractMetadata.perceptualHash),
    }))
    .filter((item) => item.distance <= SIMILARITY_THRESHOLD)
    .sort((a, b) => a.distance - b.distance)
}

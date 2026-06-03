import {
  decodeEventLog,
  formatEther,
  isAddress,
  parseAbiItem,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import artifact from '../contracts/ContentNFTMarketplace.json'
import { fetchJsonFromUri } from './ipfs'
import type {
  AssetMetadata,
  AssetRecord,
  ContractContentMetadata,
  Listing,
  SaleHistoryRecord,
} from '../types/content'

type ArtifactShape = {
  abi: Abi
}

const contractArtifact = artifact as ArtifactShape

export const CONTRACT_ABI = contractArtifact.abi
const SALE_EVENT = parseAbiItem(
  'event Sale(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 royaltyAmount, uint256 platformFeeAmount)',
)
const DEFAULT_ASSET_FETCH_CONCURRENCY = 8

function readConfiguredAddress() {
  const rawAddress =
    import.meta.env.VITE_CONTENT_NFT_ADDRESS || import.meta.env.VITE_CONTRACT_ADDRESS || ''

  return isAddress(rawAddress) ? (rawAddress as Address) : undefined
}

export const CONTRACT_ADDRESS = readConfiguredAddress()

export function hasConfiguredContract() {
  return Boolean(CONTRACT_ADDRESS)
}

export function readRequiredContractAddress() {
  if (!CONTRACT_ADDRESS) {
    throw new Error('请将 VITE_CONTENT_NFT_ADDRESS 设置为已部署的 ContentNFTMarketplace 合约地址。')
  }

  return CONTRACT_ADDRESS
}

function isZeroAddress(value: string) {
  return value.toLowerCase() === zeroAddress
}

export function toContentTypeIndex(value: string) {
  const parsed = Number(value)
  return Number.isNaN(parsed) ? 4 : parsed
}

export function toRoyaltyBps(value: string) {
  const parsed = Number(value || '0')
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
}

function parseContractMetadata(value: unknown): ContractContentMetadata {
  const metadata = value as ContractContentMetadata

  return {
    creator: metadata.creator,
    contentType: Number(metadata.contentType),
    mintedAt: BigInt(metadata.mintedAt),
    metadataURI: metadata.metadataURI,
    encryptedContentURI: metadata.encryptedContentURI,
    previewURI: metadata.previewURI,
    contentHash: metadata.contentHash,
  }
}

function parseListing(value: unknown): Listing {
  const listing = value as Listing

  return {
    seller: listing.seller,
    price: BigInt(listing.price),
    isActive: Boolean(listing.isActive) && !isZeroAddress(listing.seller),
  }
}

function resolveAssetFetchConcurrency() {
  const configured = Number(import.meta.env.VITE_ASSET_FETCH_CONCURRENCY || DEFAULT_ASSET_FETCH_CONCURRENCY)
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_ASSET_FETCH_CONCURRENCY
  return Math.min(Math.floor(configured), 16)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
) {
  const results: R[] = []
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(values[currentIndex])
    }
  }

  const workers = Array.from({ length: Math.min(limit, values.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export async function fetchAllAssets(publicClient: PublicClient): Promise<AssetRecord[]> {
  const address = readRequiredContractAddress()
  const totalMinted = (await publicClient.readContract({
    address,
    abi: CONTRACT_ABI,
    functionName: 'totalMinted',
  })) as bigint

  if (totalMinted === 0n) return []
  if (totalMinted > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('当前合约铸造数量超过前端可安全扫描范围，请接入索引服务。')
  }

  const tokenIds = Array.from({ length: Number(totalMinted) }, (_, index) => BigInt(index + 1))

  const records = await mapWithConcurrency(
    tokenIds,
    resolveAssetFetchConcurrency(),
    (tokenId) => fetchAssetRecord(publicClient, tokenId),
  )
  return records.filter((record): record is AssetRecord => Boolean(record))
}

export async function fetchListedAssets(publicClient: PublicClient) {
  const allAssets = await fetchAllAssets(publicClient)
  return allAssets.filter((asset) => asset.listing.isActive)
}

export async function fetchSaleHistory(publicClient: PublicClient): Promise<SaleHistoryRecord[]> {
  const address = readRequiredContractAddress()
  const logs = await publicClient.getLogs({
    address,
    event: SALE_EVENT,
    fromBlock: 0n,
    toBlock: 'latest',
  })

  const decodedSales = logs
    .map((log) => {
      try {
        const decoded = decodeEventLog({
          abi: CONTRACT_ABI,
          data: log.data,
          topics: log.topics,
        })

        if (decoded.eventName !== 'Sale') return null

        const args = decoded.args as {
          tokenId?: bigint
          seller?: Address
          buyer?: Address
          price?: bigint
          royaltyAmount?: bigint
          platformFeeAmount?: bigint
        }

        if (
          args.tokenId === undefined ||
          !args.seller ||
          !args.buyer ||
          args.price === undefined ||
          args.royaltyAmount === undefined ||
          args.platformFeeAmount === undefined ||
          !log.transactionHash ||
          log.blockNumber === null
        ) {
          return null
        }

        return {
          tokenId: args.tokenId,
          seller: args.seller,
          buyer: args.buyer,
          price: args.price,
          royaltyAmount: args.royaltyAmount,
          platformFeeAmount: args.platformFeeAmount,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex ?? 0,
        }
      } catch {
        return null
      }
    })
    .filter(
      (
        entry,
      ): entry is Omit<SaleHistoryRecord, 'timestamp'> & {
        logIndex: number
      } => Boolean(entry),
    )

  if (!decodedSales.length) return []

  const uniqueBlockNumbers = Array.from(
    new Set(decodedSales.map((entry) => entry.blockNumber.toString())),
    (value) => BigInt(value),
  )

  const blocks = await Promise.all(
    uniqueBlockNumbers.map(async (blockNumber) => {
      const block = await publicClient.getBlock({ blockNumber })
      return [blockNumber.toString(), block.timestamp] as const
    }),
  )

  const timestamps = new Map(blocks)

  return decodedSales
    .map(({ logIndex: _logIndex, ...entry }) => ({
      ...entry,
      timestamp: timestamps.get(entry.blockNumber.toString()) || 0n,
      _sortIndex: _logIndex,
    }))
    .sort((left, right) => {
      if (left.blockNumber === right.blockNumber) {
        return right._sortIndex - left._sortIndex
      }

      return Number(right.blockNumber - left.blockNumber)
    })
    .map(({ _sortIndex: _unused, ...entry }) => entry)
}

export async function fetchOwnedAssets(publicClient: PublicClient, ownerAddress: Address) {
  const allAssets = await fetchAllAssets(publicClient)
  return allAssets.filter((asset) => asset.owner.toLowerCase() === ownerAddress.toLowerCase())
}

export async function fetchAssetRecord(publicClient: PublicClient, tokenId: bigint): Promise<AssetRecord | null> {
  const address = readRequiredContractAddress()

  try {
    const [owner, tokenURI, rawContractMetadata, rawListing] = await Promise.all([
      publicClient.readContract({
        address,
        abi: CONTRACT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address,
        abi: CONTRACT_ABI,
        functionName: 'tokenURI',
        args: [tokenId],
      }),
      publicClient.readContract({
        address,
        abi: CONTRACT_ABI,
        functionName: 'getContentMetadata',
        args: [tokenId],
      }),
      publicClient.readContract({
        address,
        abi: CONTRACT_ABI,
        functionName: 'getListing',
        args: [tokenId],
      }),
    ])

    let metadata: AssetMetadata | null = null

    try {
      metadata = await fetchJsonFromUri<AssetMetadata>(tokenURI as string)
    } catch (error) {
      console.warn(`Unable to fetch metadata for token ${tokenId.toString()}:`, error)
    }

    return {
      tokenId,
      owner: owner as Address,
      tokenURI: tokenURI as string,
      metadata,
      contractMetadata: parseContractMetadata(rawContractMetadata),
      listing: parseListing(rawListing),
    }
  } catch (error) {
    console.warn(`Unable to load token ${tokenId.toString()}:`, error)
    return null
  }
}

export function getMintedTokenId(receipt: TransactionReceipt) {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: CONTRACT_ABI,
        data: log.data,
        topics: log.topics,
      })

      if (decoded.eventName === 'ContentMinted') {
        const args = decoded.args as { tokenId?: bigint }
        if (args.tokenId !== undefined) {
          return args.tokenId
        }
      }
    } catch {
      continue
    }
  }

  throw new Error('交易回执中未找到 ContentMinted 事件。')
}

export async function findRegisteredTokenIdByContentHash(publicClient: PublicClient, contentHash: Hex) {
  const address = readRequiredContractAddress()
  const isRegistered = (await publicClient.readContract({
    address,
    abi: CONTRACT_ABI,
    functionName: 'isContentRegistered',
    args: [contentHash],
  })) as boolean

  if (!isRegistered) return null

  return (await publicClient.readContract({
    address,
    abi: CONTRACT_ABI,
    functionName: 'getTokenIdByContentHash',
    args: [contentHash],
  })) as bigint
}

export function buildExplorerTxUrl(hash: Hex) {
  const chainId = Number(import.meta.env.VITE_CHAIN_ID || '31337')
  const configuredBase = import.meta.env.VITE_EXPLORER_TX_BASE || ''

  if (chainId === 31337) return `http://127.0.0.1:8545/tx/${hash}`
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${hash}`

  if (configuredBase) {
    const normalizedBase = configuredBase.endsWith('/')
      ? configuredBase.slice(0, -1)
      : configuredBase
    return `${normalizedBase}/${hash}`
  }

  return null
}

export function formatListingPrice(price: bigint) {
  return `${Number(formatEther(price)).toFixed(price >= 1n * 10n ** 18n ? 4 : 6)} ETH`
}

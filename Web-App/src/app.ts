import { parseEther, type Address } from 'viem'
import {
  CONTRACT_ABI,
  buildExplorerTxUrl,
  fetchListedAssets,
  fetchOwnedAssets,
  fetchSaleHistory,
  findRegisteredTokenIdByContentHash,
  getMintedTokenId,
  readRequiredContractAddress,
  toContentTypeIndex,
  toRoyaltyBps,
} from './lib/contract'
import { decryptFileFromUrl, encryptFile } from './lib/crypto'
import { formatEth, formatTimestamp, getContentTypeLabel, shortenAddress } from './lib/format'
import {
  getPinataCredentialsFromEnv,
  resolveIpfsUri,
  resolveIpfsUriCandidates,
  uploadFileToPinata,
  uploadJsonToPinata,
} from './lib/ipfs'
import { buildCertificateImageDataUri } from './lib/metadata'
import { computePHash } from './lib/phash'
import {
  attachWalletListeners,
  connectInjectedWallet,
  createConfiguredPublicClient,
  getConfiguredChain,
  hasInjectedWallet,
  hydrateInjectedWallet,
  type WalletConnection,
} from './lib/wallet'
import type { AssetRecord, SaleHistoryRecord } from './types/content'
import { contentTypeOptions } from './types/content'

type ViewName = 'marketplace' | 'publish' | 'library' | 'history'

type PublishResult = {
  tokenId: string
  contractAddress: string
  metadataURI: string
  encryptedContentURI: string
  accessKey: string
  txHash: string
  explorerUrl: string
}

type Notice = {
  tone: 'info' | 'success' | 'error'
  message: string
}

type AppState = {
  view: ViewName
  account: Address | null
  wallet: WalletConnection | null
  listedAssets: AssetRecord[]
  ownedAssets: AssetRecord[]
  saleHistory: SaleHistoryRecord[]
  pendingWithdrawal: bigint
  accessKeys: Record<string, string>
  publishResult: PublishResult | null
  notice: Notice | null
  busyMessage: string | null
}

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Missing #app root element')
}

const root = rootElement

const state: AppState = {
  view: 'marketplace',
  account: null,
  wallet: null,
  listedAssets: [],
  ownedAssets: [],
  saleHistory: [],
  pendingWithdrawal: 0n,
  accessKeys: {},
  publishResult: null,
  notice: null,
  busyMessage: null,
}

const publicClient = createConfiguredPublicClient()
const configuredChain = getConfiguredChain()
let detachWalletListeners = () => {}
const MAX_ROYALTY_PERCENT = 20

function setNotice(tone: Notice['tone'], message: string) {
  state.notice = { tone, message }
  render()
}

function clearNotice() {
  state.notice = null
}

function setBusy(message: string | null) {
  state.busyMessage = message
  render()
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseFiniteNumber(value: string, fieldName: string) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName}必须是有效数字。`)
  }

  return parsed
}

function validatePublishInputs(royaltyPercent: string, listPrice: string) {
  const royalty = parseFiniteNumber(royaltyPercent || '0', '版税')

  if (royalty < 0 || royalty > MAX_ROYALTY_PERCENT) {
    throw new Error(`版税比例必须在 0 到 ${MAX_ROYALTY_PERCENT}% 之间。`)
  }

  if (listPrice) {
    const price = parseFiniteNumber(listPrice, '挂牌价格')

    if (price <= 0) {
      throw new Error('填写挂牌价格时，价格必须大于 0 ETH。')
    }
  }
}

function getConfiguredContractLabel() {
  try {
    return readRequiredContractAddress()
  } catch {
    return '未配置'
  }
}

function getAssetImageUris(asset: AssetRecord) {
  const imageUri = asset.metadata?.image || asset.metadata?.previewURI || asset.contractMetadata.previewURI || ''
  return resolveIpfsUriCandidates(imageUri)
}

function renderAssetImage(asset: AssetRecord, title: string) {
  const images = getAssetImageUris(asset)

  if (!images.length) {
    return '<div class="card__image card__image--empty">暂无预览</div>'
  }

  return `<img class="card__image" src="${escapeHtml(images[0])}" alt="${escapeHtml(
    title,
  )}" data-ipfs-srcs="${escapeHtml(JSON.stringify(images))}" data-ipfs-index="0" loading="lazy" decoding="async" />`
}

function renderNotice() {
  if (!state.notice) return ''
  return `<div class="notice notice--${state.notice.tone}">${escapeHtml(state.notice.message)}</div>`
}

function renderAssetMeta(asset: AssetRecord) {
  return `
    <div class="meta-row"><span>持有人</span><strong>${escapeHtml(shortenAddress(asset.owner))}</strong></div>
    <div class="meta-row"><span>类型</span><strong>${escapeHtml(
      getContentTypeLabel(asset.contractMetadata.contentType)
    )}</strong></div>
    <div class="meta-row"><span>铸造时间</span><strong>${escapeHtml(
      formatTimestamp(asset.contractMetadata.mintedAt)
    )}</strong></div>
  `
}

function renderMarketplaceCards() {
  if (!state.listedAssets.length) {
    return '<div class="empty-state">当前还没有在售证书。你可以发布第一份内容来启动市场。</div>'
  }

  return state.listedAssets
    .map((asset) => {
      const title = asset.metadata?.name || `证书 #${asset.tokenId.toString()}`
      const description = asset.metadata?.description || '发布者暂未填写说明。'
      const isSeller = state.account?.toLowerCase() === asset.listing.seller.toLowerCase()

      return `
        <article class="card">
          ${renderAssetImage(asset, title)}
          <div class="card__body">
            <div class="card__topline">
              <span class="pill">Token #${asset.tokenId.toString()}</span>
              <span class="pill pill--accent">${escapeHtml(formatEth(asset.listing.price))}</span>
            </div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
            ${renderAssetMeta(asset)}
            <div class="card__actions">
              ${
                isSeller
                  ? `<button class="button button--secondary" data-action="cancel-listing" data-token-id="${asset.tokenId.toString()}">取消挂牌</button>`
                  : `<button class="button" data-action="buy" data-token-id="${asset.tokenId.toString()}" data-price="${asset.listing.price.toString()}">购买证书</button>`
              }
            </div>
          </div>
        </article>
      `
    })
    .join('')
}

function renderLibraryCards() {
  if (!state.account) {
    return '<div class="empty-state">连接钱包后可查看你当前持有的内容证书。</div>'
  }

  if (!state.ownedAssets.length) {
    return '<div class="empty-state">这个钱包在当前链上还没有持有任何证书。</div>'
  }

  return state.ownedAssets
    .map((asset) => {
      const tokenId = asset.tokenId.toString()
      const onChainKey = asset.contractMetadata.encryptedAccessKey || ''
      const keyValue = state.accessKeys[tokenId] || ''
      const title = asset.metadata?.name || `证书 #${tokenId}`
      const encryptedUri = asset.contractMetadata.encryptedContentURI
      const isAutoLoaded = onChainKey && keyValue === onChainKey
      const isListed = asset.listing.isActive

      return `
        <article class="card card--library">
          ${renderAssetImage(asset, title)}
          <div class="card__body">
            <div class="card__topline">
              <span class="pill">Token #${tokenId}</span>
              ${isListed ? `<span class="pill pill--accent">${escapeHtml(formatEth(asset.listing.price))} 在售</span>` : ''}
            </div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(asset.metadata?.description || '加密源文件可通过 IPFS 下载，并在本地解密。')}</p>
            ${renderAssetMeta(asset)}
            <div class="field">
              <label for="access-key-${tokenId}">访问密钥包</label>
              <textarea
                id="access-key-${tokenId}"
                class="textarea textarea--compact"
                data-access-key-input="${tokenId}"
                placeholder="粘贴该资产的 AES-GCM 访问密钥包。"
              >${escapeHtml(keyValue)}</textarea>
              ${isAutoLoaded ? '<span class="muted" style="font-size:0.85em">已从合约自动加载</span>' : ''}
            </div>
            <div class="card__actions">
              <button class="button button--secondary" data-action="download-encrypted" data-uri="${escapeHtml(
                encryptedUri
              )}">下载加密文件</button>
              <button class="button" data-action="decrypt-asset" data-token-id="${tokenId}" data-uri="${escapeHtml(
                encryptedUri
              )}">解密并保存</button>
              ${isListed
                ? `<button class="button button--secondary" data-action="cancel-listing" data-token-id="${tokenId}">取消挂牌</button>`
                : `<button class="button button--secondary" data-action="relist-token" data-token-id="${tokenId}">重新上架</button>`
              }
              ${!isListed
                ? `<button class="button button--danger" data-action="burn-token" data-token-id="${tokenId}">销毁证书</button>`
                : ''
              }
            </div>
          </div>
        </article>
      `
    })
    .join('')
}

function renderHistoryList(entries: SaleHistoryRecord[], emptyMessage: string) {
  if (!entries.length) {
    return `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`
  }

  return `
    <div class="history-list">
      ${entries
        .map((entry) => {
          const txUrl = buildExplorerTxUrl(entry.txHash)

          return `
            <article class="history-card">
              <div class="card__topline">
                <span class="pill">Token #${entry.tokenId.toString()}</span>
                <span class="pill pill--accent">${escapeHtml(formatEth(entry.price))}</span>
              </div>
              <h3>证书交易</h3>
              <div class="meta-row"><span>卖家</span><strong>${escapeHtml(
                shortenAddress(entry.seller),
              )}</strong></div>
              <div class="meta-row"><span>买家</span><strong>${escapeHtml(
                shortenAddress(entry.buyer),
              )}</strong></div>
              <div class="meta-row"><span>创作者版税</span><strong>${escapeHtml(
                formatEth(entry.royaltyAmount),
              )}</strong></div>
              <div class="meta-row"><span>平台服务费</span><strong>${escapeHtml(
                formatEth(entry.platformFeeAmount),
              )}</strong></div>
              <div class="meta-row"><span>成交时间</span><strong>${escapeHtml(
                formatTimestamp(entry.timestamp),
              )}</strong></div>
              <div class="history-links">
                ${
                  txUrl
                    ? `<a href="${escapeHtml(txUrl)}" target="_blank" rel="noreferrer">查看交易</a>`
                    : `<span class="mono muted">${escapeHtml(entry.txHash)}</span>`
                }
              </div>
            </article>
          `
        })
        .join('')}
    </div>
  `
}

function renderHistoryPanel() {
  if (!state.saleHistory.length) {
    return '<div class="empty-state">当前合约还没有记录到已完成的交易。</div>'
  }

  if (!state.account) {
    return renderHistoryList(
      state.saleHistory,
      '当前合约还没有记录到已完成的交易。',
    )
  }

  const account = state.account.toLowerCase()
  const salesAsSeller = state.saleHistory.filter((entry) => entry.seller.toLowerCase() === account)
  const purchasesAsBuyer = state.saleHistory.filter((entry) => entry.buyer.toLowerCase() === account)

  return `
    <div class="history-sections">
      ${state.pendingWithdrawal > 0n ? `
      <section class="panel panel--subtle">
        <div class="section-head">
          <div>
            <h3>待提取收益</h3>
            <p>来自已售出证书的收入，需要手动提取到钱包。</p>
          </div>
          <div class="inline-actions">
            <span class="pill pill--accent">${escapeHtml(formatEth(state.pendingWithdrawal))}</span>
            <button class="button" data-action="withdraw">提取到钱包</button>
          </div>
        </div>
      </section>
      ` : ''}

      <section class="panel panel--subtle">
        <div class="section-head">
          <div>
            <h3>我的售出</h3>
            <p>当前钱包作为卖家完成的证书转让。</p>
          </div>
        </div>
        ${renderHistoryList(salesAsSeller, '这个钱包还没有完成任何售出交易。')}
      </section>

      <section class="panel panel--subtle">
        <div class="section-head">
          <div>
            <h3>我的买入</h3>
            <p>当前钱包作为买家完成的证书购买。</p>
          </div>
        </div>
        ${renderHistoryList(purchasesAsBuyer, '这个钱包还没有完成任何买入交易。')}
      </section>

      <section class="panel panel--subtle">
        <div class="section-head">
          <div>
            <h3>平台近期交易</h3>
            <p>当前合约范围内最新的成交记录。</p>
          </div>
        </div>
        ${renderHistoryList(state.saleHistory, '当前合约还没有记录到已完成的交易。')}
      </section>
    </div>
  `
}

function renderPublishResult() {
  if (!state.publishResult) return ''

  return `
    <section class="panel panel--subtle">
      <div class="section-head">
        <div>
          <h3>发布完成</h3>
          <p>请妥善保存访问密钥包。没有它，加密源文件无法被解密。</p>
        </div>
        <div class="inline-actions">
          <button class="button button--secondary" data-action="copy-access-key">复制密钥</button>
          <button class="button button--secondary" data-action="clear-publish-result">隐藏详情</button>
        </div>
      </div>
      <div class="notice notice--success">
        Token #${escapeHtml(state.publishResult.tokenId)} 已发布。
        ${
          state.publishResult.explorerUrl
            ? `<a href="${escapeHtml(state.publishResult.explorerUrl)}" target="_blank" rel="noreferrer">查看交易</a>`
            : `<span class="mono">${escapeHtml(state.publishResult.txHash)}</span>`
        }
      </div>
      <div class="stack">
        <div>
          <strong>合约地址</strong>
          <div class="mono muted">${escapeHtml(state.publishResult.contractAddress)}</div>
        </div>
        <div>
          <strong>Token ID</strong>
          <div class="mono muted">${escapeHtml(state.publishResult.tokenId)}</div>
        </div>
        <div>
          <strong>元数据 URI</strong>
          <div class="mono muted">${escapeHtml(state.publishResult.metadataURI)}</div>
        </div>
        <div>
          <strong>加密内容 URI</strong>
          <div class="mono muted">${escapeHtml(state.publishResult.encryptedContentURI)}</div>
        </div>
        <div>
          <strong>访问密钥包</strong>
          <pre class="key-box">${escapeHtml(state.publishResult.accessKey)}</pre>
        </div>
      </div>
    </section>
  `
}

function render() {
  root.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div class="hero__copy">
          <span class="eyebrow">数字内容确权平台</span>
          <h1>内容确权市场</h1>
          <p>
            面向小说、图片、音乐、视频与创作文件的链上所有权证书平台。
            源文件先在本地加密，所有权流转记录在链上，访问密钥由持有人妥善保管。
          </p>
        </div>
        <div class="hero__status">
          <div class="status-card">
            <span class="status-label">当前网络</span>
            <strong>${escapeHtml(configuredChain.name)}</strong>
            <span class="muted">链 ID ${configuredChain.id}</span>
          </div>
          <div class="status-card">
            <span class="status-label">钱包账户</span>
            <strong>${escapeHtml(shortenAddress(state.account))}</strong>
            <button class="button ${state.account ? 'button--secondary' : ''}" data-action="connect-wallet">
              ${state.account ? '重新连接' : '连接钱包'}
            </button>
          </div>
        </div>
      </header>

      ${renderNotice()}

      <nav class="tabs">
        <button class="tab ${state.view === 'marketplace' ? 'tab--active' : ''}" data-action="switch-view" data-view="marketplace">市场</button>
        <button class="tab ${state.view === 'publish' ? 'tab--active' : ''}" data-action="switch-view" data-view="publish">发布</button>
        <button class="tab ${state.view === 'library' ? 'tab--active' : ''}" data-action="switch-view" data-view="library">我的资产</button>
        <button class="tab ${state.view === 'history' ? 'tab--active' : ''}" data-action="switch-view" data-view="history">交易记录</button>
      </nav>

      <main class="page">
        <section class="panel ${state.view === 'marketplace' ? '' : 'is-hidden'}">
          <div class="section-head">
            <div>
              <h2>市场</h2>
              <p>展示当前合约地址下正在出售的链上证书。</p>
            </div>
            <button class="button button--secondary" data-action="refresh-marketplace">刷新市场</button>
          </div>
          <div class="card-grid">${renderMarketplaceCards()}</div>
        </section>

        <section class="panel ${state.view === 'publish' ? '' : 'is-hidden'}">
          <div class="section-head">
            <div>
              <h2>发布内容</h2>
              <p>在浏览器本地加密源文件，上传到 IPFS 后铸造所有权证书，可选择立即挂牌。</p>
            </div>
          </div>
          <form id="publish-form" class="form-grid">
            <div class="grid-two">
              <label class="field">
                <span>标题</span>
                <input class="input" name="title" placeholder="例如：霓虹城第一章" required />
              </label>
              <label class="field">
                <span>内容类型</span>
                <select class="input" name="contentType">
                  ${contentTypeOptions
                    .map((option, index) => `<option value="${index}">${escapeHtml(option)}</option>`)
                    .join('')}
                </select>
              </label>
            </div>
            <label class="field">
              <span>内容说明</span>
              <textarea class="textarea" name="description" placeholder="描述这张证书代表的作品、授权范围或交付内容。"></textarea>
            </label>
            <div class="grid-two">
              <label class="field">
                <span>创作者版税（%）</span>
                <input class="input" name="royaltyPercent" type="number" min="0" max="20" step="0.1" value="10" />
              </label>
              <label class="field">
                <span>挂牌价格（ETH，可选）</span>
                <input class="input" name="listPrice" type="number" min="0" step="0.0001" placeholder="0.50" />
              </label>
            </div>
            <label class="field">
              <span>授权 / 访问说明</span>
              <input class="input" name="license" value="证书持有人下载" />
            </label>
            <div class="notice notice--info">
              同一份原始内容在当前合约中只能铸造一次。二级交易应转售同一张证书，而不是重新上传相同文件。
            </div>
            <div class="grid-two">
              <label class="field">
                <span>原始内容文件</span>
                <input class="input" name="contentFile" type="file" required />
              </label>
              <label class="field">
                <span>预览文件（可选）</span>
                <input class="input" name="previewFile" type="file" />
              </label>
            </div>
            <div class="card__actions">
              <button class="button" type="submit">加密并发布证书</button>
            </div>
          </form>
          ${renderPublishResult()}
        </section>

        <section class="panel ${state.view === 'library' ? '' : 'is-hidden'}">
          <div class="section-head">
            <div>
              <h2>我的资产</h2>
              <p>当前证书持有人应保存最新访问密钥包，用于本地解密源文件。</p>
            </div>
            <button class="button button--secondary" data-action="refresh-library">刷新资产</button>
          </div>
          <div class="card-grid">${renderLibraryCards()}</div>
        </section>

        <section class="panel ${state.view === 'history' ? '' : 'is-hidden'}">
          <div class="section-head">
            <div>
              <h2>交易记录</h2>
              <p>查看已完成的证书交易，包括买家、卖家、版税与平台费用。</p>
            </div>
            <button class="button button--secondary" data-action="refresh-history">刷新记录</button>
          </div>
          ${renderHistoryPanel()}
        </section>
      </main>

      <footer class="footer">
        <span>${hasInjectedWallet() ? '已检测到浏览器钱包' : '尚未检测到浏览器钱包'}</span>
        <span>合约地址：<span class="mono">${escapeHtml(getConfiguredContractLabel())}</span></span>
      </footer>
    </div>

    ${state.busyMessage ? `<div class="busy-overlay"><div class="busy-panel">${escapeHtml(state.busyMessage)}</div></div>` : ''}
  `
}

async function refreshMarketplace() {
  state.listedAssets = await fetchListedAssets(publicClient)
}

async function refreshLibrary() {
  if (!state.account) {
    state.ownedAssets = []
    state.accessKeys = {}
    return
  }

  state.ownedAssets = await fetchOwnedAssets(publicClient, state.account)

  for (const asset of state.ownedAssets) {
    const tokenId = asset.tokenId.toString()
    const onChainKey = asset.contractMetadata.encryptedAccessKey
    if (onChainKey && !state.accessKeys[tokenId]) {
      state.accessKeys[tokenId] = onChainKey
    }
  }
}

async function refreshHistory() {
  state.saleHistory = await fetchSaleHistory(publicClient)
  await refreshPendingWithdrawal()
}

async function refreshPendingWithdrawal() {
  if (!state.account) {
    state.pendingWithdrawal = 0n
    return
  }
  const address = readRequiredContractAddress()
  state.pendingWithdrawal = (await publicClient.readContract({
    address,
    abi: CONTRACT_ABI,
    functionName: 'pendingWithdrawals',
    args: [state.account],
  })) as bigint
}

async function withdrawBalance() {
  const wallet = await ensureWallet()

  if (state.pendingWithdrawal === 0n) {
    setNotice('info', '当前没有可提取的收益。')
    return
  }

  setBusy('正在提取收益...')
  try {
    const hash = await wallet.walletClient.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address: readRequiredContractAddress(),
      abi: CONTRACT_ABI,
      functionName: 'withdraw',
      args: [],
    })
    await publicClient.waitForTransactionReceipt({ hash })
    await refreshPendingWithdrawal()
    setNotice('success', `收益已提取到钱包。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '提取失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

async function syncCurrentView() {
  if (state.view === 'marketplace') {
    await refreshMarketplace()
  }

  if (state.view === 'library') {
    await refreshLibrary()
  }

  if (state.view === 'history') {
    await refreshHistory()
  }
}

async function ensureWallet() {
  if (state.wallet && state.account) return state.wallet

  const wallet = await connectInjectedWallet()
  state.wallet = wallet
  state.account = wallet.account
  return wallet
}

async function connectWallet() {
  clearNotice()
  setBusy('正在连接钱包并切换到配置的网络...')

  try {
    const wallet = await connectInjectedWallet()
    state.wallet = wallet
    state.account = wallet.account
    await syncCurrentView()
    setNotice('success', `已连接 ${shortenAddress(wallet.account)}，当前网络：${wallet.chain.name}。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '钱包连接失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

async function handlePublish(form: HTMLFormElement) {
  clearNotice()
  state.publishResult = null

  const formData = new FormData(form)
  const title = String(formData.get('title') || '').trim()
  const description = String(formData.get('description') || '').trim()
  const contentType = String(formData.get('contentType') || '0')
  const royaltyPercent = String(formData.get('royaltyPercent') || '10')
  const listPrice = String(formData.get('listPrice') || '').trim()
  const license = String(formData.get('license') || '证书持有人下载').trim()
  const contentFile = formData.get('contentFile')
  const previewFile = formData.get('previewFile')

  if (!(contentFile instanceof File) || contentFile.size === 0) {
    setNotice('error', '发布前请选择原始内容文件。')
    return
  }

  try {
    validatePublishInputs(royaltyPercent, listPrice)
  } catch (error) {
    const message = error instanceof Error ? error.message : '发布表单包含无效内容。'
    setNotice('error', message)
    return
  }

  const wallet = await ensureWallet()
  const credentials = getPinataCredentialsFromEnv()

  setBusy('正在加密文件、上传 IPFS 并铸造证书...')

  try {
    const encrypted = await encryptFile(contentFile)
    setBusy('正在检查链上记录...')
    const existingTokenId = await findRegisteredTokenIdByContentHash(publicClient, encrypted.contentHash)

    if (existingTokenId !== null) {
      throw new Error(
        `这份原始文件已注册为 Token #${existingTokenId.toString()}。请转售已有证书，不要重复铸造。`,
      )
    }

    // Compute perceptual hash (reads 128 bytes, instant)
    let perceptualHash = 0n
    const isImage = contentFile.type.startsWith('image/')
    if (isImage) {
      perceptualHash = await computePHash(contentFile)
    }

    setBusy(`正在上传加密文件到 IPFS（${(encrypted.encryptedFile.size / 1024 / 1024).toFixed(1)} MB）...`)
    const encryptedUpload = await uploadFileToPinata(encrypted.encryptedFile, credentials)
    const previewUpload =
      previewFile instanceof File && previewFile.size > 0
        ? await uploadFileToPinata(previewFile, credentials, 'preview')
        : null

    const contentTypeLabel = contentTypeOptions[toContentTypeIndex(contentType)]
    const walletImage =
      previewUpload?.ipfsUri ||
      buildCertificateImageDataUri({
        title: title || contentFile.name,
        contentTypeLabel,
        creatorAddress: wallet.account,
      })

    const metadata = {
      name: title || contentFile.name,
      description,
      image: resolveIpfsUri(walletImage),
      external_url: typeof window !== 'undefined' ? window.location.origin : undefined,
      attributes: [
        { trait_type: '内容类型', value: contentTypeLabel },
        { trait_type: '原始文件名', value: contentFile.name },
        { trait_type: 'MIME 类型', value: contentFile.type || 'application/octet-stream' },
        { trait_type: '加密存储', value: 'IPFS' },
      ],
      assetType: contentTypeLabel,
      creator: wallet.account,
      previewURI: previewUpload?.ipfsUri || '',
      encryptedContentURI: encryptedUpload.ipfsUri,
      mimeType: contentFile.type || 'application/octet-stream',
      size: contentFile.size,
      contentHash: encrypted.contentHash,
      encryptionScheme: encrypted.encryptionScheme,
      originalFileName: contentFile.name,
      accessModel: 'owner-verified-offchain-key',
      license,
      createdAt: new Date().toISOString(),
    }

    const metadataUpload = await uploadJsonToPinata(metadata, credentials, 'content-metadata.json')
    const contractAddress = readRequiredContractAddress()

    console.log('[MINT] 准备发送铸造交易...', {
      contract: contractAddress,
      chain: wallet.chain.id,
      account: wallet.account,
      contentHash: encrypted.contentHash,
      contentType: toContentTypeIndex(contentType),
      royaltyBps: toRoyaltyBps(royaltyPercent),
      perceptualHash: perceptualHash.toString(),
    })

    setBusy('正在等待 MetaMask 确认铸造交易...')
    const mintHash = await wallet.walletClient.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName: 'mint',
      args: [
        metadataUpload.ipfsUri,
        encryptedUpload.ipfsUri,
        previewUpload?.ipfsUri || '',
        encrypted.contentHash,
        toContentTypeIndex(contentType),
        toRoyaltyBps(royaltyPercent),
        encrypted.accessKey,
        perceptualHash,
      ],
    })

    console.log('[MINT] 交易已提交:', mintHash)
    setBusy('正在等待链上确认...')
    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash })
    console.log('[MINT] 交易确认:', mintReceipt.status)
    const tokenId = getMintedTokenId(mintReceipt)

    if (listPrice) {
      const approveHash = await wallet.walletClient.writeContract({
        account: wallet.account,
        chain: wallet.chain,
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'approve',
        args: [contractAddress, tokenId],
      })

      await publicClient.waitForTransactionReceipt({ hash: approveHash })

      const listHash = await wallet.walletClient.writeContract({
        account: wallet.account,
        chain: wallet.chain,
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'listForSale',
        args: [tokenId, parseEther(listPrice)],
      })

      await publicClient.waitForTransactionReceipt({ hash: listHash })
    }

    await Promise.all([refreshMarketplace(), refreshLibrary()])

    state.publishResult = {
      tokenId: tokenId.toString(),
      contractAddress,
      metadataURI: metadataUpload.ipfsUri,
      encryptedContentURI: encryptedUpload.ipfsUri,
      accessKey: encrypted.accessKey,
      txHash: mintHash,
      explorerUrl: buildExplorerTxUrl(mintHash) || '',
    }

    form.reset()
    setNotice('success', `证书 #${tokenId.toString()} 已成功铸造。`)
    void addNftToWallet(contractAddress, tokenId.toString())
  } catch (error) {
    console.error('[MINT] 铸造失败:', error)
    const message = error instanceof Error ? error.message : '发布失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

async function buyCertificate(tokenId: bigint, price: bigint) {
  const wallet = await ensureWallet()
  const contractAddress = readRequiredContractAddress()
  const contractArgs = {
    account: wallet.account,
    chain: wallet.chain,
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'buy' as const,
    args: [tokenId],
    value: price,
  }

  setBusy(`正在购买 Token #${tokenId.toString()}...`)

  try {
    // Pre-flight simulation: catches contract reverts before sending the transaction.
    await wallet.publicClient.simulateContract(contractArgs)

    const hash = await wallet.walletClient.writeContract(contractArgs)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'reverted') {
      throw new Error('链上交易执行失败（reverted）。请在区块浏览器中查看交易详情。')
    }

    await Promise.all([refreshMarketplace(), refreshLibrary(), refreshHistory()])
    setNotice('success', `Token #${tokenId.toString()} 购买完成。`)
    void addNftToWallet(contractAddress, tokenId.toString())
  } catch (error) {
    setNotice('error', parseBuyError(error))
  } finally {
    state.busyMessage = null
    render()
  }
}

function parseBuyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)

  if (raw.includes('MarketplaceNotApproved')) {
    return '市场合约未获得该证书的转移授权。请联系卖家重新授权后再试。'
  }
  if (raw.includes('NotListed')) {
    return '该证书当前未挂牌出售，可能已被卖家下架或已被他人购买。'
  }
  if (raw.includes('IncorrectPayment')) {
    return '支付金额与挂牌价格不匹配。请刷新市场后重试。'
  }
  if (raw.includes('SelfPurchase')) {
    return '不能购买自己发布的证书。'
  }
  if (raw.includes('NotTokenOwner')) {
    return '卖家已不再持有该证书。请刷新市场查看最新状态。'
  }

  return raw.length > 200 ? '购买失败。请检查控制台日志了解详情。' : raw
}

async function cancelListing(tokenId: bigint) {
  const wallet = await ensureWallet()

  setBusy(`正在取消 Token #${tokenId.toString()} 的挂牌...`)

  try {
    const hash = await wallet.walletClient.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address: readRequiredContractAddress(),
      abi: CONTRACT_ABI,
      functionName: 'cancelListing',
      args: [tokenId],
    })

    await publicClient.waitForTransactionReceipt({ hash })
    await Promise.all([refreshMarketplace(), refreshLibrary()])
    setNotice('success', `Token #${tokenId.toString()} 已取消挂牌。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '取消挂牌失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

async function burnToken(tokenId: bigint) {
  if (!window.confirm(`确定要销毁 Token #${tokenId.toString()} 吗？此操作不可撤销。`)) return

  const wallet = await ensureWallet()

  setBusy(`正在销毁 Token #${tokenId.toString()}...`)

  try {
    const hash = await wallet.walletClient.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address: readRequiredContractAddress(),
      abi: CONTRACT_ABI,
      functionName: 'burn',
      args: [tokenId],
    })

    await publicClient.waitForTransactionReceipt({ hash })
    await Promise.all([refreshMarketplace(), refreshLibrary()])
    setNotice('success', `Token #${tokenId.toString()} 已销毁。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '销毁失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

async function relistToken(tokenId: bigint) {
  const priceStr = window.prompt('请输入挂牌价格（ETH）：', '0.1')
  if (!priceStr) return

  let price: bigint
  try {
    price = parseEther(priceStr)
    if (price <= 0n) throw new Error()
  } catch {
    setNotice('error', '请输入有效的价格。')
    return
  }

  const wallet = await ensureWallet()
  const contractAddress = readRequiredContractAddress()

  setBusy(`正在上架 Token #${tokenId.toString()}...`)

  try {
    const approveHash = await wallet.walletClient.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName: 'approve',
      args: [contractAddress, tokenId],
    })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })

    const listHash = await wallet.walletClient.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName: 'listForSale',
      args: [tokenId, price],
    })
    await publicClient.waitForTransactionReceipt({ hash: listHash })

    await Promise.all([refreshMarketplace(), refreshLibrary()])
    setNotice('success', `Token #${tokenId.toString()} 已上架，价格 ${priceStr} ETH。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '上架失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

async function addNftToWallet(contractAddress: string, tokenId: string) {
  if (!window.ethereum) return

  try {
    await ensureWallet()
    await window.ethereum.request({
      method: 'wallet_watchAsset',
      params: [
        {
          type: 'ERC721',
          options: {
            address: contractAddress,
            tokenId,
          },
        },
      ],
    })
  } catch {
    // wallet_watchAsset may not be supported — MetaMask auto-detection handles it on Sepolia.
  }
}

async function downloadEncrypted(uri: string) {
  const response = await fetch(resolveIpfsUri(uri))
  if (!response.ok) {
    throw new Error(`加密文件下载失败：${response.status}`)
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = 'encrypted-content.enc'
  anchor.click()
  URL.revokeObjectURL(objectUrl)
}

async function decryptAsset(tokenId: string, uri: string) {
  const accessKey = state.accessKeys[tokenId]

  if (!accessKey?.trim()) {
    setNotice('error', `请先粘贴 Token #${tokenId} 的访问密钥包。`)
    return
  }

  setBusy(`正在本地解密 Token #${tokenId}...`)

  try {
    const { blob, fileName } = await decryptFileFromUrl(resolveIpfsUri(uri), accessKey)
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(objectUrl)
    setNotice('success', `Token #${tokenId} 的文件已解密完成。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '解密失败。'
    setNotice('error', message)
  } finally {
    state.busyMessage = null
    render()
  }
}

root.addEventListener(
  'error',
  (event) => {
    const target = event.target
    if (!(target instanceof HTMLImageElement) || !target.classList.contains('card__image')) return

    let sources: string[] = []

    try {
      sources = JSON.parse(target.dataset.ipfsSrcs || '[]') as string[]
    } catch {
      sources = []
    }

    const nextIndex = Number(target.dataset.ipfsIndex || '0') + 1

    if (sources[nextIndex]) {
      target.dataset.ipfsIndex = String(nextIndex)
      target.src = sources[nextIndex]
      return
    }

    const placeholder = document.createElement('div')
    placeholder.className = 'card__image card__image--empty'
    placeholder.textContent = '预览不可用'
    target.replaceWith(placeholder)
  },
  true,
)

root.addEventListener('click', async (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return

  const button = target.closest<HTMLElement>('[data-action]')
  if (!button) return

  const action = button.dataset.action
  if (!action) return

  try {
    if (action === 'connect-wallet') {
      await connectWallet()
      return
    }

    if (action === 'switch-view') {
      const view = button.dataset.view as ViewName | undefined
      if (!view) return
      state.view = view
      clearNotice()
      setBusy('正在加载页面数据...')
      await syncCurrentView()
      state.busyMessage = null
      render()
      return
    }

    if (action === 'refresh-marketplace') {
      setBusy('正在刷新市场...')
      await refreshMarketplace()
      state.busyMessage = null
      render()
      return
    }

    if (action === 'refresh-library') {
      setBusy('正在刷新我的资产...')
      await refreshLibrary()
      state.busyMessage = null
      render()
      return
    }

    if (action === 'refresh-history') {
      setBusy('正在刷新交易记录...')
      await refreshHistory()
      state.busyMessage = null
      render()
      return
    }

    if (action === 'clear-publish-result') {
      state.publishResult = null
      render()
      return
    }

    if (action === 'copy-access-key') {
      if (!state.publishResult) return
      await navigator.clipboard.writeText(state.publishResult.accessKey)
      setNotice('success', '访问密钥包已复制到剪贴板。')
      return
    }

    if (action === 'buy') {
      await buyCertificate(BigInt(button.dataset.tokenId || '0'), BigInt(button.dataset.price || '0'))
      return
    }

    if (action === 'cancel-listing') {
      await cancelListing(BigInt(button.dataset.tokenId || '0'))
      return
    }

    if (action === 'burn-token') {
      await burnToken(BigInt(button.dataset.tokenId || '0'))
      return
    }

    if (action === 'relist-token') {
      await relistToken(BigInt(button.dataset.tokenId || '0'))
      return
    }

    if (action === 'withdraw') {
      await withdrawBalance()
      return
    }

    if (action === 'download-encrypted') {
      setBusy('正在从 IPFS 下载加密文件...')
      await downloadEncrypted(button.dataset.uri || '')
      state.busyMessage = null
      render()
      return
    }

    if (action === 'decrypt-asset') {
      await decryptAsset(button.dataset.tokenId || '', button.dataset.uri || '')
    }
  } catch (error) {
    state.busyMessage = null
    const message = error instanceof Error ? error.message : '操作失败。'
    setNotice('error', message)
  }
})

root.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement)) return

  const tokenId = target.dataset.accessKeyInput
  if (!tokenId) return

  state.accessKeys[tokenId] = target.value
})

root.addEventListener('submit', async (event) => {
  const target = event.target
  if (!(target instanceof HTMLFormElement)) return
  if (target.id !== 'publish-form') return

  event.preventDefault()
  await handlePublish(target)
})

async function bootstrap() {
  render()
  detachWalletListeners()
  detachWalletListeners = attachWalletListeners(() => {
    void bootstrap()
  })

  try {
    state.wallet = await hydrateInjectedWallet()
    state.account = state.wallet?.account || null
    await syncCurrentView()
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法恢复钱包会话。'
    state.notice = { tone: 'info', message }
  } finally {
    render()
  }
}

void bootstrap()

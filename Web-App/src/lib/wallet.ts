import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  numberToHex,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { sepolia } from 'viem/chains'

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>
      on?(event: string, handler: (...args: unknown[]) => void): void
      removeListener?(event: string, handler: (...args: unknown[]) => void): void
    }
  }
}

const tenderlyVirtualSepolia = defineChain({
  id: 99911155111,
  name: 'Tenderly 虚拟 Sepolia',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_TENDERLY_RPC_URL
          || 'https://virtual.sepolia.eu.rpc.tenderly.co/b1bfb292-efb9-4c44-b90f-6bf3b3480dd3',
      ],
    },
  },
  blockExplorers: {
    default: {
      name: 'Tenderly',
      url: import.meta.env.VITE_TENDERLY_EXPLORER_URL || 'https://dashboard.tenderly.co',
    },
  },
  testnet: true,
})

const anvilLocal = defineChain({
  id: 31337,
  name: '本地 Anvil',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ANVIL_RPC_URL || 'http://127.0.0.1:8545'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Local',
      url: 'http://127.0.0.1:8545',
    },
  },
  testnet: true,
})

const configuredChainId = Number(import.meta.env.VITE_CHAIN_ID || '31337')
const supportedChains = [anvilLocal, sepolia, tenderlyVirtualSepolia] as const

export type WalletConnection = {
  account: Address
  chain: Chain
  publicClient: PublicClient
  walletClient: WalletClient
}

export function getConfiguredChain() {
  return supportedChains.find((chain) => chain.id === configuredChainId) ?? anvilLocal
}

export function createConfiguredPublicClient() {
  const chain = getConfiguredChain()
  return createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0]),
  })
}

export function hasInjectedWallet() {
  return Boolean(window.ethereum)
}

async function ensureConfiguredChain() {
  if (!window.ethereum) {
    throw new Error('未检测到浏览器钱包。请先安装 MetaMask 或其他 EVM 钱包。')
  }

  const chain = getConfiguredChain()
  const currentChainId = await window.ethereum.request({
    method: 'eth_chainId',
  })

  if (typeof currentChainId === 'string' && Number.parseInt(currentChainId, 16) === chain.id) {
    return chain
  }

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(chain.id) }],
    })
    return chain
  } catch (error) {
    const switchError = error as { code?: number }
    if (switchError.code !== 4902) throw error

    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: numberToHex(chain.id),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers?.default?.url
            ? [chain.blockExplorers.default.url]
            : [],
        },
      ],
    })

    return chain
  }
}

function buildConnection(account: Address, chain: Chain): WalletConnection {
  return {
    account,
    chain,
    publicClient: createConfiguredPublicClient(),
    walletClient: createWalletClient({
      account,
      chain,
      transport: custom(window.ethereum!),
    }),
  }
}

export async function connectInjectedWallet() {
  if (!window.ethereum) {
    throw new Error('未检测到浏览器钱包。请先安装 MetaMask 或其他 EVM 钱包。')
  }

  const chain = await ensureConfiguredChain()
  const accounts = (await window.ethereum.request({
    method: 'eth_requestAccounts',
  })) as string[]

  if (!accounts.length) {
    throw new Error('钱包连接没有返回任何账户。')
  }

  return buildConnection(accounts[0] as Address, chain)
}

export async function hydrateInjectedWallet() {
  if (!window.ethereum) return null

  const accounts = (await window.ethereum.request({
    method: 'eth_accounts',
  })) as string[]

  if (!accounts.length) return null

  const chain = await ensureConfiguredChain()
  return buildConnection(accounts[0] as Address, chain)
}

export function attachWalletListeners(onChange: () => void) {
  if (!window.ethereum?.on || !window.ethereum.removeListener) {
    return () => {}
  }

  const handler = () => {
    onChange()
  }

  window.ethereum.on('accountsChanged', handler)
  window.ethereum.on('chainChanged', handler)

  return () => {
    window.ethereum?.removeListener?.('accountsChanged', handler)
    window.ethereum?.removeListener?.('chainChanged', handler)
  }
}

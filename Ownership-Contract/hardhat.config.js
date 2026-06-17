require("dotenv").config()
require("@nomicfoundation/hardhat-toolbox")

const tenderlyUrl =
  process.env.TENDERLY_RPC_URL ||
  "https://virtual.mainnet.eu.rpc.tenderly.co/beat1ngheart/project/65d04c-234be9"

const tenderlyChainId = Number(process.env.TENDERLY_CHAIN_ID || "29840272360")

const privateKey = process.env.PRIVATE_KEY
const accounts = privateKey ? [privateKey] : []
const localAccounts = privateKey ? [privateKey] : "remote"
const networks = {
  hardhat: {},
  anvil: {
    url: process.env.ANVIL_RPC_URL || "http://127.0.0.1:8545",
    chainId: 31337,
    accounts: localAccounts,
  },
  tenderly: {
    url: tenderlyUrl,
    chainId: tenderlyChainId,
    accounts,
  },
}

if (process.env.SEPOLIA_RPC_URL) {
  networks.sepolia = {
    url: process.env.SEPOLIA_RPC_URL,
    chainId: 11155111,
    accounts,
  }
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks,
}

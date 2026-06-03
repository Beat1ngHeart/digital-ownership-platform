const fs = require("fs")
const path = require("path")
const hre = require("hardhat")

function upsertEnvValue(contents, key, value) {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, "m")

  if (pattern.test(contents)) {
    return contents.replace(pattern, line)
  }

  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n"
  return `${contents}${separator}${line}\n`
}

function syncFrontendLocalEnv(deploymentInfo) {
  if (deploymentInfo.chainId !== 31337) return

  const envTarget = path.join(__dirname, "..", "..", "Web-App", ".env.local")
  const current = fs.existsSync(envTarget) ? fs.readFileSync(envTarget, "utf8") : ""
  const next = [
    ["VITE_CONTENT_NFT_ADDRESS", deploymentInfo.address],
    ["VITE_CHAIN_ID", String(deploymentInfo.chainId)],
    ["VITE_ANVIL_RPC_URL", process.env.ANVIL_RPC_URL || "http://127.0.0.1:8545"],
  ].reduce((contents, [key, value]) => upsertEnvValue(contents, key, value), current)

  fs.writeFileSync(envTarget, next)
  console.log("Synced local Anvil config to ../Web-App/.env.local")
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  if (!deployer) {
    throw new Error(
      "No deployer signer found for current network. Set PRIVATE_KEY in environment (with 0x prefix) before running deploy."
    )
  }

  const deployerAddress = await deployer.getAddress()
  const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS || "250")
  const initialOwner = process.env.INITIAL_OWNER || deployerAddress

  const factory = await hre.ethers.getContractFactory("ContentNFTMarketplace")
  const contract = await factory.deploy(platformFeeBps, initialOwner)
  await contract.waitForDeployment()

  const address = await contract.getAddress()
  const network = await hre.ethers.provider.getNetwork()
  const deploymentInfo = {
    address,
    chainId: Number(network.chainId),
    platformFeeBps,
    initialOwner,
    deployedAt: new Date().toISOString(),
  }

  const deploymentDir = path.join(__dirname, "..", "deployments")
  fs.mkdirSync(deploymentDir, { recursive: true })
  fs.writeFileSync(
    path.join(deploymentDir, `${hre.network.name}.json`),
    `${JSON.stringify(deploymentInfo, null, 2)}\n`
  )

  const frontendArtifactTarget = path.join(
    __dirname,
    "..",
    "..",
    "Web-App",
    "src",
    "contracts",
    "ContentNFTMarketplace.json"
  )
  const artifact = await hre.artifacts.readArtifact("ContentNFTMarketplace")
  fs.writeFileSync(frontendArtifactTarget, `${JSON.stringify(artifact, null, 2)}\n`)
  syncFrontendLocalEnv(deploymentInfo)

  console.log(`ContentNFTMarketplace deployed to: ${address}`)
  console.log(`Chain ID: ${deploymentInfo.chainId}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

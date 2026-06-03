# Ownership Contract

这个目录现在已经从 Foundry 重构成了 `Hardhat + Solidity` 工程。

## 当前结构

- `contracts/ContentNFTMarketplace.sol`
- `scripts/deploy.js`
- `test/ContentNFTMarketplace.js`

## 合约能力

- ERC-721 所有权证书
- `metadataURI / encryptedContentURI / previewURI / contentHash` 绑定
- 非托管挂牌
- 购买与自动转移
- ERC-2981 创作者版税
- 平台手续费
- 同一份内容 `contentHash` 只能注册一次

## 为什么采用非托管挂牌

你的核心语义是：

> 谁持有证书，谁就是资源拥有者

所以挂牌时证书仍然保留在卖家钱包里，市场合约只记录价格和卖家信息，真正购买时再基于授权完成转移。

## 环境变量

复制 `.env.example` 到 `.env`，至少填写这些：

```bash
PRIVATE_KEY=0xyourprivatekey
INITIAL_OWNER=0xYourAdminAddress
PLATFORM_FEE_BPS=250
ANVIL_RPC_URL=http://127.0.0.1:8545
TENDERLY_RPC_URL=https://virtual.sepolia.eu.rpc.tenderly.co/b1bfb292-efb9-4c44-b90f-6bf3b3480dd3
```

## 常用命令

```bash
npm install
npm run compile
npm test
```

## Anvil 本地部署

先启动 Anvil：

```bash
npm run anvil
```

另开一个终端部署合约：

```bash
npm run deploy:anvil
```

部署成功后，脚本会把本地合约地址同步到 `../Web-App/.env.local`。

## Tenderly 部署（可选）

```bash
npm run deploy:tenderly
```

部署脚本会：

- 部署 `ContentNFTMarketplace`
- 在 `deployments/` 下记录部署结果
- 把最新 ABI 同步到 `../Web-App/src/contracts/ContentNFTMarketplace.json`

const { expect } = require("chai")
const { ethers } = require("hardhat")

describe("ContentNFTMarketplace", function () {
  async function deployFixture() {
    const [admin, creator, seller, buyer] = await ethers.getSigners()
    const factory = await ethers.getContractFactory("ContentNFTMarketplace")
    const market = await factory.deploy(250, admin.address)
    await market.waitForDeployment()

    return {
      market,
      admin,
      creator,
      seller,
      buyer,
      metadataURI: "ipfs://metadata-cid",
      encryptedContentURI: "ipfs://encrypted-content-cid",
      previewURI: "ipfs://preview-cid",
      contentHash: ethers.keccak256(ethers.toUtf8Bytes("content-hash")),
      encryptedAccessKey: '{"algorithm":"AES-GCM-256","key":"dGVzdC1rZXktYmFzZTY0","fileName":"test.txt","mimeType":"text/plain"}',
      perceptualHash: 0xA1B2C3D4E5F67890n,
    }
  }

  async function mintAsCreator(fixture) {
    const tx = await fixture.market
      .connect(fixture.creator)
      .mint(
        fixture.metadataURI,
        fixture.encryptedContentURI,
        fixture.previewURI,
        fixture.contentHash,
        1,
        1000,
        fixture.encryptedAccessKey,
        fixture.perceptualHash
      )

    await tx.wait()
    return 1n
  }

  it("stores metadata and royalty on mint", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    expect(await fixture.market.totalMinted()).to.equal(1n)
    expect(await fixture.market.ownerOf(tokenId)).to.equal(fixture.creator.address)
    expect(await fixture.market.tokenURI(tokenId)).to.equal(fixture.metadataURI)

    const stored = await fixture.market.getContentMetadata(tokenId)
    expect(stored.creator).to.equal(fixture.creator.address)
    expect(stored.contentType).to.equal(1n)
    expect(stored.metadataURI).to.equal(fixture.metadataURI)
    expect(stored.encryptedContentURI).to.equal(fixture.encryptedContentURI)
    expect(stored.previewURI).to.equal(fixture.previewURI)
    expect(stored.contentHash).to.equal(fixture.contentHash)
    expect(stored.encryptedAccessKey).to.equal(fixture.encryptedAccessKey)
    expect(stored.perceptualHash).to.equal(fixture.perceptualHash)

    const [receiver, amount] = await fixture.market.royaltyInfo(tokenId, ethers.parseEther("1"))
    expect(receiver).to.equal(fixture.creator.address)
    expect(amount).to.equal(ethers.parseEther("0.1"))
  })

  it("requires approval before listing", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await expect(
      fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(fixture.market, "MarketplaceNotApproved")

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))

    const listing = await fixture.market.getListing(tokenId)
    expect(listing.seller).to.equal(fixture.creator.address)
    expect(listing.price).to.equal(ethers.parseEther("1"))
    expect(listing.isActive).to.equal(true)
  })

  it("distributes funds and transfers ownership on purchase", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))

    await fixture.market.connect(fixture.buyer).buy(tokenId, { value: ethers.parseEther("1") })

    expect(await fixture.market.ownerOf(tokenId)).to.equal(fixture.buyer.address)
    expect(await fixture.market.pendingWithdrawals(fixture.creator.address)).to.equal(
      ethers.parseEther("0.975")
    )
    expect(await fixture.market.platformBalance()).to.equal(ethers.parseEther("0.025"))
  })

  it("pays royalty to creator on secondary sale", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).transferFrom(
      fixture.creator.address,
      fixture.seller.address,
      tokenId
    )

    await fixture.market.connect(fixture.seller).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.seller).listForSale(tokenId, ethers.parseEther("1"))
    await fixture.market.connect(fixture.buyer).buy(tokenId, { value: ethers.parseEther("1") })

    expect(await fixture.market.pendingWithdrawals(fixture.seller.address)).to.equal(
      ethers.parseEther("0.875")
    )
    expect(await fixture.market.pendingWithdrawals(fixture.creator.address)).to.equal(
      ethers.parseEther("0.1")
    )
  })

  it("clears listing on transfer", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))
    await fixture.market.connect(fixture.creator).transferFrom(
      fixture.creator.address,
      fixture.seller.address,
      tokenId
    )

    const listing = await fixture.market.getListing(tokenId)
    expect(listing.isActive).to.equal(false)
    expect(await fixture.market.ownerOf(tokenId)).to.equal(fixture.seller.address)
  })

  it("handles withdraw flows", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))
    await fixture.market.connect(fixture.buyer).buy(tokenId, { value: ethers.parseEther("1") })

    await expect(() => fixture.market.connect(fixture.creator).withdraw()).to.changeEtherBalances(
      [fixture.creator],
      [ethers.parseEther("0.975")]
    )

    await expect(() =>
      fixture.market.connect(fixture.admin).withdrawPlatformFees()
    ).to.changeEtherBalances([fixture.admin], [ethers.parseEther("0.025")])
  })

  it("blocks duplicate content registration", async function () {
    const fixture = await deployFixture()
    await mintAsCreator(fixture)

    await expect(
      fixture.market.connect(fixture.seller).mint(
        "ipfs://another-metadata",
        "ipfs://another-encrypted-content",
        "ipfs://another-preview",
        fixture.contentHash,
        1,
        500,
        fixture.encryptedAccessKey,
        fixture.perceptualHash
      )
    )
      .to.be.revertedWithCustomError(fixture.market, "ContentAlreadyRegistered")
      .withArgs(1n)
  })

  it("allows new owner to read access key after purchase", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))
    await fixture.market.connect(fixture.buyer).buy(tokenId, { value: ethers.parseEther("1") })

    const stored = await fixture.market.connect(fixture.buyer).getContentMetadata(tokenId)
    expect(stored.encryptedAccessKey).to.equal(fixture.encryptedAccessKey)
    expect(stored.creator).to.equal(fixture.creator.address)
  })

  it("burns token and cleans up metadata", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).burn(tokenId)

    await expect(fixture.market.ownerOf(tokenId)).to.be.reverted
    expect(await fixture.market.totalMinted()).to.equal(1n)

    // Content hash is freed — can re-mint the same content
    const tx2 = await fixture.market.connect(fixture.seller).mint(
      "ipfs://new-metadata",
      "ipfs://new-encrypted",
      "ipfs://new-preview",
      fixture.contentHash,
      2,
      500,
      fixture.encryptedAccessKey,
      fixture.perceptualHash
    )
    await tx2.wait()
    expect(await fixture.market.ownerOf(2n)).to.equal(fixture.seller.address)
  })

  it("prevents burn while listed", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))

    await expect(
      fixture.market.connect(fixture.creator).burn(tokenId)
    ).to.be.revertedWithCustomError(fixture.market, "AlreadyListed")
  })

  it("allows re-listing after cancel", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    await fixture.market.connect(fixture.creator).approve(await fixture.market.getAddress(), tokenId)
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("1"))
    await fixture.market.connect(fixture.creator).cancelListing(tokenId)

    // Re-list at a different price
    await fixture.market.connect(fixture.creator).listForSale(tokenId, ethers.parseEther("2"))

    const listing = await fixture.market.getListing(tokenId)
    expect(listing.isActive).to.equal(true)
    expect(listing.price).to.equal(ethers.parseEther("2"))
  })

  it("stores and retrieves perceptual hash", async function () {
    const fixture = await deployFixture()
    const tokenId = await mintAsCreator(fixture)

    const hash = await fixture.market.getPerceptualHash(tokenId)
    expect(hash).to.equal(fixture.perceptualHash)
  })
})

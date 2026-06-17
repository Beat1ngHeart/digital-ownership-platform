// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";

contract ContentNFTMarketplace is ERC721URIStorage, ERC721Royalty, ReentrancyGuard, Ownable {
    enum ContentType {
        Novel,
        Image,
        Music,
        Video,
        Other
    }

    struct ContentMetadata {
        address creator;
        ContentType contentType;
        uint256 mintedAt;
        string metadataURI;
        string encryptedContentURI;
        string previewURI;
        bytes32 contentHash;
        string encryptedAccessKey;
        uint64 perceptualHash;
    }

    struct Listing {
        address seller;
        uint256 price;
        bool isActive;
    }

    error MetadataURIRequired();
    error EncryptedContentURIRequired();
    error RoyaltyTooHigh();
    error PlatformFeeTooHigh();
    error NotTokenOwner();
    error PriceMustBeGreaterThanZero();
    error AlreadyListed();
    error NotListed();
    error IncorrectPayment();
    error SelfPurchase();
    error MarketplaceNotApproved();
    error InvalidContentHash();
    error ContentAlreadyRegistered(uint256 existingTokenId);

    uint96 public constant MAX_ROYALTY_BPS = 2_000;
    uint96 public constant MAX_PLATFORM_FEE_BPS = 500;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    uint256 private _nextTokenId = 1;

    mapping(uint256 tokenId => ContentMetadata) private _contentMetadata;
    mapping(uint256 tokenId => Listing) private _listings;
    mapping(bytes32 contentHash => uint256 tokenId) private _tokenIdByContentHash;
    mapping(address account => uint256 amount) public pendingWithdrawals;

    uint96 public platformFeeBps;
    uint256 public platformBalance;

    event ContentMinted(
        uint256 indexed tokenId,
        address indexed creator,
        ContentType contentType,
        string metadataURI,
        string previewURI,
        uint96 royaltyBps
    );
    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event Sale(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 royaltyAmount,
        uint256 platformFeeAmount
    );
    event Withdrawn(address indexed recipient, uint256 amount);
    event PlatformFeeUpdated(uint96 newFeeBps);
    event Burned(uint256 indexed tokenId, address indexed owner);

    constructor(uint96 initialPlatformFeeBps, address initialOwner)
        ERC721("ContentCertificate", "CERT")
        Ownable(initialOwner)
    {
        if (initialPlatformFeeBps > MAX_PLATFORM_FEE_BPS) revert PlatformFeeTooHigh();
        platformFeeBps = initialPlatformFeeBps;
    }

    function mint(
        string calldata metadataURI,
        string calldata encryptedContentURI,
        string calldata previewURI,
        bytes32 contentHash,
        ContentType contentType,
        uint96 royaltyBps,
        string calldata encryptedAccessKey,
        uint64 perceptualHash
    ) external returns (uint256 tokenId) {
        if (bytes(metadataURI).length == 0) revert MetadataURIRequired();
        if (bytes(encryptedContentURI).length == 0) revert EncryptedContentURIRequired();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (contentHash == bytes32(0)) revert InvalidContentHash();
        if (_tokenIdByContentHash[contentHash] != 0) {
            revert ContentAlreadyRegistered(_tokenIdByContentHash[contentHash]);
        }

        tokenId = _nextTokenId++;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, metadataURI);
        _setTokenRoyalty(tokenId, msg.sender, royaltyBps);

        _contentMetadata[tokenId] = ContentMetadata({
            creator: msg.sender,
            contentType: contentType,
            mintedAt: block.timestamp,
            metadataURI: metadataURI,
            encryptedContentURI: encryptedContentURI,
            previewURI: previewURI,
            contentHash: contentHash,
            encryptedAccessKey: encryptedAccessKey,
            perceptualHash: perceptualHash
        });
        _tokenIdByContentHash[contentHash] = tokenId;

        emit ContentMinted(tokenId, msg.sender, contentType, metadataURI, previewURI, royaltyBps);
    }

    function listForSale(uint256 tokenId, uint256 price) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (price == 0) revert PriceMustBeGreaterThanZero();
        if (_listings[tokenId].isActive) revert AlreadyListed();
        if (!_isMarketplaceApproved(tokenId)) revert MarketplaceNotApproved();

        _listings[tokenId] = Listing({seller: msg.sender, price: price, isActive: true});
        emit Listed(tokenId, msg.sender, price);
    }

    function cancelListing(uint256 tokenId) external {
        Listing memory listing = _listings[tokenId];
        if (!listing.isActive) revert NotListed();
        if (listing.seller != msg.sender) revert NotTokenOwner();

        delete _listings[tokenId];
        emit ListingCancelled(tokenId, msg.sender);
    }

    function burn(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (_listings[tokenId].isActive) revert AlreadyListed();

        bytes32 hash = _contentMetadata[tokenId].contentHash;
        if (hash != bytes32(0)) {
            delete _tokenIdByContentHash[hash];
        }
        delete _contentMetadata[tokenId];

        _burn(tokenId);
        emit Burned(tokenId, msg.sender);
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        Listing memory listing = _listings[tokenId];
        if (!listing.isActive) revert NotListed();
        if (msg.value != listing.price) revert IncorrectPayment();
        if (listing.seller == msg.sender) revert SelfPurchase();
        if (ownerOf(tokenId) != listing.seller) revert NotTokenOwner();
        if (!_isMarketplaceApproved(tokenId)) revert MarketplaceNotApproved();

        delete _listings[tokenId];

        (address royaltyReceiver, uint256 royaltyAmount) = royaltyInfo(tokenId, listing.price);
        uint256 platformFeeAmount = (listing.price * platformFeeBps) / BPS_DENOMINATOR;
        uint256 sellerProceeds = listing.price - royaltyAmount - platformFeeAmount;

        pendingWithdrawals[listing.seller] += sellerProceeds;

        if (royaltyAmount > 0) {
            pendingWithdrawals[royaltyReceiver] += royaltyAmount;
        }

        platformBalance += platformFeeAmount;
        _safeTransfer(listing.seller, msg.sender, tokenId);

        emit Sale(
            tokenId,
            listing.seller,
            msg.sender,
            listing.price,
            royaltyAmount,
            platformFeeAmount
        );
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    function withdrawPlatformFees() external onlyOwner nonReentrant {
        uint256 amount = platformBalance;
        require(amount > 0, "No fees");

        platformBalance = 0;
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawn(owner(), amount);
    }

    function setPlatformFee(uint96 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_PLATFORM_FEE_BPS) revert PlatformFeeTooHigh();
        platformFeeBps = newFeeBps;
        emit PlatformFeeUpdated(newFeeBps);
    }

    function canAccess(uint256 tokenId, address requester) external view returns (bool) {
        return ownerOf(tokenId) == requester;
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function isListed(uint256 tokenId) external view returns (bool) {
        return _listings[tokenId].isActive;
    }

    function isMarketplaceApproved(uint256 tokenId) external view returns (bool) {
        return _isMarketplaceApproved(tokenId);
    }

    function isContentRegistered(bytes32 contentHash) external view returns (bool) {
        return _tokenIdByContentHash[contentHash] != 0;
    }

    function getTokenIdByContentHash(bytes32 contentHash) external view returns (uint256) {
        return _tokenIdByContentHash[contentHash];
    }

    function getEncryptedContentURI(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return _contentMetadata[tokenId].encryptedContentURI;
    }

    function getContentMetadata(uint256 tokenId) external view returns (ContentMetadata memory) {
        if (_contentMetadata[tokenId].creator == address(0)) revert InvalidContentHash();
        return _contentMetadata[tokenId];
    }

    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return _listings[tokenId];
    }

    function getPerceptualHash(uint256 tokenId) external view returns (uint64) {
        return _contentMetadata[tokenId].perceptualHash;
    }

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721URIStorage, ERC721Royalty) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721) returns (address) {
        address previousOwner = super._update(to, tokenId, auth);

        if (previousOwner != address(0) && previousOwner != to && _listings[tokenId].isActive) {
            delete _listings[tokenId];
        }

        return previousOwner;
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721) {
        super._increaseBalance(account, value);
    }

    function _isMarketplaceApproved(uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return getApproved(tokenId) == address(this) || isApprovedForAll(owner, address(this));
    }
}

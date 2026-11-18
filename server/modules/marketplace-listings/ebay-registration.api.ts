/**
 * Internal API facade for eBay marketplace registration observation & contracts (CI-03 / CHN-2).
 *
 * Peer modules (`channels`, `dropship`) must import
 * `EbayMarketplaceRegistrationObserver`, `FetchEbayRegistrationReadTransport`,
 * and eBay registration identity/credential contracts through this facade
 * rather than reaching into `marketplace-listings/infrastructure/*`.
 */

export {
  EbayMarketplaceRegistrationObserver,
  type EbayMarketplaceRegistrationObserverConfig,
} from "./infrastructure/providers/ebay/ebay-registration-observer";
export {
  EBAY_REGISTRATION_ENVIRONMENTS,
  EBAY_REGISTRATION_IDENTITY_ROLES,
  EBAY_REGISTRATION_MAX_RESPONSE_BYTES,
  EBAY_REGISTRATION_READ_TIMEOUT_MS,
  FetchEbayRegistrationReadTransport,
  assertEbayRegistrationEnvironment,
  buildEbayProviderAccountEvidenceHash,
  buildEbayRegistrationIdentityNamespace,
  ebayProviderAccountNamespace,
  parseEbayRegistrationMarketplaceId,
  type EbayRegistrationCredentialProvider,
  type EbayRegistrationEnvironment,
  type EbayRegistrationIdentityRole,
  type EbayRegistrationReadCredential,
  type EbayRegistrationReadRequest,
  type EbayRegistrationReadResponse,
  type EbayRegistrationReadTransport,
  type FetchEbayRegistrationReadTransportOptions,
} from "./infrastructure/providers/ebay/ebay-registration-contracts";

import {
  DropshipEbayListingSetupService,
} from "../application/dropship-ebay-listing-setup-service";
import {
  makeDropshipListingConfigLogger,
} from "../application/dropship-listing-config-service";
import type {
  DropshipStoreConnectionPostConnectProvider,
} from "../application/dropship-store-connection-service";
import { DropshipError } from "../domain/errors";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";
import { EbayDropshipListingSetupDirectory } from "./dropship-ebay-listing-setup.directory";
import { createDropshipEbayFulfillmentCapabilityProviderFromEnv } from "./dropship-ebay-fulfillment-capability.provider";
import { PgDropshipEbayManagedLocationProvider } from "./dropship-ebay-managed-location.provider";
import { createDropshipListingConfigServiceFromEnv } from "./dropship-listing-config.factory";

export function createDropshipEbayListingSetupServiceFromEnv(): DropshipEbayListingSetupService {
  const credentials = createDropshipEbayRegistrationCredentialProviderFromEnv();
  return new DropshipEbayListingSetupService({
    listingConfig: createDropshipListingConfigServiceFromEnv(),
    directory: new EbayDropshipListingSetupDirectory(
      credentials,
    ),
    fulfillmentCapabilities: createDropshipEbayFulfillmentCapabilityProviderFromEnv(),
    managedLocations: new PgDropshipEbayManagedLocationProvider({ credentials }),
    logger: makeDropshipListingConfigLogger(),
  });
}

export class EbayDropshipListingSetupPostConnectProvider
  implements DropshipStoreConnectionPostConnectProvider
{
  constructor(
    private readonly setup: DropshipEbayListingSetupService,
    private readonly logger = makeDropshipListingConfigLogger(),
  ) {}

  async afterStoreConnected(
    input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0],
  ): Promise<void> {
    if (input.platform !== "ebay") return;
    try {
      const result = await this.setup.autoConfigureAfterConnection({
        storeConnectionId: input.storeConnectionId,
        accessToken: input.accessToken,
        environment: requireEbayEnvironment(input.providerEnvironment),
      });
      if (!result.complete) {
        this.logger.warn({
          code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_REQUIRED",
          message: "The connected eBay store requires listing setup selections.",
          context: {
            vendorId: input.vendorId,
            storeConnectionId: input.storeConnectionId,
            missingFields: result.missingFields,
          },
        });
      }
    } catch (error) {
      // Listing setup is a push prerequisite, not a reason to discard otherwise
      // valid OAuth credentials. Catalog remains available and exposes the
      // actionable setup error to the vendor.
      this.logger.warn({
        code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
        message: "The eBay store connected, but listing setup discovery did not complete.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          errorCode: error instanceof DropshipError
            ? error.code
            : "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }
  }
}

export function createDropshipEbayListingSetupPostConnectProviderFromEnv(): DropshipStoreConnectionPostConnectProvider {
  return new EbayDropshipListingSetupPostConnectProvider(
    createDropshipEbayListingSetupServiceFromEnv(),
  );
}

function requireEbayEnvironment(value: string): "sandbox" | "production" {
  if (value === "sandbox" || value === "production") return value;
  throw new DropshipError(
    "DROPSHIP_EBAY_LISTING_SETUP_ENVIRONMENT_INVALID",
    "The connected eBay store has an invalid provider environment.",
    { providerEnvironment: value, retryable: false },
  );
}

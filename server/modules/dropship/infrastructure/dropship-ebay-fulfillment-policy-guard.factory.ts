import { DropshipEbayFulfillmentPolicyGuardService } from "../application/dropship-ebay-fulfillment-policy-guard";
import { createDropshipEbayFulfillmentCapabilityProviderFromEnv } from "./dropship-ebay-fulfillment-capability.provider";
import { EbayDropshipListingSetupDirectory } from "./dropship-ebay-listing-setup.directory";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";

export function createDropshipEbayFulfillmentPolicyGuardFromEnv():
DropshipEbayFulfillmentPolicyGuardService {
  return new DropshipEbayFulfillmentPolicyGuardService({
    directory: new EbayDropshipListingSetupDirectory(
      createDropshipEbayRegistrationCredentialProviderFromEnv(),
    ),
    capabilities: createDropshipEbayFulfillmentCapabilityProviderFromEnv(),
  });
}

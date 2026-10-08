import {
  CachingDropshipEbayReturnPaymentPolicyChecker,
  type DropshipEbayReturnPaymentPolicyChecker,
} from "../application/dropship-ebay-return-payment-policy-check";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { EbayDropshipListingSetupDirectory } from "./dropship-ebay-listing-setup.directory";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";

/**
 * One checker per process, so its short-lived policy lists are shared: the
 * push worker builds a new preview service for every listing it pushes
 * (dropship-listing-push-worker.factory.ts), and a checker per service would
 * never reuse a list. Built on first use.
 */
let processChecker: DropshipEbayReturnPaymentPolicyChecker | null = null;

export function getDropshipEbayReturnPaymentPolicyCheckerFromEnv(): DropshipEbayReturnPaymentPolicyChecker {
  processChecker ??= new CachingDropshipEbayReturnPaymentPolicyChecker({
    directory: new EbayDropshipListingSetupDirectory(
      createDropshipEbayRegistrationCredentialProviderFromEnv(),
    ),
    clock: systemDropshipListingPreviewClock,
  });
  return processChecker;
}

import { z } from "zod";
import { EbayApiClient } from "../../channels/adapters/ebay/ebay-api.client";
import { EbayQuantityResponseUncertainError } from "../../channels/adapters/ebay/ebay-quantity-http";
import type { EbayQuantityRequestAdmission } from "../../channels/quantity-publication-request";
import type { EbayListingInspection } from "../../marketplace-listings/domain/ebay-listing-inspection";
import type { EbayMarketplaceRegistrationObserver } from "../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import type {
  DropshipListingEndProvider,
  ListingEndCredential,
  ListingEndWithdrawResult,
} from "../application/dropship-listing-end-service";
import type { listingEndQuantityScope } from "../domain/listing-end-claims";
import { listingEndErrorFacts } from "../domain/listing-end-errors";
import { DropshipError } from "../domain/errors";
import { recordEbayAccessTokenRejection } from "./dropship-ebay-auth-failure";
import { resolveDropshipEbayProviderEnvironment, type DropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";
import type { DropshipMarketplaceCredentialRepository, DropshipMarketplaceStoreCredentials } from "./dropship-marketplace-credentials";

/**
 * The listing end worker's eBay and inventory composition (PR C, PLAN-C v4.1 §5.5, §5.8; Dropship). Every piece is a
 * published interface: Dropship's own token owner (operation `listing_end`) and access-token rejection record; the
 * shared registration observer's read-only inspection over Dropship's credential adapter (the dropship factory's
 * `inspector`); inventory planning's response recovery and Dropship quantity admission
 * (server/modules/inventory-planning/quantity-publication.ts); the shared eBay client's `withdrawOffer`, one admitted
 * quantity write (ebay-quantity-http.ts classifies its one HTTP attempt). The adapter classifies the client's errors
 * into the worker's outcomes and never retries a write.
 */

/** The token owner's operation name for this worker (snake_case, as `listing_push`, `marketplace_sync_back`). */
export const LISTING_END_CREDENTIAL_OPERATION = "listing_end";

/** The full stored credential, kept out of the worker's view (and out of JSON: a symbol key is never serialized). */
const CREDENTIAL = Symbol("dropshipListingEndCredential");
type AdapterCredential = ListingEndCredential & { [CREDENTIAL]: DropshipMarketplaceStoreCredentials };

/** The admission the dropship store's quantity writes go through (createDropshipEbayQuantityRequestAdmission). */
export type CreateDropshipListingEndAdmission = (input: {
  storeConnectionId: number; externalAccountId: string | null; externalAccountVerifiedAt: Date | null; providerEnvironment?: string | null;
}) => EbayQuantityRequestAdmission;

/** The eBay client the withdraw is sent through (the shared EbayApiClient; tests pass a stub). */
export type CreateDropshipListingEndClient = (input: {
  accessToken: string; storeConnectionId: number; environment: "production" | "sandbox"; admission: EbayQuantityRequestAdmission;
}) => { withdrawOffer(offerId: string): Promise<void> };

export interface DropshipEbayListingEndAdapterDependencies {
  credentials: Pick<DropshipEbayRegistrationCredentialProvider, "loadFreshForStoreConnection">;
  credentialRepository: DropshipMarketplaceCredentialRepository;
  inspector: Pick<EbayMarketplaceRegistrationObserver, "inspectExistingPublication">;
  recovery: { reconcile(scopes: readonly ReturnType<typeof listingEndQuantityScope>[]): Promise<{ resolved: string[]; unresolved: string[]; busy: boolean }> };
  createAdmission: CreateDropshipListingEndAdmission;
  createClient?: CreateDropshipListingEndClient;
}

const scopeSchema = z.object({
  destinationKind: z.literal("dropship_store_connection"), connectionId: z.number().int().positive().max(2_147_483_647),
  providerKey: z.literal("ebay"), providerScopeType: z.literal("account"), externalScopeId: z.string().trim().min(1).max(240),
  externalInventoryItemId: z.string().trim().min(1).max(240), productId: z.null(), productVariantId: z.null(),
}).strict();

/** The shared eBay client, built as retirement's Dropship branch builds it (listing-member-lifecycle.composition.ts). */
export const createEbayListingEndClient: CreateDropshipListingEndClient = (input) => new EbayApiClient(
  { getAccessToken: async () => input.accessToken }, input.storeConnectionId, input.environment,
  { quantityAdmission: async () => input.admission },
);

export class DropshipEbayListingEndAdapter implements DropshipListingEndProvider {
  private readonly createClient: CreateDropshipListingEndClient;

  constructor(private readonly deps: DropshipEbayListingEndAdapterDependencies) {
    this.createClient = deps.createClient ?? createEbayListingEndClient;
  }

  async loadCredential(input: { vendorId: number; storeConnectionId: number; rejectedAccessTokenRef?: string }): Promise<ListingEndCredential> {
    const credential = await this.deps.credentials.loadFreshForStoreConnection({
      vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, operation: LISTING_END_CREDENTIAL_OPERATION,
      ...(input.rejectedAccessTokenRef ? { rejectedAccessTokenRef: input.rejectedAccessTokenRef } : {}),
    });
    if (credential.vendorId !== input.vendorId || credential.storeConnectionId !== input.storeConnectionId || credential.platform !== "ebay") {
      throw new DropshipError("DROPSHIP_EBAY_CREDENTIAL_OWNER_MISMATCH", "The loaded credential does not belong to this eBay store.",
        { storeConnectionId: input.storeConnectionId, retryable: false });
    }
    let environment: ListingEndCredential["environment"];
    try {
      environment = resolveDropshipEbayProviderEnvironment(credential);
    } catch (error) {
      // A store without a usable environment cannot be proven to be the resolved one: the worker fails it ACCOUNT_CHANGED.
      if (!(error instanceof DropshipError)) throw error;
      environment = null;
    }
    const facts: AdapterCredential = {
      externalAccountId: credential.externalAccountId, externalAccountVerifiedAt: credential.externalAccountVerifiedAt,
      environment, accessTokenRef: credential.accessTokenRef, [CREDENTIAL]: credential,
    };
    return facts;
  }

  inspect(input: { storeConnectionId: number; productId: number; productVariantId: number; marketplaceId: string; sku: string }):
    Promise<EbayListingInspection> {
    return this.deps.inspector.inspectExistingPublication({
      owner: { kind: "dropship", storeConnectionId: input.storeConnectionId, productId: input.productId, provider: "ebay",
        marketplaceId: input.marketplaceId },
      // Observation metadata only (the channels withdrawal's shape): no stock decision or quantity write is made here.
      memberCandidates: [{ productVariantId: input.productVariantId, sku: input.sku, isActive: true, availableQuantity: 0 }],
    });
  }

  reconcile(scope: ReturnType<typeof listingEndQuantityScope>): Promise<{ resolved: string[]; unresolved: string[]; busy: boolean }> {
    // The admission's own scope under the strict schema (quantity-publication-admission.ts; FID-8).
    return this.deps.recovery.reconcile([scopeSchema.parse(scope)]);
  }

  async withdraw(input: { credential: ListingEndCredential; storeConnectionId: number; offerId: string }): Promise<ListingEndWithdrawResult> {
    const credential = storedCredential(input.credential);
    if (input.credential.environment === null) throw new Error("A listing end withdraw needs a resolved eBay environment.");
    let admission: EbayQuantityRequestAdmission;
    try {
      // PR C passes the store's environment, which retirement's composition omits (FID-8).
      admission = this.deps.createAdmission({ storeConnectionId: input.storeConnectionId, externalAccountId: credential.externalAccountId,
        externalAccountVerifiedAt: credential.externalAccountVerifiedAt, providerEnvironment: credential.providerEnvironment });
    } catch (error) {
      const admissionError = asAdmissionError(error);
      if (admissionError) return { outcome: "admission", code: admissionError.code, context: admissionError.context };
      throw error;
    }
    // The shared client reads the offer before the admitted send (quantity-publication-request.ts); the POST happens
    // only inside the admission's work. Watching that work tells a failure that sent nothing from one that may have.
    let sendStarted = false;
    const watched: EbayQuantityRequestAdmission = {
      item: (sku, work) => admission.item(sku, (quantity) => { sendStarted = true; return work(quantity); }),
      group: (groupKey, skus, work, maintenance) => admission.group(groupKey, skus, (quantities, retainedSkus) => {
        sendStarted = true;
        return work(quantities, retainedSkus);
      }, maintenance),
      reducing: (identity, work, memberSkus) => admission.reducing(identity, () => { sendStarted = true; return work(); }, memberSkus),
    };
    const client = this.createClient({ accessToken: credential.accessToken, storeConnectionId: input.storeConnectionId,
      environment: input.credential.environment, admission: watched });
    try {
      await client.withdrawOffer(input.offerId);
      return { outcome: "ok" };
    } catch (error) {
      if (!sendStarted && !asAdmissionError(error)) {
        // Failed before the send (the offer read, a 401/404/5xx or a transport failure there): nothing reached eBay and
        // no inventory attempt was opened, so it is a read that failed, never an uncertain withdraw (review WRK-4).
        const facts = listingEndErrorFacts(error);
        return { outcome: "not_sent", status: facts.status, code: facts.code ?? (error instanceof Error ? error.name : null) };
      }
      return classifyWithdrawError(error);
    }
  }

  async recordAccessTokenRejection(input: { credential: ListingEndCredential; status: number; failureCode: string; message: string; now: Date }): Promise<void> {
    // Guarded by the credential this attempt loaded: a token that changed since is refused (DROPSHIP_CREDENTIAL_CHANGED).
    await recordEbayAccessTokenRejection({ credentials: this.deps.credentialRepository, credential: storedCredential(input.credential),
      status: input.status, failureCode: input.failureCode, message: input.message, now: input.now });
  }
}

function storedCredential(credential: ListingEndCredential): DropshipMarketplaceStoreCredentials {
  const stored = (credential as Partial<AdapterCredential>)[CREDENTIAL];
  if (!stored) throw new Error("The listing end credential was not loaded by this adapter.");
  return stored;
}

/** The inventory admission's own refusal (QuantityPublicationAdmissionError), matched by name, as the push provider does. */
function asAdmissionError(error: unknown): { code: string; context: Readonly<Record<string, unknown>> } | null {
  if (!(error instanceof Error) || error.name !== "QuantityPublicationAdmissionError") return null;
  const code = (error as { code?: unknown }).code;
  const context = (error as { context?: unknown }).context;
  return typeof code === "string" ? { code, context: context && typeof context === "object" ? context as Record<string, unknown> : {} } : null;
}

/**
 * The withdraw's one HTTP attempt as ebay-quantity-http.ts classified it: a refusal eBay applied nothing for
 * (QuantityProviderRejectionError), an uncertain answer (EbayQuantityResponseUncertainError), a transport failure,
 * or the admission refusing before the call. Anything else after admission is uncertain: never assumed not sent.
 */
export function classifyWithdrawError(error: unknown): ListingEndWithdrawResult {
  const admissionError = asAdmissionError(error);
  if (admissionError) return { outcome: "admission", code: admissionError.code, context: admissionError.context };
  if (error instanceof Error && error.name === "QuantityProviderRejectionError") {
    const providerWrite = (error as { providerWrite?: { httpStatus?: unknown } }).providerWrite;
    const status = typeof providerWrite?.httpStatus === "number" ? providerWrite.httpStatus : null;
    const code = (error as { code?: unknown }).code;
    return { outcome: "rejected", rejectionCode: typeof code === "string" ? code : "EBAY_QUANTITY_REJECTED", status };
  }
  if (error instanceof EbayQuantityResponseUncertainError) {
    return { outcome: "uncertain", status: error.httpStatus, detail: { errorCode: error.code } };
  }
  if (error instanceof Error && (error.name === "TypeError" || error.name === "AbortError" || error.name === "TimeoutError")) {
    return { outcome: "network", detail: { errorName: error.name } };
  }
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : null;
  return { outcome: "uncertain", status: null, detail: { errorName: error instanceof Error ? error.name : typeof error,
    ...(code ? { errorCode: code } : {}) } };
}

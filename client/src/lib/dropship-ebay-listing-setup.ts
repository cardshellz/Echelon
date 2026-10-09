import {
  DropshipApiError,
  createDropshipIdempotencyKey,
  queryErrorCode,
  type DropshipEbayListingSetupResponse,
  type DropshipEbayListingSetupSaveRequest,
  type DropshipEbayShipFromRepairRequest,
  type ReplaceDropshipEbayListingSetupInput,
} from "./dropship-ops-surface";

/**
 * The words and request bodies for the eBay listing setup panel (Listing
 * settings PR 6). Pure: no React, no network.
 */

/** Shown when this page was loaded from a server without revisions, or before one was read. */
export const LISTING_SETUP_RELOAD_MESSAGE = "This page is out of date. Reload it, then save again.";

/** Why the vendor can see but not change these settings, in their words (design 3.5); null when they can change them. */
export function listingSetupReadOnlyMessage(
  setup: Pick<DropshipEbayListingSetupResponse, "access">,
  storeName: string,
): string | null {
  const access = setup.access;
  if (!access || access.canEdit) return null;
  switch (access.reason) {
    case "store_paused":
      return `${storeName} is paused, so its settings can't be changed now.`;
    case "store_disconnecting":
      return `${storeName} is being disconnected, so its settings can't be changed now.`;
    case "store_disconnected":
      return `${storeName} is disconnected, so its settings can't be changed now.`;
    case "vendor_not_active":
      return "Your dropship account isn't active, so listing settings can't be changed. Contact support.";
  }
}

/**
 * When Card Shellz shipping could not be read, the shipping policy can't be
 * checked. The vendor gets plain words and a reference for support, never the
 * staff-facing reason.
 */
export function listingSetupShippingCheckNotice(
  setup: Pick<DropshipEbayListingSetupResponse, "checks">,
): { message: string; reference: string } | null {
  const check = setup.checks?.fulfillment;
  if (!check || check.status !== "unavailable") return null;
  switch (check.kind) {
    case "temporary":
      return {
        message: "Can't check Card Shellz shipping right now. Your saved settings still apply. Choose Refresh options in a few minutes.",
        reference: check.reference,
      };
    case "marketplace_unsupported":
      return {
        message: "Card Shellz lists on eBay US only. This store is set up for another eBay site. Contact support.",
        reference: check.reference,
      };
    default:
      return {
        message: "Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it's done.",
        reference: check.reference,
      };
  }
}

/**
 * Whether this answer carries eBay's live option lists. A read-only view and
 * a replayed save do not: they show the saved values only.
 */
export function listingSetupShowsSavedValuesOnly(setup: Pick<DropshipEbayListingSetupResponse, "checks">): boolean {
  return setup.checks !== undefined && setup.checks.ebay !== "checked";
}

/** Whether Card Shellz shipping was checked for this answer (always, for a server from before the check states existed). */
export function listingSetupShippingChecked(setup: Pick<DropshipEbayListingSetupResponse, "checks">): boolean {
  return setup.checks === undefined || setup.checks.fulfillment.status === "checked";
}

type PolicyField = keyof ReplaceDropshipEbayListingSetupInput;
const POLICY_FIELDS: readonly PolicyField[] = ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"];
const NAME_BY_FIELD = {
  fulfillmentPolicyId: "fulfillmentPolicyName",
  returnPolicyId: "returnPolicyName",
  paymentPolicyId: "paymentPolicyName",
} as const;

/** One option per saved policy, named as eBay listed it at the last save (or by its id), for a view without eBay's lists. */
export function listingSetupSavedOption(
  setup: Pick<DropshipEbayListingSetupResponse, "selection" | "storedNames">,
  field: PolicyField,
): Array<{ id: string; name: string }> {
  const id = setup.selection[field];
  if (!id) return [];
  return [{ id, name: setup.storedNames?.[NAME_BY_FIELD[field]] ?? id }];
}

/** The revision to save against, or null when this answer carries none (the page must reload). */
export function listingSetupRevision(setup: Pick<DropshipEbayListingSetupResponse, "revision">): number | null {
  const revision = setup.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

/**
 * The PUT body for this panel's save: all three policies, against the
 * revision the options were loaded with. Throws when there is no revision,
 * since the server refuses a save without one.
 */
export function buildEbayListingSetupSaveRequest(
  setup: Pick<DropshipEbayListingSetupResponse, "revision" | "selection">,
  draft: ReplaceDropshipEbayListingSetupInput,
  idempotencyKey: string,
): DropshipEbayListingSetupSaveRequest {
  const expectedRevision = listingSetupRevision(setup);
  if (expectedRevision === null) throw new Error(LISTING_SETUP_RELOAD_MESSAGE);
  // Only what changed is sent, so a return or payment change needs no Card
  // Shellz shipping check. With nothing changed, every chosen policy is sent.
  const changed = POLICY_FIELDS.filter((field) => draft[field] !== "" && draft[field] !== (setup.selection[field] ?? ""));
  const fields = changed.length > 0 ? changed : POLICY_FIELDS.filter((field) => draft[field] !== "");
  const request: DropshipEbayListingSetupSaveRequest = { expectedRevision, idempotencyKey };
  for (const field of fields) request[field] = draft[field];
  return request;
}

export function buildEbayShipFromRepairRequest(
  setup: Pick<DropshipEbayListingSetupResponse, "revision">,
  idempotencyKey: string,
): DropshipEbayShipFromRepairRequest {
  const expectedRevision = listingSetupRevision(setup);
  if (expectedRevision === null) throw new Error(LISTING_SETUP_RELOAD_MESSAGE);
  return { expectedRevision, idempotencyKey };
}

/**
 * One request key per save attempt. A retry of the same choices against the
 * same revision (after a dropped connection, say) reuses the key, so the
 * server answers it from the first save instead of saving twice. Any other
 * change starts a new attempt with a new key.
 */
export class ListingSetupRequestKeys {
  private current: { signature: string; key: string } | null = null;

  constructor(
    private readonly prefix: string,
    private readonly newKey: (prefix: string) => string = createDropshipIdempotencyKey,
  ) {}

  keyFor(attempt: unknown): string {
    const signature = JSON.stringify(attempt);
    if (this.current?.signature !== signature) {
      this.current = { signature, key: this.newKey(this.prefix) };
    }
    return this.current.key;
  }

  /** Call once the server confirmed the save, so the next save gets a new key. */
  settled(): void {
    this.current = null;
  }
}

/**
 * A save or ship-from repair error in words this panel can act on; other
 * errors keep the server's own message.
 */
export function listingSetupSaveErrorMessage(
  error: unknown,
  fallback: string,
  action: "save" | "ship_from_repair" = "save",
): string {
  switch (queryErrorCode(error)) {
    case "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT":
      return action === "ship_from_repair"
        ? "These settings changed in another window. Choose Refresh options, then Update ship-from location again."
        : "These settings changed in another window. Choose Refresh options to load what is saved now. Your changes stay chosen; check them, then save again.";
    case "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE": {
      // The vendor's own eBay policy does not fit; they fix it by choosing another.
      const issue = firstIssueMessage(error);
      return `This shipping policy doesn't work with Card Shellz shipping${issue ? `: ${issue}` : ""}. Choose Refresh options, then pick another shipping policy.`;
    }
    case "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED":
      return "Card Shellz lists on eBay US only. This store is set up for another eBay site. Contact support.";
    case "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED":
      return LISTING_SETUP_RELOAD_MESSAGE;
    case "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED":
      return "This store is paused or disconnected, so its settings can't be changed now.";
    case "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED":
      return "Too many saves in a minute. Wait a moment and try again.";
    case "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED":
      return "This store is disconnected, so its settings can't be changed now.";
    default: {
      const code = queryErrorCode(error);
      // Card Shellz shipping and warehouse problems carry staff wording; the
      // vendor gets plain words and the code as a reference for support.
      if (code && CARD_SHELLZ_SHIPPING_CODE.test(code)) {
        const retryable = error instanceof DropshipApiError && error.context?.retryable === true;
        return retryable
          ? `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`
          : `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
      }
      return error instanceof Error && error.message ? error.message : fallback;
    }
  }
}

/**
 * Card Shellz's own shipping or warehouse setup. The codes the vendor can act
 * on themselves (a policy that doesn't fit, an eBay site Card Shellz doesn't
 * list on) have their own cases above and never reach this test.
 */
const CARD_SHELLZ_SHIPPING_CODE = /^DROPSHIP_EBAY_(FULFILLMENT|MANAGED_LOCATION_WAREHOUSE|MANAGED_LOCATION_COUNTRY)_/;

/** The first issue the server named for a refused shipping policy (context.issues), if any. */
function firstIssueMessage(error: unknown): string | null {
  if (!(error instanceof DropshipApiError) || !Array.isArray(error.context?.issues)) return null;
  for (const issue of error.context.issues as unknown[]) {
    if (issue && typeof issue === "object" && typeof (issue as { message?: unknown }).message === "string") {
      // The server's issue sentences end with a period; the caller adds its own.
      const message = (issue as { message: string }).message.trim().replace(/[.\s]+$/, "");
      if (message) return message;
    }
  }
  return null;
}

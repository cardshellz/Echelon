import { z } from "zod";
import { LISTING_SETTING_WRITE_ERROR_CODES } from "../../../../shared/dropship/listing-setting-writes";
import { DropshipError } from "../domain/errors";
import type { RequestKeyUseDecision } from "../domain/listing-setting-request-key-use";
import { listingSettingRequestHash, listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import type { DropshipListingStoreContext } from "./dropship-listing-preview-service";
import type { ListingSettingWriteTransaction } from "./dropship-listing-setting-writes";

/**
 * What every listing-settings write service shares (plan PR 9, section 3.1):
 * the input parser, the gate, the request hash, the replay decision as
 * errors, and the log port.
 * Every error here carries `retryable` and `classification` (CLAUDE.md §6).
 */

/** One INFO line per successful write (plan 3.4), through the platform logger behind this port. Never any text value. */
export interface ListingSettingWriteLog {
  info(action: string, fields: Record<string, unknown>): void;
}

/** Store connection ids are int4 keys. */
export const listingSettingStoreIdSchema = z.number().int().positive().max(2_147_483_647);

/** The words of every 400 a write answers for its own input. */
export const LISTING_SETTING_INVALID_INPUT_MESSAGE = "Check the listing settings change and reload if the page is out of date.";
/** At most this many Zod issues, so a large body cannot make a large answer (plan P5). */
export const MAX_ECHOED_ISSUES = 20;

/** One issue as it may leave the server (plan P5). 8a's writers report the path as one dotted string. */
export interface ListingSettingIssue {
  path: string | Array<string | number>;
  code: string;
  message?: string;
}

/**
 * A write's route input (store id, body), parsed: the value, or the permanent
 * 400 DROPSHIP_LISTING_SETTINGS_INVALID_INPUT with at most 20 issues. Only an
 * input parsed here is the vendor's mistake; a ZodError thrown anywhere else
 * (a stored row or a derived value failing its contract inside the
 * transaction) is a broken contract, answered 500 and logged as fatal.
 */
export function parseListingSettingInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw permanent(LISTING_SETTING_WRITE_ERROR_CODES.invalidInput, LISTING_SETTING_INVALID_INPUT_MESSAGE, {
    issues: listingSettingIssues(parsed.error.issues),
  });
}

/**
 * Issues rebuilt as `{ path, code }`, keeping the message only for a custom
 * issue, whose words are ours: Zod's own messages and fields (`received`,
 * `keys`, `unionErrors`) can quote what was sent (an 8a finding). Anything
 * that is not an issue is dropped; at most MAX_ECHOED_ISSUES are kept.
 */
export function listingSettingIssues(issues: readonly unknown[]): ListingSettingIssue[] {
  const echoed: ListingSettingIssue[] = [];
  for (const issue of issues) {
    if (echoed.length === MAX_ECHOED_ISSUES) break;
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) continue;
    const { path, code, message } = issue as { path?: unknown; code?: unknown; message?: unknown };
    if (typeof code !== "string") continue;
    const echoedPath = typeof path === "string" ? path
      : Array.isArray(path) ? path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
        : null;
    if (echoedPath === null) continue;
    echoed.push({ path: echoedPath, code, ...(code === "custom" && typeof message === "string" ? { message } : {}) });
  }
  return echoed;
}

/** W9's allow-lists (plan P10): one rule for every listing writer. */
const WRITABLE_VENDOR_STATUSES: ReadonlySet<string> = new Set(["active", "onboarding"]);
// Token health is not authority for a local setting: a store that needs a
// sign-in keeps its settings writable; paused and disconnected stores do not.
const WRITABLE_STORE_STATUSES: ReadonlySet<string> = new Set(["connected", "needs_reauth", "refresh_failed"]);

export function assertListingSettingMember(memberId: string): void {
  if (typeof memberId !== "string" || !memberId.trim()) {
    throw permanent("DROPSHIP_AUTH_REQUIRED", "Dropship authentication is required.", {});
  }
}

/**
 * The gate, first inside every write transaction (plan 3.8): the store, then
 * the vendor, the .ops entitlement, the store's status and its platform. The
 * wrapper checked only that the member's vendor owns the store; the vendor and
 * store rows are held FOR SHARE, so the answer holds until commit.
 */
export async function authorizeListingSettingWrite(
  tx: Pick<ListingSettingWriteTransaction, "vendorId" | "storeConnectionId" | "catalog">,
): Promise<DropshipListingStoreContext> {
  const { storeConnectionId } = tx;
  const context = await tx.catalog.loadStoreContext({ vendorId: tx.vendorId, storeConnectionId });
  if (!context) throw permanent("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.", { storeConnectionId });
  if (!WRITABLE_VENDOR_STATUSES.has(context.vendorStatus)) {
    throw permanent("DROPSHIP_LISTING_VENDOR_BLOCKED", "Your vendor status does not permit listing settings changes.",
      { storeConnectionId, reason: context.vendorStatus });
  }
  if (context.entitlementStatus !== "active") {
    throw permanent("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "An active .ops entitlement is required to change listing settings.",
      { storeConnectionId, reason: context.entitlementStatus });
  }
  if (!WRITABLE_STORE_STATUSES.has(context.storeStatus)) {
    throw permanent("DROPSHIP_LISTING_STORE_BLOCKED", "This store is not available for listing settings changes.",
      { storeConnectionId, reason: context.storeStatus });
  }
  if (context.platform !== "ebay") {
    throw permanent("DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", "Listing settings work for eBay stores only.", { storeConnectionId });
  }
  return context;
}

/**
 * The request hash (plan 3.7): the writer's versioned operation and the
 * route-parsed body without its key, arrays sorted by id. Pass Zod-parsed
 * values so equal requests hash equal (listingSettingRequestHash).
 */
export function listingSettingWriteHash(operation: string, parsedBody: Record<string, unknown>): string {
  if ("idempotencyKey" in parsedBody) {
    throw listingSettingsInvariantFailed("A listing settings request hash never includes the request key.", { operation });
  }
  return listingSettingRequestHash({ operation, ...parsedBody });
}

/**
 * The replay probe's decision as the request's path: `new` writes, `replay`
 * answers from the probe's rows; a key used for another change is the
 * permanent key conflict, and rows a committed request cannot have left on
 * their own are fatal (plan 4.6).
 */
export function requestKeyUsePath(decision: RequestKeyUseDecision, context: { storeConnectionId: number }): "new" | "replay" {
  switch (decision.kind) {
    case "new":
    case "replay":
      return decision.kind;
    case "conflict":
      throw listingSettingKeyConflict(decision.mismatched, context);
    case "incomplete":
      throw new DropshipError(LISTING_SETTING_WRITE_ERROR_CODES.replayIncomplete,
        "An earlier save with this request key is only partly recorded.", {
          ...context, retryable: false, classification: "fatal",
        });
  }
}

/** The code, words and class of listingSettingsIdempotencyConflict (8a), with the fields that differ. */
export function listingSettingKeyConflict(mismatched: readonly string[], context: { storeConnectionId: number }): DropshipError {
  return permanent("DROPSHIP_IDEMPOTENCY_CONFLICT", "This request key was already used for a different listing settings change.",
    { ...context, mismatched: [...mismatched] });
}

function permanent(code: string, message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(code, message, { ...context, retryable: false, classification: "permanent" });
}

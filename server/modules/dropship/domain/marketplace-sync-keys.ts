import { createHash } from "node:crypto";
import { MARKETPLACE_SYNC_KEY_PREFIX } from "../../../../shared/dropship/listing-rules-conversion-keys";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "./marketplace-sync-errors";

/**
 * eBay sync-back's keys (plan v4 §6.6). Every write it makes is keyed so a
 * replay (a retried tick, a second dyno, a re-run push pre-read) writes
 * nothing new: revision keys share the vendor's `UNIQUE (vendor_id,
 * idempotency_key)` spaces under the reserved `ebay-sync:` prefix, which
 * vendor key schemas refuse (SB34); notice subject keys are unique per store
 * and kind; batch keys are the notification's own idempotency key. Every key
 * is built from ids, integer cents, epoch milliseconds and hex hashes only,
 * and checked against the columns' pattern before it is used.
 */

/** Who sync-back writes as: revision actor ids and audit rows (actor_type 'system'). */
export const MARKETPLACE_SYNC_ACTOR = { actorType: "system", actorId: "system:ebay-sync-back" } as const;

const KEY_PATTERN = /^[A-Za-z0-9:_-]+$/;
const MAX_KEY_LENGTH = 200;
const SHORT_HASH_LENGTH = 16;

/** The first 16 hex characters of a sha256: enough to tell values apart inside one listing's keys. */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, SHORT_HASH_LENGTH);
}

/** The UTC calendar day of an instant, as YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** W9 price revision key (§1.2): one per listing, adopted price and the revision it replaces. */
export function marketplacePriceAdoptionKey(input: { listingId: number; priceCents: number; expectedRevisionId: number | null }): string {
  return checkedKey(`${MARKETPLACE_SYNC_KEY_PREFIX}price:${id(input.listingId)}:${id(input.priceCents)}:${input.expectedRevisionId === null ? "none" : id(input.expectedRevisionId)}`);
}

/** Size policy revision key: the three adopted ids and the revision they replace. */
export function marketplacePolicyAdoptionKey(input: {
  listingId: number; fulfillmentPolicyId: string | null; returnPolicyId: string | null; paymentPolicyId: string | null;
  expectedRevisionId: number | null;
}): string {
  return checkedKey(`${MARKETPLACE_SYNC_KEY_PREFIX}policy:${id(input.listingId)}:${shortHash(JSON.stringify([
    input.fulfillmentPolicyId, input.returnPolicyId, input.paymentPolicyId, input.expectedRevisionId]))}`);
}

/** The key a vendor limit change (set or cleared) records in its audit row: the observation it came from (§6.6). */
export function marketplaceQuantityLimitKey(input: { listingId: number; observedAt: Date; quantity: number }): string {
  return checkedKey(`${MARKETPLACE_SYNC_KEY_PREFIX}qty-limit:${id(input.listingId)}:${instant(input.observedAt)}:${count(input.quantity)}`);
}

/** One restore push job per store per tick (§6.4): the sizes it restores and the newest sync event it saw. */
export function marketplaceQuantityRestoreJobKey(input: { storeConnectionId: number; listingIds: readonly number[]; maxEventId: number }): string {
  if (input.listingIds.length === 0) throw invalidKey("A restore job needs at least one listing.");
  const ids = [...new Set(input.listingIds.map(id))].sort((left, right) => left - right);
  return checkedKey(`${MARKETPLACE_SYNC_KEY_PREFIX}quantity:${id(input.storeConnectionId)}:${shortHash(ids.join(","))}:${count(input.maxEventId)}`);
}

/**
 * A notice batch's key, which is also the notification's idempotency key
 * (§6.6). It carries the batch's id range, so rows that arrive after a batch
 * was claimed (a late commit) get their own batch instead of joining one
 * already sent under the same key.
 */
export function marketplaceNoticeBatchKey(input: {
  kind: string; storeConnectionId: number; minNoticeId: number; maxNoticeId: number;
}): string {
  if (!/^[a-z][a-z0-9_]*$/.test(input.kind)) throw invalidKey("A notice kind must be lower-case words.");
  if (id(input.minNoticeId) > id(input.maxNoticeId)) throw invalidKey("A batch's id range is reversed.");
  return checkedKey(`${MARKETPLACE_SYNC_KEY_PREFIX}${input.kind}:${id(input.storeConnectionId)}:${input.minNoticeId}-${input.maxNoticeId}`);
}

/** A notice about one listing: `listing:{id}:{part}:...`, each part a key-safe token. */
export function marketplaceListingSubjectKey(listingId: number, ...parts: string[]): string {
  return checkedKey(["listing", String(id(listingId)), ...parts].join(":"));
}

/** At most one below-cost notice per listing per UTC day (§4.2, §7.4). */
export function marketplaceBelowCostSubjectKey(listingId: number, at: Date): string {
  return checkedKey(`below-cost:${id(listingId)}:${utcDay(at)}`);
}

/**
 * A shipping policy verdict told to the vendor (§6.3): the policy, the verdict
 * and when it was found, so a changed verdict, or the same one after the
 * policy worked again in between, notifies again. A replayed check never
 * notifies twice: the remembered verdict (notified_verdict_hash) stops it.
 */
export function marketplacePolicySubjectKey(fulfillmentPolicyId: string, verdictHash: string, checkedAt: Date): string {
  return checkedKey(`policy:${shortHash(fulfillmentPolicyId)}:${verdictHash.slice(0, SHORT_HASH_LENGTH)}:${instant(checkedAt)}`);
}

/** An unknown eBay item number (§7.3): one question per store and item, ever. */
export function marketplaceItemSubjectKey(externalListingId: string): string {
  return checkedKey(`item:${externalListingId}`);
}

function checkedKey(key: string): string {
  if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) throw invalidKey("A sync-back key is not key-safe.", { key: key.slice(0, MAX_KEY_LENGTH) });
  return key;
}

function id(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidKey("A key part must be a positive integer.", { value });
  return value;
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidKey("A key part must be a whole number.", { value });
  return value;
}

function instant(value: Date): number {
  const ms = value.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) throw invalidKey("A key part must be a valid instant.");
  return ms;
}

/** A key that cannot be built is a defect in the caller, never data to retry with (fatal). */
function invalidKey(message: string, context: Record<string, unknown> = {}) {
  return marketplaceSyncError(MARKETPLACE_SYNC_CODES.invalidKey, message, "fatal", context);
}

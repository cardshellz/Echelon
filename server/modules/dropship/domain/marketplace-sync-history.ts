import { z } from "zod";
import { sha256Hex } from "./marketplace-listing-observation";
import type { FieldHistory, MarketplaceLastSentText, MarketplaceSyncOurs, PolicyField } from "./marketplace-sync-decision";

/**
 * eBay sync-back's "Ours" (plan v4 SB3, §4.1): what Card Shellz sent for each
 * vendor-owned field, from the listing's sync events. B is the newest
 * listing_push_completed or listing_marketplace_synced event; the
 * listing_push_attempted events after it are what a push may have written
 * before it failed. Events written before this release do not record every
 * field: such a field's B comes from the newest completed job's stored intent
 * (§4.1 last row), and with neither, Card Shellz has no record of it.
 * The same stored intent is the record of the title and description Card
 * Shellz last sent (owner rule 2, storedIntentSentText).
 */

/** The sync event types this module reads, and the one sync-back writes. */
export const MARKETPLACE_BASELINE_EVENT_TYPES = ["listing_push_completed", "listing_marketplace_synced"] as const;
export const MARKETPLACE_ATTEMPT_EVENT_TYPE = "listing_push_attempted";
export const MARKETPLACE_SYNCED_EVENT_TYPE = "listing_marketplace_synced";
export const MARKETPLACE_PUSH_COMPLETED_EVENT_TYPE = "listing_push_completed";

const cents = z.number().int().positive().max(2_147_483_647);
const policyId = z.string().min(1).max(100);

/** Each field on its own: one malformed field is treated as not recorded, never as a value. */
const PAYLOAD_FIELDS = {
  priceCents: cents, fulfillmentPolicyId: policyId, returnPolicyId: policyId, paymentPolicyId: policyId,
} as const;
type PayloadField = keyof typeof PAYLOAD_FIELDS;

/** The fields of a stored listing intent (job item result.listingIntent) this module reads. */
const storedIntentSchema = z.object({
  sku: z.string().max(255).nullable().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  priceCents: cents.optional(),
  marketplaceConfig: z.object({
    businessPolicies: z.object({
      fulfillmentPolicyId: policyId.optional(), returnPolicyId: policyId.optional(), paymentPolicyId: policyId.optional(),
    }).partial().optional(),
  }).partial().optional(),
}).partial();

export interface MarketplaceSyncEvent { id: number; eventType: string; payload: unknown; createdAt: Date }

/** The values a stored intent says Card Shellz sent, in the forms events record them. */
export function storedIntentFieldValues(intent: unknown): Partial<Record<PayloadField, string | number>> {
  const parsed = storedIntentSchema.safeParse(intent);
  if (!parsed.success) return {};
  const values: Partial<Record<PayloadField, string | number>> = {};
  if (parsed.data.priceCents !== undefined) values.priceCents = parsed.data.priceCents;
  const policies = parsed.data.marketplaceConfig?.businessPolicies ?? {};
  for (const field of ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"] as const satisfies readonly PolicyField[]) {
    if (policies[field] !== undefined) values[field] = policies[field];
  }
  return values;
}

/**
 * The title and description a stored intent says Card Shellz sent to eBay,
 * exactly as the push sends them: the dropship draft sends the intent's title
 * unshortened and its description, or its title when it has none
 * (dropship-ebay-listing-push.provider.ts, `descriptionHtmlOverride`). A field
 * is null when the intent does not record it, and then a push sends Card
 * Shellz's value as today (keepVendorText).
 */
export function storedIntentSentText(intent: unknown): { title: string | null; description: string | null } {
  const parsed = storedIntentSchema.safeParse(intent);
  if (!parsed.success) return { title: null, description: null };
  const title = parsed.data.title ?? null;
  return { title, description: parsed.data.description ?? title };
}

const textFingerprint = z.string().regex(/^[0-9a-f]{64}$/);
type TextFingerprintField = "titleHash" | "descriptionHash";

function fingerprintValue(payload: unknown, field: TextFingerprintField): string | null {
  if (!payload || typeof payload !== "object") return null;
  const parsed = textFingerprint.safeParse((payload as Record<string, unknown>)[field]);
  return parsed.success ? parsed.data : null;
}

/**
 * What Card Shellz last sent for the title and description (owner rule 2,
 * review OR-1): the fingerprints each push recorded of the text it actually
 * wrote (a push sends a refreshed intent, not the text it was queued with).
 * B is the newest listing_push_completed event's; the listing_push_attempted
 * events after it are text a push may have written before it failed. Only
 * pushes write text, so a sweep's listing_marketplace_synced event is no
 * baseline here. A completed push from before this release records no
 * fingerprint: B is then the fingerprint of its stored intent's text.
 */
export function marketplaceSyncSentTextFromHistory(input: { events: readonly MarketplaceSyncEvent[]; storedIntent: unknown }): MarketplaceLastSentText {
  const ordered = [...input.events].sort((left, right) => left.id - right.id);
  const completedIndex = findLastIndex(ordered, (event) => event.eventType === MARKETPLACE_PUSH_COMPLETED_EVENT_TYPE);
  const completed = completedIndex >= 0 ? ordered[completedIndex]! : null;
  const attempts = ordered.slice(completedIndex + 1).filter((event) => event.eventType === MARKETPLACE_ATTEMPT_EVENT_TYPE);
  const intentText = storedIntentSentText(input.storedIntent);
  const field = (name: TextFingerprintField, intentValue: string | null): FieldHistory<string> => {
    const recorded = completed === null ? null : fingerprintValue(completed.payload, name);
    const baseline = recorded ?? (intentValue === null ? null : sha256Hex(intentValue));
    const attempted = attempts.map((event) => fingerprintValue(event.payload, name)).filter((value): value is string => value !== null);
    return { baseline, attempted: [...new Set(attempted)] };
  };
  return { title: field("titleHash", intentText.title), description: field("descriptionHash", intentText.description) };
}

/**
 * The SKU a stored intent says Card Shellz listed under, as the push sends it
 * (trimmed, dropship-ebay-listing-push.provider.ts buildDropshipEbayListingDraft);
 * null when the intent does not record one.
 */
export function storedIntentSku(intent: unknown): string | null {
  const parsed = storedIntentSchema.safeParse(intent);
  const sku = parsed.success ? parsed.data.sku?.trim() ?? "" : "";
  return sku === "" ? null : sku;
}

function payloadValue(payload: unknown, field: PayloadField): string | number | null {
  if (!payload || typeof payload !== "object") return null;
  const parsed = PAYLOAD_FIELDS[field].safeParse((payload as Record<string, unknown>)[field]);
  return parsed.success ? parsed.data : null;
}

/**
 * Ours for every vendor-owned field. `events` are the listing's sync events
 * in any order; only the newest baseline event and the attempts after it
 * count. `storedIntent` is the newest completed job item's intent, or null.
 */
export function marketplaceSyncOursFromHistory(input: { events: readonly MarketplaceSyncEvent[]; storedIntent: unknown }): MarketplaceSyncOurs {
  const ordered = [...input.events].sort((left, right) => left.id - right.id);
  const baselineIndex = findLastIndex(ordered, (event) => (MARKETPLACE_BASELINE_EVENT_TYPES as readonly string[]).includes(event.eventType));
  const baselineEvent = baselineIndex >= 0 ? ordered[baselineIndex]! : null;
  const attempts = ordered.slice(baselineIndex + 1).filter((event) => event.eventType === MARKETPLACE_ATTEMPT_EVENT_TYPE);
  const intent = storedIntentFieldValues(input.storedIntent);
  const field = <T extends string | number>(name: PayloadField): FieldHistory<T> => {
    const recorded = baselineEvent === null ? null : payloadValue(baselineEvent.payload, name);
    const baseline = (recorded ?? intent[name] ?? null) as T | null;
    const attempted = attempts.map((event) => payloadValue(event.payload, name)).filter((value): value is T => value !== null) as T[];
    return { baseline, attempted: [...new Set(attempted)] };
  };
  return {
    priceCents: field<number>("priceCents"),
    fulfillmentPolicyId: field<string>("fulfillmentPolicyId"),
    returnPolicyId: field<string>("returnPolicyId"),
    paymentPolicyId: field<string>("paymentPolicyId"),
  };
}

/**
 * Whether a push of the listing was attempted after its newest completed push
 * (plan v4 §6.4 "settled"): a listing_push_attempted event is written just
 * before a push's first eBay write, and a completed push writes
 * listing_push_completed. An attempt with no completion after it may have
 * written its quantity to eBay or not, so eBay's quantity cannot be compared
 * with Card Shellz's last settled one until a push completes again: nothing
 * is decided on it (no limit is made from Card Shellz's own unfinished write).
 * `events` must hold the newest completed event and every attempt after it
 * (readMarketplaceSyncEventsWithClient).
 */
export function hasUnsettledPushAttempt(events: readonly MarketplaceSyncEvent[]): boolean {
  const completedId = events.reduce<number>((newest, event) =>
    (event.eventType === MARKETPLACE_PUSH_COMPLETED_EVENT_TYPE && event.id > newest ? event.id : newest), 0);
  return events.some((event) => event.eventType === MARKETPLACE_ATTEMPT_EVENT_TYPE && event.id > completedId);
}

/** The newest sync event's id: what the observation compare-and-set compares (SB4). Null without events. */
export function newestMarketplaceSyncEventId(events: readonly MarketplaceSyncEvent[]): number | null {
  return events.reduce<number | null>((newest, event) => (newest === null || event.id > newest ? event.id : newest), null);
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) if (predicate(values[index]!)) return index;
  return -1;
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { quantityPublicationScopeSchema, type QuantityPublicationScope } from "./quantity-publication-admission";
import { MAX_PUBLICATION_REPLACEMENT_REQUESTS, supportsCurrentValueReplacement, type LegacyMaintenanceEvidence, type PublicationEffect } from "./publication-replacement-policy";

export const publicationBigint = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= BigInt("9223372036854775807"));
export const ebayAutomaticRecoveryCommandSchema = z.object({
  syncJobId: z.string().uuid(),
  syncRevision: publicationBigint,
  scopes: z.array(quantityPublicationScopeSchema).min(1).max(251),
}).strict().superRefine(({ scopes }, context) => {
  const first = scopes[0]!;
  const members = scopes.filter(scope => scope.productVariantId !== null);
  if (first.productId === null || members.length === 0 || scopes.some(scope =>
    scope.destinationKind !== "channel_connection" || scope.providerKey !== "ebay" || scope.providerScopeType !== "account"
    || scope.productId !== first.productId || scope.connectionId !== first.connectionId || scope.externalScopeId !== first.externalScopeId
    || (scope.productVariantId === null && !scope.externalInventoryItemId.startsWith("group:")))
    || new Set(scopes.map(scope => scope.externalInventoryItemId)).size !== scopes.length
    || new Set(members.map(scope => scope.productVariantId)).size !== members.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Automatic recovery requires the complete exact existing listing and catalog members from one account." });
  }
});
export type EbayAutomaticRecoveryInput = z.infer<typeof ebayAutomaticRecoveryCommandSchema>;

export interface SavedEbayRequestOperation { ordinal: number; method: string; path: string }

/** This authorizes a fresh replacement, never a claim that the old request ended.
 * Without a request row, immutable stock intent or retained maintenance evidence
 * must identify a repeatable update to the same exact existing resources. */
export function supportsAutomaticEbayReplacement(input: {
  owner: string; outboxScopeProven: boolean; requests: readonly SavedEbayRequestOperation[];
  legacyMaintenance?: LegacyMaintenanceEvidence;
}): boolean {
  if (input.requests.length > MAX_PUBLICATION_REPLACEMENT_REQUESTS) return false;
  const effects: PublicationEffect[] = input.requests.map((request, index) => request.ordinal === index + 1 && (
    request.method === "POST" && request.path === "/sell/inventory/v1/bulk_update_price_quantity"
    || request.method === "PUT" && /^\/sell\/inventory\/v1\/(inventory_item|inventory_item_group|offer)\/[^/?#\s]+$/.test(request.path)
  ) ? "replace_existing" : "unknown");
  return supportsCurrentValueReplacement({ owner: input.owner, effects, stockIntentProven: input.outboxScopeProven,
    legacyMaintenance: input.legacyMaintenance });
}

// UUIDv5 with a fixed application namespace: a replay of one durable cycle must
// reuse its channel command, including after process loss following admission.
const WATCH_COMMAND_NAMESPACE = Buffer.from("842bab9813815f01822cd3ecaf06d4b1", "hex");
export function ebayReconciliationCommandKey(watchId: string, cycle: string): string {
  publicationBigint.parse(watchId); publicationBigint.parse(cycle);
  const bytes = createHash("sha1").update(WATCH_COMMAND_NAMESPACE).update(`ebay-reconciliation:${watchId}:${cycle}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function sortedRecoveryScopes(scopes: readonly QuantityPublicationScope[]): QuantityPublicationScope[] {
  return [...scopes].sort((left, right) => left.externalInventoryItemId.localeCompare(right.externalInventoryItemId, "en"));
}

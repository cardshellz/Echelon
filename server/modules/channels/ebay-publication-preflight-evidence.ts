import { z } from "zod";
import { legacyEbayPublicationPreflightProofSchema, ebayRequestJournalContractSchema,
  type EbayRequestJournalContract, type LegacyEbayPublicationPreflightProof } from "../inventory-planning/quantity-publication";
import { syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";

/** Only a client using the versioned admission/journal protocol can advertise
 * this contract. Persist it before the publish callback, including its initial
 * read-only lookups, so a crash before admission remains provably recoverable. */
export function ebayPublicationRequestJournalContract(target: {
  groupKey: string | null; marketplaceId: string; offerId?: string | null;
}): EbayRequestJournalContract {
  const path = target.groupKey === null
    ? `/sell/inventory/v1/offer/${target.offerId}/publish`
    : "/sell/inventory/v1/offer/publish_by_inventory_item_group";
  if (target.groupKey === null && !target.offerId) throw new Error("A publication journal contract requires an exact offer.");
  return ebayRequestJournalContractSchema.parse({ version: 1, provider: "ebay", method: "POST", path,
    requestHash: syncStageHash(target.groupKey === null ? null : { inventoryItemGroupKey: target.groupKey, marketplaceId: target.marketplaceId }) });
}

export function validateEbayPublicationStageContract(input: unknown, target: EbayListingSyncIdentity): EbayRequestJournalContract {
  const contract = ebayRequestJournalContractSchema.parse(input);
  // A new single offer is created after target binding. Its exact ID is first
  // available at the publish stage and must still match fresh recovery readback.
  const offerId = target.groupKey === null && target.variants.length === 1
    ? target.variants[0].offerId ?? contract.path.match(/^\/sell\/inventory\/v1\/offer\/([^/?#\s]+)\/publish$/)?.[1] : null;
  const expected = ebayPublicationRequestJournalContract({ groupKey: target.groupKey, marketplaceId: target.marketplaceId, offerId });
  if (syncStageHash(contract) !== syncStageHash(expected)) throw new Error("The publication journal contract differs from its exact target.");
  return contract;
}

const eventSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  createdAt: z.string().datetime(),
  event: z.string(),
  evidence: z.record(z.unknown()),
}).strict();
export type EbayPublicationStageEvent = z.infer<typeof eventSchema>;
const oldFailureSchema = z.object({
  code: z.literal("EBAY_LISTING_SYNC_FAILED"), message: z.string().max(1000),
}).passthrough();
const providerFailureSchema = z.object({ errors: z.tuple([z.object({
  errorId: z.literal(25001), domain: z.literal("API_INVENTORY"),
  category: z.literal("System"),
}).passthrough()]) }).passthrough();

/** Compatibility proof for the old worker's first-member offer lookup failure.
 * The repository supplies the immediately following event, without filtering.
 * A later failure or a second member's lookup cannot prove the earlier reads
 * preceded every mutation. Inventory independently checks the attempt and its
 * empty journal under exact scope locks before accepting this evidence. */
export function proveLegacyEbayPublicationPreflight(input: {
  jobId: string;
  target: EbayListingSyncIdentity;
  start: EbayPublicationStageEvent;
  next: EbayPublicationStageEvent | null;
}): LegacyEbayPublicationPreflightProof | undefined {
  const start = eventSchema.safeParse(input.start);
  const next = eventSchema.safeParse(input.next);
  if (!start.success || !next.success || !input.target.groupKey
    || start.data.event !== "stage_started" || start.data.evidence.key !== "publish"
    || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(start.data.evidence.preparedIntentHash).success
    || start.data.revision !== next.data.revision
    || !["awaiting_evidence", "recovering", "needs_attention"].includes(next.data.event)) return undefined;
  const failure = oldFailureSchema.safeParse(next.data.evidence);
  if (!failure.success) return undefined;
  const memberSkus = input.target.variants.map(member => member.sku).sort();
  const path = `/sell/inventory/v1/offer?sku=${encodeURIComponent(memberSkus[0])}&marketplace_id=${input.target.marketplaceId}`;
  const prefix = `eBay API GET ${path} failed (500): `;
  if (!failure.data.message.startsWith(prefix)) return undefined;
  try {
    if (!providerFailureSchema.safeParse(JSON.parse(failure.data.message.slice(prefix.length))).success) return undefined;
  } catch { return undefined; }
  const proof = legacyEbayPublicationPreflightProofSchema.safeParse({
    jobId: input.jobId, revision: start.data.revision,
    stageEventId: start.data.id, stageStartedAt: start.data.createdAt,
    failureEventId: next.data.id, failureAt: next.data.createdAt,
    groupKey: input.target.groupKey, marketplaceId: input.target.marketplaceId, memberSkus,
    failedRequest: { method: "GET", path, httpStatus: 500, errorCodes: ["25001"] },
    sourceEvidenceHash: syncStageHash({ start: start.data, next: next.data, target: input.target }),
  });
  return proof.success ? proof.data : undefined;
}

import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createHash } from "node:crypto";
import { isEbayPublicationRequest, terminalEbayResponseEvidence, type TerminalRequestReceipt } from "./quantity-provider-terminal-response";

const databaseId = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ebayRequestJournalContractSchema = z.object({
  version: z.literal(1), provider: z.literal("ebay"),
  method: z.enum(["POST", "PUT", "DELETE"]),
  path: z.string().regex(/^\/sell\/inventory\/v1\/[^\s?#]{1,1000}$/),
  requestHash: hash,
}).strict();
export type EbayRequestJournalContract = z.infer<typeof ebayRequestJournalContractSchema>;

/** The channel owner proves the immutable stage/event sequence. Inventory owns
 * the independent attempt, exact-scope locks and absence of mutation requests.
 * This compatibility proof is deliberately limited to the old first-member GET
 * failure; an empty pre-versioned journal alone never proves that nothing sent. */
export const legacyEbayPublicationPreflightProofSchema = z.object({
  jobId: z.string().uuid(), revision: databaseId,
  stageEventId: databaseId, stageStartedAt: z.string().datetime(),
  failureEventId: databaseId, failureAt: z.string().datetime(),
  groupKey: z.string().min(1).max(234), marketplaceId: z.string().regex(/^EBAY_[A-Z_]{2,30}$/),
  memberSkus: z.array(z.string().trim().min(1).max(240)).min(1).max(250),
  failedRequest: z.object({ method: z.literal("GET"), path: z.string().min(1).max(1024),
    httpStatus: z.literal(500), errorCodes: z.tuple([z.literal("25001")]) }).strict(),
  sourceEvidenceHash: hash,
}).strict().superRefine((value, context) => {
  const sorted = [...new Set(value.memberSkus)].sort();
  if (canonicalJson(sorted) !== canonicalJson(value.memberSkus)
    || value.failedRequest.path !== `/sell/inventory/v1/offer?sku=${encodeURIComponent(sorted[0])}&marketplace_id=${value.marketplaceId}`
    || Date.parse(value.failureAt) < Date.parse(value.stageStartedAt)
    || BigInt(value.failureEventId) <= BigInt(value.stageEventId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Historical preflight proof must identify the first ordered member read in one completed publish stage." });
  }
});
export type LegacyEbayPublicationPreflightProof = z.infer<typeof legacyEbayPublicationPreflightProofSchema>;

export type EbayNoRequestProof =
  | { source: "request_journal_contract"; contract: EbayRequestJournalContract }
  | { source: "legacy_publish_preflight"; evidence: LegacyEbayPublicationPreflightProof };

export const preflightEvidenceHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** A finished stock/content request is not evidence that a publish was sent.
 * Require an explicit original intent and its complete final mutation history;
 * a timestamp alone cannot distinguish a same-millisecond preparation from the
 * later publish stage. An unresolved request must retain its ordinary fence. */
export function isCompletedEbayNonPublicationAttempt(input: {
  state: string; journalContract: unknown; canonicalOutboxStock: boolean;
}, receipts: TerminalRequestReceipt[]): boolean {
  if (!["succeeded", "resolved", "rejected", "not_sent"].includes(input.state)) return false;
  const parsed = ebayRequestJournalContractSchema.safeParse(input.journalContract);
  const contract = parsed.success ? parsed.data : null;
  const bulkPath = "/sell/inventory/v1/bulk_update_price_quantity";
  const contentContract = contract?.method === "PUT"
    && /^\/sell\/inventory\/v1\/(inventory_item|inventory_item_group|offer)\/[^/?#\s]+$/.test(contract.path);
  const stockContract = contract?.method === "POST" && contract.path === bulkPath;
  if (contract && !contentContract && !stockContract) return false;
  if (!contentContract && !stockContract && !input.canonicalOutboxStock) return false;
  if (contract && input.state === "not_sent" && receipts.length === 0) return true;
  if (!terminalEbayResponseEvidence(receipts) || receipts.some(receipt => isEbayPublicationRequest(receipt.method, receipt.path))) return false;
  return contentContract || stockContract
    || receipts.every(receipt => receipt.method === "POST" && receipt.path === bulkPath);
}

/** Stock can finish before a later member lookup fails. Its receipts prove
 * termination of the preparations, not successful delivery of publication.
 * Only the versioned original publish contract proves the final publish would
 * have its own durable request row; an old empty/mixed journal is insufficient. */
export function terminalEbayPublicationPreparationEvidence(rawContract: unknown,
  expected: { path: string; requestHash: string }, requests: unknown): {
    contract: EbayRequestJournalContract; terminal: NonNullable<ReturnType<typeof terminalEbayResponseEvidence>>;
  } | null {
  const parsed = ebayRequestJournalContractSchema.safeParse(rawContract);
  if (!parsed.success || parsed.data.method !== "POST" || parsed.data.path !== expected.path
    || parsed.data.requestHash !== expected.requestHash || !isEbayPublicationRequest(parsed.data.method, parsed.data.path)) return null;
  const terminal = terminalEbayResponseEvidence(requests);
  if (!terminal || terminal.receipts.some(receipt => isEbayPublicationRequest(receipt.method, receipt.path))) return null;
  return { contract: parsed.data, terminal };
}

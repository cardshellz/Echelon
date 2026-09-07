import { reviewRfqQuantity, rfqQuantityReviewMessage } from "@shared/procurement/rfq-quantity-review";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { normalizePoLinePricing } from "@shared/utils/po-line-pricing";
import {
  RFQ_HISTORY_PAGE_SIZE,
  rfqConversionResultSchema,
  rfqConvertSchema,
  rfqQuoteCaptureSchema,
  rfqQuoteRevisionSchema,
  rfqResourceIdSchema,
  rfqWorkflowDetailSchema,
  type RfqQuoteRevision,
  type RfqWorkflowDetail,
} from "@shared/procurement/rfq-workflow";
import type { CreatePurchaseOrderWithLinesInput } from "./purchasing.service";
import {
  appendRfqAudit, insertRfqPurchaseLink, insertRfqQuoteRevision, loadCreatedPurchaseLines,
  loadRfqWorkflow, readRfqLineAuditSnapshot, readRfqQuoteHistory, updateRfqQuoteMirrors, type RfqWorkflowExecutor, type RfqWorkflowSnapshot,
} from "./rfq-workflow.repository";

const MAX_QUOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const QUOTE_EDITABLE_STATUSES = new Set(["draft", "sent", "quoted"]);
const RFQ_ACTIVE_STATUSES = new Set(["draft", "sent", "partially_quoted", "quoted"]);

export class RfqWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409, public readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "RfqWorkflowError";
  }
}

export interface RfqWorkflowTransaction extends RfqWorkflowExecutor {
  transaction<T>(work: (tx: RfqWorkflowTransaction) => Promise<T>): Promise<T>;
}
export interface RfqWorkflowDatabase {
  transaction<T>(work: (tx: RfqWorkflowTransaction) => Promise<T>, options?: { isolationLevel: "repeatable read"; accessMode: "read only" }): Promise<T>;
}
export interface RfqPurchaseOrderOwner {
  createPurchaseOrderWithLines(input: CreatePurchaseOrderWithLinesInput, actorId: string, options: {
    transaction: RfqWorkflowTransaction;
    source: "rfq_quote";
    additionalEvent: { eventType: string; payload: Record<string, unknown> };
  }): Promise<unknown>;
}
export type RfqWorkflowCommand =
  | { operation: "capture_quote"; rfqId: number; lineId: number; body: unknown }
  | { operation: "convert"; rfqId: number; body: unknown };

export function rfqWorkflowVersion(snapshot: Omit<RfqWorkflowDetail, "version">): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function detail(snapshot: RfqWorkflowSnapshot): RfqWorkflowDetail {
  const reviewed = { ...snapshot, lines: snapshot.lines.map(({ quantityRuleEvidence, ...line }) => ({
    ...line, quantityReview: reviewRfqQuantity({ ...quantityRuleEvidence, quotedPieces: line.latestQuote?.quotedPieces ?? line.requestedPieces }),
  })) };
  const result = rfqWorkflowDetailSchema.safeParse({ ...reviewed, version: rfqWorkflowVersion(reviewed) });
  if (!result.success) throw new RfqWorkflowError("RFQ_EVIDENCE_INVALID", "Stored RFQ evidence failed validation", 500);
  return result.data;
}

async function requireWorkflow(tx: RfqWorkflowExecutor, rfqId: number, lock: boolean): Promise<RfqWorkflowDetail> {
  const snapshot = await loadRfqWorkflow(tx, rfqId, lock);
  if (snapshot === null) throw new RfqWorkflowError("RFQ_NOT_FOUND", "Quote request was not found", 404);
  return detail(snapshot);
}

export function assertRfqQuoteCanConvert(input: { workflow: RfqWorkflowDetail; line: RfqWorkflowDetail["lines"][number]; quoteRevisionId: number; quantityOverrideReason: string | null; at: Date }): RfqQuoteRevision {
  const { workflow, line, at } = input;
  if (!RFQ_ACTIVE_STATUSES.has(workflow.status)) throw new RfqWorkflowError("RFQ_NOT_ACTIVE", "This quote request is no longer active");
  if (workflow.currency !== "USD") throw new RfqWorkflowError("RFQ_CURRENCY_UNSUPPORTED", "The purchase-order owner currently supports USD; preserve this quote and review its currency before conversion");
  if (line.purchaseOrder !== null || line.status === "ordered") throw new RfqWorkflowError("RFQ_LINE_ALREADY_ORDERED", "This RFQ line already belongs to a purchase order", 409, { rfqLineId: line.id, purchaseOrderId: line.purchaseOrder?.purchaseOrderId });
  const quote = line.latestQuote;
  if (line.status !== "quoted" || quote === null) throw new RfqWorkflowError("RFQ_QUOTE_REQUIRED", "Capture a versioned vendor quote before creating its purchase order", 409, { rfqLineId: line.id });
  if (quote.currency !== workflow.currency) throw new RfqWorkflowError("RFQ_QUOTE_CURRENCY_CHANGED", "The quote currency differs from the RFQ; review the recorded quote before conversion");
  if (quote.id !== input.quoteRevisionId) throw new RfqWorkflowError("RFQ_QUOTE_CHANGED", "The supplier quote changed; review the latest revision", 409, { rfqLineId: line.id });
  if (quote.quote.quoteValidUntil !== null && quote.quote.quoteValidUntil < at.toISOString().slice(0, 10)) throw new RfqWorkflowError("RFQ_QUOTE_EXPIRED", "The supplier quote expired; capture current quote evidence before ordering", 409, { rfqLineId: line.id });
  if (quote.quote.packagingTreatment !== "separate" || quote.quote.packagingCostCents === null) throw new RfqWorkflowError("RFQ_PACKAGING_REVIEW_REQUIRED", "Establish separate product and packaging amounts before creating the purchase order", 409, { rfqLineId: line.id });
  if (quote.quotedPieces !== line.requestedPieces && input.quantityOverrideReason === null) throw new RfqWorkflowError("RFQ_QUANTITY_OVERRIDE_REQUIRED", "Record why the quoted purchase quantity differs from the requested quantity", 409, { rfqLineId: line.id, requestedPieces: line.requestedPieces, quotedPieces: quote.quotedPieces });
  if (!line.quantityReview.canConvert) throw new RfqWorkflowError("RFQ_ORDER_RULES_INVALID", "Correct the missing or invalid supplier order rules before converting this quote", 409, { rfqLineId: line.id });
  if (line.quantityReview.requiresReason && input.quantityOverrideReason === null) throw new RfqWorkflowError("RFQ_QUANTITY_REVIEW_REQUIRED", "Record a reason for accepting this quoted quantity. " + line.quantityReview.issues.map((issue) => rfqQuantityReviewMessage(issue, line.quantityReview)).join(" "), 409, { rfqLineId: line.id, quantityReview: line.quantityReview });
  return quote;
}

export function createRfqWorkflowService(database: RfqWorkflowDatabase, purchasing: RfqPurchaseOrderOwner) {
  return {
    async getDetail(rfqId: number): Promise<RfqWorkflowDetail> {
      rfqResourceIdSchema.parse(rfqId);
      return database.transaction((tx) => requireWorkflow(tx, rfqId, false), { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async getQuoteHistory(rfqId: number, lineId: number, beforeRevision: number | null) {
      rfqResourceIdSchema.parse(rfqId);
      rfqResourceIdSchema.parse(lineId);
      rfqResourceIdSchema.nullable().parse(beforeRevision);
      return database.transaction(async (tx) => {
        const workflow = await requireWorkflow(tx, rfqId, false);
        if (!workflow.lines.some((line) => line.id === lineId)) throw new RfqWorkflowError("RFQ_LINE_NOT_FOUND", "The selected line does not belong to this quote request", 404);
        return readRfqQuoteHistory(tx, rfqId, lineId, beforeRevision, RFQ_HISTORY_PAGE_SIZE);
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async executeInTransaction(tx: RfqWorkflowTransaction, command: RfqWorkflowCommand, actorId: string, at: Date, idempotencyKey: string) {
      rfqResourceIdSchema.parse(command.rfqId);
      z.string().trim().min(1).max(200).parse(actorId);
      z.date().parse(at);
      await lockInventoryCostGraph(tx);
      if (command.operation === "capture_quote") {
        rfqResourceIdSchema.parse(command.lineId);
        const input = rfqQuoteCaptureSchema.parse(command.body);
        const workflow = await requireWorkflow(tx, command.rfqId, true);
        if (input.expectedVersion !== workflow.version) throw new RfqWorkflowError("RFQ_VERSION_CONFLICT", "This quote request or its supplier order rules changed; refresh it before saving");
        if (!RFQ_ACTIVE_STATUSES.has(workflow.status)) throw new RfqWorkflowError("RFQ_NOT_ACTIVE", "This quote request is no longer active");
        const line = workflow.lines.find((candidate) => candidate.id === command.lineId);
        if (!line) throw new RfqWorkflowError("RFQ_LINE_NOT_FOUND", "The selected line does not belong to this quote request", 404);
        if (!QUOTE_EDITABLE_STATUSES.has(line.status) || line.purchaseOrder !== null) throw new RfqWorkflowError("RFQ_QUOTE_LOCKED", "A converted or inactive line cannot accept a replacement quote");
        if (new Date(input.quote.quotedAt).getTime() > at.getTime() + MAX_QUOTE_CLOCK_SKEW_MS) throw new RfqWorkflowError("RFQ_QUOTE_DATE_INVALID", "The quote timestamp cannot be in the future", 422);
        let pricing: ReturnType<typeof normalizePoLinePricing>;
        try { pricing = normalizePoLinePricing(input.quote.pricing); } catch (error) {
          throw new RfqWorkflowError("RFQ_QUOTE_PRICING_INVALID", error instanceof Error ? error.message : "Quote pricing is invalid", 422);
        }
        rfqResourceIdSchema.parse(pricing.orderQty);
        if (BigInt(pricing.quotedExtendedMills) + BigInt(input.quote.packagingCostCents ?? 0) * BigInt(100) > BigInt(Number.MAX_SAFE_INTEGER)) throw new RfqWorkflowError("RFQ_QUOTE_AMOUNT_OVERFLOW", "The combined quote amount exceeds the supported integer range", 422);
        const revision = {
          rfqLineId: line.id, revision: (line.latestQuote?.revision ?? 0) + 1, currency: workflow.currency,
          quotedPieces: pricing.orderQty, quotedUnitCostMills: pricing.unitCostMills, productTotalMills: pricing.quotedExtendedMills,
          pricingRemainderMills: pricing.pricingRemainderMills, quote: input.quote, createdBy: actorId, createdAt: at.toISOString(),
        };
        const fingerprint = createHash("sha256").update(canonicalJson({ rfqId: command.rfqId, ...revision })).digest("hex");
        const priorLineSnapshot = await readRfqLineAuditSnapshot(tx, line.id);
        const saved = await insertRfqQuoteRevision(tx, command.rfqId, { ...revision, fingerprint });
        const active = workflow.lines.filter((candidate) => !["declined", "cancelled"].includes(candidate.status));
        const allQuoted = active.every((candidate) => candidate.id === line.id || ["quoted", "accepted", "ordered"].includes(candidate.status));
        await updateRfqQuoteMirrors(tx, command.rfqId, saved, allQuoted ? "quoted" : "partially_quoted", at);
        await appendRfqAudit(tx, { actorId, action: "purchase_rfq.quote_captured", rfqId: command.rfqId, before: { revision: line.latestQuote, lineSnapshot: priorLineSnapshot }, after: saved, at, context: { rfqLineId: line.id, idempotencyKey } });
        return requireWorkflow(tx, command.rfqId, false);
      }
      const input = rfqConvertSchema.parse(command.body);
      const workflow = await requireWorkflow(tx, command.rfqId, true);
      if (input.expectedVersion !== workflow.version) throw new RfqWorkflowError("RFQ_VERSION_CONFLICT", "This quote request or its supplier order rules changed; review it before creating a purchase order");
      const selected = [...input.lines].sort((left, right) => left.rfqLineId - right.rfqLineId).map((selection) => {
        const line = workflow.lines.find((candidate) => candidate.id === selection.rfqLineId);
        if (!line) throw new RfqWorkflowError("RFQ_LINE_NOT_FOUND", "A selected line does not belong to this quote request", 404);
        const quote = assertRfqQuoteCanConvert({ workflow, line, quoteRevisionId: selection.quoteRevisionId, quantityOverrideReason: input.quantityOverrideReason, at });
        return { line, quote };
      });
      const warehouses = new Set(selected.map(({ line }) => line.warehouseId));
      if (warehouses.size !== 1) throw new RfqWorkflowError("RFQ_WAREHOUSE_REVIEW_REQUIRED", "Select lines for one warehouse per purchase order");
      const created = await purchasing.createPurchaseOrderWithLines({
        vendorId: workflow.vendorId, warehouseId: selected[0].line.warehouseId,
        internalNotes: `Created from ${workflow.rfqNumber}; exact supplier quote revisions remain linked.`,
        lines: selected.map(({ line, quote }) => ({
          productId: line.productId, productVariantId: line.productVariantId, vendorProductId: line.vendorProductId,
          orderQty: quote.quotedPieces, pricing: quote.quote.pricing, pricingSource: "manual",
          packagingCostCents: quote.quote.packagingCostCents!, quoteReference: quote.quote.quoteReference,
          quotedAt: new Date(quote.quote.quotedAt), quoteValidUntil: quote.quote.quoteValidUntil,
        })),
      }, actorId, { transaction: tx, source: "rfq_quote", additionalEvent: { eventType: "rfq_converted", payload: { rfq_id: workflow.id, rfq_number: workflow.rfqNumber, quote_revision_ids: selected.map(({ quote }) => quote.id) } } });
      const parsedPo = z.object({ id: rfqResourceIdSchema, poNumber: z.string(), status: z.literal("draft") }).safeParse(created);
      if (!parsedPo.success) throw new RfqWorkflowError("RFQ_PO_RESPONSE_INVALID", "The purchase-order owner returned an invalid draft identity", 500);
      const po = parsedPo.data;
      const poLines = await loadCreatedPurchaseLines(tx, po.id);
      if (poLines.length !== selected.length || poLines.some((line, index) => line.lineNumber !== index + 1)) throw new RfqWorkflowError("RFQ_PO_LINE_IDENTITY_INVALID", "Created purchase lines cannot be matched to the selected quote order", 500);
      const links = [];
      for (const [index, entry] of selected.entries()) {
        await insertRfqPurchaseLink(tx, { rfqId: workflow.id, quote: entry.quote, purchaseOrderId: po.id, purchaseOrderLineId: poLines[index].id, quantityOverrideReason: entry.line.quantityReview.requiresReason || entry.quote.quotedPieces !== entry.line.requestedPieces ? input.quantityOverrideReason : null, idempotencyKey, actorId, at });
        links.push({ rfqLineId: entry.line.id, quoteRevisionId: entry.quote.id, purchaseOrderLineId: poLines[index].id });
      }
      const result = rfqConversionResultSchema.parse({ rfqId: workflow.id, purchaseOrderId: po.id, poNumber: po.poNumber, status: "draft", lines: links });
      await appendRfqAudit(tx, { actorId, action: "purchase_rfq.converted_to_draft_po", rfqId: workflow.id, before: selected.map(({ line }) => line), after: result, at, context: { quantityOverrideReason: input.quantityOverrideReason, quantityReviews: selected.map(({ line }) => ({ rfqLineId: line.id, ...line.quantityReview })), idempotencyKey } });
      return result;
    },
  };
}

export type RfqWorkflowService = ReturnType<typeof createRfqWorkflowService>;

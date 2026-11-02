import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  receiptInvoiceApprovalRequestSchema,
  receiptInvoiceChangeSchema,
  receiptInvoicePreviewRequestSchema,
  receiptInvoicePreviewSchema,
  receiptInvoiceResultSchema,
} from "@shared/procurement/receipt-invoice-costs";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  FinancialCommandError,
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
} from "../../platform/commands/transactional-command.service";
import {
  CostEvidenceError,
  costFingerprint,
  costInteger,
} from "../inventory/infrastructure/cost-evidence.repository";
import { COGSService } from "../inventory/cogs.service";
import {
  assertInvoiceQuantityAuthority,
  InvoiceQuantityCorrectionError,
} from "./invoice-quantity-correction.policy";
import {
  validateReceiptInvoiceAllocations,
  resolveReceiptInvoiceSources,
} from "./domain/receipt-invoice-costs";
import { resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import {
  readReceiptInvoiceReviewSource,
  readReceiptInvoiceApprovalHistory,
} from "./receipt-invoice-review.repository";
import {
  persistReceiptInvoiceAllocations,
  recordReceiptInvoiceApproval,
} from "./receipt-invoice-costs.repository";
import { readInvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { purchaseTaxApprovalTime } from "./domain/purchase-tax";
import type {
  AmendmentDatabase,
  AmendmentTransaction,
} from "./po-quantity-amendment.repository";

export function receiptInvoiceCommandScope(lineId: number) {
  return {
    routeTemplate: "/api/purchasing/receipt-invoice-costs",
    resourceKey: `purchase_order_line:${lineId}`,
    commandName: "purchasing.receipt_invoice_costs.approve",
  };
}
function current(actual: string, expected: string) {
  if (actual !== expected)
    throw new CostEvidenceError(
      "RECEIPT_INVOICE_STALE",
      "The receipt, invoice, stock or approval permissions changed. Reload and review the current costs.",
    );
}

/** One approval updates financial coverage and calls the current cost owner.
 * Preview rolls that exact execution back, including audit and cost effects. */
export function createReceiptInvoiceCostService(
  database: AmendmentDatabase,
  clock: () => Date,
) {
  const commands = createDrizzleFinancialCommandRepository(database);
  async function execute(
    tx: AmendmentTransaction,
    source: Awaited<ReturnType<typeof readReceiptInvoiceReviewSource>>,
    change: z.infer<typeof receiptInvoiceChangeSchema>,
    actorId: string,
    reason: string,
    key: string,
  ) {
    assertInvoiceQuantityAuthority(source.actor);
    const candidate = {
      ...source.source,
      receiptCosting: source.receiptCosting,
    };
    const allocations = validateReceiptInvoiceAllocations(
      candidate,
      change.allocations,
    );
    if (
      source.source.receiptCosting &&
      canonicalJson(allocations) === canonicalJson(source.context.allocations)
    )
      throw new CostEvidenceError(
        "RECEIPT_INVOICE_NO_CHANGE",
        "These receipt costs are already assigned. Review the saved approval below.",
      );
    // Run exact invoice/tax checks before changing a current mapping. Invalid
    // assignments reject atomically rather than committing a review fallback.
    resolveReceiptInvoiceSources(
      {
        ...candidate,
        receiptCosting: { ...source.receiptCosting, allocations },
      },
      resolvePurchaseCostSource,
    );
    const at = purchaseTaxApprovalTime(clock(), [
      source.line.updated_at,
      ...source.dependencies.evidence.flatMap((row) =>
        row.graph.lots.map((lot) => lot.updated_at),
      ),
    ]);
    const beforeValues = await readInvoiceCorrectionInventoryValues(
      tx,
      source.dependencies,
    );
    await persistReceiptInvoiceAllocations(
      tx,
      change.purchaseOrderLineId,
      allocations,
      actorId,
      at,
    );
    const application = await reconcilePurchaseCostEvidence(
      tx,
      change.purchaseOrderLineId,
      new COGSService(tx),
      actorId,
      at,
    );
    const after = await readReceiptInvoiceReviewSource(
      tx,
      change.purchaseOrderLineId,
      actorId,
    );
    const afterValues = new Map(
      (await readInvoiceCorrectionInventoryValues(tx, after.dependencies)).map(
        (row) => [row.lotId, row],
      ),
    );
    const destination = buildCostDestinationImpact(
      source.dependencies,
      after.dependencies,
    );
    const reviewed = {
      sourceVersion: source.sourceVersion,
      change,
      before: source.context.costs,
      after: after.context.costs,
      unassignedInvoicePieces: costInteger(
        (
          source.source.approvedInvoices.reduce(
            (sum, row) => sum + BigInt(String(row.qty_invoiced)),
            BigInt(0),
          ) -
          allocations.reduce((sum, row) => sum + BigInt(row.pieces), BigInt(0))
        ).toString(),
        "unassigned invoice pieces",
      ),
      impact: {
        lots: destination.lots,
        orderCosts: destination.orderCosts,
        historicalCosts: destination.historicalCosts,
      },
      inventoryValues: beforeValues.map((row) => {
        const next = afterValues.get(row.lotId);
        if (!next || next.onHandUnits !== row.onHandUnits)
          throw new CostEvidenceError(
            "RECEIPT_INVOICE_STOCK_CHANGED",
            "Invoice cost assignment cannot change physical stock.",
          );
        return {
          lotId: row.lotId,
          lotNumber: row.lotNumber,
          onHandUnits: row.onHandUnits,
          beforeMills: row.onHandValueMills,
          afterMills: next.onHandValueMills,
          reviewReason: next.valueReviewReason,
        };
      }),
      issues: [
        ...new Map(
          application.costApplications
            .flatMap((row) =>
              row.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
              })),
            )
            .map((issue) => [canonicalJson(issue), issue]),
        ).values(),
      ],
    };
    const preview = receiptInvoicePreviewSchema.parse({
      ...reviewed,
      previewVersion: costFingerprint(reviewed),
    });
    const auditEventId = await recordReceiptInvoiceApproval(
      tx,
      source.context.purchaseOrderId,
      change.purchaseOrderLineId,
      preview,
      actorId,
      source.actorName,
      reason,
      at,
      key,
      application,
      source.actor,
    );
    return receiptInvoiceResultSchema.parse({ auditEventId, preview });
  }
  return {
    history: (purchaseOrderId: number) =>
      database.transaction((tx) =>
        readReceiptInvoiceApprovalHistory(tx, purchaseOrderId),
      ),
    context: (lineId: number, actorId: string) =>
      database.transaction(
        async (tx) =>
          (await readReceiptInvoiceReviewSource(tx, lineId, actorId)).context,
      ),
    preview: (input: unknown, actorId: string) => {
      const request = receiptInvoicePreviewRequestSchema.parse(input);
      return database.transaction(async (tx) => {
        const source = await readReceiptInvoiceReviewSource(
          tx,
          request.change.purchaseOrderLineId,
          actorId,
        );
        assertInvoiceQuantityAuthority(source.actor);
        current(source.sourceVersion, request.sourceVersion);
        await tx.execute(sql`SAVEPOINT receipt_invoice_preview`);
        try {
          return (
            await execute(
              tx,
              source,
              request.change,
              actorId,
              "Receipt invoice allocation preview; nothing saved",
              "preview",
            )
          ).preview;
        } finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT receipt_invoice_preview`);
          await tx.execute(sql`RELEASE SAVEPOINT receipt_invoice_preview`);
        }
      });
    },
    approve: (
      input: unknown,
      actorId: string,
      descriptor: FinancialCommandDescriptor,
    ) => {
      const request = receiptInvoiceApprovalRequestSchema.parse(input),
        scope = receiptInvoiceCommandScope(request.change.purchaseOrderLineId);
      if (
        descriptor.actorType !== "user" ||
        descriptor.actorId !== actorId ||
        descriptor.method !== "POST" ||
        descriptor.routeTemplate !== scope.routeTemplate ||
        descriptor.resourceKey !== scope.resourceKey ||
        descriptor.commandName !== scope.commandName
      )
        throw new FinancialCommandError(
          "Receipt cost approval scope is invalid.",
          403,
          "RECEIPT_INVOICE_SCOPE_INVALID",
        );
      return runTransactionalFinancialCommand({
        repository: commands,
        descriptor,
        classifyFailure(error) {
          if (
            error instanceof InvoiceQuantityCorrectionError ||
            error instanceof CostEvidenceError
          )
            return {
              kind: "rejected",
              httpStatus:
                error instanceof InvoiceQuantityCorrectionError
                  ? error.statusCode
                  : 409,
              errorCode: error.code,
              errorMessage: error.message,
              body: { error: error.message, code: error.code },
            };
          if (error instanceof z.ZodError)
            return {
              kind: "rejected",
              httpStatus: 409,
              errorCode: "RECEIPT_INVOICE_SOURCE_INVALID",
              errorMessage: "Saved receipt costs are invalid.",
              body: {
                error: "Saved receipt costs are invalid. Reload the review.",
                code: "RECEIPT_INVOICE_SOURCE_INVALID",
              },
            };
          return {
            kind: "retryable",
            errorCode: "RECEIPT_INVOICE_RETRY",
            errorMessage:
              "The cost assignment rolled back. Retry this saved approval.",
          };
        },
        work: async (tx) => {
          const source = await readReceiptInvoiceReviewSource(
            tx,
            request.change.purchaseOrderLineId,
            actorId,
          );
          assertInvoiceQuantityAuthority(source.actor);
          current(source.sourceVersion, request.sourceVersion);
          const result = await execute(
            tx,
            source,
            request.change,
            actorId,
            request.reason,
            descriptor.idempotencyKey,
          );
          current(result.preview.previewVersion, request.previewVersion);
          return {
            httpStatus: 200,
            body: result,
            resultType: "receipt_invoice_cost_approval",
            resultId: result.auditEventId,
          };
        },
      });
    },
  };
}

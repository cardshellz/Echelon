import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  originRepairContextSchema,
  originRepairId,
  originRepairPreviewRequestSchema,
  originRepairPreviewSchema,
  originRepairRequestSchema,
  originRepairSummarySchema,
  type OriginRepairChoices,
  type OriginRepairSummary,
} from "@shared/procurement/cost-origin-repair";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  FinancialCommandError,
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
} from "../../platform/commands/transactional-command.service";
import {
  readPurchaseApprovalActor,
  readPurchaseApproverName,
} from "../identity/infrastructure/purchase-approval-access.repository";
import { COGSService } from "../inventory/cogs.service";
import { applyCostRevision } from "../inventory/application/apply-cost-revision";
import { lotCostTotals } from "../inventory/domain/lot-cost";
import {
  reconciliationBlocker,
  reconciliationEligibility,
  reconciliationState,
} from "../inventory/domain/cost-reconciliation";
import {
  costFingerprint,
  costInteger,
  CostEvidenceError,
  lockInventoryCostGraph,
  recordReceiptCostOrigin,
} from "../inventory/infrastructure/cost-evidence.repository";
import {
  hasReconciliationRoots,
  readReconciliationLedger,
  readReconciliationRecords,
  reconciliationScope,
  recordReconciliationApproval,
} from "../inventory/infrastructure/cost-reconciliation.repository";
import { ApLedgerError, invoiceCostReviewVersion } from "./ap-ledger.service";
import {
  readOriginRepairFacts,
  readOriginRepairGraphEvidence,
  recordOriginRepair,
  restoreReceiptCostFields,
} from "./cost-origin-repair.repository";
import {
  OriginRepairError,
  originRepairBlocker,
  validateOriginRepair,
} from "./domain/cost-origin-repair";
import { reviewInvoiceCostComponentsInTransaction } from "./invoice-cost-review.service";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import type {
  AmendmentDatabase,
  AmendmentTransaction,
} from "./po-quantity-amendment.repository";
import { recordPurchaseCostRevisions } from "./purchase-cost-application.service";
import {
  prepareShipmentCostRevisions,
  recordShipmentCostRevisions,
} from "./shipment-cost-application.service";

export function originRepairScope(lotId: number) {
  originRepairId.parse(lotId);
  return {
    method: "POST",
    routeTemplate: "/api/inventory-lots/:id/cost-origin-repair",
    resourceKey: `inventory_lot:${lotId}`,
    commandName: "procurement.cost_origin.repair",
  };
}
async function load(tx: AmendmentTransaction, lotId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const facts = await readOriginRepairFacts(tx, lotId);
  if (!facts)
    throw new OriginRepairError(
      "COST_ORIGIN_NOT_FOUND",
      "The lot and its purchase receipt could not be found.",
      404,
    );
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const canApprove = hasQuantityAmendmentAuthority(actor);
  const proposals =
    facts.shipments.length === 1
      ? await prepareShipmentCostRevisions(
          tx,
          Number(facts.lot.inbound_shipment_id),
          { inboundShipmentLineId: Number(facts.shipments[0].id) },
        )
      : null;
  const ledger = [
    await readReconciliationLedger(tx, {
      purchaseOrderLineId: Number(facts.lot.po_line_id),
      component: "product",
    }),
    await readReconciliationLedger(tx, {
      purchaseOrderLineId: Number(facts.lot.po_line_id),
      component: "packaging",
    }),
    facts.shipments.length === 1
      ? await readReconciliationLedger(tx, Number(facts.shipments[0].id))
      : null,
  ];
  const graph = await readOriginRepairGraphEvidence(
    tx,
    Number(facts.lot.po_line_id),
  );
  const sourceVersion = costFingerprint({ facts, proposals, ledger, graph });
  const invoice = facts.source?.approvedInvoices[0];
  const components = invoiceCostComponentEvidenceSchema.safeParse(
    invoice?.cost_component_evidence,
  );
  const line = facts.source?.purchaseOrderLine;
  const context = originRepairContextSchema.parse({
    lotId,
    lotNumber: facts.lot.lot_number,
    sku: facts.lot.sku,
    purchaseOrderId: Number(facts.lot.purchase_order_id),
    purchaseOrderLineId: Number(facts.lot.po_line_id),
    receiptId: Number(facts.lot.receiving_order_id),
    receiptNumber: facts.lot.receipt_number,
    receiptLineId:
      facts.receipts.length === 1 ? Number(facts.receipts[0].id) : null,
    receivedUnits: costInteger(facts.lot.qty_received, "receivedUnits", 1),
    onHandUnits: costInteger(facts.lot.qty_on_hand, "onHandUnits"),
    sourceVersion,
    invoice: invoice
      ? {
          id: Number(invoice.vendor_invoice_id),
          lineId: Number(invoice.id),
          amountMills: costInteger(
            (BigInt(String(invoice.line_total_cents)) * BigInt(100)).toString(),
            "invoiceMills",
          ),
        }
      : null,
    suggested: {
      unitsPerCase:
        facts.lot.expected_receive_variant_id === facts.lot.product_variant_id
          ? facts.lot.expected_receive_units_per_variant
          : null,
      productMills: components.success
        ? components.data.productMills
        : costInteger(
            (
              BigInt(String(line?.total_product_cost_cents ?? 0)) * BigInt(100)
            ).toString(),
            "productMills",
          ),
      packagingMills: components.success
        ? components.data.packagingMills
        : costInteger(
            (
              BigInt(String(line?.packaging_cost_cents ?? 0)) * BigInt(100)
            ).toString(),
            "packagingMills",
          ),
    },
    canApprove,
    blockedReason: !canApprove
      ? "An active Administrator with purchasing approval permission must approve this repair."
      : originRepairBlocker(facts),
    approval: facts.approval,
  });
  return { facts, context, actor };
}

/** Runs the real owners inside the caller's transaction. Preview rolls this
 * entire operation back to a savepoint; approval commits only the reviewed result. */
async function executeRepair(
  tx: AmendmentTransaction,
  loaded: Awaited<ReturnType<typeof load>>,
  choices: OriginRepairChoices,
  actorId: string,
  actorName: string,
  now: Date,
): Promise<OriginRepairSummary> {
  const { facts, context } = loaded;
  validateOriginRepair(facts, choices);
  const invoiceId = Number(facts.source!.approvedInvoices[0].id);
  const invoice = (
    await tx.execute(
      sql`SELECT * FROM procurement.vendor_invoice_lines WHERE id=${invoiceId} FOR UPDATE`,
    )
  ).rows[0];
  const expectedVersion = invoiceCostReviewVersion({
    id: invoiceId,
    qtyInvoiced: costInteger(invoice.qty_invoiced, "invoiceQty"),
    unitCostCents: costInteger(invoice.unit_cost_cents, "unitCostCents"),
    unitCostMills:
      invoice.unit_cost_mills == null
        ? null
        : costInteger(invoice.unit_cost_mills, "unitCostMills"),
    lineTotalCents: costInteger(invoice.line_total_cents, "invoiceTotal"),
    costComponentEvidence: invoice.cost_component_evidence,
  });
  const existingComponents = invoiceCostComponentEvidenceSchema.safeParse(
    invoice.cost_component_evidence,
  );
  const packagingTreatment =
    choices.packagingMills === 0 && existingComponents.success
      ? existingComponents.data.packagingTreatment
      : "separate";
  await reviewInvoiceCostComponentsInTransaction(
    tx,
    invoiceId,
    {
      expectedVersion,
      productMills: choices.productMills,
      packagingMills: choices.packagingMills,
      adjustmentMills: 0,
      packagingTreatment,
      reason: choices.reason,
    },
    actorId,
    now,
    false,
  );
  await restoreReceiptCostFields(tx, facts, choices.unitsPerCase, actorId, now);
  await recordReceiptCostOrigin(
    tx,
    {
      inventoryLotId: context.lotId,
      receivingLineId: context.receiptLineId!,
      purchaseOrderLineId: context.purchaseOrderLineId,
      inboundShipmentLineId: Number(facts.shipments[0].id),
      unitsPerVariantSnapshot: choices.unitsPerCase,
      receivedVariantQty: context.receivedUnits,
    },
    actorId,
    now,
  );
  const supplier = await recordPurchaseCostRevisions(
    tx,
    context.purchaseOrderLineId,
    actorId,
    now,
  );
  const freight = await recordShipmentCostRevisions(
    tx,
    Number(facts.lot.inbound_shipment_id),
    actorId,
    now,
    { inboundShipmentLineId: Number(facts.shipments[0].id) },
  );
  if (
    freight.issues.length ||
    freight.revisions.length !== 1 ||
    supplier.length !== 2
  )
    throw new OriginRepairError(
      "COST_ORIGIN_SOURCE_REVIEW",
      "The supplier or shipment source is incomplete. Review the current charges before approving the origin repair.",
    );
  const revisions = [...supplier, ...freight.revisions];
  const before = lotCostTotals(facts.lot).totals;
  const components: OriginRepairSummary["components"] = [];
  const writer = new COGSService(tx);
  for (const revision of revisions) {
    const scope = reconciliationScope(revision.contract);
    const beforeLedger = await readReconciliationLedger(tx, scope);
    // This is an origin/supplier repair, not permission to reclassify a shipment
    // charge which already has its own approved accounting destination.
    const postingDestination =
      revision.contract.component === "landed" && beforeLedger.approval
        ? beforeLedger.approval.destination
        : choices.destination;
    const first = await applyCostRevision(tx, revision, writer, actorId, now);
    let final = first;
    if (first.issues.length) {
      const records = await readReconciliationRecords(
        tx,
        revision.contract,
        first.issues,
      );
      const eligible = reconciliationEligibility(
        revision.contract,
        first.issues,
        records,
      );
      const blocker = reconciliationBlocker(
        revision.contract,
        first.issues,
        records,
        await hasReconciliationRoots(tx, revision.contract),
      );
      // This approval is for this missing receipt only. It must never sweep up
      // unrelated gaps on other lots just because they share a purchase line.
      if (
        blocker ||
        !eligible ||
        records.some((row) => row.record.lotId !== context.lotId)
      )
        throw new OriginRepairError(
          "COST_ORIGIN_APPLICATION_REVIEW",
          blocker ??
            "Other lot history also needs reconciliation; this approval cannot dispose of those costs.",
        );
      await recordReconciliationApproval(tx, {
        lineId: scope,
        revisionId: revision.id,
        applicationId: first.applicationId,
        fingerprint: eligible.identity,
        destination: postingDestination,
        actorId,
        actorName,
        reason: choices.reason,
        now,
        evidence: {
          postingDestination,
          kind: "historical_origin_repair",
          lotId: context.lotId,
          sourceVersion: context.sourceVersion,
          choices,
          originalReceipt: facts.receipts[0],
          records,
          source: revision.contract,
          authority: loaded.actor,
        },
      });
      final = await applyCostRevision(tx, revision, writer, actorId, now);
      const ledger = await readReconciliationLedger(tx, scope);
      if (reconciliationState(eligible, ledger).status !== "posted")
        throw new OriginRepairError(
          "COST_ORIGIN_NOT_POSTED",
          "The historical component posting was not confirmed. No repair was committed.",
        );
    }
    const afterLedger = await readReconciliationLedger(tx, scope);
    const lot = (
      await tx.execute(
        sql`SELECT * FROM inventory.inventory_lots WHERE id=${context.lotId}`,
      )
    ).rows[0];
    const after = lotCostTotals(lot).totals;
    const key = {
      product: "poMills",
      packaging: "packagingMills",
      landed: "landedMills",
    } as const;
    components.push({
      component: revision.contract.component,
      lotBeforeMills: costInteger(
        before[key[revision.contract.component]].toString(),
        "beforeMills",
      ),
      lotAfterMills: costInteger(
        after[key[revision.contract.component]].toString(),
        "afterMills",
      ),
      historicalBeforeMills: costInteger(
        (
          BigInt(beforeLedger.balances.historical_cogs) +
          BigInt(beforeLedger.balances.inventory_variance)
        ).toString(),
        "historicalBefore",
      ),
      historicalAfterMills: costInteger(
        (
          BigInt(afterLedger.balances.historical_cogs) +
          BigInt(afterLedger.balances.inventory_variance)
        ).toString(),
        "historicalAfter",
      ),
      orderCostDeltaCents: costInteger(
        (
          BigInt(first.totalCogsDeltaCents) +
          BigInt(final === first ? 0 : final.totalCogsDeltaCents)
        ).toString(),
        "orderDelta",
        -Number.MAX_SAFE_INTEGER,
      ),
      lotsUpdated: first.lotsUpdated,
    });
  }
  return originRepairSummarySchema.parse({
    receivedUnits: context.receivedUnits,
    basePieces: context.receivedUnits * choices.unitsPerCase,
    components,
    stockQuantityChange: 0,
  });
}
export function createCostOriginRepairService(
  database: AmendmentDatabase,
  clock: () => Date,
) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    context: (id: number, actorId: string) =>
      database.transaction(
        async (tx) =>
          (await load(tx, originRepairId.parse(id), actorId)).context,
      ),
    async preview(id: number, raw: unknown, actorId: string) {
      const input = originRepairPreviewRequestSchema.parse(raw);
      return database.transaction(async (tx) => {
        const loaded = await load(tx, originRepairId.parse(id), actorId);
        assertReview(loaded.context, input.sourceVersion);
        await tx.execute(sql`SAVEPOINT cost_origin_preview`);
        try {
          const summary = await executeRepair(
            tx,
            loaded,
            input,
            actorId,
            await readPurchaseApproverName(tx, actorId),
            z.date().parse(clock()),
          );
          return originRepairPreviewSchema.parse({
            sourceVersion: input.sourceVersion,
            summary,
            previewVersion: costFingerprint({ input, summary }),
          });
        } finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT cost_origin_preview`);
          await tx.execute(sql`RELEASE SAVEPOINT cost_origin_preview`);
        }
      });
    },
    async approve(
      id: number,
      raw: unknown,
      actorId: string,
      descriptor: FinancialCommandDescriptor,
    ) {
      const lotId = originRepairId.parse(id),
        input = originRepairRequestSchema.parse(raw),
        scope = originRepairScope(lotId);
      if (
        descriptor.actorId !== actorId ||
        descriptor.actorType !== "user" ||
        Object.entries(scope).some(
          ([key, value]) =>
            descriptor[key as keyof FinancialCommandDescriptor] !== value,
        )
      )
        throw new FinancialCommandError(
          "The approval scope does not match this administrator and lot.",
          403,
          "COST_ORIGIN_SCOPE",
        );
      return runTransactionalFinancialCommand({
        repository,
        descriptor,
        classifyFailure(error) {
          if (
            error instanceof OriginRepairError ||
            error instanceof CostEvidenceError ||
            error instanceof ApLedgerError
          )
            return {
              kind: "rejected",
              httpStatus:
                error instanceof OriginRepairError ||
                error instanceof ApLedgerError
                  ? error.statusCode
                  : 409,
              errorCode:
                error instanceof ApLedgerError
                  ? "COST_ORIGIN_INVOICE"
                  : error.code,
              errorMessage: error.message,
              body: {
                error: error.message,
                code:
                  error instanceof ApLedgerError
                    ? "COST_ORIGIN_INVOICE"
                    : error.code,
              },
            };
          return {
            kind: "retryable",
            errorCode: "COST_ORIGIN_RETRY",
            errorMessage:
              "The repair was not confirmed. Retry the same approval.",
          };
        },
        work: async (tx) => {
          const loaded = await load(tx, lotId, actorId);
          assertReview(loaded.context, input.sourceVersion);
          const now = z.date().parse(clock()),
            actorName = await readPurchaseApproverName(tx, actorId);
          const { previewVersion, ...review } = input;
          const summary = await executeRepair(
            tx,
            loaded,
            review,
            actorId,
            actorName,
            now,
          );
          if (costFingerprint({ input: review, summary }) !== previewVersion)
            throw new OriginRepairError(
              "COST_ORIGIN_PREVIEW_CHANGED",
              "The cost impact changed. Review a new before and after; nothing was committed.",
            );
          await recordOriginRepair(tx, {
            facts: loaded.facts,
            sourceVersion: review.sourceVersion,
            choices: review,
            summary,
            actorId,
            actorName,
            now,
          });
          return {
            httpStatus: 200,
            resultType: "inventory_lot",
            resultId: lotId,
            body: (await load(tx, lotId, actorId)).context,
          };
        },
      });
    },
  };
}
function assertReview(
  context: z.infer<typeof originRepairContextSchema>,
  version: string,
) {
  if (!context.canApprove)
    throw new OriginRepairError(
      "COST_ORIGIN_ADMIN",
      context.blockedReason!,
      403,
    );
  if (context.sourceVersion !== version)
    throw new OriginRepairError(
      "COST_ORIGIN_STALE",
      "The receipt, costs or prior approval changed. Reload the review.",
    );
  if (context.blockedReason)
    throw new OriginRepairError("COST_ORIGIN_BLOCKED", context.blockedReason);
}

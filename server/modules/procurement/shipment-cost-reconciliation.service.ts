import { sql } from "drizzle-orm";
import { z } from "zod";
import { costIssueSchema, costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import {
  reconciliationContextSchema,
  reconciliationPreview,
  reconciliationRequestSchema,
  reconciliationResultSchema,
} from "@shared/procurement/cost-reconciliation";
import { shipmentExceptionIdSchema } from "@shared/procurement/shipment-cost-exception";
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
import { costFingerprint, lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import {
  reconciliationEligibility,
  reconciliationState,
  reconciliationBlocker,
} from "../inventory/domain/cost-reconciliation";
import {
  readReconciliationLedger,
  readReconciliationRecords,
  readReconciliationHistory,
  hasReconciliationRoots,
  recordReconciliationApproval,
} from "../inventory/infrastructure/cost-reconciliation.repository";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import {
  readShipmentExceptionFacts,
  readCurrentShipmentSourceFingerprints,
} from "./shipment-cost-exception.repository";
import { ShipmentCostExceptionError } from "./shipment-cost-exception.policy";
import { readCostReconciliationReport } from "../inventory/infrastructure/cost-reconciliation-report.repository";

export function shipmentReconciliationScope(lineId: number) {
  shipmentExceptionIdSchema.parse(lineId);
  return {
    method: "POST",
    routeTemplate: "/api/shipment-lines/:id/cost-reconciliation",
    resourceKey: `shipment_line:${lineId}`,
    commandName: "procurement.shipment_cost.reconcile",
  };
}
async function loadContext(tx: AmendmentTransaction, lineId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const locked = await tx.execute(sql`SELECT shipment.id FROM procurement.inbound_shipments shipment
    JOIN procurement.inbound_shipment_lines line ON line.inbound_shipment_id=shipment.id WHERE line.id=${lineId} FOR UPDATE OF shipment`);
  if (!locked.rows.length)
    throw new ShipmentCostExceptionError("Shipment line not found.", "SHIPMENT_RECONCILIATION_NOT_FOUND", 404);
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const [facts] = await readShipmentExceptionFacts(tx, [lineId]);
  if (!facts?.revisionId || !facts.applicationId)
    throw new ShipmentCostExceptionError(
      "Update shipment costs to prepare the current cost evidence.",
      "SHIPMENT_RECONCILIATION_NO_APPLICATION",
    );
  const source = costSourceRevisionSchema.parse(facts.contract);
  const result = z.object({ issues: z.array(costIssueSchema) }).parse(facts.result);
  if (source.currency !== "USD" || source.totalMills === null || source.totalMills < 0)
    throw new ShipmentCostExceptionError(
      "Review the source amount and currency before reconciling.",
      "SHIPMENT_RECONCILIATION_SOURCE",
    );
  const current = (await readCurrentShipmentSourceFingerprints(tx, facts.shipmentId)).get(lineId) ?? null;
  const ledger = await readReconciliationLedger(tx, lineId);
  const records = await readReconciliationRecords(tx, source, result.issues);
  const eligible = reconciliationEligibility(source, result.issues, records);
  const canApprove = hasQuantityAmendmentAuthority(actor);
  const blocker = reconciliationBlocker(source, result.issues, records, await hasReconciliationRoots(tx, source));
  const savedState = reconciliationState(eligible, ledger);
  const context = reconciliationContextSchema.parse({
    lineId,
    shipmentId: facts.shipmentId,
    sku: facts.sku,
    currency: source.currency,
    sourceVersion: costFingerprint({ facts, current, ledger, records }),
    sourceAmountMills: source.totalMills,
    sourceEvidence: source.evidence,
    historicalAmountMills: eligible?.amountMills ?? 0,
    balances: ledger.balances,
    // Match the upstream read: a posting for an older charge revision is history,
    // not proof that the current shipment costs are complete.
    state: current !== source.fingerprint && savedState.status === "posted"
      ? { ...savedState, status: "review_required" }
      : savedState,
    records: records.map((row) => row.record),
    issues: result.issues,
    canApprove,
    blockedReason: !canApprove
      ? "A current Administrator with purchasing approval permission must approve this correction."
      : facts.shipmentStatus !== "closed"
        ? "Finish shipment costing before reconciling historical inventory costs."
        : current !== source.fingerprint
          ? "Shipment costs changed. Update shipment costs, then review the new amounts."
          : blocker,
    history: await readReconciliationHistory(tx, lineId),
  });
  return { facts, source, issues: result.issues, eligible, actor, ledger, context };
}
export function createShipmentCostReconciliationService(database: AmendmentDatabase, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    report: () => database.transaction((tx) => readCostReconciliationReport(tx)),
    async context(id: number, actorId: string) {
      const lineId = shipmentExceptionIdSchema.parse(id);
      return database.transaction(async (tx) => (await loadContext(tx, lineId, actorId)).context);
    },
    async reconcile(id: number, input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const lineId = shipmentExceptionIdSchema.parse(id),
        scope = shipmentReconciliationScope(lineId);
      if (
        descriptor.actorType !== "user" ||
        descriptor.actorId !== actorId ||
        descriptor.method !== scope.method ||
        descriptor.routeTemplate !== scope.routeTemplate ||
        descriptor.resourceKey !== scope.resourceKey ||
        descriptor.commandName !== scope.commandName
      ) {
        throw new FinancialCommandError(
          "The approval does not match this administrator and shipment line.",
          403,
          "SHIPMENT_RECONCILIATION_SCOPE",
        );
      }
      const parsed = reconciliationRequestSchema.safeParse(input);
      if (!parsed.success)
        throw new FinancialCommandError(
          "Choose a cost destination and provide a reason of at least 10 characters.",
          400,
          "SHIPMENT_RECONCILIATION_INPUT",
        );
      return runTransactionalFinancialCommand({
        repository,
        descriptor,
        classifyFailure: (error) =>
          error instanceof ShipmentCostExceptionError
            ? {
                kind: "rejected",
                httpStatus: error.statusCode,
                errorCode: error.code,
                errorMessage: error.message,
                body: { code: error.code, error: error.message },
              }
            : {
                kind: "retryable",
                errorCode: "SHIPMENT_RECONCILIATION_FAILED",
                errorMessage: "The correction was not confirmed. Retry the same approval.",
              },
        work: async (tx) => {
          const request = parsed.data;
          const { facts, source, eligible, actor, context } = await loadContext(tx, lineId, actorId);
          if (!context.canApprove)
            throw new ShipmentCostExceptionError(context.blockedReason!, "SHIPMENT_RECONCILIATION_ADMIN", 403);
          if (context.sourceVersion !== request.sourceVersion)
            throw new ShipmentCostExceptionError(
              "The stock, costs or prior correction changed. Reload the before and after before approving.",
              "SHIPMENT_RECONCILIATION_STALE",
            );
          if (context.blockedReason || !eligible)
            throw new ShipmentCostExceptionError(
              context.blockedReason ?? "This cost cannot be reconciled automatically.",
              "SHIPMENT_RECONCILIATION_BLOCKED",
            );
          if (context.state.status === "posted" && context.state.destination === request.destination)
            throw new ShipmentCostExceptionError(
              "These costs are already reconciled to this destination.",
              "SHIPMENT_RECONCILIATION_ALREADY_POSTED",
            );
          const now = z.date().parse(clock()),
            actorName = await readPurchaseApproverName(tx, actorId);
          await recordReconciliationApproval(tx, {
            lineId,
            revisionId: facts.revisionId!,
            applicationId: facts.applicationId!,
            fingerprint: eligible.identity,
            destination: request.destination,
            actorId,
            actorName,
            reason: request.reason,
            now,
            evidence: {
              version: 1,
              sourceVersion: context.sourceVersion,
              approval: actor,
              records: context.records,
              issues: context.issues,
              preview: reconciliationPreview(context, request.destination),
              inventoryQuantityDelta: 0,
              sourceAmountMills: context.sourceAmountMills,
              sourceEvidence: context.sourceEvidence,
            },
          });
          const application = await applyCostRevision(
            tx,
            { id: facts.revisionId!, contract: source },
            new COGSService(tx),
            actorId,
            now,
          );
          const ledger = await readReconciliationLedger(tx, lineId);
          const records = await readReconciliationRecords(tx, source, application.issues);
          const state = reconciliationState(reconciliationEligibility(source, application.issues, records), ledger);
          if (state.status !== "posted")
            throw new ShipmentCostExceptionError(
              "The correction did not reconcile completely. Nothing from this approval was saved.",
              "SHIPMENT_RECONCILIATION_INCOMPLETE",
            );
          const body = reconciliationResultSchema.parse({
            lineId,
            shipmentId: facts.shipmentId,
            applicationId: application.applicationId,
            state,
          });
          return {
            httpStatus: 200,
            body,
            resultType: "shipment_cost_reconciliation",
            resultId: application.applicationId,
          };
        },
      });
    },
  };
}

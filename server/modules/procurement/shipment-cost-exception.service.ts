import { sql } from "drizzle-orm";
import { z } from "zod";
import { shipmentExceptionContextSchema, shipmentExceptionIdSchema, shipmentExceptionRequestSchema,
  shipmentExceptionResultSchema } from "@shared/procurement/shipment-cost-exception";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import { readPurchaseApprovalActor } from "../identity/infrastructure/purchase-approval-access.repository";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import { buildShipmentCostException, shipmentExceptionVersion, ShipmentCostExceptionError } from "./shipment-cost-exception.policy";
import { persistShipmentExceptionDecision, readCurrentShipmentSourceFingerprints, readShipmentExceptionFacts } from "./shipment-cost-exception.repository";

export function shipmentExceptionScope(lineId: number) {
  shipmentExceptionIdSchema.parse(lineId);
  return { method: "POST", routeTemplate: "/api/shipment-lines/:id/cost-exception",
    resourceKey: `shipment_line:${lineId}`, commandName: "procurement.shipment_cost.exception_decide" };
}

async function loadReview(tx: AmendmentTransaction, lineId: number, actorId: string) {
  // Same lock order as cost updates: graph, shipment, identity. Decisions and
  // source changes serialize; identity share locks prevent mid-commit revocation.
  await lockInventoryCostGraph(tx);
  const shipment = await tx.execute(sql`SELECT shipment.id FROM procurement.inbound_shipments shipment
    JOIN procurement.inbound_shipment_lines line ON line.inbound_shipment_id=shipment.id
    WHERE line.id=${lineId} FOR UPDATE OF shipment`);
  if (!shipment.rows.length) throw new ShipmentCostExceptionError("Shipment line not found.", "SHIPMENT_EXCEPTION_NOT_FOUND", 404);
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const [facts] = await readShipmentExceptionFacts(tx, [lineId]);
  if (!facts) throw new ShipmentCostExceptionError("Shipment line changed. Reload the review.", "SHIPMENT_EXCEPTION_STALE");
  const review = buildShipmentCostException(facts);
  const current = review ? (await readCurrentShipmentSourceFingerprints(tx, facts.shipmentId)).get(lineId) ?? null : null;
  const stale = review !== null && current !== (facts.contract as { fingerprint: string }).fingerprint;
  const canApprove = hasQuantityAmendmentAuthority(actor);
  const context = shipmentExceptionContextSchema.parse({
    shipmentId: facts.shipmentId, lineId, sku: facts.sku, sourceVersion: shipmentExceptionVersion(facts, current), canApprove,
    blockedReason: !canApprove ? "A current Administrator with purchasing approval permission must approve this decision."
      : !review ? "This issue needs its source records corrected. Only documented historical quantity or receipt gaps can be accepted."
        : stale ? "Shipment charges or their allocation changed. Update shipment costs, then review the latest inventory result." : null,
    review: stale && review ? { ...review, state: "open" } : review,
  });
  return { facts, context, actor };
}

export function createShipmentCostExceptionService(database: AmendmentDatabase, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    async context(id: number, actorId: string) {
      const lineId = shipmentExceptionIdSchema.parse(id);
      return database.transaction(async tx => (await loadReview(tx, lineId, actorId)).context);
    },
    async decide(id: number, input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const lineId = shipmentExceptionIdSchema.parse(id), scope = shipmentExceptionScope(lineId);
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId || descriptor.method !== scope.method
        || descriptor.routeTemplate !== scope.routeTemplate || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("The exception command does not match its authenticated administrator or shipment line.", 403, "SHIPMENT_EXCEPTION_SCOPE_INVALID");
      }
      const parsed = shipmentExceptionRequestSchema.safeParse(input);
      if (!parsed.success) throw new FinancialCommandError("Review the decision and enter a reason of at least 10 characters.", 400, "SHIPMENT_EXCEPTION_INPUT_INVALID");
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure: error => error instanceof ShipmentCostExceptionError ? {
          kind: "rejected", httpStatus: error.statusCode, errorCode: error.code, errorMessage: error.message, body: { error: error.message, code: error.code },
        } : { kind: "retryable", errorCode: "SHIPMENT_EXCEPTION_FAILED", errorMessage: "The decision could not be recorded. Retry the same approval." },
        work: async tx => {
          const request = parsed.data;
          const { facts, context, actor } = await loadReview(tx, lineId, actorId);
          if (!context.canApprove) throw new ShipmentCostExceptionError(context.blockedReason!, "SHIPMENT_EXCEPTION_ADMIN_REQUIRED", 403);
          if (context.sourceVersion !== request.sourceVersion) throw new ShipmentCostExceptionError("The cost evidence or review decision changed. Reload and review the new before and after values.", "SHIPMENT_EXCEPTION_STALE");
          if (context.blockedReason || !context.review) throw new ShipmentCostExceptionError(context.blockedReason ?? "This issue is not eligible for acceptance.", "SHIPMENT_EXCEPTION_BLOCKED");
          if ((request.action === "accept") === (context.review.state === "accepted")) throw new ShipmentCostExceptionError("This review has already changed. Reload the saved decision.", "SHIPMENT_EXCEPTION_STALE");
          const decision = await persistShipmentExceptionDecision(tx, facts, context, request, actor, z.date().parse(clock()));
          return { httpStatus: 200, body: shipmentExceptionResultSchema.parse({ lineId, shipmentId: facts.shipmentId, decision }),
            resultType: "shipment_cost_exception_decision", resultId: decision.id };
        },
      });
    },
  };
}

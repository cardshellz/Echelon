import { shipmentCostWorkflowIdSchema, shipmentCostUpdateInputSchema } from "@shared/procurement/shipment-cost-workflow";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand,
  type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository,
} from "../../platform/commands/transactional-command.service";
import { ShipmentTrackingError, type ShipmentTrackingService } from "./shipment-tracking.service";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";

export const SHIPMENT_COST_UPDATE_PRINCIPAL = "procurement.shipment-cost-update";
export function shipmentCostUpdateScope(shipmentId: number) {
  shipmentCostWorkflowIdSchema.parse(shipmentId);
  return { method: "POST", routeTemplate: "/api/inbound-shipments/:id/update-costs",
    resourceKey: `shipment:${shipmentId}`, commandName: "procurement.shipment_cost.update_all" };
}

export function classifyShipmentCostUpdateFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof CostEvidenceError && error.code === "COST_RECONCILIATION_PARTIAL_HISTORY") {
    return { kind: "rejected", httpStatus: 409, body: { code: error.code, error: error.message },
      errorCode: error.code, errorMessage: error.message };
  }
  if (error instanceof ShipmentTrackingError && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "SHIPMENT_COST_UPDATE_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message, details: error.details },
      errorCode: code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "SHIPMENT_COST_UPDATE_FAILED",
    errorMessage: "Shipment cost update failed before its transaction committed." };
}

export function createShipmentCostUpdateCommands(
  service: Pick<ShipmentTrackingService, "updateCostsInTransaction">,
  repository: FinancialCommandRepository<any> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return { async execute(shipmentId: number, body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
    if (typeof actorId !== "string" || !actorId.trim()) throw new FinancialCommandError("Sign in before updating costs.", 401, "SHIPMENT_COST_UPDATE_ACTOR_REQUIRED");
    if (!shipmentCostUpdateInputSchema.safeParse(body).success) {
      throw new FinancialCommandError("Reload this shipment before updating its costs.", 400, "SHIPMENT_COST_UPDATE_INPUT_INVALID");
    }
    const scope = shipmentCostUpdateScope(shipmentId);
    if (descriptor.actorType !== "service" || descriptor.actorId !== SHIPMENT_COST_UPDATE_PRINCIPAL
      || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
      || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
      throw new FinancialCommandError("Shipment cost update scope is invalid", 500, "SHIPMENT_COST_UPDATE_SCOPE_INVALID");
    }
    return runTransactionalFinancialCommand({ repository, descriptor, classifyFailure: classifyShipmentCostUpdateFailure,
      work: async tx => ({ httpStatus: 200, body: await service.updateCostsInTransaction(tx, shipmentId, body, actorId, clock()) }),
    });
  } };
}

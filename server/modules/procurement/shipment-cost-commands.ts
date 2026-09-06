import { z } from "zod";
import { shipmentCostResourceIdSchema } from "@shared/procurement/shipment-cost-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  FinancialCommandError, runTransactionalFinancialCommand,
  type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository,
} from "../../platform/commands/transactional-command.service";
import { ShipmentTrackingError, type ShipmentTrackingService } from "./shipment-tracking.service";

export interface ShipmentCostCommand {
  operation: "create" | "update" | "delete";
  resourceId: number;
  body: unknown;
}

// Reservation scope belongs to the command owner, so a delegated retry cannot
// duplicate a charge. The authenticated human is required separately and is
// written to the immutable audit event inside the business transaction.
export const SHIPMENT_COST_COMMAND_PRINCIPAL = "procurement.shipment-cost";

export function shipmentCostCommandScope(command: Pick<ShipmentCostCommand, "operation" | "resourceId">) {
  if (!shipmentCostResourceIdSchema.safeParse(command.resourceId).success) {
    throw new FinancialCommandError("Charge resource ID must be a positive PostgreSQL integer", 400, "SHIPMENT_COST_ID_INVALID");
  }
  if (!["create", "update", "delete"].includes(command.operation)) {
    throw new FinancialCommandError("Unsupported charge command", 400, "SHIPMENT_COST_OPERATION_INVALID");
  }
  return {
    method: command.operation === "create" ? "POST" : command.operation === "update" ? "PATCH" : "DELETE",
    routeTemplate: command.operation === "create" ? "/api/inbound-shipments/:id/costs" : "/api/inbound-shipments/costs/:costId",
    resourceKey: `${command.operation === "create" ? "shipment" : "shipment_cost"}:${command.resourceId}`,
    commandName: `procurement.shipment_cost.${command.operation}`,
  };
}

export function classifyShipmentCostCommandFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    const message = "Invalid shipment charge command: " + error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return { kind: "rejected", httpStatus: 400, body: { code: "SHIPMENT_COST_INPUT_INVALID", error: message }, errorCode: "SHIPMENT_COST_INPUT_INVALID", errorMessage: message };
  }
  if (error instanceof ShipmentTrackingError && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "SHIPMENT_COST_COMMAND_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message, details: error.details }, errorCode: code, errorMessage: error.message };
  }
  const cause = error instanceof Error ? error.cause ?? error : error;
  const pgError = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  // Only classify the charge's own input constraints as definitive rejection.
  // An allocation/audit/result constraint failure is infrastructure failure and
  // must retain the command for recovery after its transaction has rolled back.
  if ((pgError?.code === "23503" || pgError?.code === "23514")
    && pgError.schema === "procurement" && pgError.table === "inbound_freight_costs") {
    const message = "The charge references an unavailable or incompatible record. Refresh and review the supplier and shipment.";
    return { kind: "rejected", httpStatus: 422, body: { code: "SHIPMENT_COST_REFERENCE_INVALID", error: message }, errorCode: "SHIPMENT_COST_REFERENCE_INVALID", errorMessage: message };
  }
  return { kind: "retryable", errorCode: "SHIPMENT_COST_TRANSIENT_FAILURE", errorMessage: "Shipment charge command failed before its transaction committed." };
}

export function createShipmentCostCommands(
  service: Pick<ShipmentTrackingService, "executeCostCommandInTransaction">,
  repository: FinancialCommandRepository<any> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(command: ShipmentCostCommand, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (typeof actorId !== "string" || !actorId.trim()) throw new FinancialCommandError("An authenticated actor is required", 401, "SHIPMENT_COST_ACTOR_REQUIRED");
      const scope = shipmentCostCommandScope(command);
      if (descriptor.actorType !== "service" || descriptor.actorId !== SHIPMENT_COST_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("Shipment charge command scope is invalid", 500, "SHIPMENT_COST_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure: classifyShipmentCostCommandFailure,
        work: async (tx) => {
          const result = await service.executeCostCommandInTransaction(tx, command, actorId, clock());
          return { httpStatus: command.operation === "create" ? 201 : 200, body: result };
        },
      });
    },
  };
}

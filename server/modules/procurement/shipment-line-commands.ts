import { ShipmentSourceCapacityError } from "./shipment-source-capacity";
import { z } from "zod";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  FinancialCommandError, runTransactionalFinancialCommand,
  type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository,
} from "../../platform/commands/transactional-command.service";
import { ShipmentTrackingError, type ShipmentTrackingService } from "./shipment-tracking.service";

export interface ShipmentLineCommand {
  operation: "add-from-po" | "import" | "resolve-dimensions" | "update" | "delete";
  resourceId: number;
  body: unknown;
}

// Reservation scope belongs to the command owner, so a delegated retry cannot
// duplicate a line. The authenticated human is required separately and is
// written to the immutable audit event inside the business transaction.
export const SHIPMENT_LINE_COMMAND_PRINCIPAL = "procurement.shipment-line";

export function shipmentLineCommandScope(command: Pick<ShipmentLineCommand, "operation" | "resourceId">) {
  if (!shipmentLineResourceIdSchema.safeParse(command.resourceId).success) {
    throw new FinancialCommandError("Line resource ID must be a positive PostgreSQL integer", 400, "SHIPMENT_LINE_ID_INVALID");
  }
  if (!["add-from-po", "import", "resolve-dimensions", "update", "delete"].includes(command.operation)) {
    throw new FinancialCommandError("Unsupported line command", 400, "SHIPMENT_LINE_OPERATION_INVALID");
  }
  const isLine = command.operation === "update" || command.operation === "delete";
  const suffix = command.operation === "add-from-po" ? "from-po"
    : command.operation === "import" ? "import-packing-list" : "resolve-dimensions";
  return {
    method: command.operation === "update" ? "PATCH" : command.operation === "delete" ? "DELETE" : "POST",
    routeTemplate: isLine ? "/api/inbound-shipments/lines/:lineId" : `/api/inbound-shipments/:id/lines/${suffix}`,
    resourceKey: `${isLine ? "shipment_line" : "shipment"}:${command.resourceId}`,
    commandName: `procurement.shipment_line.${command.operation}`,
  };
}

export function classifyShipmentLineCommandFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    const message = "Invalid shipment line command: " + error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return { kind: "rejected", httpStatus: 400, body: { code: "SHIPMENT_LINE_INPUT_INVALID", error: message }, errorCode: "SHIPMENT_LINE_INPUT_INVALID", errorMessage: message };
  }
  if ((error instanceof ShipmentTrackingError || error instanceof ShipmentSourceCapacityError) && error.statusCode >= 400 && error.statusCode < 500) {
    const code = String(error.details?.code ?? "SHIPMENT_LINE_COMMAND_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message, details: error.details }, errorCode: code, errorMessage: error.message };
  }
  const cause = error instanceof Error ? error.cause ?? error : error;
  const pgError = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  // Only classify the line's own input constraints as definitive rejection.
  // An allocation/audit/result constraint failure is infrastructure failure and
  // must retain the command for recovery after its transaction has rolled back.
  if ((pgError?.code === "23503" || pgError?.code === "23514")
    && pgError.schema === "procurement" && pgError.table === "inbound_shipment_lines") {
    const message = "The line references an unavailable or incompatible record. Refresh and review the supplier and shipment.";
    return { kind: "rejected", httpStatus: 422, body: { code: "SHIPMENT_LINE_REFERENCE_INVALID", error: message }, errorCode: "SHIPMENT_LINE_REFERENCE_INVALID", errorMessage: message };
  }
  return { kind: "retryable", errorCode: "SHIPMENT_LINE_TRANSIENT_FAILURE", errorMessage: "Shipment line command failed before its transaction committed." };
}

export function createShipmentLineCommands(
  service: Pick<ShipmentTrackingService, "executeLineCommandInTransaction">,
  repository: FinancialCommandRepository<any> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(command: ShipmentLineCommand, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (typeof actorId !== "string" || !actorId.trim()) throw new FinancialCommandError("An authenticated actor is required", 401, "SHIPMENT_LINE_ACTOR_REQUIRED");
      const scope = shipmentLineCommandScope(command);
      if (descriptor.actorType !== "service" || descriptor.actorId !== SHIPMENT_LINE_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("Shipment line command scope is invalid", 500, "SHIPMENT_LINE_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure: classifyShipmentLineCommandFailure,
        work: async (tx) => {
          const result = await service.executeLineCommandInTransaction(tx, command, actorId, clock());
          return { httpStatus: command.operation === "add-from-po" ? 201 : 200, body: result };
        },
      });
    },
  };
}

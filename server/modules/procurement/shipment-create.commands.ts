import { z } from "zod";
import { shipmentCreateResultSchema, shipmentCreateSchema } from "@shared/procurement/shipment-create-command";
import { canonicalJson } from "@shared/utils/canonical-json";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { ShipmentSourceCapacityError } from "./shipment-source-capacity";
import { assertShipmentCreateActor, ShipmentCreateError, type CreatedShipment } from "./shipment-create.service";
import type { ShipmentCreateTransaction } from "./shipment-create.repository";

// Delegated same-key recovery replays the original authenticated operator's
// result, following the other procurement command owners' service scope.
export const SHIPMENT_CREATE_COMMAND_PRINCIPAL = "procurement.shipment-create";
export function shipmentCreateCommandScope() {
  return { method: "POST", routeTemplate: "/api/inbound-shipments", resourceKey: "shipment:create", commandName: "procurement.shipment.create" } as const;
}

export function classifyShipmentCreateFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    const message = "Invalid shipment creation: " + error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return { kind: "rejected", httpStatus: 400, body: { code: "SHIPMENT_CREATE_INPUT_INVALID", error: message }, errorCode: "SHIPMENT_CREATE_INPUT_INVALID", errorMessage: message };
  }
  if ((error instanceof ShipmentCreateError || error instanceof ShipmentTrackingError || error instanceof ShipmentSourceCapacityError)
    && error.statusCode >= 400 && error.statusCode < 500) {
    const code = error instanceof ShipmentCreateError ? error.code : String(error.details?.code ?? "SHIPMENT_CREATE_REJECTED");
    return { kind: "rejected", httpStatus: error.statusCode, body: { code, error: error.message }, errorCode: code, errorMessage: error.message };
  }
  const cause = error instanceof Error ? error.cause ?? error : error;
  const pg = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  if (pg?.code === "23505" && pg.constraint === "inbound_shipments_shipment_number_active_uidx") {
    const message = "This shipment number is already used by an active shipment. Choose a different number.";
    return { kind: "rejected", httpStatus: 409, body: { code: "SHIPMENT_CREATE_NUMBER_CONFLICT", error: message }, errorCode: "SHIPMENT_CREATE_NUMBER_CONFLICT", errorMessage: message };
  }
  if ((pg?.code === "23503" || pg?.code === "23514") && pg.schema === "procurement" && pg.table === "inbound_shipments") {
    const message = "A shipment reference is no longer available. Refresh and review the warehouse and operator.";
    return { kind: "rejected", httpStatus: 422, body: { code: "SHIPMENT_CREATE_REFERENCE_INVALID", error: message }, errorCode: "SHIPMENT_CREATE_REFERENCE_INVALID", errorMessage: message };
  }
  return { kind: "retryable", errorCode: "SHIPMENT_CREATE_TRANSIENT_FAILURE", errorMessage: "Shipment creation failed before its transaction committed." };
}

interface ShipmentCreateOwner {
  executeCreateShipmentInTransaction(tx: ShipmentCreateTransaction, body: unknown, actorId: string, now: Date): Promise<CreatedShipment>;
}

export function createShipmentCreateCommands(
  service: ShipmentCreateOwner,
  repository: FinancialCommandRepository<ShipmentCreateTransaction> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      try { assertShipmentCreateActor(actorId); }
      catch (error) {
        if (error instanceof ShipmentCreateError) throw new FinancialCommandError(error.message, error.statusCode, error.code);
        throw error;
      }
      const scope = shipmentCreateCommandScope();
      if (descriptor.actorType !== "service" || descriptor.actorId !== SHIPMENT_CREATE_COMMAND_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("Shipment create command scope is invalid", 500, "SHIPMENT_CREATE_SCOPE_INVALID");
      }
      if (descriptor.requestHash !== hashHttpFinancialCommand({ ...scope, body })) {
        throw new FinancialCommandError("Shipment create command identity does not match its original request", 500, "SHIPMENT_CREATE_IDENTITY_INVALID");
      }
      return runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure: classifyShipmentCreateFailure,
        work: async (tx) => {
          // Validation runs in the claimed command so definitive rejection is
          // durable too. Identity above deliberately hashes the unmodified body.
          const requested = shipmentCreateSchema.parse(body);
          const created = await service.executeCreateShipmentInTransaction(tx, body, actorId, clock());
          const parsed = shipmentCreateResultSchema.safeParse(JSON.parse(canonicalJson(created)));
          if (!parsed.success || parsed.data.lineCount !== (requested.purchaseOrder?.lineSelections?.length ?? 0)
            || parsed.data.createdBy !== actorId
            || (requested.shipmentNumber !== undefined && parsed.data.shipmentNumber !== requested.shipmentNumber)) {
            throw new ShipmentCreateError("SHIPMENT_CREATE_RESULT_INVALID", "Shipment creation returned an invalid recovery identity.", 500);
          }
          return { httpStatus: 201, body: parsed.data, resultType: "inbound_shipment", resultId: parsed.data.id };
        },
      });
    },
  };
}

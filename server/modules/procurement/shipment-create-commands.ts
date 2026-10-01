import { z } from "zod";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand,
  type FinancialCommandDescriptor, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { classifyShipmentLineCommandFailure } from "./shipment-line-commands";
import type { ShipmentTrackingService } from "./shipment-tracking.service";

export const SHIPMENT_CREATE_PRINCIPAL = "procurement.shipment-create";
export function shipmentCreateScope(purchaseOrderId: number) {
  shipmentLineResourceIdSchema.parse(purchaseOrderId);
  return { method: "POST", routeTemplate: "/api/inbound-shipments/from-po",
    resourceKey: `purchase_order:${purchaseOrderId}`, commandName: "procurement.shipment.create-from-po" };
}

export function createShipmentCreateCommands(
  service: Pick<ShipmentTrackingService, "createShipmentFromPoInTransaction">,
  repository: FinancialCommandRepository<any> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async execute(body: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (!actorId?.trim()) throw new FinancialCommandError("An authenticated actor is required", 401, "SHIPMENT_CREATE_ACTOR_REQUIRED");
      // Validate the scope independently; full input validation occurs inside
      // the owner transaction and is saved as a definitive rejection.
      const { source } = z.object({ source: z.object({ purchaseOrderId: shipmentLineResourceIdSchema }) }).parse(body);
      const scope = shipmentCreateScope(source.purchaseOrderId);
      if (descriptor.actorType !== "service" || descriptor.actorId !== SHIPMENT_CREATE_PRINCIPAL
        || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName) {
        throw new FinancialCommandError("Shipment creation scope is invalid", 500, "SHIPMENT_CREATE_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure: (error) => {
          if (error instanceof z.ZodError) return { kind: "rejected", httpStatus: 400,
            body: { code: "SHIPMENT_CREATE_INPUT_INVALID", error: "Invalid shipment creation request", details: error.issues },
            errorCode: "SHIPMENT_CREATE_INPUT_INVALID", errorMessage: "Invalid shipment creation request" };
          const cause = error instanceof Error ? error.cause ?? error : error;
          const pgError = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
          if (pgError?.code === "23503" && pgError.schema === "procurement" && pgError.table === "inbound_shipments") {
            const message = "The shipment references a record that is no longer available. Refresh its details and try again.";
            return { kind: "rejected", httpStatus: 422, body: { code: "SHIPMENT_CREATE_REFERENCE_INVALID", error: message },
              errorCode: "SHIPMENT_CREATE_REFERENCE_INVALID", errorMessage: message };
          }
          const disposition = classifyShipmentLineCommandFailure(error);
          return disposition.kind === "rejected" ? disposition : { kind: "retryable",
            errorCode: "SHIPMENT_CREATE_TRANSIENT_FAILURE", errorMessage: "Shipment creation failed before its transaction committed." };
        },
        work: async (tx) => {
          const result = await service.createShipmentFromPoInTransaction(tx, body, actorId, clock());
          return { httpStatus: 201, body: result, resultType: "inbound_shipment", resultId: String(result.shipment.id) };
        },
      });
    },
  };
}

import { z } from "zod";
import { shipmentHistoryApprovalSchema, shipmentHistoryId, shipmentHistoryInputSchema, shipmentHistoryPreviewSchema } from "@shared/procurement/shipment-history-correction";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";
import type { AmendmentDatabase } from "./po-quantity-amendment.repository";
import { historyFingerprint, readShipmentHistorySource, writeHistoryCorrection } from "./shipment-history-correction.repository";
import { planShipmentHistoryCorrection, ShipmentHistoryCorrectionError } from "./domain/shipment-history-correction";

export function shipmentHistoryScope(shipmentId: number) {
  return { method: "POST", routeTemplate: "/api/inbound-shipments/:id/history-correction", resourceKey: `inbound-shipment:${shipmentId}`,
    commandName: "procurement.shipment.history-correction", contractVersion: 1 };
}

export function createShipmentHistoryCorrectionService(database: AmendmentDatabase, clock: () => Date) {
  const repository = createDrizzleFinancialCommandRepository(database);
  return {
    context: (id: number, actorId: string) => database.transaction(async tx =>
      (await readShipmentHistorySource(tx, shipmentHistoryId.parse(id), actorId)).context, { isolationLevel: "repeatable read" }),
    preview: (id: number, raw: unknown, actorId: string) => database.transaction(async tx => {
      const input = shipmentHistoryInputSchema.parse(raw);
      const source = await readShipmentHistorySource(tx, shipmentHistoryId.parse(id), actorId);
      const review = planShipmentHistoryCorrection(source.context, input, source.protectedRecordsVersion, z.date().parse(clock()));
      return shipmentHistoryPreviewSchema.parse({ review, previewVersion: historyFingerprint({ actorId, input, review }) });
    }, { isolationLevel: "repeatable read" }),
    async approve(id: number, raw: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      const shipmentId = shipmentHistoryId.parse(id), approval = shipmentHistoryApprovalSchema.parse(raw);
      const scope = shipmentHistoryScope(shipmentId);
      if (descriptor.actorId !== actorId || descriptor.actorType !== "user" || Object.entries(scope).some(([key, value]) => descriptor[key as keyof FinancialCommandDescriptor] !== value)) {
        throw new FinancialCommandError("This approval does not match the administrator and shipment.", 403, "SHIPMENT_HISTORY_SCOPE");
      }
      return runTransactionalFinancialCommand({ repository, descriptor,
        classifyFailure(error) {
          if (error instanceof ShipmentHistoryCorrectionError) return { kind: "rejected", httpStatus: error.statusCode,
            errorCode: error.code, errorMessage: error.message, body: { code: error.code, error: error.message } };
          return { kind: "retryable", errorCode: "SHIPMENT_HISTORY_RETRY", errorMessage: "The correction was not confirmed. Retry the same approval." };
        },
        work: async tx => {
          const source = await readShipmentHistorySource(tx, shipmentId, actorId);
          const { previewVersion, ...input } = approval;
          const approvedAt = z.date().parse(clock());
          const review = planShipmentHistoryCorrection(source.context, input, source.protectedRecordsVersion, approvedAt);
          if (previewVersion !== historyFingerprint({ actorId, input, review })) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_PREVIEW_CHANGED", "The reviewed change does not match this approval. Review it again; nothing was saved.");
          const posting = await writeHistoryCorrection(tx, shipmentId, input.sourceVersion, actorId, input.reason, review, approvedAt);
          const after = await readShipmentHistorySource(tx, shipmentId, actorId);
          if (after.protectedRecordsVersion !== source.protectedRecordsVersion) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_PROTECTED_RECORD_CHANGED", "A quantity or cost record changed during the correction. Everything was rolled back.");
          return { httpStatus: 200, resultType: "shipment_history_correction", resultId: posting.id, body: posting };
        },
      });
    },
  };
}

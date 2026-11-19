import { sql } from "drizzle-orm";
import { shipmentEditorApprovalSchema, shipmentEditorPreviewSchema, shipmentEditorRequestSchema, shipmentEditorResultSchema, type ShipmentEditorRequest } from "@shared/procurement/shipment-editor";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import type { ShipmentTrackingService } from "./shipment-tracking.service";
import type { ShipmentLineCommand } from "./shipment-line-commands";
import { classifyShipmentLineCommandFailure } from "./shipment-line-commands";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import { readShipmentEditorSource, recordShipmentEditorApproval } from "./shipment-editor.repository";
import { rejectShipmentEdit, sumShipmentCents } from "./shipment-editor.policy";
import { costFingerprint } from "../inventory/infrastructure/cost-evidence-values";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import { runTransactionalFinancialCommand, type FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";

export const shipmentEditorScope = (id: number) => ({ method: "POST", routeTemplate: "/api/inbound-shipments/:id/editor",
  resourceKey: `shipment:${id}`, commandName: "procurement.shipment.editor.approve" });
type Source = Awaited<ReturnType<typeof readShipmentEditorSource>>;
const sumShares = (values: readonly (number | null)[]) => values.some(value => value === null) ? null
  : sumShipmentCents(values.filter((value): value is number => value !== null));

export function createShipmentEditorService(database: AmendmentDatabase, owner: Pick<ShipmentTrackingService, "executeLineBatchInTransaction">, clock: () => Date) {
  async function apply(tx: AmendmentTransaction, source: Source, request: ShipmentEditorRequest, actorId: string) {
    if (!source.context.canApprove) rejectShipmentEdit("A current Administrator with purchasing approval permission must approve this edit.", "SHIPMENT_EDITOR_ADMIN", 403);
    if (source.context.blockedReason) rejectShipmentEdit(source.context.blockedReason, "SHIPMENT_EDITOR_HISTORY");
    if (source.context.sourceVersion !== request.sourceVersion) rejectShipmentEdit("Shipment lines, costs or approval permissions changed. Reload and review again.", "SHIPMENT_EDITOR_STALE");
    const commands: ShipmentLineCommand[] = [];
    const version = (id: number): string => {
      const value = source.versions.get(id);
      if (!value) rejectShipmentEdit("A selected line does not belong to this shipment.", "SHIPMENT_EDITOR_LINE", 404);
      return value;
    };
    for (const id of request.removals) commands.push({ operation: "delete", resourceId: id, body: { expectedVersion: version(id) } });
    for (const change of request.changes) commands.push({ operation: "update", resourceId: change.lineId, body: { ...change.fields,
      ...(change.unitSelection ? { unitSelection: change.unitSelection } : {}), expectedVersion: version(change.lineId) } });
    for (const addition of request.additions) commands.push({ operation: "add-from-po", resourceId: source.context.shipmentId,
      body: { purchaseOrderId: addition.purchaseOrderId, lineSelections: [{ poLineId: addition.purchaseOrderLineId, qty: addition.quantityPieces, unitSelection: addition.unitSelection, packing: addition.packing }] } });
    const at = clock();
    if (!Number.isFinite(at.getTime())) throw new Error("Shipment editor clock is invalid");
    await owner.executeLineBatchInTransaction(tx, source.context.shipmentId, commands, actorId, at);
    const after = await readShipmentEditorSource(tx, source.context.shipmentId, actorId);
    if (costFingerprint(source.protectedCharges) !== costFingerprint(after.protectedCharges)) rejectShipmentEdit("A shipment charge changed unexpectedly. The entire edit was rolled back.", "SHIPMENT_EDITOR_COST_CHANGED");
    const beforeIds = new Set(source.context.lines.map(line => line.id));
    const afterLines = after.context.lines.map(line => {
      if (beforeIds.has(line.id)) return line;
      const added = request.additions.find(row => row.purchaseOrderLineId === line.purchaseOrderLineId && row.purchaseOrderId === line.purchaseOrderId);
      if (!added) rejectShipmentEdit("An unexpected shipment line was created. No edit was saved.", "SHIPMENT_EDITOR_RESULT");
      // Sequence IDs are not stable across the rolled-back preview and approval.
      return { ...line, id: null, key: `new:${added.clientKey}` };
    });
    const poIds = [...new Set([...source.context.lines, ...afterLines].map(line => line.purchaseOrderId))];
    const review = { shipmentId: source.context.shipmentId, sourceVersion: request.sourceVersion, reason: request.reason,
      before: source.context.lines, after: afterLines, charges: source.context.charges,
      costShares: poIds.map(id => ({ purchaseOrderId: id,
        poNumber: [...source.context.lines, ...afterLines].find(line => line.purchaseOrderId === id)?.poNumber ?? null,
        beforeCents: sumShares(source.context.lines.filter(line => line.purchaseOrderId === id).map(line => line.allocatedCostCents)),
        afterCents: sumShares(afterLines.filter(line => line.purchaseOrderId === id).map(line => line.allocatedCostCents)) })) };
    if (costFingerprint(review.before) === costFingerprint(review.after)) {
      rejectShipmentEdit("Change a line value before approving.", "SHIPMENT_EDITOR_NO_CHANGE", 400);
    }
    const preview = shipmentEditorPreviewSchema.parse({ review, previewVersion: costFingerprint({ actorId, request, review }) });
    return { after, preview, at };
  }
  return {
    context: (id: number, actorId: string) => database.transaction(async tx => (await readShipmentEditorSource(tx, shipmentLineResourceIdSchema.parse(id), actorId)).context),
    preview: (id: number, raw: unknown, actorId: string) => database.transaction(async tx => {
      const request = shipmentEditorRequestSchema.parse(raw), source = await readShipmentEditorSource(tx, shipmentLineResourceIdSchema.parse(id), actorId);
      await tx.execute(sql`SAVEPOINT shipment_editor_preview`);
      try { return (await apply(tx, source, request, actorId)).preview; }
      finally { await tx.execute(sql`ROLLBACK TO SAVEPOINT shipment_editor_preview`); await tx.execute(sql`RELEASE SAVEPOINT shipment_editor_preview`); }
    }),
    approve: async (id: number, raw: unknown, actorId: string, descriptor: FinancialCommandDescriptor) => {
      shipmentLineResourceIdSchema.parse(id);
      if (descriptor.actorId !== actorId || descriptor.actorType !== "user" || Object.entries(shipmentEditorScope(id)).some(([key, value]) => descriptor[key as keyof FinancialCommandDescriptor] !== value)) rejectShipmentEdit("The approval belongs to a different user or shipment.", "SHIPMENT_EDITOR_SCOPE", 403);
      return runTransactionalFinancialCommand({ repository: createDrizzleFinancialCommandRepository(database), descriptor, classifyFailure: classifyShipmentLineCommandFailure,
        work: async tx => {
          const { previewVersion, approvalConfirmed: _confirmed, ...request } = shipmentEditorApprovalSchema.parse(raw);
          const source = await readShipmentEditorSource(tx, id, actorId);
          const result = await apply(tx, source, request, actorId);
          if (result.preview.previewVersion !== previewVersion) rejectShipmentEdit("The reviewed impact changed. Reload and review before approving.", "SHIPMENT_EDITOR_STALE");
          const saved = await recordShipmentEditorApproval(tx, source, result.after, result.preview, request, actorId, result.at);
          return { httpStatus: 200, body: shipmentEditorResultSchema.parse(saved), resultId: saved.auditId, resultType: "shipment_edit" };
        } });
    },
  };
}

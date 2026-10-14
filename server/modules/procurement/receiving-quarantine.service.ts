import { z } from "zod";
import {
  receivingQuarantineIntakeSchema, prepareQuarantineAcceptanceSchema, returnQuarantineCustodySchema,
  cancelQuarantineAcceptanceSchema, receivingQuarantineCommandResultSchema, receivingQuarantineViewSchema,
} from "@shared/procurement/receiving-quarantine";
import { readCommandAuthorityActor } from "../identity/infrastructure/command-authority.repository";
import type { CommandAuthorityActor } from "../identity/domain/command-authority";
import { assertCustodyResolution, assertReviewedCustodyConversion, custodyQuantities, ReceivingQuarantineError } from "./domain/receiving-quarantine";
import { validateReceivingLocations } from "./receiving-close-integrity.repository";
import { lockReceivingCustodyFence } from "./receiving-custody-public";
import type { ReceivingQuarantineReceivingPort } from "./receiving-quarantine-receiving.port";
import {
  assertPhysicalHoldingLocation, canResolveCustody, custodyCapability, insertCustodyAcceptance, insertCustodyObservation, listCustodyObservations,
  projectCustodyObservation, readCustodyAcceptance, readCustodyObservation, readCustodyReceipt, readReceiptCustodyPresence,
  recordCustodyDisposition, type CustodyTransaction,
} from "./receiving-quarantine.repository";

export type ReceivingCustodyCommand = "intake" | "prepare-acceptance" | "return" | "cancel-acceptance";
const schemas = { intake: receivingQuarantineIntakeSchema, "prepare-acceptance": prepareQuarantineAcceptanceSchema,
  return: returnQuarantineCustodySchema, "cancel-acceptance": cancelQuarantineAcceptanceSchema } as const;
export function validateCustodyCommandInput(command: ReceivingCustodyCommand, input: unknown): void {
  if (!schemas[command].safeParse(input).success) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_INPUT_INVALID",
    "Supply the reviewed quantities, source, reason and evidence required for this quarantine action.", 400);
}
function assertAuthority(actor: CommandAuthorityActor, command: ReceivingCustodyCommand): void {
  const allowed = command === "intake" ? actor.active && actor.permissions.includes("inventory:adjust") : canResolveCustody(actor);
  if (!allowed) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_FORBIDDEN",
    command === "intake" ? "An active inventory adjuster is required to record custody." : "An active purchasing approver is required to resolve custody.", 403);
}

export async function readReceivingQuarantineView(tx: CustodyTransaction, receivingOrderId: number, actorId: string) {
  const actor = await readCommandAuthorityActor(tx, actorId);
  if (!actor.active) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_FORBIDDEN", "An active account is required.", 403);
  const receipt = await readCustodyReceipt(tx, receivingOrderId);
  const rows = await listCustodyObservations(tx, receivingOrderId);
  const history = rows.length > 0 || await readReceiptCustodyPresence(tx, receivingOrderId);
  const observations = [];
  for (const row of rows) observations.push(await projectCustodyObservation(tx, row, actor));
  return receivingQuarantineViewSchema.parse({
    receivingOrderId, warehouseId: receipt.warehouseId,
    canRecord: custodyCapability(actor.permissions.includes("inventory:adjust") && receipt.warehouseId !== null && receipt.status !== "cancelled",
      "Select a warehouse on an active receipt. Recording custody requires inventory adjustment permission."),
    canAcceptAll: custodyCapability(actor.permissions.includes("inventory:adjust") && !history
      && ["draft","open","receiving","verified"].includes(receipt.status),
      history ? "This receipt has quarantine history. Review accepted quantities individually." : "The receipt must be editable and you need inventory adjustment permission."),
    observations,
  });
}

export async function executeReceivingCustodyCommand(tx: CustodyTransaction, receiving: ReceivingQuarantineReceivingPort, input: {
  command: ReceivingCustodyCommand; resourceId: number; body: unknown; actorId: string; at: Date; commandKey: string;
}) {
  validateCustodyCommandInput(input.command, input.body);
  z.number().int().positive().max(2_147_483_647).parse(input.resourceId);
  if (!Number.isFinite(input.at.getTime()) || !input.commandKey.trim()) throw new TypeError("Valid custody clock and command key required");
  await lockReceivingCustodyFence(tx, "write");
  const actor = await readCommandAuthorityActor(tx, input.actorId);
  assertAuthority(actor, input.command);
  let observationId: number;
  let acceptanceId: number | null = null;
  if (input.command === "intake") {
    const command = receivingQuarantineIntakeSchema.parse(input.body);
    const receipt = await readCustodyReceipt(tx, input.resourceId, true);
    if (receipt.status === "cancelled") throw new ReceivingQuarantineError("RECEIVING_CUSTODY_SOURCE_CANCELLED", "Cannot record custody against a cancelled receipt.");
    await validateReceivingLocations(tx, { receivingOrderId: receipt.id, warehouseId: receipt.warehouseId,
      references: [{ locationId: command.holdingLocationId }] });
    await assertPhysicalHoldingLocation(tx, command.holdingLocationId);
    if (!receipt.warehouseId) throw new ReceivingQuarantineError("RECEIVING_WAREHOUSE_REQUIRED", "Select the receiving warehouse first.");
    const common = { receivingOrderId: receipt.id, warehouseId: receipt.warehouseId, holdingLocationId: command.holdingLocationId,
      condition: command.condition, reason: command.reason, evidenceReference: command.evidenceReference, actorId: input.actorId, recordedAt: input.at.toISOString() };
    if (command.kind === "receipt_line") {
      const reviewed = await receiving.reviewQuarantineIntakeInTransaction(tx, { ...command, receivingOrderId: receipt.id }, input.actorId, input.at);
      observationId = await insertCustodyObservation(tx, { ...common,
        receivingLineId: command.receivingLineId, productId: reviewed.productId, productVariantId: reviewed.productVariantId,
        unitsPerVariant: reviewed.unitsPerVariantSnapshot, purchaseOrderLineId: reviewed.lineAfter.purchaseOrderLineId,
        inboundShipmentLineId: reviewed.lineAfter.inboundShipmentLineId, description: reviewed.lineBefore.productName || reviewed.lineBefore.sku || `Product ${reviewed.productId}`,
        observedSku: reviewed.lineBefore.sku, unitLabel: `Receive unit (${reviewed.unitsPerVariantSnapshot} pieces)`, observedQty: command.heldQty,
      }, input.commandKey, { before: reviewed.lineBefore, after: reviewed.lineAfter, countsReviewed: true });
    } else {
      observationId = await insertCustodyObservation(tx, { ...common, receivingLineId: null, productId: null, productVariantId: null,
        unitsPerVariant: null, purchaseOrderLineId: null, inboundShipmentLineId: null, description: command.description,
        observedSku: command.observedSku, unitLabel: command.unitLabel, observedQty: command.quantity,
      }, input.commandKey, { kind: command.kind, quantity: command.quantity, unitLabel: command.unitLabel });
    }
  } else {
    const row = await readCustodyObservation(tx, input.resourceId, true);
    observationId = row.id;
    const base = { actorId: input.actorId, at: input.at, commandKey: input.commandKey };
    if (input.command === "prepare-acceptance") {
      const command = prepareQuarantineAcceptanceSchema.parse(input.body);
      assertCustodyResolution(row, command.expectedVersion, command.observationQty);
      if (row.productId !== null && (row.purchaseOrderLineId !== command.purchaseOrderLineId || row.inboundShipmentLineId !== command.inboundShipmentLineId)) {
        throw new ReceivingQuarantineError("RECEIVING_CUSTODY_SOURCE_MISMATCH", "Known quarantined goods must retain their recorded purchase and shipment source.");
      }
      // The receiving owner rechecks current catalog and source identities in
      // this TX. A failed conversion rolls back its prepared line as well.
      const prepared = await receiving.prepareQuarantineAcceptanceInTransaction(tx, { ...command, sourceReceivingOrderId: row.receivingOrderId,
        observationId: row.id }, input.actorId, input.at);
      assertReviewedCustodyConversion({ observedProductId: row.productId, observedUnitsPerVariant: row.unitsPerVariant,
        observationQty: command.observationQty, targetProductId: prepared.productId,
        targetUnitsPerVariant: prepared.unitsPerVariantSnapshot, acceptedVariantQty: prepared.acceptedVariantQty });
      acceptanceId = await insertCustodyAcceptance(tx, { observationId: row.id, receivingOrderId: prepared.receivingOrderId,
        receivingLineId: prepared.receivingLineId, observationQty: command.observationQty, productId: prepared.productId, productVariantId: prepared.productVariantId,
        unitsPerVariant: prepared.unitsPerVariantSnapshot, acceptedVariantQty: prepared.acceptedVariantQty }, input.actorId, input.at, command.reason, command);
      await recordCustodyDisposition(tx, row, { ...base, kind: "prepare_acceptance", quantity: command.observationQty, acceptanceId,
        reason: command.reason, evidenceReference: null, requestEvidence: command });
    } else if (input.command === "return") {
      const command = returnQuarantineCustodySchema.parse(input.body);
      assertCustodyResolution(row, command.expectedVersion, command.observationQty);
      await recordCustodyDisposition(tx, row, { ...base, kind: "return", quantity: command.observationQty, acceptanceId: null,
        reason: command.reason, evidenceReference: command.evidenceReference, requestEvidence: command });
    } else {
      const command = cancelQuarantineAcceptanceSchema.parse(input.body);
      custodyQuantities(row);
      if (row.version !== command.expectedVersion) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_STALE", "Quarantine changed. Refresh before cancelling.");
      const acceptance = await readCustodyAcceptance(tx, command.acceptanceId);
      if (acceptance.observationId !== row.id || acceptance.status !== "awaiting_receipt") throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACCEPTANCE_STALE", "This acceptance no longer awaits receiving.");
      await receiving.cancelQuarantineAcceptanceInTransaction(tx, { ...acceptance, acceptanceId: acceptance.id }, input.actorId, input.at);
      acceptanceId = acceptance.id;
      await recordCustodyDisposition(tx, row, { ...base, kind: "cancel_acceptance", quantity: acceptance.observationQty, acceptanceId,
        reason: command.reason, evidenceReference: null, requestEvidence: command });
    }
  }
  const observation = await projectCustodyObservation(tx, await readCustodyObservation(tx, observationId), actor);
  return receivingQuarantineCommandResultSchema.parse({ observation, acceptance: acceptanceId === null ? null
    : observation.acceptances.find(acceptance => acceptance.id === acceptanceId) });
}

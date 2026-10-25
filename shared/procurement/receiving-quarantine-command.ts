import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  receivingQuarantineIntakeSchema, prepareQuarantineAcceptanceSchema, returnQuarantineCustodySchema,
  cancelQuarantineAcceptanceSchema, receivingQuarantineCommandResultSchema,
} from "./receiving-quarantine";

const id = z.number().int().positive().max(2_147_483_647);
export const custodyActionSchema = z.enum(["intake", "prepare-acceptance", "return", "cancel-acceptance"]);
export type CustodyAction = z.infer<typeof custodyActionSchema>;
export const custodyRequestSchemas = { intake: receivingQuarantineIntakeSchema,
  "prepare-acceptance": prepareQuarantineAcceptanceSchema, return: returnQuarantineCustodySchema,
  "cancel-acceptance": cancelQuarantineAcceptanceSchema } as const;
export const custodyCommandIdentitySchema = z.object({ command: custodyActionSchema, resourceId: id,
  actorId: z.string().trim().min(1).max(100), idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/),
}).strict();
export type CustodyCommandIdentity = z.infer<typeof custodyCommandIdentitySchema>;
export const verifiedCustodyResultSchema = receivingQuarantineCommandResultSchema.extend({
  ...custodyCommandIdentitySchema.shape, request: z.unknown(),
}).strict();
export type VerifiedCustodyResult = z.infer<typeof verifiedCustodyResultSchema>;

/** The response must prove both the exact request and its recorded custody effect.
 * A syntactically valid observation from another action is never recovery proof. */
export function verifyCustodyCommandResult(raw: unknown, identity: CustodyCommandIdentity, request: unknown): VerifiedCustodyResult {
  const result = verifiedCustodyResultSchema.parse(raw);
  const input = custodyRequestSchemas[identity.command].parse(request);
  const recorded = custodyRequestSchemas[identity.command].parse(result.request);
  if (Object.entries(identity).some(([key, value]) => result[key as keyof CustodyCommandIdentity] !== value)
    || canonicalJson(input) !== canonicalJson(recorded)) throw new Error("Quarantine result identity does not match the saved request.");
  const observation = result.observation;
  if (observation.physicalHeldQty !== observation.observedQty - observation.receivedQty - observation.returnedQty
    || observation.unallocatedQty !== observation.physicalHeldQty - observation.awaitingReceiptQty) throw new Error("Quarantine custody quantities do not reconcile.");
  if (identity.command === "intake") {
    const intake = receivingQuarantineIntakeSchema.parse(input);
    if (observation.receivingOrderId !== identity.resourceId || observation.actorId !== identity.actorId
      || observation.holdingLocationId !== intake.holdingLocationId || observation.condition !== intake.condition
      || observation.reason !== intake.reason || observation.evidenceReference !== intake.evidenceReference
      || observation.version !== 0 || result.acceptance !== null || observation.awaitingReceiptQty !== 0 || observation.receivedQty !== 0
      || observation.returnedQty !== 0 || observation.acceptances.length !== 0 || observation.dispositions.length !== 0) throw new Error("Quarantine intake evidence does not match the request.");
    if (intake.kind === "receipt_line") {
      if (observation.receivingLineId !== intake.receivingLineId || observation.observedQty !== intake.heldQty || observation.productId === null || observation.productVariantId === null || observation.unitsPerVariant === null) throw new Error("Quarantine held quantity or source does not match.");
    } else if (observation.receivingLineId !== null || observation.productId !== null || observation.observedQty !== intake.quantity
      || observation.description !== intake.description || observation.observedSku !== intake.observedSku || observation.unitLabel !== intake.unitLabel) {
      throw new Error("Quarantine unidentified intake does not match.");
    }
  } else {
    const resolution = input as z.infer<typeof prepareQuarantineAcceptanceSchema> | z.infer<typeof returnQuarantineCustodySchema> | z.infer<typeof cancelQuarantineAcceptanceSchema>;
    if (observation.id !== identity.resourceId || observation.version !== resolution.expectedVersion + 1) throw new Error("Quarantine resolution version does not match.");
    const kind = identity.command === "prepare-acceptance" ? "prepare_acceptance" : identity.command === "cancel-acceptance" ? "cancel_acceptance" : "return";
    const disposition = observation.dispositions.at(-1);
    if (!disposition || disposition.kind !== kind || disposition.actorId !== identity.actorId || disposition.reason !== resolution.reason) throw new Error("Quarantine disposition does not match.");
    if (identity.command === "return") {
      const value = returnQuarantineCustodySchema.parse(input);
      if (result.acceptance !== null || disposition.acceptanceId !== null || disposition.observationQty !== value.observationQty || disposition.evidenceReference !== value.evidenceReference) throw new Error("Quarantine return evidence does not match.");
    } else {
      const acceptance = result.acceptance;
      if (!acceptance || disposition.acceptanceId !== acceptance.id || disposition.observationQty !== acceptance.observationQty
        || !observation.acceptances.some(item => canonicalJson(item) === canonicalJson(acceptance))) throw new Error("Quarantine acceptance evidence is incomplete.");
      if (identity.command === "prepare-acceptance") {
        const value = prepareQuarantineAcceptanceSchema.parse(input);
        if (acceptance.status !== "awaiting_receipt" || acceptance.observationQty !== value.observationQty
          || acceptance.productVariantId !== value.productVariantId || acceptance.unitsPerVariant !== value.expectedUnitsPerVariant
          || acceptance.acceptedVariantQty !== value.acceptedVariantQty || value.targetReceivingOrderId !== null && acceptance.receivingOrderId !== value.targetReceivingOrderId) throw new Error("Prepared quarantine units or destination do not match.");
      } else if (acceptance.id !== cancelQuarantineAcceptanceSchema.parse(input).acceptanceId || acceptance.status !== "cancelled") throw new Error("Cancelled quarantine acceptance does not match.");
    }
  }
  return result;
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

const MAX_COMMERCIAL_SOURCES = 500;
const MAX_EFFECT_HISTORY = 102_000; // Matches the bounded allocation planner history.
const positiveId = z.number().int().positive().max(2_147_483_647);
const bigintId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const desiredIntent = z
  .object({
    intentKey: z.string().min(1).max(600),
    payloadHash: hash,
    effectType: z.literal("commercial_fulfillment"),
    subjectKey: z.string().min(1).max(600),
    wmsShipmentItemId: positiveId,
    packageKey: z.null(),
    quantity: positiveId,
    executable: z.literal(false),
  })
  .strict();
const inheritedRow = z
  .object({
    intentId: bigintId,
    originPlanId: bigintId,
    originPlanVersion: positiveId,
    intentKey: z.string().min(1),
    payloadHash: hash,
    payload: z.unknown(),
    executable: z.literal(false),
    sourceLineId: bigintId,
    sourceWmsShipmentItemId: positiveId,
    sourceQuantity: positiveId,
    quantity: positiveId,
  })
  .strict();
export type InheritedCommercialIntent = z.output<typeof inheritedRow>;

/** A no-op may retain exactly the already-issued commercial effects, not grant new quantity.
 * The repository separately proves those exact effects were fully materialized and activated. */
export function validateInheritedCommercialIntents(
  snapshot: unknown,
  currentVersion: number,
  rows: unknown,
): readonly InheritedCommercialIntent[] {
  positiveId.min(2).parse(currentVersion);
  const state = z
    .object({
      desiredEffectIntents: z.array(z.unknown()).max(MAX_EFFECT_HISTORY),
      effectIntentEvidence: z
        .array(z.object({ intentKey: z.string(), payloadHash: hash }).strict())
        .max(MAX_EFFECT_HISTORY),
      sourceLines: z
        .array(
          z
            .object({
              wmsShipmentItemId: positiveId,
              sourceQuantity: positiveId,
            })
            .passthrough(),
        )
        .max(MAX_COMMERCIAL_SOURCES),
    })
    .passthrough()
    .parse(snapshot);
  const desired = state.desiredEffectIntents.flatMap((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("effectType" in value) ||
      value.effectType !== "commercial_fulfillment"
    ) {
      return [];
    }
    return [desiredIntent.parse(value)];
  });
  const persisted = z
    .array(inheritedRow)
    .min(1)
    .max(MAX_COMMERCIAL_SOURCES)
    .parse(rows);
  const desiredByKey = new Map(
    desired.map((intent) => [intent.intentKey, intent]),
  );
  const evidenceByKey = new Map(
    state.effectIntentEvidence.map((evidence) => [
      evidence.intentKey,
      evidence.payloadHash,
    ]),
  );
  const sources = new Map(
    state.sourceLines.map((source) => [
      source.wmsShipmentItemId,
      source.sourceQuantity,
    ]),
  );
  if (
    desired.length !== persisted.length ||
    desiredByKey.size !== desired.length ||
    evidenceByKey.size !== state.effectIntentEvidence.length ||
    sources.size !== state.sourceLines.length ||
    new Set(persisted.map((intent) => intent.intentKey)).size !==
      persisted.length ||
    new Set(persisted.map((intent) => intent.sourceWmsShipmentItemId)).size !==
      persisted.length
  ) {
    throw new Error(
      "Current commercial authority is not one exact inherited source/effect set",
    );
  }
  for (const intent of persisted) {
    const current = desiredByKey.get(intent.intentKey);
    if (!current) {
      throw new Error(
        "The current plan removed or replaced an inherited commercial effect",
      );
    }
    const payload = {
      effectType: current.effectType,
      subjectKey: current.subjectKey,
      wmsShipmentItemId: current.wmsShipmentItemId,
      packageKey: current.packageKey,
      quantity: current.quantity,
    };
    const payloadHash = createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex");
    if (
      intent.originPlanVersion >= currentVersion ||
      current.wmsShipmentItemId !== intent.sourceWmsShipmentItemId ||
      current.quantity !== intent.quantity ||
      intent.quantity > intent.sourceQuantity ||
      sources.get(intent.sourceWmsShipmentItemId) !== intent.sourceQuantity ||
      current.payloadHash !== payloadHash ||
      intent.payloadHash !== payloadHash ||
      evidenceByKey.get(intent.intentKey) !== payloadHash ||
      canonicalJson(intent.payload) !== canonicalJson(payload)
    ) {
      throw new Error(
        "Inherited commercial effect identity, quantity, or immutable payload differs from the current plan",
      );
    }
  }
  return Object.freeze(persisted.map((intent) => Object.freeze(intent)));
}

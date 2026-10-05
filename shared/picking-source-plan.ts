import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const locationSchema = z.object({
  id,
  code: z.string().min(1),
  warehouseId: id.nullable(),
  isPickable: z.number().int(),
  isActive: z.number().int(),
  cycleCountFreezeId: id.nullable(),
  locationType: z.string(),
});
const levelSchema = z.object({
  warehouseLocationId: id,
  variantQty: z.number().int().nonnegative().max(2_147_483_647),
});
export const pickingSourcePlanSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      productVariantId: id,
      warehouseLocationId: id,
      warehouseId: id.nullable(),
      locationCode: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("confirmation_only") }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      reason: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
]);
export type PickingSourcePlan = z.infer<typeof pickingSourcePlanSchema>;

export class PickingSourcePlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: {
      locationId: number | null;
      locationCode: string | null;
      systemQty: number;
    } | null = null,
  ) {
    super(message);
    this.name = "PickingSourcePlanError";
  }
}

/** Resolve a physical assignment once. Availability authority still owns stock/claim admission. */
export function selectPickingSource(input: {
  assignedCode: string | null;
  warehouseId: number | null;
  explicitLocationId?: number;
  quantity: number;
  locations: readonly z.input<typeof locationSchema>[];
  levels: readonly z.input<typeof levelSchema>[];
}): z.infer<typeof locationSchema> {
  const quantity = id.parse(input.quantity);
  const warehouseId = id.nullable().parse(input.warehouseId);
  const locations = z.array(locationSchema).parse(input.locations);
  const levels = z.array(levelSchema).parse(input.levels);
  if (
    new Set(locations.map((location) => location.id)).size !== locations.length
  ) {
    throw new PickingSourcePlanError(
      "pick_location_duplicate",
      "Duplicate location identity in picking source data",
    );
  }
  if (
    new Set(levels.map((level) => level.warehouseLocationId)).size !==
    levels.length
  ) {
    throw new PickingSourcePlanError(
      "pick_level_duplicate",
      "Duplicate inventory level identity in picking source data",
    );
  }
  const eligible = (location: z.infer<typeof locationSchema>) =>
    location.isPickable === 1 &&
    location.isActive === 1 &&
    location.cycleCountFreezeId === null &&
    (warehouseId === null ||
      location.warehouseId === warehouseId ||
      location.warehouseId === null);
  const code = input.assignedCode?.trim().toUpperCase();
  let location: z.infer<typeof locationSchema> | undefined;
  if (input.explicitLocationId !== undefined) {
    location = locations.find(
      (candidate) => candidate.id === id.parse(input.explicitLocationId),
    );
    if (
      code &&
      !["U", "UNASSIGNED"].includes(code) &&
      location?.code.trim().toUpperCase() !== code
    ) {
      throw new PickingSourcePlanError(
        "pick_assignment_changed",
        "The requested source differs from the order assignment. Refresh or confirm the bin first.",
      );
    }
  } else if (code && !["U", "UNASSIGNED"].includes(code)) {
    const matches = locations.filter(
      (candidate) =>
        candidate.code.trim().toUpperCase() === code && eligible(candidate),
    );
    const exact =
      warehouseId === null
        ? matches
        : matches.filter((candidate) => candidate.warehouseId === warehouseId);
    const candidates = exact.length > 0 ? exact : matches;
    if (candidates.length > 1)
      throw new PickingSourcePlanError(
        "pick_location_ambiguous",
        `Bin ${code} needs an exact warehouse/location assignment`,
      );
    location = candidates[0];
  } else {
    const priority = (type: string) =>
      type === "pick" ? 0 : type === "pallet" ? 1 : 2;
    location = locations
      .filter(eligible)
      .filter((candidate) =>
        levels.some(
          (level) =>
            level.warehouseLocationId === candidate.id &&
            level.variantQty >= quantity,
        ),
      )
      .sort(
        (left, right) =>
          priority(left.locationType) - priority(right.locationType) ||
          left.id - right.id,
      )[0];
  }
  if (!location || !eligible(location)) {
    if (!code || ["U", "UNASSIGNED"].includes(code)) {
      const available = locations
        .filter(eligible)
        .map((candidate) => ({
          location: candidate,
          quantity:
            levels.find((level) => level.warehouseLocationId === candidate.id)
              ?.variantQty ?? 0,
        }))
        .filter((candidate) => candidate.quantity > 0)
        .sort(
          (left, right) =>
            right.quantity - left.quantity ||
            left.location.id - right.location.id,
        )[0];
      throw new PickingSourcePlanError(
        "pick_location_unavailable",
        available
          ? `This item has no assigned pick bin and no single pickable bin holds ${quantity}. Best available bin is ${available.location.code} with ${available.quantity}. Confirm the bin before recording work.`
          : "No pickable location has any stock",
        {
          locationId: available?.location.id ?? null,
          locationCode: available?.location.code ?? null,
          systemQty: available?.quantity ?? 0,
        },
      );
    }
    throw new PickingSourcePlanError(
      "pick_location_unavailable",
      "No active, unfrozen pickable source is available for this assignment",
    );
  }
  return location;
}

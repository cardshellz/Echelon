import { z } from "zod";

const snapshotSchema = z
  .object({
    channelId: z.number().int().positive().optional(),
    warehouseId: z.number().int().positive().optional(),
    requirement: z.enum(["any", "unbranded"]).optional(),
    boxes: z.array(z.object({ id: z.number().int().positive() })),
  })
  .refine(
    (value) =>
      value.channelId === undefined ||
      (value.warehouseId !== undefined && value.requirement !== undefined),
    "A channel-scoped snapshot requires its warehouse and branding requirement.",
  );

/** Old plans may be confirmed as planned, but cannot authorize a new box from
 * the entire catalog. Regenerating the plan supplies explicit suite evidence. */
export function packingPermission(
  snapshot: unknown,
  plannedBoxId: number | null,
  actualBoxId: number | null,
) {
  const parsed = snapshotSchema.safeParse(snapshot);
  const selectedBoxId = actualBoxId ?? plannedBoxId;
  if (!parsed.success)
    return {
      allowed: snapshot == null && selectedBoxId === plannedBoxId,
      canonical: false,
      channelId: null,
      warehouseId: null,
      requirement: "any" as const,
    };
  return {
    allowed:
      selectedBoxId === null
        ? parsed.data.requirement !== "unbranded"
        : parsed.data.boxes.some((b) => b.id === selectedBoxId),
    canonical: parsed.data.channelId !== undefined,
    channelId: parsed.data.channelId ?? null,
    warehouseId: parsed.data.warehouseId ?? null,
    requirement: parsed.data.requirement ?? "any",
  };
}

export function permittedPlanBoxIds(
  snapshot: unknown,
  plannedBoxIds: readonly (number | null)[],
): number[] {
  const parsed = snapshotSchema.safeParse(snapshot);
  return parsed.success
    ? [...new Set(parsed.data.boxes.map((b) => b.id))]
    : snapshot == null
      ? [...new Set(plannedBoxIds.filter((id): id is number => id !== null))]
      : [];
}

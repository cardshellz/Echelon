import {
  shippingPackPlanParcels,
  shippingPackPlans,
  type ShippingPackPlanParcel,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

export async function confirmPackPlanParcelInTx(
  tx: { update: (...args: any[]) => any },
  input: {
    planId: number;
    parcelId: number;
    actualBoxId: number | null;
    actualWeightGrams: number | null;
    packedAt: Date;
    packedBy: string | null;
  },
): Promise<ShippingPackPlanParcel | undefined> {
  const [parcel] = await tx
    .update(shippingPackPlanParcels)
    .set({
      actualBoxId: input.actualBoxId,
      actualWeightGrams: input.actualWeightGrams,
      packedAt: input.packedAt,
      packedBy: input.packedBy,
    })
    .where(
      and(
        eq(shippingPackPlanParcels.id, input.parcelId),
        eq(shippingPackPlanParcels.packPlanId, input.planId),
      ),
    )
    .returning();
  return parcel;
}

export async function markPackPlanPackedInTx(
  tx: { update: (...args: any[]) => any },
  planId: number,
  now: Date,
): Promise<void> {
  await tx
    .update(shippingPackPlans)
    .set({ status: "packed", updatedAt: now })
    .where(
      and(
        eq(shippingPackPlans.id, planId),
        eq(shippingPackPlans.status, "active"),
      ),
    );
}

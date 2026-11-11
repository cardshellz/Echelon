import { eq } from "drizzle-orm";
import {
  productVariants,
  shippingServiceLevels,
  shippingVariantAttrs,
} from "@shared/schema";
import { db } from "../../../db";
import { confirmProductVariantShipsInOwnContainer } from "../../catalog/variant-shipping-flags.api";

export interface UpsertShippingVariantAttrsInput {
  productVariantId: number;
  riderEligible?: boolean;
  riderVoidCm3?: number | null;
  riderVoidMaxWeightGrams?: number | null;
  riderVoidMaxItems?: number | null;
  notes?: string | null;
}

export interface UpdateShippingServiceLevelPatch {
  displayName?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  promiseMinBusinessDays?: number | null;
  promiseMaxBusinessDays?: number | null;
}

export async function upsertShippingVariantAttrs(
  input: UpsertShippingVariantAttrsInput,
  database: typeof db = db,
) {
  const variant = await database
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.id, input.productVariantId))
    .limit(1);
  if (variant.length === 0) {
    return null;
  }

  const [attrs] = await database
    .insert(shippingVariantAttrs)
    .values({ ...input, siocSuggested: false })
    .onConflictDoUpdate({
      target: shippingVariantAttrs.productVariantId,
      // A manual save resolves any pending suggestion.
      set: {
        ...input,
        siocSuggested: false,
        updatedAt: new Date(),
      },
    })
    .returning();
  return attrs;
}

export async function recordShippingVariantSiocDecision(
  input: { productVariantId: number; confirmed: boolean },
  database: typeof db = db,
): Promise<{ productVariantId: number; confirmed: boolean } | null> {
  const { productVariantId, confirmed } = input;
  return database.transaction(async (tx) => {
    const variant = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);
    if (variant.length === 0) return null;

    if (confirmed) {
      await confirmProductVariantShipsInOwnContainer(productVariantId, tx);
    }

    // Either way the suggestion is resolved for this variant.
    await tx
      .insert(shippingVariantAttrs)
      .values({ productVariantId, siocSuggested: false })
      .onConflictDoUpdate({
        target: shippingVariantAttrs.productVariantId,
        set: { siocSuggested: false, updatedAt: new Date() },
      });
    return { productVariantId, confirmed };
  });
}

export async function updateShippingServiceLevelRow(
  id: number,
  patch: UpdateShippingServiceLevelPatch,
  database: typeof db = db,
) {
  const updated = await database
    .update(shippingServiceLevels)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(shippingServiceLevels.id, id))
    .returning();
  return updated[0] ?? null;
}

import { and, eq, isNull, or } from "drizzle-orm";
import {
  shippingRateBookAssignments,
  shippingRateBooks,
  shippingZoneSets,
} from "@shared/schema";
import { db } from "../../../db";
import type { ShippingRateContext } from "../domain/shipping-channel";
import type { RateBookAssignmentCandidate } from "../domain/rate-book";

export async function loadActiveRateBookAssignments(
  context: ShippingRateContext,
  originWarehouseId: number,
): Promise<RateBookAssignmentCandidate[]> {
  const rows = await db
    .select({
      assignmentId: shippingRateBookAssignments.id,
      rateBookId: shippingRateBooks.id,
      rateBookCode: shippingRateBooks.code,
      zoneSetId: shippingRateBooks.zoneSetId,
      pricingChannel: shippingRateBookAssignments.pricingChannel,
      purpose: shippingRateBookAssignments.ratePurpose,
      originWarehouseId: shippingRateBookAssignments.originWarehouseId,
    })
    .from(shippingRateBookAssignments)
    .innerJoin(shippingRateBooks, eq(shippingRateBooks.id, shippingRateBookAssignments.rateBookId))
    .innerJoin(shippingZoneSets, eq(shippingZoneSets.id, shippingRateBooks.zoneSetId))
    .where(and(
      eq(shippingRateBookAssignments.isActive, true),
      eq(shippingRateBooks.status, "active"),
      eq(shippingZoneSets.status, "active"),
      eq(shippingRateBookAssignments.pricingChannel, context.pricingChannel),
      eq(shippingRateBookAssignments.ratePurpose, context.purpose),
      or(
        isNull(shippingRateBookAssignments.originWarehouseId),
        eq(shippingRateBookAssignments.originWarehouseId, originWarehouseId),
      ),
    ));

  return rows.map((row) => ({
    ...row,
    pricingChannel: context.pricingChannel,
    purpose: context.purpose,
  }));
}

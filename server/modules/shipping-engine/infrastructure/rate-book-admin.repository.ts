import { and, eq, inArray } from "drizzle-orm";
import {
  shippingRateBookAssignments,
  shippingRateBooks,
  shippingRateTables,
} from "@shared/schema";
import type { db } from "../../../db";

type RateBookTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RateBookAssignmentWriteInput {
  pricingChannel: string;
  ratePurpose: string;
  originWarehouseId: number | null;
}

export async function insertRateBookRecordInTx(
  tx: RateBookTx,
  values: typeof shippingRateBooks.$inferInsert,
) {
  const [book] = await tx.insert(shippingRateBooks).values(values).returning();
  return book;
}

export async function insertRateBookAssignmentsInTx(
  tx: RateBookTx,
  rateBookId: number,
  assignments: readonly RateBookAssignmentWriteInput[],
): Promise<void> {
  if (assignments.length === 0) return;
  await tx.insert(shippingRateBookAssignments).values(
    assignments.map((assignment) => ({
      rateBookId,
      pricingChannel: assignment.pricingChannel,
      ratePurpose: assignment.ratePurpose,
      originWarehouseId: assignment.originWarehouseId,
      isActive: true,
    })),
  );
}

export async function replaceRateBookAssignmentsInTx(
  tx: RateBookTx,
  rateBookId: number,
  assignments: readonly RateBookAssignmentWriteInput[],
): Promise<void> {
  await tx
    .delete(shippingRateBookAssignments)
    .where(eq(shippingRateBookAssignments.rateBookId, rateBookId));
  await insertRateBookAssignmentsInTx(tx, rateBookId, assignments);
}

export async function updateRateBookRecordIfStatusInTx(
  tx: RateBookTx,
  id: number,
  expectedStatus: string,
  values: Partial<typeof shippingRateBooks.$inferInsert>,
) {
  const [book] = await tx
    .update(shippingRateBooks)
    .set(values)
    .where(and(eq(shippingRateBooks.id, id), eq(shippingRateBooks.status, expectedStatus)))
    .returning();
  return book ?? null;
}

export async function deactivateRateBookChildrenOnRetireInTx(
  tx: RateBookTx,
  rateBookId: number,
  now: Date,
): Promise<void> {
  await tx
    .update(shippingRateBookAssignments)
    .set({ isActive: false, updatedAt: now })
    .where(eq(shippingRateBookAssignments.rateBookId, rateBookId));
  await tx
    .update(shippingRateTables)
    .set({ status: "retired", effectiveTo: now })
    .where(
      and(
        eq(shippingRateTables.rateBookId, rateBookId),
        inArray(shippingRateTables.status, ["active", "superseded"]),
      ),
    );
}

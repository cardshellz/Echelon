import { and, eq, inArray, ne } from "drizzle-orm";
import {
  shippingRateTableRows,
  shippingRateTables,
} from "@shared/schema";
import type { db } from "../../../db";
import type { RateTableImportRow } from "../domain/rate-table-import";

type RateTableTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const INSERT_CHUNK_SIZE = 1000;

export async function insertRateTableRecordInTx(
  tx: RateTableTx,
  values: typeof shippingRateTables.$inferInsert,
) {
  const [table] = await tx.insert(shippingRateTables).values(values).returning();
  return table;
}

export async function updateRateTableMetadataInTx(
  tx: RateTableTx,
  id: number,
  metadata: Record<string, unknown>,
) {
  const [savedTable] = await tx
    .update(shippingRateTables)
    .set({ metadata })
    .where(eq(shippingRateTables.id, id))
    .returning();
  return savedTable;
}

export async function updateDraftRateTableHeaderInTx(
  tx: RateTableTx,
  id: number,
  values: Partial<typeof shippingRateTables.$inferInsert>,
) {
  const [updated] = await tx
    .update(shippingRateTables)
    .set(values)
    .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
    .returning();
  return updated ?? null;
}

export async function deleteAllRateTableRowsInTx(
  tx: RateTableTx,
  rateTableId: number,
): Promise<void> {
  await tx
    .delete(shippingRateTableRows)
    .where(eq(shippingRateTableRows.rateTableId, rateTableId));
}

export async function insertRateTableRowsChunkedInTx(
  tx: RateTableTx,
  rateTableId: number,
  rows: readonly RateTableImportRow[],
): Promise<void> {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    await tx.insert(shippingRateTableRows).values(
      rows.slice(index, index + INSERT_CHUNK_SIZE).map((row) => ({
        rateTableId,
        originWarehouseId: row.originWarehouseId,
        destinationCountry: row.destinationCountry,
        destinationRegion: row.destinationRegion,
        postalPrefix: row.postalPrefix,
        minMeasure: row.minMeasure,
        maxMeasure: row.maxMeasure,
        maxShipmentWeightGrams: row.maxShipmentWeightGrams,
        chargeModel: row.chargeModel,
        rateCents: row.rateCents,
        perStartedPoundCents: row.perStartedPoundCents,
      })),
    );
  }
}

export async function insertSingleRateTableRowInTx(
  tx: RateTableTx,
  values: typeof shippingRateTableRows.$inferInsert,
) {
  return tx.insert(shippingRateTableRows).values(values).returning();
}

export async function updateSingleRateTableRowInTx(
  tx: RateTableTx,
  rateTableId: number,
  rowId: number,
  values: Partial<typeof shippingRateTableRows.$inferInsert>,
) {
  const [result] = await tx
    .update(shippingRateTableRows)
    .set(values)
    .where(
      and(
        eq(shippingRateTableRows.id, rowId),
        eq(shippingRateTableRows.rateTableId, rateTableId),
      ),
    )
    .returning();
  return result ?? null;
}

export async function deleteSingleRateTableRowInTx(
  tx: RateTableTx,
  rateTableId: number,
  rowId: number,
) {
  const [result] = await tx
    .delete(shippingRateTableRows)
    .where(
      and(
        eq(shippingRateTableRows.id, rowId),
        eq(shippingRateTableRows.rateTableId, rateTableId),
      ),
    )
    .returning({ id: shippingRateTableRows.id });
  return result ?? null;
}

export async function activateDraftRateTableAndSupersedePriorInTx(
  tx: RateTableTx,
  id: number,
  rateBookId: number,
  now: Date,
) {
  const [target] = await tx
    .update(shippingRateTables)
    .set({ status: "active", effectiveFrom: now, effectiveTo: null })
    .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
    .returning();
  if (!target) return null;

  await tx
    .update(shippingRateTables)
    .set({ status: "superseded", effectiveTo: now })
    .where(
      and(
        eq(shippingRateTables.rateBookId, rateBookId),
        eq(shippingRateTables.serviceLevelId, target.serviceLevelId),
        eq(shippingRateTables.status, "active"),
        ne(shippingRateTables.id, target.id),
      ),
    );
  return target;
}

export async function retireRateTableRecordInTx(
  tx: RateTableTx,
  id: number,
  now: Date,
) {
  const [updated] = await tx
    .update(shippingRateTables)
    .set({ status: "retired", effectiveTo: now })
    .where(
      and(
        eq(shippingRateTables.id, id),
        inArray(shippingRateTables.status, ["active", "superseded"]),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function deleteDraftRateTableRecordInTx(
  tx: RateTableTx,
  id: number,
) {
  const [deleted] = await tx
    .delete(shippingRateTables)
    .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
    .returning({ id: shippingRateTables.id });
  return deleted ?? null;
}

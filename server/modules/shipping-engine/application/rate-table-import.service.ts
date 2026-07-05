/**
 * Rate-table import — application layer, shared by BOTH producers of
 * shipping.rate_tables / rate_table_rows:
 *
 *   1. The admin CSV import route (interfaces/http/rate-table-admin.routes.ts).
 *   2. The ShipStation-v2 calibration job (application/rate-calibration.service.ts).
 *
 * Extracted from the import route so both writers share ONE validation +
 * transactional write path (band-overlap rejection, unknown-zone warnings,
 * supersede-then-insert). Design: docs/SHIPPING-ENGINE-DESIGN.md ("Rates
 * Engine").
 *
 * Contract: data problems (overlapping bands) come back as { ok: false } —
 * this never throws for bad rows. Infrastructure failures (DB down) reject.
 */

import { and, eq } from "drizzle-orm";
import { shippingRateTableRows, shippingRateTables, shippingZoneRules } from "@shared/schema";
import { db } from "../../../db";
import {
  findBandOverlaps,
  findUnknownZones,
  type RateTableImportRow,
} from "../domain/rate-table-import";

/** Keep multi-row inserts comfortably below the postgres bind-param limit. */
const INSERT_CHUNK_SIZE = 1000;

export interface RateTableImportInput {
  carrier: string;
  serviceCode: string;
  /** ISO-4217; stored uppercased. */
  currency: string;
  /** Defaults to the injected clock's now. */
  effectiveFrom?: Date;
  /**
   * ON supersedes the prior active table for the same carrier+service so the
   * rate-quote join never sees two active tables for one combo.
   */
  replaceExisting: boolean;
  rows: RateTableImportRow[];
  /**
   * Provenance stored on shipping.rate_tables.metadata. Defaults to the
   * admin-import shape ({ source: "admin-import", importedAt, rowCount }) so
   * the CSV route's behavior is unchanged; the calibration job passes its own.
   */
  metadata?: Record<string, unknown>;
}

export type RateTableImportOutcome =
  | { ok: false; bandErrors: string[] }
  | {
      ok: true;
      rateTable: typeof shippingRateTables.$inferSelect;
      rowCount: number;
      warnings: string[];
    };

export interface RateTableImportServiceOptions {
  /** Injected clock (supersede timestamp + effectiveFrom default). */
  clock?: () => Date;
}

/**
 * Validate then transactionally write one rate table (+rows). All validation
 * happens BEFORE any write; the supersede + insert are one transaction.
 */
export async function importRateTable(
  input: RateTableImportInput,
  opts: RateTableImportServiceOptions = {},
): Promise<RateTableImportOutcome> {
  const { carrier, serviceCode, replaceExisting, rows } = input;
  const currency = input.currency.toUpperCase();

  // All validation BEFORE any write.
  const bandErrors = findBandOverlaps(rows);
  if (bandErrors.length > 0) {
    return { ok: false, bandErrors };
  }
  const knownZones = await db
    .selectDistinct({ zone: shippingZoneRules.zone })
    .from(shippingZoneRules)
    .where(eq(shippingZoneRules.isActive, true));
  const warnings = findUnknownZones(rows, knownZones.map((z) => z.zone));

  const now = (opts.clock ?? (() => new Date()))();
  const effectiveFrom = input.effectiveFrom ?? now;
  const metadata = input.metadata
    ?? { source: "admin-import", importedAt: now.toISOString(), rowCount: rows.length };

  const rateTable = await db.transaction(async (tx) => {
    if (replaceExisting) {
      await tx.update(shippingRateTables)
        .set({ status: "superseded", effectiveTo: now })
        .where(and(
          eq(shippingRateTables.carrier, carrier),
          eq(shippingRateTables.serviceCode, serviceCode),
          eq(shippingRateTables.status, "active"),
        ));
    }
    const [table] = await tx.insert(shippingRateTables).values({
      carrier,
      serviceCode,
      currency,
      status: "active",
      effectiveFrom,
      metadata,
    }).returning();

    for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
      await tx.insert(shippingRateTableRows).values(
        rows.slice(i, i + INSERT_CHUNK_SIZE).map((row) => ({ ...row, rateTableId: table.id })),
      );
    }
    return table;
  });

  return { ok: true, rateTable, rowCount: rows.length, warnings };
}

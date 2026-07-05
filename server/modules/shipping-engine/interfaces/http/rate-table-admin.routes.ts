/**
 * Rate-table import admin — interface layer.
 *
 * GET  /api/shipping/admin/rate-tables            list tables + row/zone coverage
 * POST /api/shipping/admin/rate-tables/parse-csv  preview a CSV (no writes)
 * POST /api/shipping/admin/rate-tables/import     create a table + rows (transactional)
 *
 * Feeds shipping.rate_tables / rate_table_rows for two producers: the hand
 * transcription of Parcelify's grid (CSV via the admin UI) and the
 * ShipStation-v2 calibration job. Separate file from shipping-admin.routes.ts
 * (same pattern as shadow-admin.routes.ts) so this PR does not touch the
 * config-CRUD surface. Parsing/validation live in domain/rate-table-import.ts
 * as pure functions; the transactional write is the shared
 * application/rate-table-import.service.ts (also used by the calibration job).
 * Design: docs/SHIPPING-ENGINE-DESIGN.md ("Rates Engine").
 */

import type { Express, Response } from "express";
import { desc, sql } from "drizzle-orm";
import { z } from "zod";
import { shippingRateTableRows, shippingRateTables } from "@shared/schema";
import { db } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import { importRateTable } from "../../application/rate-table-import.service";
import {
  MAX_IMPORT_ROWS,
  findBandOverlaps,
  parseRateTableCsv,
  type RateTableImportRow,
} from "../../domain/rate-table-import";

const importRowSchema = z.object({
  originWarehouseId: z.number().int().positive().nullable().optional(),
  destinationZone: z.string().trim().min(1).max(40),
  minWeightGrams: z.number().int().min(0),
  maxWeightGrams: z.number().int().min(0),
  rateCents: z.number().int().min(0),
});

const importSchema = z.object({
  carrier: z.string().trim().min(1).max(50),
  serviceCode: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).default("USD"),
  effectiveFrom: z.coerce.date().optional(),
  // ON supersedes the prior active table for the same carrier+service so the
  // rate-quote join never sees two active tables for one combo.
  replaceExisting: z.boolean().default(false),
  rows: z.array(importRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

const parseCsvSchema = z.object({
  // ~5000 rows of the widest dialect stays far under this; the cap just bounds
  // pathological payloads before we split lines.
  csv: z.string().min(1).max(2_000_000),
});

export function registerRateTableAdminRoutes(app: Express): void {
  app.get(
    "/api/shipping/admin/rate-tables",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        const [tables, coverage] = await Promise.all([
          db.select().from(shippingRateTables)
            .orderBy(desc(shippingRateTables.effectiveFrom), desc(shippingRateTables.id)),
          db.select({
            rateTableId: shippingRateTableRows.rateTableId,
            rowCount: sql<number>`count(*)::int`,
            zoneCount: sql<number>`count(distinct ${shippingRateTableRows.destinationZone})::int`,
            minWeightGrams: sql<number>`min(${shippingRateTableRows.minWeightGrams})::int`,
            maxWeightGrams: sql<number>`max(${shippingRateTableRows.maxWeightGrams})::int`,
          })
            .from(shippingRateTableRows)
            .groupBy(shippingRateTableRows.rateTableId),
        ]);

        const coverageByTable = new Map(coverage.map((c) => [c.rateTableId, c]));
        return res.json({
          rateTables: tables.map((table) => {
            const c = coverageByTable.get(table.id);
            return {
              ...table,
              rowCount: c?.rowCount ?? 0,
              zoneCount: c?.zoneCount ?? 0,
              minWeightGrams: c?.minWeightGrams ?? null,
              maxWeightGrams: c?.maxWeightGrams ?? null,
            };
          }),
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "list rate tables");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/parse-csv",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = parseCsvSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const result = parseRateTableCsv(parsed.data.csv);
        // Preview surfaces band overlaps too, so the operator fixes the CSV
        // before hitting the import endpoint (which re-validates regardless).
        const bandErrors = result.errors.length === 0 ? findBandOverlaps(result.rows) : [];
        return res.json({
          dialect: result.dialect,
          rows: result.rows,
          errors: result.errors,
          bandErrors,
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "parse rate table CSV");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/import",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = importSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const rows: RateTableImportRow[] = parsed.data.rows.map((row) => ({
          ...row,
          originWarehouseId: row.originWarehouseId ?? null,
        }));

        const outcome = await importRateTable({
          carrier: parsed.data.carrier,
          serviceCode: parsed.data.serviceCode,
          currency: parsed.data.currency,
          effectiveFrom: parsed.data.effectiveFrom,
          replaceExisting: parsed.data.replaceExisting,
          rows,
        });
        if (!outcome.ok) {
          return res.status(400).json({
            error: { code: "SHIPPING_ADMIN_RATE_BANDS_INVALID", message: "Weight bands overlap.", details: outcome.bandErrors },
          });
        }

        return res.json({ rateTable: outcome.rateTable, rowCount: outcome.rowCount, warnings: outcome.warnings });
      } catch (error) {
        return sendRateTableAdminError(res, error, "import rate table");
      }
    },
  );
}

function sendRateTableAdminError(res: Response, error: unknown, action: string): Response {
  console.error(`[RateTableAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}

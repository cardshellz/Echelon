/**
 * Shipping rate-table administration.
 *
 * Imports always create drafts. A table can affect quotes only after a
 * separate, validated activation action supersedes the prior active version.
 */

import type { Express, Response } from "express";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  shippingRateBookAssignments,
  shippingRateBooks,
  shippingRateTableRows,
  shippingRateTables,
  shippingZoneRules,
  shippingZoneSets,
  warehouses,
} from "@shared/schema";
import { db } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import {
  MAX_IMPORT_ROWS,
  findBandOverlaps,
  findMissingStateDefaults,
  findUnknownZones,
  parseRateTableCsv,
  stateZipPricingAreaKey,
  type RatePricingMode,
  type RateTableImportRow,
} from "../../domain/rate-table-import";
import {
  analyzeRateTable,
  canActivateRateTable,
  canDeleteRateTable,
  canRetireRateTable,
} from "../../domain/rate-table-lifecycle";
import { normalizeUsPostalRegion } from "../../domain/us-geography";

const importRowSchema = z.object({
  originWarehouseId: z.number().int().positive().nullable().optional(),
  destinationZone: z.string().trim().min(1).max(40).optional(),
  destinationRegion: z.string().trim().length(2).nullable().optional(),
  postalPrefix: z.string().trim().max(5).nullable().optional(),
  minWeightGrams: z.number().int().min(0),
  maxWeightGrams: z.number().int().min(0),
  rateCents: z.number().int().min(0),
});

const importSchema = z.object({
  pricingMode: z.enum(["state_zip", "legacy_zone"]).default("state_zip"),
  rateBookCode: z.string().trim().min(1).max(80).default("shopify-retail-default"),
  carrier: z.string().trim().min(1).max(50),
  serviceCode: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).default("USD"),
  effectiveFrom: z.coerce.date().optional(),
  rows: z.array(importRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

const parseCsvSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
});

const tableIdSchema = z.coerce.number().int().positive();
const activateSchema = z.object({ confirmWarnings: z.boolean().default(false) });
const INSERT_CHUNK_SIZE = 1000;

type ImportRowInput = z.infer<typeof importRowSchema>;
type ImportInput = z.infer<typeof importSchema>;

export function registerRateTableAdminRoutes(app: Express): void {
  app.get(
    "/api/shipping/admin/rate-tables",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        const [tables, coverage, books, assignments] = await Promise.all([
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
          db.select({
            id: shippingRateBooks.id,
            code: shippingRateBooks.code,
            name: shippingRateBooks.name,
            status: shippingRateBooks.status,
            zoneSetId: shippingRateBooks.zoneSetId,
            metadata: shippingRateBooks.metadata,
          }).from(shippingRateBooks),
          db.select({
            id: shippingRateBookAssignments.id,
            rateBookId: shippingRateBookAssignments.rateBookId,
            pricingChannel: shippingRateBookAssignments.pricingChannel,
            ratePurpose: shippingRateBookAssignments.ratePurpose,
            originWarehouseId: shippingRateBookAssignments.originWarehouseId,
            originWarehouseName: warehouses.name,
            isActive: shippingRateBookAssignments.isActive,
          })
            .from(shippingRateBookAssignments)
            .leftJoin(warehouses, eq(shippingRateBookAssignments.originWarehouseId, warehouses.id))
            .orderBy(asc(shippingRateBookAssignments.pricingChannel), asc(shippingRateBookAssignments.ratePurpose)),
        ]);

        const assignmentsByBook = groupBy(assignments, (assignment) => assignment.rateBookId);
        const coverageByTable = new Map(coverage.map((item) => [item.rateTableId, item]));
        const hydratedBooks = books.map((book) => ({
          ...book,
          assignments: assignmentsByBook.get(book.id) ?? [],
        }));
        const bookById = new Map(hydratedBooks.map((book) => [book.id, book]));

        return res.json({
          rateBooks: hydratedBooks,
          rateTables: tables.map((table) => {
            const tableCoverage = coverageByTable.get(table.id);
            return {
              ...table,
              rateBook: table.rateBookId ? bookById.get(table.rateBookId) ?? null : null,
              rowCount: tableCoverage?.rowCount ?? 0,
              zoneCount: tableCoverage?.zoneCount ?? 0,
              minWeightGrams: tableCoverage?.minWeightGrams ?? null,
              maxWeightGrams: tableCoverage?.maxWeightGrams ?? null,
            };
          }),
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "list rate tables");
      }
    },
  );

  app.get(
    "/api/shipping/admin/rate-tables/:id",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const detail = await loadRateTableDetail(id);
        if (!detail) {
          throw new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_TABLE_NOT_FOUND", "Rate table not found.");
        }
        return res.json(detail);
      } catch (error) {
        return sendRateTableAdminError(res, error, "load rate table");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/parse-csv",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = parseCsvSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const result = parseRateTableCsv(parsed.data.csv);
        const bandErrors = result.errors.length === 0 ? findBandOverlaps(result.rows) : [];
        const geographyErrors = result.errors.length === 0 && result.pricingMode === "state_zip"
          ? findMissingStateDefaults(result.rows)
          : [];
        return res.json({
          dialect: result.dialect,
          pricingMode: result.pricingMode,
          rows: result.rows,
          errors: result.errors,
          bandErrors,
          geographyErrors,
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
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const prepared = await prepareRateTableImport(parsed.data);
        const now = new Date();

        const rateTable = await db.transaction(async (tx) => {
          await ensureStateZipRules(tx, prepared.rateBook, prepared.rows, prepared.pricingMode);
          const [table] = await tx.insert(shippingRateTables).values({
            rateBookId: prepared.rateBook.id,
            carrier: prepared.carrier,
            serviceCode: prepared.serviceCode,
            currency: prepared.currency,
            status: "draft",
            effectiveFrom: prepared.effectiveFrom ?? now,
            metadata: importMetadata(prepared.pricingMode, prepared.rows.length, now),
          }).returning();
          await insertRateRows(tx, table.id, prepared.rows);
          return table;
        });

        return res.status(201).json({
          rateTable,
          rowCount: prepared.rows.length,
          warnings: prepared.warnings,
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "import rate table draft");
      }
    },
  );

  app.put(
    "/api/shipping/admin/rate-tables/:id",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const parsed = importSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const prepared = await prepareRateTableImport(parsed.data);
        const now = new Date();

        const rateTable = await db.transaction(async (tx) => {
          const [updated] = await tx.update(shippingRateTables)
            .set({
              rateBookId: prepared.rateBook.id,
              carrier: prepared.carrier,
              serviceCode: prepared.serviceCode,
              currency: prepared.currency,
              effectiveFrom: prepared.effectiveFrom ?? now,
              effectiveTo: null,
              metadata: importMetadata(prepared.pricingMode, prepared.rows.length, now),
            })
            .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
            .returning();
          if (!updated) {
            throw new RateTableAdminError(
              409,
              "SHIPPING_ADMIN_DRAFT_REQUIRED",
              "Only a draft rate table can be replaced.",
            );
          }
          await tx.delete(shippingRateTableRows).where(eq(shippingRateTableRows.rateTableId, id));
          await ensureStateZipRules(tx, prepared.rateBook, prepared.rows, prepared.pricingMode);
          await insertRateRows(tx, id, prepared.rows);
          return updated;
        });

        return res.json({
          rateTable,
          rowCount: prepared.rows.length,
          warnings: prepared.warnings,
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "replace rate table draft");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/:id/activate",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const parsed = activateSchema.safeParse(req.body ?? {});
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const detail = await loadRateTableDetail(id);
        if (!detail) {
          throw new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_TABLE_NOT_FOUND", "Rate table not found.");
        }
        if (!canActivateRateTable(detail.rateTable.status)) {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_DRAFT_REQUIRED",
            "Only a draft rate table can be activated.",
          );
        }
        if (!detail.rateBook || detail.rateBook.status !== "active") {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_RATE_BOOK_INACTIVE",
            "The rate book must be active before this table can be activated.",
          );
        }
        const activeRateBook = detail.rateBook;
        if (!detail.analysis.canActivate) {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_ACTIVATION_BLOCKED",
            "Resolve the rate-table validation errors before activation.",
            detail.analysis.errors,
          );
        }
        const warnings = [...detail.analysis.warnings];
        if (!activeRateBook.assignments.some((assignment) => assignment.isActive)) {
          warnings.push("This rate book is not assigned to an active channel and purpose.");
        }
        if (warnings.length > 0 && !parsed.data.confirmWarnings) {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_ACTIVATION_CONFIRMATION_REQUIRED",
            "Review and confirm the activation warnings.",
            warnings,
          );
        }

        const now = new Date();
        const activated = await db.transaction(async (tx) => {
          const [target] = await tx.update(shippingRateTables)
            .set({ status: "active", effectiveFrom: now, effectiveTo: null })
            .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
            .returning();
          if (!target) return null;
          await tx.update(shippingRateTables)
            .set({ status: "superseded", effectiveTo: now })
            .where(and(
              eq(shippingRateTables.rateBookId, activeRateBook.id),
              eq(shippingRateTables.carrier, target.carrier),
              eq(shippingRateTables.serviceCode, target.serviceCode),
              eq(shippingRateTables.status, "active"),
              ne(shippingRateTables.id, target.id),
            ));
          return target;
        });
        if (!activated) {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_DRAFT_REQUIRED",
            "The table is no longer a draft. Refresh and review its current status.",
          );
        }
        return res.json({ rateTable: activated, warnings });
      } catch (error) {
        return sendRateTableAdminError(res, error, "activate rate table");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/:id/retire",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const [current] = await db.select({ status: shippingRateTables.status })
          .from(shippingRateTables)
          .where(eq(shippingRateTables.id, id))
          .limit(1);
        if (!current) {
          throw new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_TABLE_NOT_FOUND", "Rate table not found.");
        }
        if (!canRetireRateTable(current.status)) {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_RATE_TABLE_NOT_RETIRABLE",
            "Only an active or superseded rate table can be retired.",
          );
        }
        const [retired] = await db.update(shippingRateTables)
          .set({ status: "retired", effectiveTo: new Date() })
          .where(and(
            eq(shippingRateTables.id, id),
            inArray(shippingRateTables.status, ["active", "superseded"]),
          ))
          .returning();
        if (!retired) {
          throw new RateTableAdminError(409, "SHIPPING_ADMIN_RATE_TABLE_CHANGED", "Refresh and try again.");
        }
        return res.json({ rateTable: retired });
      } catch (error) {
        return sendRateTableAdminError(res, error, "retire rate table");
      }
    },
  );

  app.delete(
    "/api/shipping/admin/rate-tables/:id",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const [current] = await db.select({ status: shippingRateTables.status })
          .from(shippingRateTables)
          .where(eq(shippingRateTables.id, id))
          .limit(1);
        if (!current) {
          throw new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_TABLE_NOT_FOUND", "Rate table not found.");
        }
        if (!canDeleteRateTable(current.status)) {
          throw new RateTableAdminError(
            409,
            "SHIPPING_ADMIN_DRAFT_REQUIRED",
            "Only a draft rate table can be deleted.",
          );
        }
        const [deleted] = await db.delete(shippingRateTables)
          .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
          .returning({ id: shippingRateTables.id });
        if (!deleted) {
          throw new RateTableAdminError(409, "SHIPPING_ADMIN_RATE_TABLE_CHANGED", "Refresh and try again.");
        }
        return res.status(204).send();
      } catch (error) {
        return sendRateTableAdminError(res, error, "delete rate table draft");
      }
    },
  );
}

async function prepareRateTableImport(input: ImportInput) {
  const rows = normalizeImportRows(input.rows, input.pricingMode);
  if (!rows.ok) {
    throw new RateTableAdminError(400, "SHIPPING_ADMIN_INVALID_GEOGRAPHY", rows.message);
  }
  const bandErrors = findBandOverlaps(rows.rows);
  if (bandErrors.length > 0) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_RATE_BANDS_INVALID",
      "Weight bands overlap.",
      bandErrors,
    );
  }
  const [rateBook] = await db.select({
    id: shippingRateBooks.id,
    code: shippingRateBooks.code,
    status: shippingRateBooks.status,
    zoneSetId: shippingRateBooks.zoneSetId,
  })
    .from(shippingRateBooks)
    .where(eq(shippingRateBooks.code, input.rateBookCode))
    .limit(1);
  if (!rateBook || rateBook.status === "retired") {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_RATE_BOOK_INVALID",
      `Rate book ${input.rateBookCode} is missing or retired.`,
    );
  }
  if (input.pricingMode === "state_zip") {
    const geographyErrors = findMissingStateDefaults(rows.rows);
    if (geographyErrors.length > 0) {
      throw new RateTableAdminError(
        400,
        "SHIPPING_ADMIN_STATE_FALLBACK_REQUIRED",
        "Every ZIP override requires a statewide fallback rate.",
        geographyErrors,
      );
    }
    if (rateBook.zoneSetId === null) {
      throw new RateTableAdminError(
        400,
        "SHIPPING_ADMIN_RATE_BOOK_INVALID",
        `Rate book ${input.rateBookCode} does not have a geography set.`,
      );
    }
  }
  const knownZones = input.pricingMode === "legacy_zone"
    ? await db.selectDistinct({ zone: shippingZoneRules.zone })
        .from(shippingZoneRules)
        .where(and(
          eq(shippingZoneRules.zoneSetId, rateBook.zoneSetId),
          eq(shippingZoneRules.isActive, true),
        ))
    : [];

  return {
    rateBook,
    rows: rows.rows,
    pricingMode: input.pricingMode,
    carrier: input.carrier,
    serviceCode: input.serviceCode,
    currency: input.currency.toUpperCase(),
    effectiveFrom: input.effectiveFrom,
    warnings: input.pricingMode === "legacy_zone"
      ? findUnknownZones(rows.rows, knownZones.map((item) => item.zone))
      : [],
  };
}

type RateBookForImport = Awaited<ReturnType<typeof prepareRateTableImport>>["rateBook"];
type RateTableTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function ensureStateZipRules(
  tx: RateTableTransaction,
  rateBook: RateBookForImport,
  rows: readonly RateTableImportRow[],
  pricingMode: RatePricingMode,
): Promise<void> {
  if (pricingMode !== "state_zip") return;

  const activeWarehouses = await tx.select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.isActive, 1));
  const warehouseIds = new Set(activeWarehouses.map((warehouse) => warehouse.id));
  const invalidWarehouse = rows.find(
    (row) => row.originWarehouseId !== null && !warehouseIds.has(row.originWarehouseId),
  );
  if (invalidWarehouse?.originWarehouseId) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_WAREHOUSE_INVALID",
      `Warehouse ${invalidWarehouse.originWarehouseId} is missing or inactive.`,
    );
  }
  if (activeWarehouses.length === 0) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_WAREHOUSE_REQUIRED",
      "At least one active warehouse is required for state pricing.",
    );
  }

  const ruleByKey = new Map<string, typeof shippingZoneRules.$inferInsert>();
  for (const row of rows) {
    const targetWarehouseIds = row.originWarehouseId === null
      ? activeWarehouses.map((warehouse) => warehouse.id)
      : [row.originWarehouseId];
    const postalPrefixes = row.postalPrefix === null ? [null] : [null, row.postalPrefix];
    for (const warehouseId of targetWarehouseIds) {
      for (const postalPrefix of postalPrefixes) {
        const zone = stateZipPricingAreaKey(row.destinationRegion!, postalPrefix);
        const key = `${warehouseId}|${row.destinationRegion}|${postalPrefix ?? ""}`;
        ruleByKey.set(key, {
          zoneSetId: rateBook.zoneSetId,
          originWarehouseId: warehouseId,
          destinationCountry: "US",
          destinationRegion: row.destinationRegion,
          postalPrefix,
          zone,
          priority: postalPrefix ? postalPrefix.length : 0,
          isActive: true,
        });
      }
    }
  }
  if (ruleByKey.size > 0) {
    await tx.insert(shippingZoneRules).values([...ruleByKey.values()]).onConflictDoNothing();
  }
}

async function insertRateRows(
  tx: RateTableTransaction,
  rateTableId: number,
  rows: readonly RateTableImportRow[],
): Promise<void> {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    await tx.insert(shippingRateTableRows).values(
      rows.slice(index, index + INSERT_CHUNK_SIZE).map((row) => ({
        rateTableId,
        originWarehouseId: row.originWarehouseId,
        destinationZone: row.destinationZone,
        minWeightGrams: row.minWeightGrams,
        maxWeightGrams: row.maxWeightGrams,
        rateCents: row.rateCents,
      })),
    );
  }
}

async function loadRateTableDetail(id: number) {
  const [rateTable] = await db.select().from(shippingRateTables)
    .where(eq(shippingRateTables.id, id))
    .limit(1);
  if (!rateTable) return null;

  const [rateBook, rows] = await Promise.all([
    rateTable.rateBookId === null
      ? Promise.resolve(null)
      : db.select().from(shippingRateBooks)
          .where(eq(shippingRateBooks.id, rateTable.rateBookId))
          .limit(1)
          .then((items) => items[0] ?? null),
    db.select({
      id: shippingRateTableRows.id,
      originWarehouseId: shippingRateTableRows.originWarehouseId,
      originWarehouseName: warehouses.name,
      destinationZone: shippingRateTableRows.destinationZone,
      minWeightGrams: shippingRateTableRows.minWeightGrams,
      maxWeightGrams: shippingRateTableRows.maxWeightGrams,
      rateCents: shippingRateTableRows.rateCents,
    })
      .from(shippingRateTableRows)
      .leftJoin(warehouses, eq(shippingRateTableRows.originWarehouseId, warehouses.id))
      .where(eq(shippingRateTableRows.rateTableId, id))
      .orderBy(
        asc(shippingRateTableRows.destinationZone),
        asc(shippingRateTableRows.originWarehouseId),
        asc(shippingRateTableRows.minWeightGrams),
      ),
  ]);

  const [zoneSet, assignments, zoneRules] = rateBook === null
    ? [null, [], []] as const
    : await Promise.all([
        rateBook.zoneSetId === null
          ? Promise.resolve(null)
          : db.select().from(shippingZoneSets)
              .where(eq(shippingZoneSets.id, rateBook.zoneSetId))
              .limit(1)
              .then((items) => items[0] ?? null),
        db.select({
          id: shippingRateBookAssignments.id,
          pricingChannel: shippingRateBookAssignments.pricingChannel,
          ratePurpose: shippingRateBookAssignments.ratePurpose,
          originWarehouseId: shippingRateBookAssignments.originWarehouseId,
          originWarehouseName: warehouses.name,
          isActive: shippingRateBookAssignments.isActive,
        })
          .from(shippingRateBookAssignments)
          .leftJoin(warehouses, eq(shippingRateBookAssignments.originWarehouseId, warehouses.id))
          .where(eq(shippingRateBookAssignments.rateBookId, rateBook.id))
          .orderBy(asc(shippingRateBookAssignments.pricingChannel), asc(shippingRateBookAssignments.ratePurpose)),
        rateBook.zoneSetId === null
          ? Promise.resolve([])
          : db.select({
              originWarehouseId: shippingZoneRules.originWarehouseId,
              destinationRegion: shippingZoneRules.destinationRegion,
              postalPrefix: shippingZoneRules.postalPrefix,
              zone: shippingZoneRules.zone,
            })
              .from(shippingZoneRules)
              .where(and(
                eq(shippingZoneRules.zoneSetId, rateBook.zoneSetId),
                eq(shippingZoneRules.isActive, true),
              )),
      ]);

  const geographyByWarehouseAndZone = new Map<string, typeof zoneRules[number]>();
  const geographyByZone = new Map<string, typeof zoneRules[number]>();
  for (const rule of zoneRules) {
    geographyByWarehouseAndZone.set(`${rule.originWarehouseId}|${rule.zone.toUpperCase()}`, rule);
    if (!geographyByZone.has(rule.zone.toUpperCase())) {
      geographyByZone.set(rule.zone.toUpperCase(), rule);
    }
  }
  const mappedRows = rows.map((row) => {
    const zone = row.destinationZone.toUpperCase();
    const geography = row.originWarehouseId === null
      ? geographyByZone.get(zone)
      : geographyByWarehouseAndZone.get(`${row.originWarehouseId}|${zone}`) ?? geographyByZone.get(zone);
    return {
      ...row,
      destinationRegion: geography?.destinationRegion ?? null,
      postalPrefix: geography?.postalPrefix ?? null,
    };
  });
  const pricingMode = resolvePricingMode(rateBook?.metadata, zoneSet?.metadata, rateTable.metadata);
  const analysis = analyzeRateTable(mappedRows, pricingMode);

  return {
    rateTable,
    rateBook: rateBook === null ? null : { ...rateBook, zoneSet, assignments },
    pricingMode,
    rows: mappedRows,
    analysis,
  };
}

function resolvePricingMode(
  rateBookMetadata: unknown,
  zoneSetMetadata: unknown,
  tableMetadata: unknown,
): RatePricingMode {
  const bookMode = metadataString(rateBookMetadata, "pricingGeography")
    ?? metadataString(zoneSetMetadata, "pricingGeography");
  if (bookMode === "state_zip") return "state_zip";
  return metadataString(tableMetadata, "pricingMode") === "state_zip" ? "state_zip" : "legacy_zone";
}

function metadataString(metadata: unknown, key: string): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function importMetadata(pricingMode: RatePricingMode, rowCount: number, importedAt: Date) {
  return {
    source: "admin-import",
    pricingMode,
    importedAt: importedAt.toISOString(),
    rowCount,
  };
}

function normalizeImportRows(
  inputRows: readonly ImportRowInput[],
  pricingMode: RatePricingMode,
): { ok: true; rows: RateTableImportRow[] } | { ok: false; message: string } {
  const rows: RateTableImportRow[] = [];
  for (const input of inputRows) {
    const originWarehouseId = input.originWarehouseId ?? null;
    if (pricingMode === "legacy_zone") {
      const destinationZone = input.destinationZone?.trim();
      if (!destinationZone) {
        return { ok: false, message: "Every legacy row requires a destination zone." };
      }
      rows.push({
        originWarehouseId,
        destinationZone,
        destinationRegion: null,
        postalPrefix: null,
        minWeightGrams: input.minWeightGrams,
        maxWeightGrams: input.maxWeightGrams,
        rateCents: input.rateCents,
      });
      continue;
    }

    const destinationRegion = normalizeUsPostalRegion(input.destinationRegion);
    if (destinationRegion === null) {
      return { ok: false, message: `${JSON.stringify(input.destinationRegion)} is not a valid US state or territory.` };
    }
    const postalPrefix = input.postalPrefix?.trim() || null;
    if (postalPrefix !== null && !/^\d{1,5}$/.test(postalPrefix)) {
      return { ok: false, message: "ZIP prefixes must contain 1 to 5 digits." };
    }
    rows.push({
      originWarehouseId,
      destinationZone: stateZipPricingAreaKey(destinationRegion, postalPrefix),
      destinationRegion,
      postalPrefix,
      minWeightGrams: input.minWeightGrams,
      maxWeightGrams: input.maxWeightGrams,
      rateCents: input.rateCents,
    });
  }
  return { ok: true, rows };
}

function parseTableId(value: string): number {
  const parsed = tableIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new RateTableAdminError(400, "SHIPPING_ADMIN_INVALID_INPUT", "A valid rate-table ID is required.");
  }
  return parsed.data;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}

class RateTableAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

function sendInvalidInput(res: Response, issues: z.ZodIssue[]): Response {
  return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues } });
}

function sendRateTableAdminError(res: Response, error: unknown, action: string): Response {
  if (error instanceof RateTableAdminError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  console.error(`[RateTableAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}

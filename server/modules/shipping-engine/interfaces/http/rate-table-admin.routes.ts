/** Draft-first administration for direct-geography shipping rate tables. */

import type { Express, Response } from "express";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  shippingRateBookAssignments,
  shippingRateBooks,
  shippingRateTableRows,
  shippingRateTables,
  shippingZoneSets,
  warehouses,
} from "@shared/schema";
import { db } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import {
  MAX_IMPORT_ROWS,
  findBandOverlaps,
  findMissingStateDefaults,
  parseRateTableCsv,
  type RateTableImportRow,
} from "../../domain/rate-table-import";
import {
  analyzeRateTable,
  canActivateRateTable,
  canDeleteRateTable,
  canRetireRateTable,
} from "../../domain/rate-table-lifecycle";
import { normalizeUsPostalRegion } from "../../domain/us-geography";

const rateRowSchema = z.object({
  originWarehouseId: z.number().int().positive().nullable().optional(),
  destinationCountry: z.string().trim().length(2).default("US"),
  destinationRegion: z.string().trim().length(2),
  postalPrefix: z.string().trim().regex(/^\d{1,5}$/).nullable().optional(),
  minWeightGrams: z.number().int().min(0),
  maxWeightGrams: z.number().int().min(0),
  rateCents: z.number().int().min(0),
}).superRefine((row, context) => {
  if (row.maxWeightGrams < row.minWeightGrams) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxWeightGrams"],
      message: "Maximum weight must be greater than or equal to minimum weight.",
    });
  }
});

const importSchema = z.object({
  pricingMode: z.literal("state_zip").default("state_zip"),
  rateBookCode: z.string().trim().min(1).max(80).default("shopify-retail-default"),
  carrier: z.string().trim().min(1).max(50),
  serviceCode: z.string().trim().min(1).max(80),
  currency: z.string().trim().length(3).default("USD"),
  effectiveFrom: z.coerce.date().optional(),
  rows: z.array(rateRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

const parseCsvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });
const tableIdSchema = z.coerce.number().int().positive();
const activateSchema = z.object({ confirmWarnings: z.boolean().default(false) });
const INSERT_CHUNK_SIZE = 1000;

type RateRowInput = z.infer<typeof rateRowSchema>;
type ImportInput = z.infer<typeof importSchema>;
type RateTableTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
            stateCount: sql<number>`count(distinct case when ${shippingRateTableRows.postalPrefix} is null then ${shippingRateTableRows.destinationRegion} end)::int`,
            zipOverrideCount: sql<number>`count(*) filter (where ${shippingRateTableRows.postalPrefix} is not null)::int`,
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
          rateTables: tables.map((table) => ({
            ...table,
            rateBook: table.rateBookId ? bookById.get(table.rateBookId) ?? null : null,
            rowCount: coverageByTable.get(table.id)?.rowCount ?? 0,
            stateCount: coverageByTable.get(table.id)?.stateCount ?? 0,
            zipOverrideCount: coverageByTable.get(table.id)?.zipOverrideCount ?? 0,
            minWeightGrams: coverageByTable.get(table.id)?.minWeightGrams ?? null,
            maxWeightGrams: coverageByTable.get(table.id)?.maxWeightGrams ?? null,
          })),
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
        const detail = await loadRateTableDetail(parseTableId(req.params.id));
        if (!detail) throw notFoundError();
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
        return res.json({
          ...result,
          bandErrors: result.errors.length === 0 ? findBandOverlaps(result.rows) : [],
          geographyErrors: result.errors.length === 0 ? findMissingStateDefaults(result.rows) : [],
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
          const [table] = await tx.insert(shippingRateTables).values({
            rateBookId: prepared.rateBook.id,
            carrier: prepared.carrier,
            serviceCode: prepared.serviceCode,
            currency: prepared.currency,
            status: "draft",
            effectiveFrom: prepared.effectiveFrom ?? now,
            metadata: importMetadata(prepared.rows.length, now),
          }).returning();
          await insertRateRows(tx, table.id, prepared.rows);
          return table;
        });
        return res.status(201).json({ rateTable, rowCount: prepared.rows.length, warnings: [] });
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
              metadata: importMetadata(prepared.rows.length, now),
            })
            .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
            .returning();
          if (!updated) throw draftRequiredError("Only a draft rate table can be replaced.");
          await tx.delete(shippingRateTableRows).where(eq(shippingRateTableRows.rateTableId, id));
          await insertRateRows(tx, id, prepared.rows);
          return updated;
        });
        return res.json({ rateTable, rowCount: prepared.rows.length, warnings: [] });
      } catch (error) {
        return sendRateTableAdminError(res, error, "replace rate table draft");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/:id/rows",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const parsed = rateRowSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const row = normalizeRateRow(parsed.data);
        await validateWarehouseIds(db, [row]);
        const [created] = await db.transaction(async (tx) => {
          await assertDraftTable(tx, id);
          return tx.insert(shippingRateTableRows).values({ rateTableId: id, ...row }).returning();
        });
        return res.status(201).json({ row: created });
      } catch (error) {
        return sendRateTableAdminError(res, error, "add rate row");
      }
    },
  );

  app.put(
    "/api/shipping/admin/rate-tables/:id/rows/:rowId",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const rowId = parseTableId(req.params.rowId);
        const parsed = rateRowSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const row = normalizeRateRow(parsed.data);
        await validateWarehouseIds(db, [row]);
        const updated = await db.transaction(async (tx) => {
          await assertDraftTable(tx, id);
          const [result] = await tx.update(shippingRateTableRows)
            .set(row)
            .where(and(eq(shippingRateTableRows.id, rowId), eq(shippingRateTableRows.rateTableId, id)))
            .returning();
          return result ?? null;
        });
        if (!updated) throw new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_ROW_NOT_FOUND", "Rate row not found.");
        return res.json({ row: updated });
      } catch (error) {
        return sendRateTableAdminError(res, error, "update rate row");
      }
    },
  );

  app.delete(
    "/api/shipping/admin/rate-tables/:id/rows/:rowId",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const rowId = parseTableId(req.params.rowId);
        const deleted = await db.transaction(async (tx) => {
          await assertDraftTable(tx, id);
          const [result] = await tx.delete(shippingRateTableRows)
            .where(and(eq(shippingRateTableRows.id, rowId), eq(shippingRateTableRows.rateTableId, id)))
            .returning({ id: shippingRateTableRows.id });
          return result ?? null;
        });
        if (!deleted) throw new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_ROW_NOT_FOUND", "Rate row not found.");
        return res.status(204).send();
      } catch (error) {
        return sendRateTableAdminError(res, error, "delete rate row");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/:id/clone",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = parseTableId(req.params.id);
        const detail = await loadRateTableDetail(id);
        if (!detail) throw notFoundError();
        if (detail.rateTable.status === "draft") {
          throw new RateTableAdminError(409, "SHIPPING_ADMIN_ALREADY_DRAFT", "This table is already editable.");
        }
        const now = new Date();
        const rateTable = await db.transaction(async (tx) => {
          const [draft] = await tx.insert(shippingRateTables).values({
            rateBookId: detail.rateTable.rateBookId,
            carrier: detail.rateTable.carrier,
            serviceCode: detail.rateTable.serviceCode,
            currency: detail.rateTable.currency,
            status: "draft",
            effectiveFrom: now,
            effectiveTo: null,
            metadata: {
              source: "admin-clone",
              clonedFromRateTableId: id,
              clonedAt: now.toISOString(),
              rowCount: detail.rows.length,
            },
          }).returning();
          await insertRateRows(tx, draft.id, detail.rows);
          return draft;
        });
        return res.status(201).json({ rateTable, rowCount: detail.rows.length });
      } catch (error) {
        return sendRateTableAdminError(res, error, "create editable rate-table draft");
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
        if (!detail) throw notFoundError();
        if (!canActivateRateTable(detail.rateTable.status)) throw draftRequiredError("Only a draft rate table can be activated.");
        if (!detail.rateBook || detail.rateBook.status !== "active") {
          throw new RateTableAdminError(409, "SHIPPING_ADMIN_RATE_BOOK_INACTIVE", "The rate book must be active before this table can be activated.");
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
        if (!activated) throw draftRequiredError("The table is no longer a draft. Refresh and try again.");
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
          .from(shippingRateTables).where(eq(shippingRateTables.id, id)).limit(1);
        if (!current) throw notFoundError();
        if (!canRetireRateTable(current.status)) {
          throw new RateTableAdminError(409, "SHIPPING_ADMIN_RATE_TABLE_NOT_RETIRABLE", "Only an active or superseded rate table can be retired.");
        }
        const [retired] = await db.update(shippingRateTables)
          .set({ status: "retired", effectiveTo: new Date() })
          .where(and(eq(shippingRateTables.id, id), inArray(shippingRateTables.status, ["active", "superseded"])))
          .returning();
        if (!retired) throw changedError();
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
          .from(shippingRateTables).where(eq(shippingRateTables.id, id)).limit(1);
        if (!current) throw notFoundError();
        if (!canDeleteRateTable(current.status)) throw draftRequiredError("Only a draft rate table can be deleted.");
        const [deleted] = await db.delete(shippingRateTables)
          .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
          .returning({ id: shippingRateTables.id });
        if (!deleted) throw changedError();
        return res.status(204).send();
      } catch (error) {
        return sendRateTableAdminError(res, error, "delete rate table draft");
      }
    },
  );
}

async function prepareRateTableImport(input: ImportInput) {
  const rows = normalizeImportRows(input.rows);
  const bandErrors = findBandOverlaps(rows);
  if (bandErrors.length > 0) {
    throw new RateTableAdminError(400, "SHIPPING_ADMIN_RATE_BANDS_INVALID", "Weight bands overlap.", bandErrors);
  }
  const geographyErrors = findMissingStateDefaults(rows);
  if (geographyErrors.length > 0) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_STATE_FALLBACK_REQUIRED",
      "Every ZIP override requires a statewide fallback rate.",
      geographyErrors,
    );
  }
  await validateWarehouseIds(db, rows);
  const [rateBook] = await db.select({
    id: shippingRateBooks.id,
    code: shippingRateBooks.code,
    status: shippingRateBooks.status,
  }).from(shippingRateBooks).where(eq(shippingRateBooks.code, input.rateBookCode)).limit(1);
  if (!rateBook || rateBook.status === "retired") {
    throw new RateTableAdminError(400, "SHIPPING_ADMIN_RATE_BOOK_INVALID", `Rate book ${input.rateBookCode} is missing or retired.`);
  }
  return {
    rateBook,
    rows,
    carrier: input.carrier,
    serviceCode: input.serviceCode,
    currency: input.currency.toUpperCase(),
    effectiveFrom: input.effectiveFrom,
  };
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
        destinationCountry: row.destinationCountry,
        destinationRegion: row.destinationRegion,
        postalPrefix: row.postalPrefix,
        minWeightGrams: row.minWeightGrams,
        maxWeightGrams: row.maxWeightGrams,
        rateCents: row.rateCents,
      })),
    );
  }
}

async function loadRateTableDetail(id: number) {
  const [rateTable] = await db.select().from(shippingRateTables)
    .where(eq(shippingRateTables.id, id)).limit(1);
  if (!rateTable) return null;

  const [rateBook, rows] = await Promise.all([
    rateTable.rateBookId === null
      ? Promise.resolve(null)
      : db.select().from(shippingRateBooks)
          .where(eq(shippingRateBooks.id, rateTable.rateBookId)).limit(1)
          .then((items) => items[0] ?? null),
    db.select({
      id: shippingRateTableRows.id,
      originWarehouseId: shippingRateTableRows.originWarehouseId,
      originWarehouseName: warehouses.name,
      destinationCountry: shippingRateTableRows.destinationCountry,
      destinationRegion: shippingRateTableRows.destinationRegion,
      postalPrefix: shippingRateTableRows.postalPrefix,
      minWeightGrams: shippingRateTableRows.minWeightGrams,
      maxWeightGrams: shippingRateTableRows.maxWeightGrams,
      rateCents: shippingRateTableRows.rateCents,
    })
      .from(shippingRateTableRows)
      .leftJoin(warehouses, eq(shippingRateTableRows.originWarehouseId, warehouses.id))
      .where(eq(shippingRateTableRows.rateTableId, id))
      .orderBy(
        asc(shippingRateTableRows.destinationCountry),
        asc(shippingRateTableRows.destinationRegion),
        asc(shippingRateTableRows.postalPrefix),
        asc(shippingRateTableRows.originWarehouseId),
        asc(shippingRateTableRows.minWeightGrams),
      ),
  ]);

  const [zoneSet, assignments] = rateBook === null
    ? [null, []] as const
    : await Promise.all([
        rateBook.zoneSetId === null
          ? Promise.resolve(null)
          : db.select().from(shippingZoneSets)
              .where(eq(shippingZoneSets.id, rateBook.zoneSetId)).limit(1)
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
      ]);

  return {
    rateTable,
    rateBook: rateBook === null ? null : { ...rateBook, zoneSet, assignments },
    pricingMode: "state_zip" as const,
    rows,
    analysis: analyzeRateTable(rows),
  };
}

function normalizeImportRows(inputRows: readonly RateRowInput[]): RateTableImportRow[] {
  return inputRows.map(normalizeRateRow);
}

function normalizeRateRow(input: RateRowInput): RateTableImportRow {
  const destinationCountry = input.destinationCountry.trim().toUpperCase();
  const destinationRegion = destinationCountry === "US"
    ? normalizeUsPostalRegion(input.destinationRegion)
    : input.destinationRegion.trim().toUpperCase();
  if (destinationRegion === null || !/^[A-Z]{2}$/.test(destinationRegion)) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_INVALID_GEOGRAPHY",
      `${JSON.stringify(input.destinationRegion)} is not a valid state or region.`,
    );
  }
  return {
    originWarehouseId: input.originWarehouseId ?? null,
    destinationCountry,
    destinationRegion,
    postalPrefix: input.postalPrefix?.trim() || null,
    minWeightGrams: input.minWeightGrams,
    maxWeightGrams: input.maxWeightGrams,
    rateCents: input.rateCents,
  };
}

async function validateWarehouseIds(
  executor: Pick<typeof db, "select">,
  rows: readonly RateTableImportRow[],
): Promise<void> {
  const requested = new Set(rows.flatMap((row) => row.originWarehouseId === null ? [] : [row.originWarehouseId]));
  if (requested.size === 0) return;
  const activeWarehouses = await executor.select({ id: warehouses.id })
    .from(warehouses).where(eq(warehouses.isActive, 1));
  const activeIds = new Set(activeWarehouses.map((warehouse) => warehouse.id));
  const invalid = [...requested].find((id) => !activeIds.has(id));
  if (invalid !== undefined) {
    throw new RateTableAdminError(400, "SHIPPING_ADMIN_WAREHOUSE_INVALID", `Warehouse ${invalid} is missing or inactive.`);
  }
}

async function assertDraftTable(tx: RateTableTransaction, id: number): Promise<void> {
  const [table] = await tx.select({ status: shippingRateTables.status })
    .from(shippingRateTables).where(eq(shippingRateTables.id, id)).limit(1);
  if (!table) throw notFoundError();
  if (table.status !== "draft") throw draftRequiredError("Only a draft rate table can be edited.");
}

function importMetadata(rowCount: number, importedAt: Date) {
  return {
    source: "admin-import",
    pricingGeography: "state_zip",
    importedAt: importedAt.toISOString(),
    rowCount,
  };
}

function parseTableId(value: string): number {
  const parsed = tableIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new RateTableAdminError(400, "SHIPPING_ADMIN_INVALID_INPUT", "A valid ID is required.");
  }
  return parsed.data;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}

function notFoundError(): RateTableAdminError {
  return new RateTableAdminError(404, "SHIPPING_ADMIN_RATE_TABLE_NOT_FOUND", "Rate table not found.");
}

function draftRequiredError(message: string): RateTableAdminError {
  return new RateTableAdminError(409, "SHIPPING_ADMIN_DRAFT_REQUIRED", message);
}

function changedError(): RateTableAdminError {
  return new RateTableAdminError(409, "SHIPPING_ADMIN_RATE_TABLE_CHANGED", "Refresh and try again.");
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
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return res.status(409).json({
      error: {
        code: "SHIPPING_ADMIN_DUPLICATE_RATE_ROW",
        message: "A rate row already exists for this destination, warehouse, and weight band.",
      },
    });
  }
  console.error(`[RateTableAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}

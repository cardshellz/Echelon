/** Draft-first administration for direct-geography shipping rate tables. */

import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  shippingRateBookAssignments,
  shippingRateBooks,
  shippingRateRules,
  shippingRateTableRows,
  shippingRateTables,
  shippingServiceLevels,
  shippingZoneSets,
  warehouses,
} from "@shared/schema";
import { db } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import { parseRateTableAdminBulkJson } from "./rate-table-admin-body.middleware";
import {
  MAX_IMPORT_ROWS,
  findBandOverlaps,
  findMissingRegionDefaults,
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
import type { ShippingRateChargeModel } from "../../domain/rate-selection";
import {
  cloneProductRules,
  validateRateTableProductRules,
} from "../../application/product-rate-policy-admin.service";
import {
  RateCoverageAdminError,
  saveRateCoverageManifest,
} from "../../application/rate-coverage-admin.service";
import {
  coverageGroupsFromDraftLayout,
  draftLayoutSchema,
  layoutWithSavedGroupIdentities,
  metadataRecord,
  readDraftLayout,
  type DraftLayoutInput,
} from "../../application/rate-table-draft-layout";
import { findStaleDraftCoverageErrors } from "../../domain/rate-coverage";

import {
  cloneRateTableCoverages,
  loadRateBookDestinationGroups,
  loadRateTableCoverages,
  PostgresRateCoverageAdminTransaction,
} from "../../infrastructure/rate-coverage.repository";
import {
  loadDestinationScopes,
} from "../../infrastructure/channel-shipping-policy.repository";
import { persistAuditEvent } from "../../../../infrastructure/auditLogger";

const INITIAL_RATE_TABLE_SERVICE_LEVEL_CODE = "standard";

const rateRowSchema = z.object({
  originWarehouseId: z.number().int().positive().nullable().optional(),
  destinationCountry: z.string().trim().length(2).default("US"),
  destinationRegion: z.string().trim().length(2),
  postalPrefix: z.string().trim().regex(/^\d{1,5}$/).nullable().optional(),
  minMeasure: z.number().int().min(0),
  maxMeasure: z.number().int().min(0).nullable(),
  maxShipmentWeightGrams: z.number().int().positive().nullable().optional(),
  chargeModel: z.enum(["fixed_band", "base_plus_per_started_pound"]).default("fixed_band"),
  rateCents: z.number().int().min(0),
  perStartedPoundCents: z.number().int().min(0).nullable().optional(),
}).superRefine((row, context) => {
  if (row.maxMeasure !== null && row.maxMeasure < row.minMeasure) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxMeasure"],
      message: "Maximum must be greater than or equal to minimum.",
    });
  }
  if (row.chargeModel === "fixed_band" && row.perStartedPoundCents != null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["perStartedPoundCents"],
      message: "Fixed-band rows cannot have a per-pound charge.",
    });
  }
  if (
    row.chargeModel === "base_plus_per_started_pound"
    && (row.minMeasure !== 0 || row.maxMeasure !== null || row.perStartedPoundCents == null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chargeModel"],
      message: "Formula rows must begin at zero, have no maximum, and include a per-pound charge.",
    });
  }
});

const importSchema = z.object({
  pricingMode: z.literal("state_zip").default("state_zip"),
  rateBookCode: z.string().trim().min(1).max(80).default("shopify-retail-default"),
  serviceLevelCode: z.string().trim().min(1).max(40),
  pricingBasis: z.enum(["shipment_weight", "pallet_count"]),
  currency: z.string().trim().length(3).default("USD"),
  effectiveFrom: z.coerce.date().optional(),
  rows: z.array(rateRowSchema).max(MAX_IMPORT_ROWS),
  // Draft-first editing (UX spec): an in-progress draft may be saved with
  // aggregate validation failures — even zero finished rows — while
  // activation stays strictly gated on a clean analysis.
  allowIncomplete: z.boolean().default(false),
  draftLayout: draftLayoutSchema.nullish(),
}).superRefine((input, context) => {
  if (!input.allowIncomplete && input.rows.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rows"],
      message: "At least one rate row is required.",
    });
  }
});

const parseCsvSchema = z.object({ csv: z.string().min(1).max(2_000_000) });
const tableIdSchema = z.coerce.number().int().positive();
const activateSchema = z.object({ confirmWarnings: z.boolean().default(false) });
const INSERT_CHUNK_SIZE = 1000;

type RateRowInput = z.infer<typeof rateRowSchema>;
type ImportInput = z.infer<typeof importSchema>;
type RateTableTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RateTableExecutor = typeof db | RateTableTransaction;

export function registerRateTableAdminRoutes(app: Express): void {
  app.get(
    "/api/shipping/admin/rate-tables",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        const [
          tables,
          rowCoverage,
          productRuleCounts,
          books,
          assignments,
          serviceLevels,
          destinationGroups,
          destinationScopes,
        ] = await Promise.all([
          db.select().from(shippingRateTables)
            .orderBy(desc(shippingRateTables.effectiveFrom), desc(shippingRateTables.id)),
          db.select({
            rateTableId: shippingRateTableRows.rateTableId,
            rowCount: sql<number>`count(*)::int`,
            regionCount: sql<number>`count(distinct case when ${shippingRateTableRows.postalPrefix} is null then ${shippingRateTableRows.destinationRegion} end)::int`,
            zipOverrideCount: sql<number>`count(*) filter (where ${shippingRateTableRows.postalPrefix} is not null)::int`,
            minMeasure: sql<number>`min(${shippingRateTableRows.minMeasure})::int`,
            maxMeasure: sql<number>`max(${shippingRateTableRows.maxMeasure})::int`,
            hasOpenEnded: sql<boolean>`bool_or(${shippingRateTableRows.maxMeasure} is null)`,
          })
            .from(shippingRateTableRows)
            .groupBy(shippingRateTableRows.rateTableId),
          db.select({
            rateTableId: shippingRateRules.rateTableId,
            productRuleCount: sql<number>`count(*)::int`,
          })
            .from(shippingRateRules)
            .groupBy(shippingRateRules.rateTableId),
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
          db.select().from(shippingServiceLevels)
            .orderBy(asc(shippingServiceLevels.sortOrder), asc(shippingServiceLevels.id)),
          loadRateBookDestinationGroups(),
          loadDestinationScopes(db),
        ]);
        const coverageManifests = await loadRateTableCoverages(
          db,
          tables
            .filter((table) =>
              table.status === "active" || table.status === "draft")
            .map((table) => table.id),
        );

        const assignmentsByBook = groupBy(assignments, (assignment) => assignment.rateBookId);
        const rowCoverageByTable = new Map(
          rowCoverage.map((item) => [item.rateTableId, item]),
        );
        const manifestsByTable = groupBy(
          coverageManifests,
          (manifest) => manifest.rateTableId,
        );
        const productRuleCountByTable = new Map(
          productRuleCounts.map((item) => [item.rateTableId, item.productRuleCount]),
        );
        const hydratedBooks = books.map((book) => ({
          ...book,
          assignments: assignmentsByBook.get(book.id) ?? [],
        }));
        const bookById = new Map(hydratedBooks.map((book) => [book.id, book]));
        const serviceLevelById = new Map(serviceLevels.map((level) => [level.id, level]));

        return res.json({
          rateBooks: hydratedBooks,
          serviceLevels,
          destinationGroups,
          destinationScopes,
          rateTables: tables.map((table) => ({
            ...table,
            rateBook: bookById.get(table.rateBookId) ?? null,
            serviceLevel: serviceLevelById.get(table.serviceLevelId) ?? null,
            coverages: manifestsByTable.get(table.id) ?? [],
            rowCount: rowCoverageByTable.get(table.id)?.rowCount ?? 0,
            regionCount: rowCoverageByTable.get(table.id)?.regionCount ?? 0,
            // Preserve the original field for callers deployed before regionCount.
            stateCount: rowCoverageByTable.get(table.id)?.regionCount ?? 0,
            zipOverrideCount:
              rowCoverageByTable.get(table.id)?.zipOverrideCount ?? 0,
            minMeasure: rowCoverageByTable.get(table.id)?.minMeasure ?? null,
            maxMeasure: rowCoverageByTable.get(table.id)?.hasOpenEnded
              ? null
              : rowCoverageByTable.get(table.id)?.maxMeasure ?? null,
            productRuleCount: productRuleCountByTable.get(table.id) ?? 0,
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
    parseRateTableAdminBulkJson,
    async (req, res) => {
      try {
        const parsed = parseCsvSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const result = parseRateTableCsv(parsed.data.csv);
        return res.json({
          ...result,
          bandErrors: result.errors.length === 0 ? findBandOverlaps(result.rows) : [],
          geographyErrors: result.errors.length === 0 ? findMissingRegionDefaults(result.rows) : [],
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "parse rate table CSV");
      }
    },
  );

  app.post(
    ["/api/shipping/admin/rate-tables/drafts", "/api/shipping/admin/rate-tables/import"],
    requirePermission("settings", "edit"),
    parseRateTableAdminBulkJson,
    async (req, res) => {
      try {
        const actor = auditActor(req);
        const parsed = importSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const prepared = await prepareRateTableImport(parsed.data);
        const now = new Date();
        const result = await db.transaction(async (tx) => {
          const [table] = await tx.insert(shippingRateTables).values({
            rateBookId: prepared.rateBook.id,
            serviceLevelId: prepared.serviceLevel.id,
            pricingBasis: prepared.pricingBasis,
            currency: prepared.currency,
            status: "draft",
            effectiveFrom: prepared.effectiveFrom ?? now,
            metadata: importMetadata(prepared.rows.length, now, prepared.draftLayout),
          }).returning();
          await insertRateRows(tx, table.id, prepared.rows);
          const manifest = await persistPreparedCoverageManifest(
            tx,
            table.id,
            prepared,
            actor,
            now,
          );
          const [savedTable] = await tx.update(shippingRateTables)
            .set({
              metadata: importMetadata(
                prepared.rows.length,
                now,
                manifest.draftLayout,
              ),
            })
            .where(eq(shippingRateTables.id, table.id))
            .returning();
          await persistAuditEvent(tx, {
            actor,
            action: "shipping.rate_table_draft.created",
            target: `shipping.rate_tables:${table.id}`,
            changes: {
              before: null,
              after: rateTableAuditState(savedTable, prepared.rows.length),
            },
          }, { timestamp: now });
          return { rateTable: savedTable, ...manifest };
        });
        return res.status(201).json({
          ...result,
          rowCount: prepared.rows.length,
          warnings: prepared.analysis.warnings,
          analysis: prepared.analysis,
        });
      } catch (error) {
        return sendRateTableAdminError(res, error, "import rate table draft");
      }
    },
  );

  app.put(
    "/api/shipping/admin/rate-tables/:id",
    requirePermission("settings", "edit"),
    parseRateTableAdminBulkJson,
    async (req, res) => {
      try {
        const actor = auditActor(req);
        const id = parseTableId(req.params.id);
        const parsed = importSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const prepared = await prepareRateTableImport(parsed.data);
        const now = new Date();
        const result = await db.transaction(async (tx) => {
          const [before] = await tx.select().from(shippingRateTables)
            .where(eq(shippingRateTables.id, id))
            .limit(1);
          const [updated] = await tx.update(shippingRateTables)
            .set({
              rateBookId: prepared.rateBook.id,
              serviceLevelId: prepared.serviceLevel.id,
              pricingBasis: prepared.pricingBasis,
              currency: prepared.currency,
              effectiveFrom: prepared.effectiveFrom ?? now,
              effectiveTo: null,
              metadata: importMetadata(prepared.rows.length, now, prepared.draftLayout),
            })
            .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
            .returning();
          if (!updated) throw draftRequiredError("Only a draft rate table can be replaced.");
          await tx.delete(shippingRateTableRows).where(eq(shippingRateTableRows.rateTableId, id));
          await insertRateRows(tx, id, prepared.rows);
          const manifest = await persistPreparedCoverageManifest(
            tx,
            id,
            prepared,
            actor,
            now,
          );
          const [savedTable] = await tx.update(shippingRateTables)
            .set({
              metadata: importMetadata(
                prepared.rows.length,
                now,
                manifest.draftLayout,
              ),
            })
            .where(eq(shippingRateTables.id, id))
            .returning();
          await persistAuditEvent(tx, {
            actor,
            action: "shipping.rate_table_draft.saved",
            target: `shipping.rate_tables:${id}`,
            changes: {
              before: before
                ? rateTableAuditState(before, null)
                : null,
              after: rateTableAuditState(savedTable, prepared.rows.length),
            },
          }, { timestamp: now });
          return { rateTable: savedTable, ...manifest };
        });
        return res.json({
          ...result,
          rowCount: prepared.rows.length,
          warnings: prepared.analysis.warnings,
          analysis: prepared.analysis,
        });
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
          const table = await assertDraftTable(tx, id);
          validateRowForBasis(row, table.pricingBasis);
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
          const table = await assertDraftTable(tx, id);
          validateRowForBasis(row, table.pricingBasis);
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
        const actor = auditActor(req);
        const id = parseTableId(req.params.id);
        const detail = await loadRateTableDetail(id);
        if (!detail) throw notFoundError();
        if (detail.rateTable.status === "draft") {
          throw new RateTableAdminError(409, "SHIPPING_ADMIN_ALREADY_DRAFT", "This table is already editable.");
        }
        const now = new Date();
        const result = await db.transaction(async (tx) => {
          const sourceLayout = readDraftLayout(detail.rateTable.metadata);
          const [draft] = await tx.insert(shippingRateTables).values({
            rateBookId: detail.rateTable.rateBookId,
            serviceLevelId: detail.rateTable.serviceLevelId,
            pricingBasis: detail.rateTable.pricingBasis,
            currency: detail.rateTable.currency,
            status: "draft",
            effectiveFrom: now,
            effectiveTo: null,
            metadata: {
              ...metadataRecord(detail.rateTable.metadata),
              source: "admin-clone",
              clonedFromRateTableId: id,
              clonedAt: now.toISOString(),
              rowCount: detail.rows.length,
            },
          }).returning();
          await insertRateRows(tx, draft.id, detail.rows);
          await cloneProductRules(tx, id, draft.id);
          const clonedCoverageCount = await cloneRateTableCoverages(
            tx,
            id,
            draft.id,
          );
          let draftLayout = sourceLayout;
          let coverages = clonedCoverageCount > 0
            ? await loadRateTableCoverages(tx, [draft.id])
            : [];
          if (clonedCoverageCount === 0 && sourceLayout !== null) {
            const legacyGroups = coverageGroupsFromDraftLayout(sourceLayout);
            if (legacyGroups.length > 0) {
              const saved = await saveRateCoverageManifest(
                new PostgresRateCoverageAdminTransaction(tx),
                {
                  rateBookId: detail.rateTable.rateBookId,
                  rateTableId: draft.id,
                  groups: legacyGroups,
                  actor,
                  now,
                },
              );
              coverages = saved.coverages;
              draftLayout = layoutWithSavedGroupIdentities(
                sourceLayout,
                saved.groups,
              );
            }
          }
          const [savedDraft] = await tx.update(shippingRateTables)
            .set({
              metadata: {
                ...metadataRecord(draft.metadata),
                ...(draftLayout === null ? {} : { draftLayout }),
                ...(
                  coverages.length === 0
                    ? {}
                    : { coverageManifestVersion: 1 }
                ),
              },
            })
            .where(eq(shippingRateTables.id, draft.id))
            .returning();
          await persistAuditEvent(tx, {
            actor,
            action: "shipping.rate_table_draft.cloned",
            target: `shipping.rate_tables:${draft.id}`,
            changes: {
              before: null,
              after: rateTableAuditState(savedDraft, detail.rows.length),
            },
            context: { sourceRateTableId: id },
          }, { timestamp: now });
          return { rateTable: savedDraft, coverages, draftLayout };
        });
        return res.status(201).json({
          ...result,
          rowCount: detail.rows.length,
        });
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
        const actor = auditActor(req);
        const id = parseTableId(req.params.id);
        const parsed = activateSchema.safeParse(req.body ?? {});
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);

        const now = new Date();
        const activation = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM shipping.rate_tables WHERE id = ${id} FOR UPDATE`);
          const [lockedTarget] = await tx
            .select({
              rateBookId: shippingRateTables.rateBookId,
            })
            .from(shippingRateTables)
            .where(eq(shippingRateTables.id, id))
            .limit(1);
          if (!lockedTarget) throw notFoundError();
          // Serializes competing draft activations for one pricing program so
          // superseding the prior live revision cannot race another activation.
          await tx.execute(sql`
            SELECT id
            FROM shipping.rate_books
            WHERE id = ${lockedTarget.rateBookId}
            FOR UPDATE
          `);
          const detail = await loadRateTableDetail(id, tx);
          if (!detail) throw notFoundError();
          if (!canActivateRateTable(detail.rateTable.status)) {
            throw draftRequiredError("Only a draft rate table can be activated.");
          }
          if (!detail.rateBook || detail.rateBook.status !== "active") {
            throw new RateTableAdminError(
              409,
              "SHIPPING_ADMIN_RATE_BOOK_INACTIVE",
              "The rate book must be active before this table can be activated.",
            );
          }
          if (!detail.analysis.canActivate) {
            throw new RateTableAdminError(
              409,
              "SHIPPING_ADMIN_ACTIVATION_BLOCKED",
              "Resolve the rate-table validation errors before activation.",
              detail.analysis.errors,
            );
          }
          const warnings = [...detail.analysis.warnings];
          if (!detail.rateBook.assignments.some(
            (assignment) => assignment.isActive,
          )) {
            warnings.push(
              "This rate book is not assigned to an active channel and purpose.",
            );
          }
          const productPolicyErrors = await validateRateTableProductRules(id, tx);
          if (productPolicyErrors.length > 0) {
            throw new RateTableAdminError(
              409,
              "SHIPPING_ADMIN_ACTIVATION_BLOCKED",
              "Resolve the product policy validation errors before activation.",
              productPolicyErrors,
            );
          }
          if (warnings.length > 0 && !parsed.data.confirmWarnings) {
            throw new RateTableAdminError(
              409,
              "SHIPPING_ADMIN_ACTIVATION_CONFIRMATION_REQUIRED",
              "Review and confirm the activation warnings.",
              warnings,
            );
          }
          const [target] = await tx.update(shippingRateTables)
            .set({ status: "active", effectiveFrom: now, effectiveTo: null })
            .where(and(eq(shippingRateTables.id, id), eq(shippingRateTables.status, "draft")))
            .returning();
          if (!target) {
            throw draftRequiredError(
              "The table is no longer a draft. Refresh and try again.",
            );
          }
          await tx.update(shippingRateTables)
            .set({ status: "superseded", effectiveTo: now })
            .where(and(
              eq(shippingRateTables.rateBookId, detail.rateBook.id),
              eq(shippingRateTables.serviceLevelId, target.serviceLevelId),
              eq(shippingRateTables.status, "active"),
              ne(shippingRateTables.id, target.id),
            ));
          await persistAuditEvent(tx, {
            actor,
            action: "shipping.rate_table.activated",
            target: `shipping.rate_tables:${target.id}`,
            changes: {
              before: {
                status: "draft",
                effectiveFrom: detail.rateTable.effectiveFrom,
              },
              after: {
                status: "active",
                effectiveFrom: now.toISOString(),
              },
            },
            context: {
              rateBookId: detail.rateBook.id,
              serviceLevelId: target.serviceLevelId,
            },
          }, { timestamp: now });
          return { rateTable: target, warnings };
        });
        return res.json(activation);
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
  // Row identity mirrors shipping_rate_row_band_idx; an incomplete draft may
  // legitimately describe the same scope twice mid-edit, so collapse exact
  // index collisions instead of failing the whole save on 23505.
  const rows = input.allowIncomplete
    ? dedupeRowsByBandIdentity(normalizeImportRows(input.rows))
    : normalizeImportRows(input.rows);
  if (!input.allowIncomplete) {
    const bandErrors = findBandOverlaps(rows);
    if (bandErrors.length > 0) {
      throw new RateTableAdminError(400, "SHIPPING_ADMIN_RATE_BANDS_INVALID", "Rate bands overlap.", bandErrors);
    }
    const geographyErrors = findMissingRegionDefaults(rows);
    if (geographyErrors.length > 0) {
      throw new RateTableAdminError(
        400,
        "SHIPPING_ADMIN_STATE_FALLBACK_REQUIRED",
        "Every ZIP override requires a region-wide fallback rate.",
        geographyErrors,
      );
    }
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
  const [serviceLevel] = await db.select({
    id: shippingServiceLevels.id,
    code: shippingServiceLevels.code,
    fulfillmentMode: shippingServiceLevels.fulfillmentMode,
  }).from(shippingServiceLevels)
    .where(eq(shippingServiceLevels.code, input.serviceLevelCode))
    .limit(1);
  if (!serviceLevel) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_SERVICE_LEVEL_INVALID",
      `Shipping option ${input.serviceLevelCode} is missing.`,
    );
  }
  if (serviceLevel.code !== INITIAL_RATE_TABLE_SERVICE_LEVEL_CODE) {
    throw new RateTableAdminError(
      409,
      "SHIPPING_ADMIN_SERVICE_LEVEL_NOT_AVAILABLE",
      "Only Standard Shipping rate tables are available in the initial rollout.",
    );
  }
  const expectedBasis = serviceLevel.fulfillmentMode === "freight"
    ? "pallet_count"
    : "shipment_weight";
  if (input.pricingBasis !== expectedBasis) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_PRICING_BASIS_INVALID",
      `${serviceLevel.code} requires ${expectedBasis} pricing.`,
    );
  }
  const coverageGroups = input.draftLayout === null
    || input.draftLayout === undefined
    ? null
    : coverageGroupsFromDraftLayout(input.draftLayout);
  const analysis = analyzeRateTable(
    rows,
    input.pricingBasis,
    coverageGroups,
  );
  if (!input.allowIncomplete && !analysis.canActivate) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_RATE_ROWS_INVALID",
      "Resolve the rate-table validation errors.",
      analysis.errors,
    );
  }
  return {
    rateBook,
    serviceLevel,
    rows,
    analysis,
    pricingBasis: input.pricingBasis,
    currency: input.currency.toUpperCase(),
    effectiveFrom: input.effectiveFrom,
    draftLayout: input.draftLayout ?? null,
    coverageGroups,
  };
}

function dedupeRowsByBandIdentity(rows: readonly RateTableImportRow[]): RateTableImportRow[] {
  const seen = new Set<string>();
  const deduped: RateTableImportRow[] = [];
  for (const row of rows) {
    const key = [
      row.originWarehouseId ?? 0,
      row.destinationCountry,
      row.destinationRegion,
      row.postalPrefix ?? "",
      row.minMeasure,
      row.maxMeasure,
      row.maxShipmentWeightGrams ?? 0,
      row.chargeModel,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
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

async function loadRateTableDetail(
  id: number,
  executor: RateTableExecutor = db,
) {
  const [rateTable] = await executor.select().from(shippingRateTables)
    .where(eq(shippingRateTables.id, id)).limit(1);
  if (!rateTable) return null;

  const [
    rateBook,
    serviceLevel,
    rows,
    coverages,
    destinationGroups,
  ] = await Promise.all([
    executor.select().from(shippingRateBooks)
      .where(eq(shippingRateBooks.id, rateTable.rateBookId)).limit(1)
      .then((items) => items[0] ?? null),
    executor.select().from(shippingServiceLevels)
      .where(eq(shippingServiceLevels.id, rateTable.serviceLevelId)).limit(1)
      .then((items) => items[0] ?? null),
    executor.select({
      id: shippingRateTableRows.id,
      originWarehouseId: shippingRateTableRows.originWarehouseId,
      originWarehouseName: warehouses.name,
      destinationCountry: shippingRateTableRows.destinationCountry,
      destinationRegion: shippingRateTableRows.destinationRegion,
      postalPrefix: shippingRateTableRows.postalPrefix,
      minMeasure: shippingRateTableRows.minMeasure,
      maxMeasure: shippingRateTableRows.maxMeasure,
      maxShipmentWeightGrams: shippingRateTableRows.maxShipmentWeightGrams,
      chargeModel: shippingRateTableRows.chargeModel,
      rateCents: shippingRateTableRows.rateCents,
      perStartedPoundCents: shippingRateTableRows.perStartedPoundCents,
    })
      .from(shippingRateTableRows)
      .leftJoin(warehouses, eq(shippingRateTableRows.originWarehouseId, warehouses.id))
      .where(eq(shippingRateTableRows.rateTableId, id))
      .orderBy(
        asc(shippingRateTableRows.destinationCountry),
        asc(shippingRateTableRows.destinationRegion),
        asc(shippingRateTableRows.postalPrefix),
        asc(shippingRateTableRows.originWarehouseId),
        asc(shippingRateTableRows.minMeasure),
      ),
    loadRateTableCoverages(executor, [id]),
    loadRateBookDestinationGroups(executor, [rateTable.rateBookId]),
  ]);

  const [zoneSet, assignments] = rateBook === null
    ? [null, []] as const
    : await Promise.all([
        rateBook.zoneSetId === null
          ? Promise.resolve(null)
          : executor.select().from(shippingZoneSets)
              .where(eq(shippingZoneSets.id, rateBook.zoneSetId)).limit(1)
              .then((items) => items[0] ?? null),
        executor.select({
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

  const normalizedRows = rows.map((row) => ({
    ...row,
    chargeModel: row.chargeModel as ShippingRateChargeModel,
  }));
  const hasCoverageManifest =
    metadataRecord(rateTable.metadata).coverageManifestVersion === 1;

  const analysis = analyzeRateTable(
    normalizedRows,
    rateTable.pricingBasis as "shipment_weight" | "pallet_count",
    coverages.length > 0 || hasCoverageManifest ? coverages : null,
  );
  const staleCoverageErrors = rateTable.status === "draft"
    && hasCoverageManifest
    ? findStaleDraftCoverageErrors(coverages, destinationGroups)
    : [];

  return {
    rateTable,
    serviceLevel,
    rateBook: rateBook === null ? null : { ...rateBook, zoneSet, assignments },
    pricingMode: "state_zip" as const,
    rows: normalizedRows,
    coverages,
    analysis: staleCoverageErrors.length === 0
      ? analysis
      : {
          ...analysis,
          canActivate: false,
          errors: [...new Set([
            ...analysis.errors,
            ...staleCoverageErrors,
          ])],
        },
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
    minMeasure: input.minMeasure,
    maxMeasure: input.maxMeasure,
    maxShipmentWeightGrams: input.maxShipmentWeightGrams ?? null,
    chargeModel: input.chargeModel,
    rateCents: input.rateCents,
    perStartedPoundCents: input.perStartedPoundCents ?? null,
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

async function assertDraftTable(tx: RateTableTransaction, id: number) {
  const [table] = await tx.select({
    status: shippingRateTables.status,
    pricingBasis: shippingRateTables.pricingBasis,
  })
    .from(shippingRateTables).where(eq(shippingRateTables.id, id)).limit(1);
  if (!table) throw notFoundError();
  if (table.status !== "draft") throw draftRequiredError("Only a draft rate table can be edited.");
  return table;
}

function validateRowForBasis(
  row: RateTableImportRow,
  pricingBasis: string,
): void {
  if (pricingBasis === "pallet_count") {
    if (row.chargeModel !== "fixed_band" || row.maxMeasure === null) {
      throw new RateTableAdminError(
        400,
        "SHIPPING_ADMIN_RATE_CHARGE_MODEL_INVALID",
        "Pallet rates require fixed bands with an upper limit.",
      );
    }
    if (row.minMeasure < 1) {
      throw new RateTableAdminError(
        400,
        "SHIPPING_ADMIN_RATE_MEASURE_INVALID",
        "Pallet rate bands must begin at one pallet or greater.",
      );
    }
    return;
  }
  if (row.maxShipmentWeightGrams !== null) {
    throw new RateTableAdminError(
      400,
      "SHIPPING_ADMIN_RATE_MEASURE_INVALID",
      "Shipment-weight rate rows cannot have a freight weight ceiling.",
    );
  }
  if (row.chargeModel === "base_plus_per_started_pound") {
    if (row.minMeasure !== 0 || row.maxMeasure !== null || row.perStartedPoundCents === null) {
      throw new RateTableAdminError(
        400,
        "SHIPPING_ADMIN_RATE_CHARGE_MODEL_INVALID",
        "Per-pound rates must begin at zero, have no maximum, and include a per-pound charge.",
      );
    }
  }
}

function importMetadata(
  rowCount: number,
  importedAt: Date,
  draftLayout: z.infer<typeof draftLayoutSchema> | null = null,
) {
  return {
    source: draftLayout === null ? "admin-import" : "admin-editor",
    pricingGeography: "state_zip",
    importedAt: importedAt.toISOString(),
    rowCount,
    ...(draftLayout === null
      ? {}
      : { draftLayout, coverageManifestVersion: 1 }),
  };
}

async function persistPreparedCoverageManifest(
  tx: RateTableTransaction,
  rateTableId: number,
  prepared: Awaited<ReturnType<typeof prepareRateTableImport>>,
  actor: string,
  now: Date,
): Promise<{
  draftLayout: DraftLayoutInput | null;
  coverages: Awaited<ReturnType<typeof loadRateTableCoverages>>;
}> {
  const coverageTx = new PostgresRateCoverageAdminTransaction(tx);
  if (prepared.coverageGroups === null || prepared.draftLayout === null) {
    const before = await coverageTx.loadRateTableCoverages(rateTableId);
    const coverages = await coverageTx.replaceRateTableCoverages({
      rateTableId,
      groups: [],
    });
    if (before.length > 0) {
      await coverageTx.persistAudit({
        actor,
        action: "shipping.rate_table_coverage.cleared",
        target: `shipping.rate_tables:${rateTableId}`,
        changes: {
          before: { coverageCount: before.length },
          after: { coverageCount: 0 },
        },
      }, now);
    }
    return { draftLayout: null, coverages };
  }

  const saved = await saveRateCoverageManifest(coverageTx, {
    rateBookId: prepared.rateBook.id,
    rateTableId,
    groups: prepared.coverageGroups,
    actor,
    now,
  });
  return {
    draftLayout: layoutWithSavedGroupIdentities(
      prepared.draftLayout,
      saved.groups,
    ),
    coverages: saved.coverages,
  };
}

function rateTableAuditState(
  table: {
    id: number;
    rateBookId: number | null;
    serviceLevelId: number;
    pricingBasis: string;
    currency: string;
    status: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  },
  rowCount: number | null,
): Record<string, unknown> {
  return {
    id: table.id,
    rateBookId: table.rateBookId,
    serviceLevelId: table.serviceLevelId,
    pricingBasis: table.pricingBasis,
    currency: table.currency,
    status: table.status,
    effectiveFrom: table.effectiveFrom.toISOString(),
    effectiveTo: table.effectiveTo?.toISOString() ?? null,
    rowCount,
  };
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new RateTableAdminError(
      401,
      "SHIPPING_ADMIN_ACTOR_REQUIRED",
      "An authenticated operator is required to change shipping rates.",
    );
  }
  return actor;
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
  if (error instanceof RateCoverageAdminError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }
  if (error instanceof RateTableAdminError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505"
  ) {
    const constraint = "constraint" in error
      && typeof error.constraint === "string"
      ? error.constraint
      : null;
    if (constraint === "shipping_rate_book_destination_group_name_idx") {
      return res.status(409).json({
        error: {
          code: "SHIPPING_ADMIN_DESTINATION_GROUP_NAME_CONFLICT",
          message:
            "A destination group with that name already exists in this pricing program.",
        },
      });
    }
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

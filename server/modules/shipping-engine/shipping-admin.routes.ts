import type { Express, Request, Response } from "express";
import { and, asc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import {
  insertShippingBoxSchema,
  insertShippingVariantAttrsSchema,
  productVariants,
  products,
  SHIPPING_BOX_KINDS,
  shippingBoxCatalog,
  shippingBoxWarehouseStock,
  shippingServiceLevelMethods,
  shippingServiceLevels,
  shippingVariantAttrs,
} from "@shared/schema";

/**
 * Admin surface for the shipping engine (quote plane) config:
 * box catalog, per-variant packing behavior (SIOC/rider), service levels.
 * Rate tables and zone rules get their own routes with the rates PR — they
 * are calibration-fed, not hand-edited, so their admin is read/import only.
 */

const upsertBoxSchema = insertShippingBoxSchema.extend({
  id: z.number().int().positive().optional(),
  kind: z.enum(SHIPPING_BOX_KINDS),
  // Blank in the dialog means "no weight cap" — omission clears, not keeps.
  maxWeightGrams: z.number().int().positive().nullable().default(null),
  warehouseIds: z.array(z.number().int().positive()).default([]),
});

const upsertVariantAttrsSchema = insertShippingVariantAttrsSchema.pick({
  productVariantId: true,
  shipsInOwnContainer: true,
  riderEligible: true,
  riderVoidCm3: true,
  riderVoidMaxWeightGrams: true,
  riderVoidMaxItems: true,
  notes: true,
});

const updateServiceLevelSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const replaceMethodsSchema = z.object({
  methods: z.array(z.object({
    carrier: z.string().trim().min(1).max(50),
    serviceCode: z.string().trim().min(1).max(80),
    isActive: z.boolean().default(true),
  })).max(50),
});

export function registerShippingAdminRoutes(app: Express): void {
  app.get(
    "/api/shipping/admin/config",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        const [boxes, stock, levels, methods, coverage] = await Promise.all([
          db.select().from(shippingBoxCatalog).orderBy(asc(shippingBoxCatalog.code)),
          db.select().from(shippingBoxWarehouseStock),
          db.select().from(shippingServiceLevels).orderBy(asc(shippingServiceLevels.sortOrder)),
          db.select().from(shippingServiceLevelMethods).orderBy(asc(shippingServiceLevelMethods.carrier)),
          db.select({
            variantsTotal: sql<number>`count(*)::int`,
            variantsWithDims: sql<number>`count(*) filter (
              where ${productVariants.weightGrams} > 0
                and ${productVariants.lengthMm} > 0
                and ${productVariants.widthMm} > 0
                and ${productVariants.heightMm} > 0
            )::int`,
          }).from(productVariants),
        ]);

        const stockByBox = new Map<number, number[]>();
        for (const row of stock) {
          if (!row.isStocked) continue;
          const list = stockByBox.get(row.boxId) ?? [];
          list.push(row.warehouseId);
          stockByBox.set(row.boxId, list);
        }
        const methodsByLevel = new Map<number, typeof methods>();
        for (const method of methods) {
          const list = methodsByLevel.get(method.serviceLevelId) ?? [];
          list.push(method);
          methodsByLevel.set(method.serviceLevelId, list);
        }

        return res.json({
          boxes: boxes.map((box) => ({ ...box, warehouseIds: stockByBox.get(box.id) ?? [] })),
          serviceLevels: levels.map((level) => ({ ...level, methods: methodsByLevel.get(level.id) ?? [] })),
          dimsCoverage: coverage[0] ?? { variantsTotal: 0, variantsWithDims: 0 },
        });
      } catch (error) {
        return sendShippingAdminError(res, error, "load shipping config");
      }
    },
  );

  app.put(
    "/api/shipping/admin/boxes",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = upsertBoxSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const { id, warehouseIds, ...fields } = parsed.data;

        const box = await db.transaction(async (tx) => {
          let record;
          if (id != null) {
            const updated = await tx.update(shippingBoxCatalog)
              .set({ ...fields, updatedAt: new Date() })
              .where(eq(shippingBoxCatalog.id, id))
              .returning();
            if (updated.length === 0) return null;
            record = updated[0];
          } else {
            const inserted = await tx.insert(shippingBoxCatalog)
              .values(fields)
              .onConflictDoUpdate({
                target: shippingBoxCatalog.code,
                set: { ...fields, updatedAt: new Date() },
              })
              .returning();
            record = inserted[0];
          }

          await tx.delete(shippingBoxWarehouseStock).where(eq(shippingBoxWarehouseStock.boxId, record.id));
          if (warehouseIds.length > 0) {
            await tx.insert(shippingBoxWarehouseStock).values(
              warehouseIds.map((warehouseId) => ({ boxId: record.id, warehouseId, isStocked: true })),
            );
          }
          return { ...record, warehouseIds };
        });

        if (!box) {
          return res.status(404).json({ error: { code: "SHIPPING_ADMIN_BOX_NOT_FOUND" } });
        }
        return res.json({ box });
      } catch (error) {
        return sendShippingAdminError(res, error, "upsert box");
      }
    },
  );

  app.get(
    "/api/shipping/admin/variant-attrs",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const filters = search
          ? or(
              ilike(productVariants.sku, `%${search}%`),
              ilike(productVariants.name, `%${search}%`),
              ilike(products.name, `%${search}%`),
            )
          : undefined;

        const rows = await db
          .select({
            productVariantId: productVariants.id,
            sku: productVariants.sku,
            name: productVariants.name,
            productName: products.name,
            weightGrams: productVariants.weightGrams,
            lengthMm: productVariants.lengthMm,
            widthMm: productVariants.widthMm,
            heightMm: productVariants.heightMm,
            shipsInOwnContainer: shippingVariantAttrs.shipsInOwnContainer,
            siocSuggested: shippingVariantAttrs.siocSuggested,
            riderEligible: shippingVariantAttrs.riderEligible,
            riderVoidCm3: shippingVariantAttrs.riderVoidCm3,
            riderVoidMaxWeightGrams: shippingVariantAttrs.riderVoidMaxWeightGrams,
            riderVoidMaxItems: shippingVariantAttrs.riderVoidMaxItems,
            notes: shippingVariantAttrs.notes,
          })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .leftJoin(shippingVariantAttrs, eq(shippingVariantAttrs.productVariantId, productVariants.id))
          .where(filters)
          .orderBy(asc(productVariants.sku))
          .limit(100);

        return res.json({
          rows: rows.map((row) => ({
            ...row,
            shipsInOwnContainer: row.shipsInOwnContainer ?? false,
            siocSuggested: row.siocSuggested ?? false,
            riderEligible: row.riderEligible ?? false,
          })),
        });
      } catch (error) {
        return sendShippingAdminError(res, error, "list variant attrs");
      }
    },
  );

  app.put(
    "/api/shipping/admin/variant-attrs",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = upsertVariantAttrsSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const variant = await db.select({ id: productVariants.id })
          .from(productVariants)
          .where(eq(productVariants.id, parsed.data.productVariantId))
          .limit(1);
        if (variant.length === 0) {
          return res.status(404).json({ error: { code: "SHIPPING_ADMIN_VARIANT_NOT_FOUND" } });
        }

        const [attrs] = await db.insert(shippingVariantAttrs)
          .values({ ...parsed.data, siocSuggested: false })
          .onConflictDoUpdate({
            target: shippingVariantAttrs.productVariantId,
            // A manual save resolves any pending suggestion.
            set: { ...parsed.data, siocSuggested: false, updatedAt: new Date() },
          })
          .returning();
        return res.json({ attrs });
      } catch (error) {
        return sendShippingAdminError(res, error, "upsert variant attrs");
      }
    },
  );

  app.get(
    "/api/shipping/admin/sioc-suggestions",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        // Heuristic: sealed multi-unit pack levels (case/master) with complete
        // dims. An existing attrs row — however it's flagged — means a human
        // already decided (confirm OR dismiss both write one), so only
        // attrs-less variants are suggested.
        const rows = await db
          .select({
            productVariantId: productVariants.id,
            sku: productVariants.sku,
            name: productVariants.name,
            unitsPerVariant: productVariants.unitsPerVariant,
            hierarchyLevel: productVariants.hierarchyLevel,
            weightGrams: productVariants.weightGrams,
            lengthMm: productVariants.lengthMm,
            widthMm: productVariants.widthMm,
            heightMm: productVariants.heightMm,
          })
          .from(productVariants)
          .leftJoin(shippingVariantAttrs, eq(shippingVariantAttrs.productVariantId, productVariants.id))
          .where(and(
            sql`${productVariants.hierarchyLevel} >= 2`,
            sql`${productVariants.unitsPerVariant} >= 2`,
            isNotNull(productVariants.weightGrams),
            isNotNull(productVariants.lengthMm),
            sql`${shippingVariantAttrs.id} is null`,
          ))
          .orderBy(asc(productVariants.sku))
          .limit(50);
        return res.json({ rows });
      } catch (error) {
        return sendShippingAdminError(res, error, "list sioc suggestions");
      }
    },
  );

  app.put(
    "/api/shipping/admin/service-levels/:id",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", message: "invalid id" } });
        }
        const parsed = updateServiceLevelSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const updated = await db.update(shippingServiceLevels)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(shippingServiceLevels.id, id))
          .returning();
        if (updated.length === 0) {
          return res.status(404).json({ error: { code: "SHIPPING_ADMIN_SERVICE_LEVEL_NOT_FOUND" } });
        }
        const methods = await db.select().from(shippingServiceLevelMethods)
          .where(eq(shippingServiceLevelMethods.serviceLevelId, id));
        return res.json({ serviceLevel: { ...updated[0], methods } });
      } catch (error) {
        return sendShippingAdminError(res, error, "update service level");
      }
    },
  );

  app.put(
    "/api/shipping/admin/service-levels/:id/methods",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", message: "invalid id" } });
        }
        const parsed = replaceMethodsSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const level = await db.select().from(shippingServiceLevels)
          .where(eq(shippingServiceLevels.id, id)).limit(1);
        if (level.length === 0) {
          return res.status(404).json({ error: { code: "SHIPPING_ADMIN_SERVICE_LEVEL_NOT_FOUND" } });
        }

        const methods = await db.transaction(async (tx) => {
          await tx.delete(shippingServiceLevelMethods).where(eq(shippingServiceLevelMethods.serviceLevelId, id));
          if (parsed.data.methods.length === 0) return [];
          return tx.insert(shippingServiceLevelMethods).values(
            parsed.data.methods.map((m) => ({ ...m, serviceLevelId: id })),
          ).returning();
        });
        return res.json({ serviceLevel: { ...level[0], methods } });
      } catch (error) {
        return sendShippingAdminError(res, error, "replace service level methods");
      }
    },
  );
}

function sendShippingAdminError(res: Response, error: unknown, action: string): Response {
  console.error(`[ShippingAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}

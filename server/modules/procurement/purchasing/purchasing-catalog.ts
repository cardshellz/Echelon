import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import {
  purchaseOrderLines as purchaseOrderLinesTable,
  vendorProducts as vendorProductsTable,
} from "@shared/schema";
import { centsToMills, millsToCents } from "@shared/utils/money";
import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import { insertAuditEventDrizzle } from "../../../infrastructure/transactional-audit";
import { supplierEvidenceCatalogStateFingerprint } from "../application/supplier-evidence-catalog-state";
import {
  assertNonnegativeSafeInteger,
  assertOptionalCatalogText,
  assertPositivePgInteger,
  bulkCatalogKey,
  isValidIsoDateOnly,
  MAX_BULK_CATALOG_ENTRIES,
  MAX_QUOTE_CLOCK_SKEW_MS,
  PG_INTEGER_MAX,
  PurchasingError,
  rethrowVendorCatalogWriteError,
  safeIntegerMoney,
  type BulkCatalogEntry,
  type BulkCatalogResult,
  type CatalogWritablePoLine,
  type PurchasingBaseContext,
} from "./purchasing.types";

export function createPurchasingCatalog(ctx: PurchasingBaseContext) {
  const { db, storage, now, lockInventoryCostGraph, resolveActor } = ctx;

  /** Persist supplier purchase evidence only after an authorized close. */
  async function persistCompletedVendorPurchaseEvidenceTx(
    tx: any,
    purchaseOrderId: number,
    purchasedAt: Date,
    userId?: string,
  ): Promise<void> {
    const purchasedLines = await tx
      .select({
        vendorProductId: purchaseOrderLinesTable.vendorProductId,
        unitCostCents: purchaseOrderLinesTable.unitCostCents,
        unitCostMills: purchaseOrderLinesTable.unitCostMills,
        receivedQty: purchaseOrderLinesTable.receivedQty,
      })
      .from(purchaseOrderLinesTable)
      .where(and(
        eq(purchaseOrderLinesTable.purchaseOrderId, purchaseOrderId),
        eq(purchaseOrderLinesTable.lineType, "product"),
        ne(purchaseOrderLinesTable.status, "cancelled"),
        sql`${purchaseOrderLinesTable.vendorProductId} IS NOT NULL`,
        sql`${purchaseOrderLinesTable.receivedQty} > 0`,
      ));

    const totalsByVendorProductId = new Map<
      number,
      { extendedCostMills: bigint; receivedQty: bigint }
    >();
    for (const line of purchasedLines) {
      const vendorProductId = Number(line.vendorProductId);
      if (!Number.isSafeInteger(vendorProductId) || vendorProductId <= 0) continue;
      const receivedQty = BigInt(line.receivedQty ?? 0);
      if (receivedQty <= BigInt(0)) continue;
      const unitCostMills = BigInt(
        line.unitCostMills ?? centsToMills(readIntegerCents(line.unitCostCents ?? 0, "unit cost", true)),
      );
      const current = totalsByVendorProductId.get(vendorProductId) ?? {
        extendedCostMills: BigInt(0),
        receivedQty: BigInt(0),
      };
      current.extendedCostMills += unitCostMills * receivedQty;
      current.receivedQty += receivedQty;
      totalsByVendorProductId.set(vendorProductId, current);
    }
    const costByVendorProductId = new Map<
      number,
      { lastCostMills: number; lastCostCents: number }
    >();
    for (const [vendorProductId, totals] of totalsByVendorProductId) {
      const roundedUnitCostMills =
        (totals.extendedCostMills * BigInt(2) + totals.receivedQty) /
        (totals.receivedQty * BigInt(2));
      const lastCostMills = safeIntegerMoney(roundedUnitCostMills, "last_cost_mills");
      costByVendorProductId.set(vendorProductId, {
        lastCostMills,
        lastCostCents: millsToCents(lastCostMills),
      });
    }
    if (costByVendorProductId.size === 0) return;

    const vendorProductIds = [...costByVendorProductId.keys()];
    const currentRows = await tx
      .select()
      .from(vendorProductsTable)
      .where(inArray(vendorProductsTable.id, vendorProductIds))
      .for("update");
    const { actorType, actorId } = resolveActor(userId);
    const auditRows: Array<Record<string, unknown>> = [];

    for (const current of currentRows) {
      const priorPurchasedAt = current.lastPurchasedAt instanceof Date
        ? current.lastPurchasedAt
        : current.lastPurchasedAt
          ? new Date(current.lastPurchasedAt)
          : null;
      if (
        priorPurchasedAt &&
        !Number.isNaN(priorPurchasedAt.getTime()) &&
        priorPurchasedAt.getTime() > purchasedAt.getTime()
      ) {
        continue;
      }
      const lastCost = costByVendorProductId.get(Number(current.id));
      if (!lastCost) continue;
      const updatedRows = await tx
        .update(vendorProductsTable)
        .set({
          lastPurchasedAt: purchasedAt,
          lastCostMills: lastCost.lastCostMills,
          lastCostCents: lastCost.lastCostCents,
          updatedAt: purchasedAt,
        })
        .where(eq(vendorProductsTable.id, Number(current.id)))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new PurchasingError("Supplier purchase evidence could not be updated", 409, {
          code: "VENDOR_CATALOG_PURCHASE_EVIDENCE_CONFLICT",
          vendorProductId: Number(current.id),
        });
      }
      auditRows.push({
        level: "AUDIT",
        actor: `${actorType}:${actorId}`,
        action: "vendor_catalog.purchase_evidence_updated",
        timestamp: purchasedAt,
        target: `vendor_product:${updated.id}`,
        changes: {
          before: catalogAuditSnapshot(current),
          after: catalogAuditSnapshot(updated),
        },
        context: {
          purchaseOrderId,
          vendorProductId: updated.id,
          vendorId: updated.vendorId,
          productId: updated.productId,
          productVariantId: updated.productVariantId ?? null,
        },
      });
    }

    if (auditRows.length > 0) {
      await insertAuditEventDrizzle(tx, auditRows);
    }
  }

  async function persistPurchaseOrderCatalogWritesTx(
    tx: any,
    vendorId: number,
    lines: CatalogWritablePoLine[],
    userId?: string | null,
  ): Promise<Array<number | null>> {
    const targets = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.catalogWrite?.mode === "upsert");
    if (targets.length === 0) return lines.map(() => null);

    const entries: BulkCatalogEntry[] = targets.map(({ line, index }) => {
      if (!line.pricing || line.pricing.basis === "extended_total") {
        throw new PurchasingError(
          `lines[${index}].catalog_write requires reusable per-piece or purchase-UOM pricing`,
          400,
          { code: "PO_LINE_CATALOG_WRITE_PRICING_REQUIRED", lineIndex: index },
        );
      }
      if (!(line.quotedAt instanceof Date) || Number.isNaN(line.quotedAt.getTime())) {
        throw new PurchasingError(
          `lines[${index}].quoted_at is required when saving reusable catalog pricing`,
          400,
          { code: "PO_LINE_CATALOG_WRITE_QUOTED_AT_REQUIRED", lineIndex: index },
        );
      }
      const productId = Number(line.productId);
      assertPositivePgInteger(productId, `lines[${index}].productId`);
      return {
        productId,
        productVariantId: line.expectedReceiveVariantId ?? line.productVariantId ?? null,
        vendorSku: line.vendorSku,
        pricing: line.pricing,
        quoteReference: line.quoteReference,
        quotedAt: line.quotedAt,
        quoteValidUntil: line.quoteValidUntil,
        packSize: line.pricing.basis === "per_purchase_uom"
          ? line.pricing.piecesPerUom
          : 1,
        ...(line.catalogWrite?.setPreferred === undefined
          ? {}
          : { isPreferred: line.catalogWrite.setPreferred }),
      };
    });

    const result = await bulkUpsertVendorCatalog(vendorId, entries, userId, tx);
    const persisted = [...result.created, ...result.updated];
    const idByKey = new Map(
      persisted.map((row) => [
        bulkCatalogKey(row.productId, row.productVariantId),
        row.vendorProductId,
      ]),
    );
    const ids = lines.map(() => null as number | null);
    targets.forEach(({ line, index }) => {
      const variantId = line.expectedReceiveVariantId ?? line.productVariantId ?? null;
      const vendorProductId = idByKey.get(bulkCatalogKey(Number(line.productId), variantId));
      if (!vendorProductId) {
        throw new PurchasingError("Vendor catalog mapping was not returned after upsert", 409, {
          code: "PO_LINE_CATALOG_WRITE_RESULT_MISSING",
          lineIndex: index,
        });
      }
      line.vendorProductId = vendorProductId;
      ids[index] = vendorProductId;
    });
    return ids;
  }

  type ValidatedBulkCatalogEntry = {
    entry: BulkCatalogEntry;
    index: number;
    variantId: number | null;
    resolvedPricing: {
      unitCostMills: number;
      unitCostCents: number;
      pricingBasis: "legacy_unknown" | "per_piece" | "per_purchase_uom";
      purchaseUom: string | null;
      quotedUnitCostMills: number | null;
      piecesPerPurchaseUom: number | null;
      quoteReference: string | null;
      quotedAt: Date | null;
      quoteValidUntil: string | null;
    };
  };

  function resolveBulkCatalogEntryPricing(entry: BulkCatalogEntry, index: number) {
    if (entry.pricing) {
      if (entry.pricing.basis === "extended_total") {
        throw new PurchasingError(
          `entries[${index}].pricing is quantity-specific and cannot be reused as a catalog price`,
          400,
          { code: "VENDOR_CATALOG_EXTENDED_TOTAL_NOT_REUSABLE" },
        );
      }
      let normalized: NormalizedPoLinePricing;
      try {
        normalized = normalizePoLinePricing(entry.pricing);
      } catch (error: any) {
        throw new PurchasingError(`entries[${index}].pricing is invalid: ${error.message}`, 400, {
          code: "VENDOR_CATALOG_PRICING_INVALID",
          index,
        });
      }
      if (!(entry.quotedAt instanceof Date) || Number.isNaN(entry.quotedAt.getTime())) {
        throw new PurchasingError(
          `entries[${index}].quotedAt is required for an explicit reusable vendor catalog quote`,
          400,
          { code: "VENDOR_CATALOG_QUOTED_AT_REQUIRED", index },
        );
      }
      if (
        entry.unitCostMills !== undefined &&
        entry.unitCostMills !== null &&
        entry.unitCostMills !== normalized.unitCostMills
      ) {
        throw new PurchasingError(
          `entries[${index}].unitCostMills does not match normalized pricing`,
          400,
        );
      }
      if (
        entry.unitCostCents !== undefined &&
        entry.unitCostCents !== null &&
        entry.unitCostCents !== normalized.unitCostCents
      ) {
        throw new PurchasingError(
          `entries[${index}].unitCostCents does not match normalized pricing`,
          400,
        );
      }
      return {
        unitCostMills: normalized.unitCostMills,
        unitCostCents: normalized.unitCostCents,
        pricingBasis: entry.pricing.basis,
        purchaseUom: normalized.purchaseUom,
        quotedUnitCostMills: normalized.quotedUnitCostMills,
        piecesPerPurchaseUom: normalized.piecesPerPurchaseUom,
        quoteReference: entry.quoteReference?.trim() || null,
        quotedAt: entry.quotedAt ?? null,
        quoteValidUntil: entry.quoteValidUntil ?? null,
      };
    }

    try {
      const hasMills = entry.unitCostMills !== undefined && entry.unitCostMills !== null;
      const unitCostMills = hasMills
        ? readIntegerMills(entry.unitCostMills, "unit cost", true)
        : centsToMills(readIntegerCents(entry.unitCostCents, "unit cost", true));
      return {
        unitCostMills,
        unitCostCents: millsToCents(unitCostMills),
        pricingBasis: "legacy_unknown" as const,
        purchaseUom: null,
        quotedUnitCostMills: null,
        piecesPerPurchaseUom: null,
        quoteReference: null,
        quotedAt: null,
        quoteValidUntil: null,
      };
    } catch (error: any) {
      throw new PurchasingError(`entries[${index}] price is invalid: ${error.message}`, 400, {
        code: "VENDOR_CATALOG_PRICING_INVALID",
        index,
      });
    }
  }

  function catalogAuditSnapshot(row: any): Record<string, unknown> {
    return {
      unitCostCents: row?.unitCostCents ?? row?.unit_cost_cents ?? null,
      unitCostMills: row?.unitCostMills ?? row?.unit_cost_mills ?? null,
      pricingBasis: row?.pricingBasis ?? row?.pricing_basis ?? null,
      purchaseUom: row?.purchaseUom ?? row?.purchase_uom ?? null,
      quotedUnitCostMills:
        row?.quotedUnitCostMills ?? row?.quoted_unit_cost_mills ?? null,
      piecesPerPurchaseUom:
        row?.piecesPerPurchaseUom ?? row?.pieces_per_purchase_uom ?? null,
      packSize: row?.packSize ?? row?.pack_size ?? null,
      moq: row?.moq ?? null,
      leadTimeDays: row?.leadTimeDays ?? row?.lead_time_days ?? null,
      isPreferred: row?.isPreferred ?? row?.is_preferred ?? null,
      isActive: row?.isActive ?? row?.is_active ?? null,
      vendorSku: row?.vendorSku ?? row?.vendor_sku ?? null,
      vendorProductName: row?.vendorProductName ?? row?.vendor_product_name ?? null,
      quoteReference: row?.quoteReference ?? row?.quote_reference ?? null,
      quotedAt: row?.quotedAt ?? row?.quoted_at ?? null,
      quoteValidUntil: row?.quoteValidUntil ?? row?.quote_valid_until ?? null,
      lastPurchasedAt: row?.lastPurchasedAt ?? row?.last_purchased_at ?? null,
      lastCostMills: row?.lastCostMills ?? row?.last_cost_mills ?? null,
      lastCostCents: row?.lastCostCents ?? row?.last_cost_cents ?? null,
    };
  }

  async function lockVendorProductReferences(
    tx: any,
    vendorId: number,
    productId: number,
    productVariantId: number | null,
  ): Promise<void> {
    const vendorRows = await tx.execute(sql`
      SELECT id, active
      FROM procurement.vendors
      WHERE id = ${vendorId}
      FOR UPDATE
    `);
    const vendor = vendorRows.rows?.[0];
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    if (Number(vendor.active) !== 1) {
      throw new PurchasingError("Vendor is inactive", 409, {
        code: "VENDOR_CATALOG_VENDOR_INACTIVE",
        vendorId,
      });
    }

    const productRows = await tx.execute(sql`
      SELECT id, is_active
      FROM catalog.products
      WHERE id = ${productId}
      FOR UPDATE
    `);
    const product = productRows.rows?.[0];
    if (!product) {
      throw new PurchasingError(`Product ${productId} not found`, 404, {
        code: "VENDOR_CATALOG_PRODUCT_NOT_FOUND",
        productId,
      });
    }
    if (product.is_active !== true) {
      throw new PurchasingError(`Product ${productId} is inactive`, 409, {
        code: "VENDOR_CATALOG_PRODUCT_INACTIVE",
        productId,
      });
    }

    if (productVariantId === null) return;
    const variantRows = await tx.execute(sql`
      SELECT id, product_id, is_active
      FROM catalog.product_variants
      WHERE id = ${productVariantId}
      FOR UPDATE
    `);
    const variant = variantRows.rows?.[0];
    if (!variant) {
      throw new PurchasingError(`Product variant ${productVariantId} not found`, 404, {
        code: "VENDOR_CATALOG_VARIANT_NOT_FOUND",
        productId,
        productVariantId,
      });
    }
    if (Number(variant.product_id) !== productId) {
      throw new PurchasingError(
        `Product variant ${productVariantId} does not belong to product ${productId}`,
        400,
        {
          code: "VENDOR_CATALOG_VARIANT_PRODUCT_MISMATCH",
          productId,
          productVariantId,
          actualProductId: Number(variant.product_id),
        },
      );
    }
    if (variant.is_active !== true) {
      throw new PurchasingError(`Product variant ${productVariantId} is inactive`, 409, {
        code: "VENDOR_CATALOG_VARIANT_INACTIVE",
        productId,
        productVariantId,
      });
    }
  }

  async function demoteCompetingPreferredMappings(
    tx: any,
    input: {
      vendorId: number;
      productId: number;
      productVariantId: number | null;
      updatedAt: Date;
    },
  ): Promise<Array<{ before: Record<string, unknown>; after: any }>> {
    const result = await tx.execute(sql`
      UPDATE procurement.vendor_products
      SET
        is_preferred = 0,
        updated_at = ${input.updatedAt}
      WHERE product_id = ${input.productId}
        AND COALESCE(product_variant_id, 0) = ${input.productVariantId ?? 0}
        AND vendor_id <> ${input.vendorId}
        AND is_active = 1
        AND is_preferred = 1
      RETURNING *
    `);
    return (result.rows ?? []).map((row: any) => ({
      before: catalogAuditSnapshot({ ...row, is_preferred: 1 }),
      after: row,
    }));
  }

  function appendPreferredDemotionAudits(
    target: Array<Record<string, unknown>>,
    demotions: Array<{ before: Record<string, unknown>; after: any }>,
    actorType: "user" | "system",
    actorId: string,
    promoted: { vendorId: number; productId: number; productVariantId: number | null },
    action: "vendor_catalog.preferred_demoted" | "vendor_catalog.rfq_preferred_demoted" = "vendor_catalog.preferred_demoted",
  ): void {
    for (const demotion of demotions) {
      const vendorProductId = Number(demotion.after.id);
      target.push({
        level: "AUDIT",
        actor: `${actorType}:${actorId}`,
        action,
        target: `vendor_product:${vendorProductId}`,
        changes: {
          before: demotion.before,
          after: catalogAuditSnapshot(demotion.after),
        },
        context: {
          vendorProductId,
          vendorId: Number(demotion.after.vendor_id),
          productId: promoted.productId,
          productVariantId: promoted.productVariantId,
          promotedVendorId: promoted.vendorId,
        },
      });
    }
  }

  function validateStoredVendorProductQuote(
    row: Record<string, any>,
    timestamp: Date,
  ): void {
    const explicit = row.pricingBasis === "per_piece" || row.pricingBasis === "per_purchase_uom";
    if (!explicit) {
      if (row.quoteReference != null || row.quotedAt != null || row.quoteValidUntil != null) {
        throw new PurchasingError("Legacy catalog pricing cannot carry quote metadata", 400, {
          code: "VENDOR_CATALOG_QUOTE_METADATA_REQUIRES_PRICING",
        });
      }
      return;
    }
    if (!(row.quotedAt instanceof Date) || Number.isNaN(row.quotedAt.getTime())) {
      throw new PurchasingError("Explicit catalog pricing requires quotedAt", 400, {
        code: "VENDOR_CATALOG_QUOTED_AT_REQUIRED",
      });
    }
    if (row.quotedAt.getTime() > timestamp.getTime() + MAX_QUOTE_CLOCK_SKEW_MS) {
      throw new PurchasingError("quotedAt cannot be materially in the future", 400, {
        code: "VENDOR_CATALOG_QUOTED_AT_IN_FUTURE",
      });
    }
    if (
      row.quoteValidUntil != null &&
      (
        typeof row.quoteValidUntil !== "string" ||
        !isValidIsoDateOnly(row.quoteValidUntil)
      )
    ) {
      throw new PurchasingError("quoteValidUntil must be a real YYYY-MM-DD date", 400);
    }
    if (
      row.quoteValidUntil &&
      row.quoteValidUntil < row.quotedAt.toISOString().slice(0, 10)
    ) {
      throw new PurchasingError("quoteValidUntil cannot be earlier than quotedAt", 400, {
        code: "VENDOR_CATALOG_QUOTE_DATE_INVALID",
      });
    }
  }

  async function createVendorProduct(
    data: Record<string, any>,
    userId?: string | null,
  ): Promise<any> {
    assertPositivePgInteger(data.vendorId, "vendorId");
    assertPositivePgInteger(data.productId, "productId");
    if (data.productVariantId !== undefined && data.productVariantId !== null) {
      assertPositivePgInteger(data.productVariantId, "productVariantId");
    }
    const variantId = data.productVariantId ?? null;
    const writeTime = now();
    validateStoredVendorProductQuote(data, writeTime);
    const { actorType, actorId } = resolveActor(userId);

    try {
      return await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
        await lockVendorProductReferences(tx, data.vendorId, data.productId, variantId);
        const auditRows: Array<Record<string, unknown>> = [];
        if (Number(data.isActive ?? 1) === 1 && Number(data.isPreferred ?? 0) === 1) {
          const demotions = await demoteCompetingPreferredMappings(tx, {
            vendorId: data.vendorId,
            productId: data.productId,
            productVariantId: variantId,
            updatedAt: writeTime,
          });
          appendPreferredDemotionAudits(
            auditRows,
            demotions,
            actorType,
            actorId,
            { vendorId: data.vendorId, productId: data.productId, productVariantId: variantId },
          );
        }
        const insertedRows = await tx
          .insert(vendorProductsTable)
          .values({ ...data, productVariantId: variantId })
          .returning();
        const row = insertedRows[0];
        if (!row) throw new PurchasingError("Vendor catalog mapping was not created", 409);
        auditRows.push({
          level: "AUDIT",
          actor: `${actorType}:${actorId}`,
          action: "vendor_catalog.created",
          target: `vendor_product:${row.id}`,
          changes: { before: null, after: catalogAuditSnapshot(row) },
          context: {
            vendorId: row.vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          },
        });
        await insertAuditEventDrizzle(tx, auditRows);
        return row;
      });
    } catch (error: any) {
      rethrowVendorCatalogWriteError(error);
    }
  }

  async function updateVendorProduct(
    id: number,
    updates: Record<string, any>,
    userId?: string | null,
  ): Promise<any | null> {
    assertPositivePgInteger(id, "vendorProductId");
    for (const identityField of ["vendorId", "productId", "productVariantId"]) {
      if (Object.prototype.hasOwnProperty.call(updates, identityField)) {
        throw new PurchasingError(
          "Vendor-product identity is immutable; create a new mapping and deactivate this one",
          409,
          { code: "VENDOR_CATALOG_IDENTITY_IMMUTABLE", field: identityField },
        );
      }
    }
    const snapshot = await storage.getVendorProductById(id);
    if (!snapshot) return null;
    const { actorType, actorId } = resolveActor(userId);
    const writeTime = now();

    try {
      return await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
        await lockVendorProductReferences(
          tx,
          Number(snapshot.vendorId),
          Number(snapshot.productId),
          snapshot.productVariantId == null ? null : Number(snapshot.productVariantId),
        );
        const lockedRows = await tx
          .select()
          .from(vendorProductsTable)
          .where(eq(vendorProductsTable.id, id))
          .limit(1)
          .for("update");
        const current = lockedRows[0];
        if (!current) return null;
        if (
          Number(current.vendorId) !== Number(snapshot.vendorId) ||
          Number(current.productId) !== Number(snapshot.productId) ||
          (current.productVariantId == null ? null : Number(current.productVariantId)) !==
            (snapshot.productVariantId == null ? null : Number(snapshot.productVariantId))
        ) {
          throw new PurchasingError("Vendor-product identity changed concurrently; retry", 409, {
            code: "VENDOR_CATALOG_CONFLICT_RETRY",
          });
        }

        const effective = { ...current, ...updates };
        validateStoredVendorProductQuote(effective, writeTime);
        const auditRows: Array<Record<string, unknown>> = [];
        if (Number(effective.isActive ?? 0) === 1 && Number(effective.isPreferred ?? 0) === 1) {
          const demotions = await demoteCompetingPreferredMappings(tx, {
            vendorId: Number(current.vendorId),
            productId: Number(current.productId),
            productVariantId: current.productVariantId == null
              ? null
              : Number(current.productVariantId),
            updatedAt: writeTime,
          });
          appendPreferredDemotionAudits(
            auditRows,
            demotions,
            actorType,
            actorId,
            {
              vendorId: Number(current.vendorId),
              productId: Number(current.productId),
              productVariantId: current.productVariantId == null
                ? null
                : Number(current.productVariantId),
            },
          );
        }
        const updatedRows = await tx
          .update(vendorProductsTable)
          .set({ ...updates, updatedAt: writeTime })
          .where(eq(vendorProductsTable.id, id))
          .returning();
        const row = updatedRows[0];
        if (!row) return null;
        const deactivated = Number(current.isActive ?? 0) === 1 && Number(row.isActive ?? 0) === 0;
        auditRows.push({
          level: "AUDIT",
          actor: `${actorType}:${actorId}`,
          action: deactivated ? "vendor_catalog.deactivated" : "vendor_catalog.updated",
          target: `vendor_product:${row.id}`,
          changes: {
            before: catalogAuditSnapshot(current),
            after: catalogAuditSnapshot(row),
          },
          context: {
            vendorId: row.vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          },
        });
        await insertAuditEventDrizzle(tx, auditRows);
        return row;
      });
    } catch (error: any) {
      rethrowVendorCatalogWriteError(error);
    }
  }

  async function deactivateVendorProduct(
    id: number,
    userId?: string | null,
  ): Promise<boolean> {
    const row = await updateVendorProduct(id, { isActive: 0 }, userId);
    return row !== null;
  }

  /** Reviewed imports always use the same locked owner as ordinary catalog writes. */
  async function applyReviewedSupplierEvidenceImport(
    vendorId: number,
    entries: BulkCatalogEntry[],
    reviewedCatalogStateFingerprint: string,
    userId: string | null | undefined,
  ): Promise<BulkCatalogResult> {
    if (typeof reviewedCatalogStateFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(reviewedCatalogStateFingerprint)) {
      throw new PurchasingError("Supplier evidence preview is required before applying this import", 400, {
        code: "SUPPLIER_EVIDENCE_PREVIEW_REQUIRED",
      });
    }
    return bulkUpsertVendorCatalog(vendorId, entries, userId, undefined, reviewedCatalogStateFingerprint);
  }

  async function bulkUpsertVendorCatalog(
    vendorId: number,
    entries: BulkCatalogEntry[],
    userId: string | null | undefined,
    existingTransaction?: any,
    reviewedCatalogStateFingerprint?: string,
  ): Promise<BulkCatalogResult> {
    assertPositivePgInteger(vendorId, "vendorId");
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new PurchasingError("entries must be a non-empty array", 400);
    }
    if (entries.length > MAX_BULK_CATALOG_ENTRIES) {
      throw new PurchasingError(
        `entries cannot contain more than ${MAX_BULK_CATALOG_ENTRIES} items`,
        400,
        { code: "VENDOR_CATALOG_BATCH_TOO_LARGE", maximum: MAX_BULK_CATALOG_ENTRIES },
      );
    }

    // Reject the entire request before opening a transaction if any boundary
    // value or duplicate business key is invalid.
    const validatedEntries: ValidatedBulkCatalogEntry[] = [];
    const firstIndexByKey = new Map<string, number>();
    const boundaryNow = now();
    for (const [idx, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new PurchasingError(`entries[${idx}] must be an object`, 400);
      }
      assertPositivePgInteger(entry.productId, `entries[${idx}].productId`);
      if (entry.productVariantId !== undefined && entry.productVariantId !== null) {
        assertPositivePgInteger(
          entry.productVariantId,
          `entries[${idx}].productVariantId`,
        );
      }
      const variantId = entry.productVariantId ?? null;
      const key = bulkCatalogKey(entry.productId, variantId);
      const firstIndex = firstIndexByKey.get(key);
      if (firstIndex !== undefined) {
        throw new PurchasingError(
          `entries[${idx}] duplicates entries[${firstIndex}] for product ${entry.productId}` +
            (variantId === null ? " at product level" : ` variant ${variantId}`),
          400,
          {
            code: "VENDOR_CATALOG_DUPLICATE_ENTRY",
            firstIndex,
            duplicateIndex: idx,
            productId: entry.productId,
            productVariantId: variantId,
          },
        );
      }
      firstIndexByKey.set(key, idx);

      const hasCents = entry.unitCostCents !== undefined && entry.unitCostCents !== null;
      const hasMills = entry.unitCostMills !== undefined && entry.unitCostMills !== null;
      if (!entry.pricing && !hasCents && !hasMills) {
        throw new PurchasingError(
          `entries[${idx}].pricing, unitCostCents, or unitCostMills is required`,
          400,
        );
      }
      if (hasCents) {
        assertNonnegativeSafeInteger(
          entry.unitCostCents,
          `entries[${idx}].unitCostCents`,
        );
      }
      if (hasMills) {
        assertNonnegativeSafeInteger(
          entry.unitCostMills,
          `entries[${idx}].unitCostMills`,
        );
      }
      if (hasCents && hasMills) {
        const expected = millsToCents(entry.unitCostMills as number);
        if (expected !== entry.unitCostCents) {
          throw new PurchasingError(
            `entries[${idx}]: unitCostMills (${entry.unitCostMills}) and unitCostCents (${entry.unitCostCents}) disagree; expected cents=${expected}`,
            400,
          );
        }
      }

      assertOptionalCatalogText(
        entry.quoteReference,
        `entries[${idx}].quoteReference`,
        255,
      );
      const hasQuoteMetadata =
        entry.quoteReference !== undefined ||
        entry.quotedAt !== undefined ||
        entry.quoteValidUntil !== undefined;
      if (!entry.pricing && hasQuoteMetadata) {
        throw new PurchasingError(
          `entries[${idx}] quote metadata requires an explicit reusable pricing basis`,
          400,
          { code: "VENDOR_CATALOG_QUOTE_METADATA_REQUIRES_PRICING", index: idx },
        );
      }
      if (
        entry.quotedAt !== undefined &&
        entry.quotedAt !== null &&
        (!(entry.quotedAt instanceof Date) || Number.isNaN(entry.quotedAt.getTime()))
      ) {
        throw new PurchasingError(`entries[${idx}].quotedAt must be a valid date`, 400);
      }
      if (
        entry.quotedAt &&
        entry.quotedAt.getTime() > boundaryNow.getTime() + MAX_QUOTE_CLOCK_SKEW_MS
      ) {
        throw new PurchasingError(
          `entries[${idx}].quotedAt cannot be materially in the future`,
          400,
          { code: "VENDOR_CATALOG_QUOTED_AT_IN_FUTURE", index: idx },
        );
      }
      if (
        entry.quoteValidUntil !== undefined &&
        entry.quoteValidUntil !== null &&
        (
          typeof entry.quoteValidUntil !== "string" ||
          !isValidIsoDateOnly(entry.quoteValidUntil)
        )
      ) {
        throw new PurchasingError(
          `entries[${idx}].quoteValidUntil must be a real YYYY-MM-DD date`,
          400,
        );
      }
      if (
        entry.pricing &&
        entry.quoteValidUntil &&
        entry.quoteValidUntil < entry.quotedAt!.toISOString().slice(0, 10)
      ) {
        throw new PurchasingError(
          `entries[${idx}].quoteValidUntil cannot be earlier than quotedAt`,
          400,
          { code: "VENDOR_CATALOG_QUOTE_DATE_INVALID", index: idx },
        );
      }

      const resolvedPricing = resolveBulkCatalogEntryPricing(entry, idx);
      if (
        resolvedPricing.piecesPerPurchaseUom !== null &&
        resolvedPricing.piecesPerPurchaseUom > PG_INTEGER_MAX
      ) {
        throw new PurchasingError(
          `entries[${idx}].pricing.piecesPerUom exceeds the PostgreSQL integer range`,
          400,
        );
      }
      if (entry.packSize !== undefined && entry.packSize !== null) {
        assertPositivePgInteger(entry.packSize, `entries[${idx}].packSize`);
      }
      if (entry.moq !== undefined && entry.moq !== null) {
        assertPositivePgInteger(entry.moq, `entries[${idx}].moq`);
      }
      if (entry.leadTimeDays !== undefined && entry.leadTimeDays !== null) {
        if (
          typeof entry.leadTimeDays !== "number" ||
          !Number.isSafeInteger(entry.leadTimeDays) ||
          entry.leadTimeDays < 0 ||
          entry.leadTimeDays > PG_INTEGER_MAX
        ) {
          throw new PurchasingError(
            `entries[${idx}].leadTimeDays must be a non-negative PostgreSQL integer`,
            400,
          );
        }
      }
      if (entry.isPreferred !== undefined && typeof entry.isPreferred !== "boolean") {
        throw new PurchasingError(`entries[${idx}].isPreferred must be a boolean`, 400);
      }
      assertOptionalCatalogText(entry.vendorSku, `entries[${idx}].vendorSku`, 100);
      assertOptionalCatalogText(
        entry.vendorProductName,
        `entries[${idx}].vendorProductName`,
        20_000,
      );

      validatedEntries.push({ entry, index: idx, variantId, resolvedPricing });
    }

    const { actorType, actorId } = resolveActor(userId);
    const result: BulkCatalogResult = { created: [], updated: [], skipped: [] };

    const execute = async (tx: any) => {
      // RFQ conversion locks products before the reused PO owner locks its
      // supplier. Join their graph-first protocol before taking supplier locks
      // so reviewed imports and conversions cannot invert that lock order.
      await lockInventoryCostGraph(tx);
      // Lock references in a stable order. This makes validation current at
      // commit time and serializes overlapping batches for one vendor.
      const vendorLock = await tx.execute(sql`
        SELECT id, active
        FROM procurement.vendors
        WHERE id = ${vendorId}
        FOR UPDATE
      `);
      const vendor = vendorLock.rows?.[0];
      if (!vendor) throw new PurchasingError("Vendor not found", 404);
      if (Number(vendor.active) !== 1) {
        throw new PurchasingError("Vendor is inactive", 409, {
          code: "VENDOR_CATALOG_VENDOR_INACTIVE",
          vendorId,
        });
      }

      const productIds = [...new Set(validatedEntries.map(({ entry }) => entry.productId))]
        .sort((a, b) => a - b);
      const productLock = await tx.execute(sql`
        SELECT id, is_active
        FROM catalog.products
        WHERE id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY id
        FOR UPDATE
      `);
      const productsById = new Map<number, any>(
        (productLock.rows ?? []).map((row: any) => [Number(row.id), row]),
      );
      for (const productId of productIds) {
        const product = productsById.get(productId);
        if (!product) {
          throw new PurchasingError(`Product ${productId} not found`, 404, {
            code: "VENDOR_CATALOG_PRODUCT_NOT_FOUND",
            productId,
          });
        }
        if (product.is_active !== true) {
          throw new PurchasingError(`Product ${productId} is inactive`, 409, {
            code: "VENDOR_CATALOG_PRODUCT_INACTIVE",
            productId,
          });
        }
      }

      const variantIds = [...new Set(
        validatedEntries
          .map(({ variantId }) => variantId)
          .filter((id): id is number => id !== null),
      )].sort((a, b) => a - b);
      const variantsById = new Map<number, any>();
      if (variantIds.length > 0) {
        const variantLock = await tx.execute(sql`
          SELECT id, product_id, is_active
          FROM catalog.product_variants
          WHERE id IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY id
          FOR UPDATE
        `);
        for (const row of variantLock.rows ?? []) {
          variantsById.set(Number(row.id), row);
        }
      }
      for (const { entry, variantId } of validatedEntries) {
        if (variantId === null) continue;
        const variant = variantsById.get(variantId);
        if (!variant) {
          throw new PurchasingError(`Product variant ${variantId} not found`, 404, {
            code: "VENDOR_CATALOG_VARIANT_NOT_FOUND",
            productId: entry.productId,
            productVariantId: variantId,
          });
        }
        if (Number(variant.product_id) !== entry.productId) {
          throw new PurchasingError(
            `Product variant ${variantId} does not belong to product ${entry.productId}`,
            400,
            {
              code: "VENDOR_CATALOG_VARIANT_PRODUCT_MISMATCH",
              productId: entry.productId,
              productVariantId: variantId,
              actualProductId: Number(variant.product_id),
            },
          );
        }
        if (variant.is_active !== true) {
          throw new PurchasingError(`Product variant ${variantId} is inactive`, 409, {
            code: "VENDOR_CATALOG_VARIANT_INACTIVE",
            productId: entry.productId,
            productVariantId: variantId,
          });
        }
      }

      if (reviewedCatalogStateFingerprint !== undefined) {
        // Product locks serialize canonical catalog writers, including new competing
        // mappings. Lock existing rows too, then compare the full affected footprint
        // before demotion, upsert, or audit. An outside preflight cannot provide this guarantee.
        const currentMappings = await tx.execute(sql`
          SELECT * FROM procurement.vendor_products
          WHERE product_id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY id
          FOR UPDATE
        `);
        const currentFingerprint = supplierEvidenceCatalogStateFingerprint(
          vendorId,
          validatedEntries.map(({ entry }) => entry),
          currentMappings.rows ?? [],
        );
        if (currentFingerprint !== reviewedCatalogStateFingerprint) {
          throw new PurchasingError(
            "Supplier evidence changed after preview; preview the file again before applying it",
            409,
            { code: "SUPPLIER_EVIDENCE_PREVIEW_STALE" },
          );
        }
      }

      const auditRows: Array<Record<string, unknown>> = [];
      const quoteWriteTime = boundaryNow;
      for (const { entry, variantId, resolvedPricing } of validatedEntries) {
        if (entry.isPreferred === true) {
          const demotions = await demoteCompetingPreferredMappings(tx, {
            vendorId,
            productId: entry.productId,
            productVariantId: variantId,
            updatedAt: quoteWriteTime,
          });
          appendPreferredDemotionAudits(
            auditRows,
            demotions,
            actorType,
            actorId,
            { vendorId, productId: entry.productId, productVariantId: variantId },
          );
        }
        const quotedAt = resolvedPricing.pricingBasis === "legacy_unknown"
          ? null
          : resolvedPricing.quotedAt;
        const insertResult = await tx.execute(sql`
          INSERT INTO procurement.vendor_products (
            vendor_id,
            product_id,
            product_variant_id,
            vendor_sku,
            vendor_product_name,
            unit_cost_cents,
            unit_cost_mills,
            pricing_basis,
            purchase_uom,
            quoted_unit_cost_mills,
            pieces_per_purchase_uom,
            quote_reference,
            quoted_at,
            quote_valid_until,
            pack_size,
            moq,
            lead_time_days,
            is_preferred,
            is_active
          ) VALUES (
            ${vendorId},
            ${entry.productId},
            ${variantId},
            ${entry.vendorSku ?? null},
            ${entry.vendorProductName ?? null},
            ${resolvedPricing.unitCostCents},
            ${resolvedPricing.unitCostMills},
            ${resolvedPricing.pricingBasis},
            ${resolvedPricing.purchaseUom},
            ${resolvedPricing.quotedUnitCostMills},
            ${resolvedPricing.piecesPerPurchaseUom},
            ${resolvedPricing.quoteReference},
            ${quotedAt},
            ${resolvedPricing.quoteValidUntil},
            ${entry.packSize ?? resolvedPricing.piecesPerPurchaseUom ?? 1},
            ${entry.moq ?? 1},
            ${entry.leadTimeDays ?? null},
            ${entry.isPreferred ? 1 : 0},
            1
          )
          ON CONFLICT (
            vendor_id,
            product_id,
            (COALESCE(product_variant_id, 0))
          ) DO NOTHING
          RETURNING *
        `);
        const inserted = insertResult.rows?.[0];
        let row: any;
        let before: Record<string, unknown> | null = null;
        let action: "created" | "updated";

        if (inserted) {
          row = inserted;
          result.created.push({
            vendorProductId: Number(row.id),
            productId: Number(row.product_id),
            productVariantId: row.product_variant_id == null
              ? null
              : Number(row.product_variant_id),
          });
          action = "created";
        } else {
          // ON CONFLICT waits for a concurrent inserter. Re-select with a row
          // lock to capture a stable before-image and prevent lost updates.
          const existingResult = await tx.execute(sql`
            SELECT *
            FROM procurement.vendor_products
            WHERE vendor_id = ${vendorId}
              AND product_id = ${entry.productId}
              AND COALESCE(product_variant_id, 0) = ${variantId ?? 0}
            FOR UPDATE
          `);
          const existing = existingResult.rows?.[0];
          if (!existing) {
            throw new PurchasingError(
              "Vendor catalog conflict could not be resolved; retry the request",
              409,
              {
                code: "VENDOR_CATALOG_CONFLICT_RETRY",
                vendorId,
                productId: entry.productId,
                productVariantId: variantId,
              },
            );
          }
          if (entry.isPreferred === undefined && Number(existing.is_preferred ?? 0) === 1) {
            const demotions = await demoteCompetingPreferredMappings(tx, {
              vendorId,
              productId: entry.productId,
              productVariantId: variantId,
              updatedAt: quoteWriteTime,
            });
            appendPreferredDemotionAudits(
              auditRows,
              demotions,
              actorType,
              actorId,
              { vendorId, productId: entry.productId, productVariantId: variantId },
            );
          }
          before = catalogAuditSnapshot(existing);
          const patch: Record<string, unknown> = {
            unitCostCents: resolvedPricing.unitCostCents,
            unitCostMills: resolvedPricing.unitCostMills,
            pricingBasis: resolvedPricing.pricingBasis,
            purchaseUom: resolvedPricing.purchaseUom,
            quotedUnitCostMills: resolvedPricing.quotedUnitCostMills,
            piecesPerPurchaseUom: resolvedPricing.piecesPerPurchaseUom,
            quoteReference: resolvedPricing.quoteReference,
            quotedAt,
            quoteValidUntil: resolvedPricing.quoteValidUntil,
            isActive: 1,
            updatedAt: now(),
          };
          if (entry.packSize !== undefined && entry.packSize !== null) {
            patch.packSize = entry.packSize;
          } else if (resolvedPricing.piecesPerPurchaseUom !== null) {
            patch.packSize = resolvedPricing.piecesPerPurchaseUom;
          }
          if (entry.moq !== undefined && entry.moq !== null) patch.moq = entry.moq;
          if (entry.leadTimeDays !== undefined && entry.leadTimeDays !== null) {
            patch.leadTimeDays = entry.leadTimeDays;
          }
          if (entry.vendorSku !== undefined && entry.vendorSku !== null) {
            patch.vendorSku = entry.vendorSku;
          }
          if (entry.vendorProductName !== undefined && entry.vendorProductName !== null) {
            patch.vendorProductName = entry.vendorProductName;
          }
          if (entry.isPreferred !== undefined) {
            patch.isPreferred = entry.isPreferred ? 1 : 0;
          }

          const updatedRows = await tx
            .update(vendorProductsTable)
            .set(patch)
            .where(eq(vendorProductsTable.id, Number(existing.id)))
            .returning();
          row = updatedRows[0];
          if (!row) {
            throw new PurchasingError("Vendor catalog row disappeared during update", 409, {
              code: "VENDOR_CATALOG_CONFLICT_RETRY",
              vendorProductId: Number(existing.id),
            });
          }
          result.updated.push({
            vendorProductId: Number(row.id),
            productId: Number(row.productId),
            productVariantId: row.productVariantId == null
              ? null
              : Number(row.productVariantId),
          });
          action = "updated";
        }

        const vendorProductId = Number(row.id);
        auditRows.push({
          level: "AUDIT",
          actor: `${actorType}:${actorId}`,
          action: `vendor_catalog.${action}`,
          target: `vendor_product:${vendorProductId}`,
          changes: {
            before,
            after: catalogAuditSnapshot(row),
          },
          context: {
            vendorId,
            vendorProductId,
            productId: entry.productId,
            productVariantId: variantId,
          },
        });
      }

      // Audit persistence is deliberately atomic with the catalog changes.
      // A failed audit insert rolls back every row in the batch.
      if (auditRows.length > 0) {
        await insertAuditEventDrizzle(tx, auditRows);
      }
    };

    try {
      if (existingTransaction) {
        await execute(existingTransaction);
      } else {
        await db.transaction(execute);
      }
    } catch (error: any) {
      if (
        error?.code === "23505" &&
        error?.constraint === "vendor_products_one_active_preferred_key_uidx"
      ) {
        throw new PurchasingError(
          "Another active preferred vendor mapping already exists for this product/configuration",
          409,
          { code: "VENDOR_CATALOG_PREFERRED_CONFLICT" },
        );
      }
      if (
        error?.code === "23505" &&
        error?.constraint === "vendor_products_vendor_product_variant_key_uidx"
      ) {
        throw new PurchasingError("Vendor catalog mapping changed concurrently; retry", 409, {
          code: "VENDOR_CATALOG_CONFLICT_RETRY",
        });
      }
      throw error;
    }

    return result;
  }

  return {
    persistCompletedVendorPurchaseEvidenceTx,
    persistPurchaseOrderCatalogWritesTx,
    catalogAuditSnapshot,
    lockVendorProductReferences,
    demoteCompetingPreferredMappings,
    appendPreferredDemotionAudits,
    createVendorProduct,
    updateVendorProduct,
    deactivateVendorProduct,
    applyReviewedSupplierEvidenceImport,
    bulkUpsertVendorCatalog,
  };
}

export type PurchasingCatalog = ReturnType<typeof createPurchasingCatalog>;

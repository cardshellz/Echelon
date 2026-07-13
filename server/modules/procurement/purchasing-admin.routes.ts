import type { Express } from "express";
import { z } from "zod";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import { PurchasingError } from "./purchasing.service";
import { millsToCents } from "@shared/utils/money";
import {
  normalizePoLinePricing,
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";

const PG_INTEGER_MAX = 2_147_483_647;
const MAX_QUOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const positivePgInteger = z.number().int().positive().max(PG_INTEGER_MAX);
const nonnegativePgInteger = z.number().int().min(0).max(PG_INTEGER_MAX);
const nonnegativeSafeInteger = z.number().int().min(0).safe();
const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();
const nullablePositivePgInteger = positivePgInteger.nullable().optional();

function isValidIsoDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidQuoteTimestamp(value: string): boolean {
  if (isValidIsoDateOnly(value)) return true;
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isValidIsoDateOnly(match[1])) return false;
  return !Number.isNaN(new Date(value).getTime());
}

const quotedAtValue = z.union([
  z.date(),
  z.string().trim().refine(isValidQuoteTimestamp, {
    message: "quotedAt must be a real YYYY-MM-DD date or ISO-8601 timestamp",
  }).transform((value) => new Date(
    isValidIsoDateOnly(value) ? `${value}T00:00:00.000Z` : value,
  )),
]).nullable().optional();

const quoteValidUntilValue = z.string().trim().refine(isValidIsoDateOnly, {
  message: "quoteValidUntil must be a real YYYY-MM-DD calendar date",
}).nullable().optional();

const vendorCatalogPricingSchema = z.discriminatedUnion("basis", [
  z.object({
    basis: z.literal("per_piece"),
    quantityPieces: positivePgInteger,
    unitCostMills: nonnegativeSafeInteger,
  }).strict(),
  z.object({
    basis: z.literal("per_purchase_uom"),
    purchaseUom: z.string().trim().min(1).max(50),
    uomQuantity: positivePgInteger,
    piecesPerUom: positivePgInteger,
    quotedCostMillsPerUom: nonnegativeSafeInteger,
  }).strict(),
  z.object({
    basis: z.literal("extended_total"),
    quantityPieces: positivePgInteger,
    quotedTotalCents: nonnegativeSafeInteger,
  }).strict(),
]);

const vendorProductMutableFields = {
  vendorId: positivePgInteger.optional(),
  productId: positivePgInteger.optional(),
  productVariantId: nullablePositivePgInteger,
  vendorSku: nullableText(100),
  vendorProductName: nullableText(20_000),
  pricing: vendorCatalogPricingSchema.optional(),
  unitCostMills: nonnegativeSafeInteger.nullable().optional(),
  unitCostCents: nonnegativeSafeInteger.nullable().optional(),
  quoteReference: nullableText(255),
  quotedAt: quotedAtValue,
  quoteValidUntil: quoteValidUntilValue,
  packSize: nullablePositivePgInteger,
  moq: nullablePositivePgInteger,
  leadTimeDays: nonnegativePgInteger.nullable().optional(),
  isPreferred: z.union([z.literal(0), z.literal(1)]).optional(),
  isActive: z.union([z.literal(0), z.literal(1)]).optional(),
  notes: nullableText(20_000),
};

const createVendorProductBodySchema = z.object({
  ...vendorProductMutableFields,
  vendorId: positivePgInteger,
  productId: positivePgInteger,
}).strict();

const {
  vendorId: _updateVendorId,
  productId: _updateProductId,
  productVariantId: _updateProductVariantId,
  ...vendorProductUpdateFields
} = vendorProductMutableFields;

// Mapping identity is immutable because historical PO lines retain the
// vendorProductId as quote provenance. Reassignment requires a new mapping
// and deactivation of the old one.
const updateVendorProductBodySchema = z.object(vendorProductUpdateFields)
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one vendor-product field is required",
  });

const upsertVendorProductBodySchema = z.object({
  vendorId: positivePgInteger,
  productId: positivePgInteger,
  // This endpoint is used by PO-line catalog capture, where the selected
  // receive variant is part of the catalog identity. Product-level mappings
  // remain available through the generic create endpoint and bulk upsert.
  productVariantId: positivePgInteger,
  vendorSku: nullableText(100),
  pricing: vendorCatalogPricingSchema.optional(),
  unitCostMills: nonnegativeSafeInteger.nullable().optional(),
  unitCostCents: nonnegativeSafeInteger.nullable().optional(),
  quoteReference: nullableText(255),
  quotedAt: quotedAtValue,
  quoteValidUntil: quoteValidUntilValue,
  packSize: nullablePositivePgInteger,
  isPreferred: z.union([
    z.boolean(),
    z.literal(0),
    z.literal(1),
  ]).transform((value) => value === true || value === 1).optional(),
}).strict();

const bulkVendorProductEntrySchema = z.object({
  productId: positivePgInteger,
  productVariantId: nullablePositivePgInteger,
  vendorSku: nullableText(100),
  vendorProductName: nullableText(20_000),
  pricing: vendorCatalogPricingSchema.optional(),
  unitCostMills: nonnegativeSafeInteger.nullable().optional(),
  unitCostCents: nonnegativeSafeInteger.nullable().optional(),
  quoteReference: nullableText(255),
  quotedAt: quotedAtValue,
  quoteValidUntil: quoteValidUntilValue,
  packSize: nullablePositivePgInteger,
  moq: nullablePositivePgInteger,
  leadTimeDays: nonnegativePgInteger.nullable().optional(),
  isPreferred: z.union([
    z.boolean(),
    z.literal(0),
    z.literal(1),
  ]).transform((value) => value === true || value === 1).optional(),
}).strict();

const bulkVendorProductBodySchema = z.object({
  entries: z.array(bulkVendorProductEntrySchema).min(1).max(2_000),
}).strict();

function vendorProductValidationError(error: z.ZodError): PurchasingError {
  return new PurchasingError("Invalid vendor-product request", 400, {
    code: "VENDOR_PRODUCT_REQUEST_INVALID",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function parseVendorProductBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw vendorProductValidationError(parsed.error);
  return parsed.data;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function resolveVendorCatalogPricing(body: {
  pricing?: PoLinePricingInput;
  unitCostMills?: number | null;
  unitCostCents?: number | null;
  quoteReference?: string | null;
  quotedAt?: Date | null;
  quoteValidUntil?: string | null;
}): {
  unitCostMills: number;
  unitCostCents: number;
  pricingBasis: "legacy_unknown" | "per_piece" | "per_purchase_uom";
  purchaseUom: string | null;
  quotedUnitCostMills: number | null;
  piecesPerPurchaseUom: number | null;
  quoteReference: string | null;
  quotedAt: Date | null;
  quoteValidUntil: string | null;
} {
  const hasPricing = hasOwn(body, "pricing") && body.pricing !== undefined;
  const hasMillsField = hasOwn(body, "unitCostMills");
  const hasCentsField = hasOwn(body, "unitCostCents");
  const hasQuoteMetadata =
    hasOwn(body, "quoteReference") ||
    hasOwn(body, "quotedAt") ||
    hasOwn(body, "quoteValidUntil");
  if (hasPricing && (hasMillsField || hasCentsField)) {
    throw new PurchasingError(
      "pricing cannot be combined with legacy unitCostMills or unitCostCents fields",
      400,
      { code: "VENDOR_CATALOG_PRICING_AMBIGUOUS" },
    );
  }

  if (hasPricing) {
    const pricing = body.pricing as PoLinePricingInput;
    if (pricing?.basis === "extended_total") {
      throw new PurchasingError(
        "An extended-total quote is quantity-specific and cannot be saved as a reusable catalog price",
        400,
        { code: "VENDOR_CATALOG_EXTENDED_TOTAL_NOT_REUSABLE" },
      );
    }
    let normalized;
    try {
      normalized = normalizePoLinePricing(pricing);
    } catch (error: any) {
      throw new PurchasingError(error?.message || "Invalid vendor catalog pricing", 400, {
        code: "VENDOR_CATALOG_PRICING_INVALID",
      });
    }
    if (!(body.quotedAt instanceof Date) || Number.isNaN(body.quotedAt.getTime())) {
      throw new PurchasingError(
        "quotedAt is required for an explicit reusable vendor catalog quote",
        400,
        { code: "VENDOR_CATALOG_QUOTED_AT_REQUIRED" },
      );
    }
    const quotedAt = body.quotedAt;
    if (quotedAt.getTime() > Date.now() + MAX_QUOTE_CLOCK_SKEW_MS) {
      throw new PurchasingError("quotedAt cannot be materially in the future", 400, {
        code: "VENDOR_CATALOG_QUOTED_AT_IN_FUTURE",
      });
    }
    if (
      body.quoteValidUntil &&
      body.quoteValidUntil < quotedAt.toISOString().slice(0, 10)
    ) {
      throw new PurchasingError("quoteValidUntil cannot be earlier than quotedAt", 400, {
        code: "VENDOR_CATALOG_QUOTE_DATE_INVALID",
      });
    }
    return {
      unitCostMills: normalized.unitCostMills,
      unitCostCents: normalized.unitCostCents,
      pricingBasis: pricing.basis,
      purchaseUom: normalized.purchaseUom,
      quotedUnitCostMills: normalized.quotedUnitCostMills,
      piecesPerPurchaseUom: normalized.piecesPerPurchaseUom,
      quoteReference: body.quoteReference ?? null,
      quotedAt,
      quoteValidUntil: body.quoteValidUntil ?? null,
    };
  }

  if (hasQuoteMetadata) {
    throw new PurchasingError(
      "Quote metadata can only be supplied with an explicit reusable pricing basis",
      400,
      { code: "VENDOR_CATALOG_QUOTE_METADATA_REQUIRES_PRICING" },
    );
  }

  const rawMills = body.unitCostMills;
  const rawCents = body.unitCostCents;
  if (!hasMillsField && !hasCentsField) {
    throw new PurchasingError("pricing, unitCostMills, or unitCostCents is required", 400, {
      code: "VENDOR_CATALOG_PRICE_REQUIRED",
    });
  }
  if (rawMills == null && rawCents == null) {
    throw new PurchasingError("A supplied legacy catalog price cannot be null", 400, {
      code: "VENDOR_CATALOG_PRICE_REQUIRED",
    });
  }
  const unitCostMills = rawMills == null
    ? Number(rawCents) * 100
    : Number(rawMills);
  if (!Number.isSafeInteger(unitCostMills) || unitCostMills < 0) {
    throw new PurchasingError("unitCostMills or unitCostCents must be a non-negative integer", 400);
  }
  const unitCostCents = millsToCents(unitCostMills);
  if (
    rawCents != null &&
    (!Number.isSafeInteger(Number(rawCents)) || Number(rawCents) !== unitCostCents)
  ) {
    throw new PurchasingError("unitCostMills and unitCostCents disagree", 400, {
      code: "VENDOR_CATALOG_MONEY_MISMATCH",
      expectedUnitCostCents: unitCostCents,
    });
  }
  return {
    unitCostMills,
    unitCostCents,
    pricingBasis: "legacy_unknown",
    purchaseUom: null,
    quotedUnitCostMills: null,
    piecesPerPurchaseUom: null,
    quoteReference: null,
    quotedAt: null,
    quoteValidUntil: null,
  };
}

function buildVendorProductWrite(
  body: z.output<typeof createVendorProductBodySchema> | z.output<typeof updateVendorProductBodySchema>,
  requirePrice: boolean,
): Record<string, unknown> {
  const hasPriceFields =
    hasOwn(body, "pricing") || hasOwn(body, "unitCostMills") || hasOwn(body, "unitCostCents");
  const {
    pricing: _pricing,
    unitCostMills: _unitCostMills,
    unitCostCents: _unitCostCents,
    quoteReference: _quoteReference,
    quotedAt: _quotedAt,
    quoteValidUntil: _quoteValidUntil,
    ...mutableFields
  } = body;

  const hasQuoteFields =
    hasOwn(body, "quoteReference") ||
    hasOwn(body, "quotedAt") ||
    hasOwn(body, "quoteValidUntil");
  const suppliedQuoteFields = {
    ...(hasOwn(body, "quoteReference")
      ? { quoteReference: body.quoteReference ?? null }
      : {}),
    ...(hasOwn(body, "quotedAt")
      ? { quotedAt: body.quotedAt ?? null }
      : {}),
    ...(hasOwn(body, "quoteValidUntil")
      ? { quoteValidUntil: body.quoteValidUntil ?? null }
      : {}),
  };

  if (!hasPriceFields) {
    if (requirePrice) {
      throw new PurchasingError("A vendor-product price is required", 400, {
        code: "VENDOR_CATALOG_PRICE_REQUIRED",
      });
    }
    // Quote metadata can be corrected independently of the economics. In
    // particular, changing a reference or validity date must not silently
    // refresh quotedAt. The service merges these fields with the locked row
    // and rejects them when the stored mapping is still legacy_unknown.
    return hasQuoteFields
      ? { ...mutableFields, ...suppliedQuoteFields }
      : mutableFields;
  }

  return {
    ...mutableFields,
    ...resolveVendorCatalogPricing(body),
  };
}

function parseVendorProductId(rawId: string): number {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
    throw new PurchasingError("Vendor product id must be a positive integer", 400, {
      code: "VENDOR_PRODUCT_ID_INVALID",
    });
  }
  return id;
}

export function registerPurchasingAdminRoutes(app: Express) {
  const { purchasing } = app.locals.services;


  // Vendor Products

  app.get("/api/vendor-products", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const filters = {
        vendorId: req.query.vendorId ? Number(req.query.vendorId) : undefined,
        productId: req.query.productId ? Number(req.query.productId) : undefined,
        productVariantId: req.query.productVariantId ? Number(req.query.productVariantId) : undefined,
        isActive: req.query.isActive !== undefined ? Number(req.query.isActive) : undefined,
      };
      const vendorProducts = await purchasing.getVendorProducts(filters);
      res.json({ vendorProducts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/vendor-products", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const body = parseVendorProductBody(createVendorProductBodySchema, req.body);
      const vp = await purchasing.createVendorProduct(
        buildVendorProductWrite(body, true),
        req.session.user?.id,
      );
      res.status(201).json(vp);
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Upsert: create or update vendor catalog entry by (vendorId, productId, productVariantId)
  app.post("/api/vendor-products/upsert", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const body = parseVendorProductBody(upsertVendorProductBodySchema, req.body);
      // Validate price/quote coherence at the HTTP boundary; the transactional
      // bulk service repeats the checks before writing.
      resolveVendorCatalogPricing(body);
      const { vendorId, ...entry } = body;
      const result = await purchasing.bulkUpsertVendorCatalog(
        vendorId,
        [entry],
        req.session.user?.id,
      );
      const outcome = result.created[0] ?? result.updated[0];
      if (!outcome) {
        throw new PurchasingError("Vendor-product upsert produced no result", 409, {
          code: "VENDOR_CATALOG_CONFLICT_RETRY",
        });
      }
      const vp = await purchasing.getVendorProductById(outcome.vendorProductId);
      if (!vp) {
        throw new PurchasingError("Vendor-product upsert result could not be loaded", 409, {
          code: "VENDOR_CATALOG_CONFLICT_RETRY",
        });
      }
      res.json({ vp, created: result.created.length === 1 });
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/vendor-products/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const id = parseVendorProductId(req.params.id);
      const body = parseVendorProductBody(updateVendorProductBodySchema, req.body);
      const vp = await purchasing.updateVendorProduct(
        id,
        buildVendorProductWrite(body, false),
        req.session.user?.id,
      );
      if (!vp) return res.status(404).json({ error: "Vendor product not found" });
      res.json(vp);
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/vendor-products/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const id = parseVendorProductId(req.params.id);
      const deleted = await purchasing.deleteVendorProduct(id, req.session.user?.id);
      if (!deleted) return res.status(404).json({ error: "Vendor product not found" });
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/products/:id/vendors", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorProducts = await purchasing.getVendorProducts({ productId: Number(req.params.id) });
      res.json(vendorProducts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/vendors/:id/products", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorProducts = await purchasing.getVendorProducts({ vendorId: Number(req.params.id) });
      res.json({ vendorProducts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Spec A follow-up: bulk upsert vendor catalog entries. Backs the
  app.post(
    "/api/vendors/:vendorId/catalog/bulk-upsert",
    requirePermission("purchasing", "edit"),
    requireIdempotency(),
    async (req, res) => {
      try {
        const vendorId = Number(req.params.vendorId);
        if (!Number.isSafeInteger(vendorId) || vendorId <= 0 || vendorId > PG_INTEGER_MAX) {
          return res.status(400).json({ error: "Invalid vendorId" });
        }
        const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
        // Normalize snake_case and carry through both unit_cost_cents and
        // unit_cost_mills. The service validator enforces pair agreement.
        const normalizedBody = { entries: rawEntries.map((e: any) => {
          const out: any = {
            productId: e.productId ?? e.product_id,
            productVariantId: e.productVariantId ?? e.product_variant_id ?? null,
            packSize: e.packSize ?? e.pack_size,
            moq: e.moq,
            leadTimeDays: e.leadTimeDays ?? e.lead_time_days,
            vendorSku: e.vendorSku ?? e.vendor_sku,
            vendorProductName: e.vendorProductName ?? e.vendor_product_name,
            isPreferred: e.isPreferred ?? e.is_preferred,
            pricing: e.pricing,
          };
          // Optional quote fields are presence-sensitive in the service: an
          // absent field means "no metadata supplied", while explicit null
          // means "clear this field". Do not manufacture own-properties whose
          // value is undefined while normalizing snake_case aliases.
          if (hasOwn(e, "quoteReference") || hasOwn(e, "quote_reference")) {
            out.quoteReference = hasOwn(e, "quoteReference")
              ? e.quoteReference
              : e.quote_reference;
          }
          if (hasOwn(e, "quotedAt") || hasOwn(e, "quoted_at")) {
            out.quotedAt = hasOwn(e, "quotedAt") ? e.quotedAt : e.quoted_at;
          }
          if (hasOwn(e, "quoteValidUntil") || hasOwn(e, "quote_valid_until")) {
            out.quoteValidUntil = hasOwn(e, "quoteValidUntil")
              ? e.quoteValidUntil
              : e.quote_valid_until;
          }
          const cents = e.unitCostCents ?? e.unit_cost_cents;
          const mills = e.unitCostMills ?? e.unit_cost_mills;
          if (cents !== undefined && cents !== null) out.unitCostCents = cents;
          if (mills !== undefined && mills !== null) out.unitCostMills = mills;
          return out;
        }) };
        const { entries } = parseVendorProductBody(
          bulkVendorProductBodySchema,
          normalizedBody,
        );
        const userId = req.session.user?.id;
        const result = await purchasing.bulkUpsertVendorCatalog(vendorId, entries, userId);
        res.json(result);
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message, details: error.details });
        }
        console.error("[catalog bulk-upsert] error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Spec A follow-up: two-layer catalog typeahead for the new PO editor.
  // Returns vendor-catalog matches (top) and non-catalog product matches (bottom).
  app.get(
    "/api/vendors/:vendorId/catalog-search",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const vendorId = Number(req.params.vendorId);
        if (!Number.isInteger(vendorId) || vendorId <= 0) {
          return res.status(400).json({ error: "Invalid vendorId" });
        }
        const vendor = await storage.getVendorById(vendorId);
        if (!vendor) return res.status(404).json({ error: "Vendor not found" });
        const q = typeof req.query.q === "string" ? req.query.q : "";
        const limitRaw = Number(req.query.limit);
        const limit =
          Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.min(100, Math.floor(limitRaw))
            : 50;
        const result = await storage.searchVendorCatalog({ vendorId, q, limit });
        res.json(result);
      } catch (error: any) {
        console.error("[catalog-search] error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Approval Tiers

  app.get("/api/purchasing/approval-tiers", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const tiers = await purchasing.getApprovalTiers();
      res.json({ tiers });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchasing/approval-tiers", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const tier = await purchasing.createApprovalTier(req.body);
      res.status(201).json(tier);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchasing/approval-tiers/:id", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const tier = await purchasing.updateApprovalTier(Number(req.params.id), req.body);
      if (!tier) return res.status(404).json({ error: "Approval tier not found" });
      res.json(tier);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchasing/approval-tiers/:id", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const deleted = await purchasing.deleteApprovalTier(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Approval tier not found" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Reorder to PO

  app.post("/api/purchasing/create-po-from-reorder", requirePermission("purchasing", "create"), async (req, res) => {
    res.status(410).json({
      error: "Direct reorder PO creation has been removed",
      message:
        "Use the purchasing recommendation engine auto-draft endpoints so PO creation is governed by exclusion rules, confidence, and the active approval policy.",
    });
  });

}

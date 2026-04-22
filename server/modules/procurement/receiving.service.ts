/**
 * Receiving service for Echelon WMS.
 *
 * Handles PO close (atomic inventory receipt via inventoryCore + channelSync),
 * bulk CSV import with fuzzy location matching, SKU hierarchy variant creation,
 * and receiving order state transitions.
 */

// ── Minimal dependency interfaces ───────────────────────────────────

type DrizzleDb = {
  execute: (query: any) => Promise<{ rows: any[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// Import sql tagged template for raw queries
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { millsToCents } from "@shared/utils/money";

interface InventoryCore {
  receiveInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
    unitCostCents?: number;
    receivingOrderId?: number;
    purchaseOrderId?: number;
    inboundShipmentId?: number;
    costProvisional?: number;
  }, tx?: any): Promise<void>;
}

interface ChannelSync {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
}

interface Purchasing {
  onReceivingOrderClosed(receivingOrderId: number, receivingLines: Array<{
    receivingLineId: number;
    purchaseOrderLineId?: number;
    receivedQty: number;
    damagedQty?: number;
    unitCost?: number;
  }>): Promise<void>;
}

interface ShipmentTracking {
  getLandedCostForPoLine(purchaseOrderLineId: number): Promise<number | null>;
}

interface Storage {
  // Receiving orders
  getReceivingOrderById(id: number): Promise<any>;
  getReceivingLines(orderId: number): Promise<any[]>;
  getReceivingLineById(lineId: number): Promise<any>;
  updateReceivingOrder(id: number, updates: any, tx?: any): Promise<any>;
  updateReceivingLine(lineId: number, updates: any, tx?: any): Promise<any>;
  bulkCreateReceivingLines(lines: any[], tx?: any): Promise<any[]>;
  // PO line lookup — used to pull the 4-decimal unit_cost_mills when
  // stamping per-unit cost on lots/receipts, so receive-time precision
  // matches the PO line (spec 2026-04-22).
  getPurchaseOrderLineById?(id: number): Promise<any>;
  getVendorById(id: number): Promise<any>;
  // Inventory lookups
  getProductVariantBySku(sku: string): Promise<any>;
  getProductVariantById(id: number): Promise<any>;
  getProductVariantsByProductId(productId: number): Promise<any[]>;
  getAllProductVariants(): Promise<any[]>;
  getProductBySku(sku: string): Promise<any>;
  createProduct(data: any): Promise<any>;
  createProductVariant(data: any): Promise<any>;
  // Location lookups
  getAllWarehouseLocations(): Promise<any[]>;
  getAllProductLocations(): Promise<any[]>;
  // Products
  getAllProducts(): Promise<any[]>;
  // Settings
  getSetting(key: string): Promise<string | null>;
}

// ── Error class ─────────────────────────────────────────────────────

export class ReceivingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "ReceivingError";
  }
}

export class ReceivingReconciliationError extends ReceivingError {
  constructor(message: string, details?: any) {
    super(message, 409, details);
    this.name = "ReceivingReconciliationError";
  }
}

// ── Helper: fuzzy location code matching ────────────────────────────

function normalizeLocationCode(input: string): string[] {
  const clean = input.trim().toUpperCase();
  const candidates = new Set<string>();
  candidates.add(clean);

  // Strip all hyphens
  candidates.add(clean.replace(/-/g, ""));

  // Zero-pad single-digit numeric segments
  const segments = clean.split("-");
  const padded = segments.map((seg) => {
    const num = parseInt(seg, 10);
    if (!isNaN(num) && seg === num.toString()) return num.toString().padStart(2, "0");
    return seg;
  });
  candidates.add(padded.join("-"));
  candidates.add(padded.join(""));

  // If no hyphens, insert at letter↔digit transitions: H6 → H-6, J1A → J-1-A
  if (!clean.includes("-")) {
    const withHyphens = clean
      .replace(/([A-Z])(\d)/g, "$1-$2")
      .replace(/(\d)([A-Z])/g, "$1-$2");
    candidates.add(withHyphens);
    // Also pad the hyphenated version
    const hSegments = withHyphens.split("-");
    const hPadded = hSegments.map((seg) => {
      const num = parseInt(seg, 10);
      if (!isNaN(num) && seg === num.toString()) return num.toString().padStart(2, "0");
      return seg;
    });
    candidates.add(hPadded.join("-"));
    candidates.add(hPadded.join(""));
  }

  return Array.from(candidates);
}

// ── Service class ───────────────────────────────────────────────────

export class ReceivingService {
  constructor(
    private db: DrizzleDb,
    private inventoryCore: InventoryCore,
    private channelSync: ChannelSync,
    private storage: Storage,
    private purchasing: Purchasing | null = null,
    private shipmentTracking: ShipmentTracking | null = null,
  ) {}

  // ─── Open ─────────────────────────────────────────────────────

  async open(orderId: number, userId: string | null) {
    const order = await this.storage.getReceivingOrderById(orderId);
    if (!order) throw new ReceivingError("Receiving order not found", 404);
    if (order.status !== "draft") throw new ReceivingError("Can only open orders in draft status");

    const updated = await this.storage.updateReceivingOrder(orderId, {
      status: "open",
      receivedBy: userId,
      receivedDate: new Date(),
    });

    const lines = await this.storage.getReceivingLines(orderId);
    const vendor = order.vendorId ? await this.storage.getVendorById(order.vendorId) : null;
    return { ...updated, lines, vendor };
  }

  // ─── Close ────────────────────────────────────────────────────

  async close(orderId: number, userId: string | null) {
    const order = await this.storage.getReceivingOrderById(orderId);
    if (!order) throw new ReceivingError("Receiving order not found", 404);
    if (order.status === "closed" || order.status === "cancelled") {
      throw new ReceivingError("Order already closed or cancelled");
    }

    const lines = await this.storage.getReceivingLines(orderId);

    // Auto-resolve missing productVariantId from SKU before processing
    for (const line of lines) {
      if (line.receivedQty > 0 && !line.productVariantId && line.sku) {
        const variant = await this.storage.getProductVariantBySku(line.sku);
        if (variant) {
          await this.storage.updateReceivingLine(line.id, { productVariantId: variant.id });
          (line as any).productVariantId = variant.id;
        }
      }
    }

    // Block close if any received lines are still missing required data
    const unresolvable = lines.filter((l: any) => l.receivedQty > 0 && (!l.productVariantId || !l.putawayLocationId));
    if (unresolvable.length > 0) {
      const issues = unresolvable.map((l: any) => ({
        lineId: l.id,
        sku: l.sku || "(no SKU)",
        missingVariant: !l.productVariantId,
        missingLocation: !l.putawayLocationId,
      }));
      throw new ReceivingError(
        `${unresolvable.length} received line(s) cannot be processed`,
        400,
        { issues, hint: "Link SKUs to product variants and assign putaway locations before closing." },
      );
    }

    // Process each line using inventoryCore (atomic, transaction-wrapped)
    const batchId = `RCV-${orderId}-${Date.now()}`;
    let totalReceived = 0;
    let linesReceived = 0;
    const receivedVariantIds = new Set<number>();
    const putawayLocationIds = new Set<number>();

    const updated = await this.db.transaction(async (tx) => {
      for (const line of lines) {
      if (line.receivedQty > 0 && line.productVariantId && line.putawayLocationId) {
        const qtyToAdd = line.receivedQty;

        // Determine unit cost: landed cost (if finalized) > PO line cost > receiving line cost
        //
        // Precision: when the receipt is linked to a PO line and that line
        // carries 4-decimal unit_cost_mills, use it as the authoritative
        // source and round to cents via millsToCents (half-up). This prevents
        // precision loss at receive time on costs like $0.0375 that would
        // otherwise collapse to 4 cents silently. (Only applied when neither
        // the receiving_line.unit_cost nor a finalized landed cost has
        // already been resolved.)
        let unitCostCents = (line as any).unitCost || undefined;
        if (
          (unitCostCents === undefined || unitCostCents === null) &&
          line.purchaseOrderLineId &&
          typeof (this.storage as any).getPurchaseOrderLineById === "function"
        ) {
          try {
            const poLine = await (this.storage as any).getPurchaseOrderLineById(
              line.purchaseOrderLineId,
            );
            if (poLine) {
              if (
                typeof poLine.unitCostMills === "number" &&
                poLine.unitCostMills >= 0
              ) {
                unitCostCents = millsToCents(poLine.unitCostMills);
              } else if (typeof poLine.unitCostCents === "number") {
                unitCostCents = poLine.unitCostCents;
              }
            }
          } catch {
            // Non-fatal: fall through to landed-cost / receipt-line fallbacks.
          }
        }
        let costProvisional = 0;
        let inboundShipmentId: number | undefined;

        if (line.purchaseOrderLineId && this.shipmentTracking) {
          try {
            const landedCost = await this.shipmentTracking.getLandedCostForPoLine(line.purchaseOrderLineId);
            if (landedCost !== null) {
              unitCostCents = landedCost;
            } else if (order.inboundShipmentId) {
              // Shipment exists but costs not finalized — mark provisional
              costProvisional = 1;
              inboundShipmentId = order.inboundShipmentId;
            }
          } catch {
            // Non-critical — fall through to PO/line cost
          }
        } else if (order.inboundShipmentId) {
          // Receiving order linked to shipment but no tracking service — mark provisional
          costProvisional = 1;
          inboundShipmentId = order.inboundShipmentId;
        }

        await this.inventoryCore.receiveInventory({
          productVariantId: line.productVariantId,
          warehouseLocationId: line.putawayLocationId,
          qty: qtyToAdd,
          referenceId: batchId,
          notes: `Received from ${order.sourceType === "po" ? `PO ${order.poNumber}` : order.receiptNumber}`,
          userId: userId || undefined,
          unitCostCents,
          receivingOrderId: orderId,
          purchaseOrderId: order.purchaseOrderId || undefined,
          inboundShipmentId,
          costProvisional,
        }, tx);

        // Mark line as put away
        await this.storage.updateReceivingLine(line.id, {
          putawayComplete: 1,
          status: "complete",
        }, tx);

        totalReceived += qtyToAdd;
        linesReceived++;
        receivedVariantIds.add(line.productVariantId);
        putawayLocationIds.add(line.putawayLocationId);
      }
    }

    // Auto-break cases into base units for child variant ATP
    for (const line of lines) {
      if (line.receivedQty > 0 && line.productVariantId) {
        const variant = await this.storage.getProductVariantById(line.productVariantId);
        if (variant && (variant as any).hierarchyLevel > 1) {
          // Find the base unit variant (hierarchy_level = 1) for this product
          const allVariants = await this.storage.getProductVariantsByProductId((variant as any).productId);
          const baseVariant = allVariants.find((v: any) => v.hierarchyLevel === 1);
          if (baseVariant && baseVariant.id !== line.productVariantId) {
            const totalUnits = line.receivedQty * (variant as any).unitsPerVariant;
            await this.inventoryCore.receiveInventory({
              productVariantId: baseVariant.id,
              warehouseLocationId: line.putawayLocationId,
              qty: totalUnits,
              referenceId: `BREAK-${batchId}-${line.id}`,
              notes: `Auto-break: ${line.receivedQty}× ${variant.sku} → ${totalUnits}× ${baseVariant.sku}`,
              userId: userId || undefined,
              unitCostCents: (line as any).unitCost || undefined,
              receivingOrderId: orderId,
            }, tx);

            // Deduct the case variant inventory to avoid double-counting in ATP
            // The base units are now the sellable quantity; the case is empty
            const check = await tx.execute(sql`
              SELECT variant_qty FROM inventory.inventory_levels
              WHERE product_variant_id = ${line.productVariantId}
                AND warehouse_location_id = ${line.putawayLocationId}
              FOR UPDATE
            `);
            const currentQty = check.rows.length ? Number(check.rows[0].variant_qty) : 0;
            if (currentQty < line.receivedQty) {
              throw new ReceivingReconciliationError(`Negative Inventory Guard: Cannot break case variant ${line.productVariantId}. Requires ${line.receivedQty}, has ${currentQty}.`);
            }
            await tx.execute(sql`
              UPDATE inventory.inventory_levels
              SET variant_qty = variant_qty - ${line.receivedQty},
                  updated_at = NOW()
              WHERE product_variant_id = ${line.productVariantId}
                AND warehouse_location_id = ${line.putawayLocationId}
            `);
            receivedVariantIds.add(baseVariant.id);
          }
        }
      }
    }

    // Fire channel sync for all received variants (fire-and-forget)
    for (const variantId of Array.from(receivedVariantIds)) {
      this.channelSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
        console.warn(`[ChannelSync] Post-receive sync failed for variant ${variantId}:`, err),
      );
    }

      // Update order totals and close
      return await this.storage.updateReceivingOrder(orderId, {
        status: "closed",
        closedDate: new Date(),
        closedBy: userId,
        receivedLineCount: linesReceived,
        receivedTotalUnits: totalReceived,
      }, tx);
    });

    // Fire channel sync for all received variants (fire-and-forget)

    // If this receipt is linked to a PO, update PO line quantities and auto-transition status
    if (order.purchaseOrderId && this.purchasing) {
      try {
        await this.purchasing.onReceivingOrderClosed(orderId, lines.map((l: any) => ({
          receivingLineId: l.id,
          purchaseOrderLineId: l.purchaseOrderLineId || undefined,
          receivedQty: l.receivedQty || 0,
          damagedQty: l.damagedQty || 0,
          unitCost: l.unitCost || undefined,
        })));
      } catch (err: any) {
        console.warn(`[Receiving] PO callback failed for order ${orderId}:`, err.message);
      }
    }

    return {
      success: true,
      order: updated,
      linesProcessed: linesReceived,
      unitsReceived: totalReceived,
      putawayLocationIds: Array.from(putawayLocationIds),
    };
  }

  // ─── Complete All Lines ───────────────────────────────────────

  async completeAllLines(orderId: number) {
    const lines = await this.storage.getReceivingLines(orderId);
    if (!lines || lines.length === 0) {
      throw new ReceivingError("No lines found for this order", 404);
    }

    let updated = 0;
    for (const line of lines) {
      if (line.status !== "complete") {
        // For untouched lines (receivedQty is 0 or null), set to expected qty.
        // For partially entered lines, keep what the user entered.
        const effectiveQty = (line.receivedQty != null && line.receivedQty > 0)
          ? line.receivedQty
          : (line.expectedQty || 0);
        await this.storage.updateReceivingLine(line.id, {
          receivedQty: effectiveQty,
          status: "complete",
        });
        updated++;
      }
    }

    // Update order received totals
    const updatedLines = await this.storage.getReceivingLines(orderId);
    await this.storage.updateReceivingOrder(orderId, {
      receivedLineCount: updatedLines.filter((l: any) => l.status === "complete").length,
      receivedTotalUnits: updatedLines.reduce((sum: number, l: any) => sum + (l.receivedQty || 0), 0),
    });

    // Return enriched order
    const order = await this.storage.getReceivingOrderById(orderId);
    const vendor = order?.vendorId ? await this.storage.getVendorById(order.vendorId) : null;
    return { message: `Completed ${updated} lines`, updated, order: { ...order, lines: updatedLines, vendor } };
  }

  // ─── Create Variant From Line ─────────────────────────────────

  async createVariantFromLine(lineId: number) {
    const line = await this.storage.getReceivingLineById(lineId);
    if (!line) throw new ReceivingError("Receiving line not found", 404);
    if (!line.sku) throw new ReceivingError("Line has no SKU");
    if (line.productVariantId) throw new ReceivingError("Line already has a linked product variant");

    const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
    const match = line.sku.match(variantPattern);

    let baseSku: string;
    let variantType: string;
    let unitsPerVariant: number;
    let hierarchyLevel: number;
    let variantName: string;

    if (match) {
      baseSku = match[1].toUpperCase();
      variantType = match[2].toUpperCase();
      unitsPerVariant = parseInt(match[3], 10);
      hierarchyLevel = variantType === "P" ? 1 : variantType === "B" ? 2 : 3;
      const typeName = variantType === "P" ? "Pack" : variantType === "B" ? "Box" : "Case";
      variantName = `${typeName} of ${unitsPerVariant}`;
    } else {
      // Standalone SKU — single unit
      baseSku = line.sku.toUpperCase();
      variantType = "EA";
      unitsPerVariant = 1;
      hierarchyLevel = 1;
      variantName = "Each";
    }

    // Find or create the parent product
    let product = await this.storage.getProductBySku(baseSku);
    if (!product) {
      product = await this.storage.createProduct({
        sku: baseSku,
        name: baseSku,
        baseUnit: "EA",
      });
    }

    // Create the variant
    let variant;
    try {
      variant = await this.storage.createProductVariant({
        productId: product.id,
        sku: line.sku.toUpperCase(),
        name: variantName,
        unitsPerVariant,
        hierarchyLevel,
      });
    } catch (error: any) {
      if (error.code === "23505" || error.message?.includes("unique")) {
        throw new ReceivingError("A variant with this SKU already exists. Use the search to link it instead.", 409);
      }
      throw error;
    }

    // Link the variant to the receiving line
    const updatedLine = await this.storage.updateReceivingLine(lineId, {
      productVariantId: variant.id,
      productName: `${product.name} — ${variantName}`,
    });

    return {
      line: updatedLine,
      product: { id: product.id, sku: product.sku, name: product.name },
      variant: { id: variant.id, sku: variant.sku, name: variant.name, unitsPerVariant: variant.unitsPerVariant },
    };
  }

  // ─── Bulk Import Lines (CSV) ──────────────────────────────────

  async bulkImportLines(
    orderId: number,
    lines: Array<{
      sku?: string;
      qty?: string | number;
      location?: string;
      damaged_qty?: string | number;
      unit_cost?: string | number;
      barcode?: string;
      notes?: string;
    }>,
    userId: string | null,
  ) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ReceivingError("Lines array is required");
    }

    // Check setting for multiple SKUs per bin
    const allowMultipleSkusSetting = await this.storage.getSetting("allow_multiple_skus_per_bin");
    const allowMultipleSkus = allowMultipleSkusSetting !== "false"; // Default to true

    // Pre-fetch product locations if we need to validate bin occupancy
    let existingProductLocations: any[] = [];
    if (!allowMultipleSkus) {
      existingProductLocations = await this.storage.getAllProductLocations();
    }

    // Fetch existing lines for this order to enable idempotent imports (update vs create)
    const existingLines = await this.storage.getReceivingLines(orderId);
    const existingBySkuLocation = new Map(
      existingLines
        .filter((l: any) => l.sku)
        .map((l: any) => {
          const locationId = l.putawayLocationId || "none";
          return [`${l.sku!.toUpperCase()}|${locationId}`, l];
        }),
    );

    const linesToCreate: any[] = [];
    const linesToUpdate: { id: number; updates: any }[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Get the receipt's warehouseId to filter locations
    const receipt = await this.storage.getReceivingOrderById(orderId);
    const receiptWarehouseId = receipt?.warehouseId ?? null;

    // Pre-fetch warehouse locations — filter by receipt's warehouse when set
    const allWarehouseLocations = await this.storage.getAllWarehouseLocations();
    const filteredLocations = receiptWarehouseId
      ? allWarehouseLocations.filter((l: any) => l.warehouseId === receiptWarehouseId)
      : allWarehouseLocations;
    const locationByCode = new Map(filteredLocations.map((l: any) => [l.code.toUpperCase().trim(), l]));
    const locationByName = new Map(
      filteredLocations
        .filter((l: any) => l.name)
        .map((l: any) => [l.name!.toUpperCase().trim(), l]),
    );
    // Normalized index: stripped hyphens → location (for fuzzy matching)
    const locationByNormalized = new Map<string, any>();
    for (const loc of filteredLocations) {
      const stripped = (loc as any).code.toUpperCase().replace(/-/g, "");
      if (!locationByNormalized.has(stripped)) {
        locationByNormalized.set(stripped, loc);
      }
    }

    // Pre-fetch products for efficient lookup
    const allProducts = await this.storage.getAllProducts();
    const productBySku = new Map(
      allProducts
        .filter((p: any) => p.sku)
        .map((p: any) => [p.sku!.toUpperCase(), p]),
    );

    // Pre-fetch product_variants for efficient lookup (source of truth)
    const allProductVariants = await this.storage.getAllProductVariants();
    const productVariantBySku = new Map(
      allProductVariants
        .filter((v: any) => v.sku)
        .map((v: any) => [v.sku!.toUpperCase(), v]),
    );

    for (const line of lines) {
      const { sku, qty, location, damaged_qty, unit_cost, barcode, notes } = line;

      if (!sku) {
        errors.push("Missing SKU in line");
        continue;
      }

      // Source of truth: product_variants (sellable SKUs with product linkage)
      const lookupKey = sku.toUpperCase();
      const productVariant = productVariantBySku.get(lookupKey);
      const product = productBySku.get(lookupKey);

      let productVariantId: number | null = null;
      let productId: number | null = null;
      let productName = sku;
      let productBarcode = barcode || null;

      if (productVariant) {
        productVariantId = productVariant.id;
        productName = productVariant.name;
        if (!productBarcode && productVariant.barcode) {
          productBarcode = productVariant.barcode;
        }
        if (product) productId = product.id;
      } else if (product) {
        productId = product.id;
        productName = product.name;
        warnings.push(`SKU ${sku} found in products but not in product_variants - please set up variant hierarchy`);
      } else {
        warnings.push(`SKU ${sku} not found in products - inventory will not be updated on close`);
      }

      // Look up location: exact code → exact name → normalized/fuzzy
      let putawayLocationId = null;
      let csvLocationRaw: string | null = null;
      if (location) {
        const cleanLocation = location.trim().toUpperCase();
        csvLocationRaw = location.trim();
        let loc = locationByCode.get(cleanLocation);
        let matchMethod = "exact";

        if (!loc) {
          loc = locationByName.get(cleanLocation);
          if (loc) matchMethod = "name";
        }

        // Fuzzy matching: try normalized candidate codes
        if (!loc) {
          const candidates = normalizeLocationCode(cleanLocation);
          for (const candidate of candidates) {
            loc = locationByCode.get(candidate);
            if (loc) {
              matchMethod = "normalized";
              break;
            }
            const stripped = candidate.replace(/-/g, "");
            loc = locationByNormalized.get(stripped);
            if (loc) {
              matchMethod = "fuzzy";
              break;
            }
          }
        }

        if (loc) {
          putawayLocationId = loc.id;
          if (matchMethod !== "exact") {
            warnings.push(`Location "${location}" auto-matched to "${loc.code}" (${matchMethod})`);
          }

          // Check if bin is already occupied by a different SKU
          if (!allowMultipleSkus) {
            const existingInBin = existingProductLocations.find(
              (pl: any) =>
                pl.location?.trim().toUpperCase() === loc!.code.toUpperCase() &&
                pl.sku?.toUpperCase() !== sku.toUpperCase(),
            );
            if (existingInBin) {
              errors.push(`Bin ${loc.code} already contains SKU ${existingInBin.sku} - cannot add ${sku} (multiple SKUs per bin is disabled)`);
              continue;
            }
          }
        } else {
          warnings.push(`Location "${location}" not found for SKU ${sku} - needs manual resolution`);
        }
      }

      // Parse numeric values
      const parsedQty = parseInt(String(qty)) || 0;
      const parsedDamagedQty = parseInt(String(damaged_qty)) || 0;
      const parsedUnitCost = unit_cost ? new Decimal(String(unit_cost)).times(100).round().toNumber() : null;

      // Build notes: append CSV location if unmatched for resolution UI
      let lineNotes = notes || null;
      if (csvLocationRaw && !putawayLocationId) {
        lineNotes = lineNotes ? `${lineNotes} | CSV location: ${csvLocationRaw}` : `CSV location: ${csvLocationRaw}`;
      }

      // Check if line with same SKU + Location already exists in this order (idempotent import)
      const uniqueKey = `${sku.toUpperCase()}|${putawayLocationId || "none"}`;
      const existingLine = existingBySkuLocation.get(uniqueKey);
      if (existingLine) {
        linesToUpdate.push({
          id: existingLine.id,
          updates: {
            productName,
            barcode: productBarcode,
            expectedQty: parsedQty,
            receivedQty: parsedQty,
            damagedQty: parsedDamagedQty,
            unitCost: parsedUnitCost,
            productVariantId,
            productId,
            putawayLocationId,
            notes: lineNotes,
            status: putawayLocationId ? "complete" : "pending",
            receivedBy: userId,
            receivedAt: new Date(),
          },
        });
      } else {
        linesToCreate.push({
          receivingOrderId: orderId,
          sku: sku.toUpperCase(),
          productName,
          barcode: productBarcode,
          expectedQty: parsedQty,
          receivedQty: parsedQty,
          damagedQty: parsedDamagedQty,
          unitCost: parsedUnitCost,
          productVariantId,
          productId,
          putawayLocationId,
          notes: lineNotes,
          status: putawayLocationId ? "complete" : "pending",
          receivedBy: userId,
          receivedAt: new Date(),
        });
      }
    }

    // Update existing lines
    for (const item of linesToUpdate) {
      await this.storage.updateReceivingLine(item.id, item.updates);
    }

    // Create new lines
    const created = await this.storage.bulkCreateReceivingLines(linesToCreate);

    // Update order totals
    const allLines = await this.storage.getReceivingLines(orderId);
    await this.storage.updateReceivingOrder(orderId, {
      expectedLineCount: allLines.length,
      receivedLineCount: allLines.filter((l: any) => l.receivedQty > 0).length,
      expectedTotalUnits: allLines.reduce((sum: number, l: any) => sum + (l.expectedQty || 0), 0),
      receivedTotalUnits: allLines.reduce((sum: number, l: any) => sum + (l.receivedQty || 0), 0),
    });

    return {
      success: true,
      created: created.length,
      updated: linesToUpdate.length,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

// ── Factory function ────────────────────────────────────────────────

export function createReceivingService(
  db: DrizzleDb,
  inventoryCore: InventoryCore,
  channelSync: ChannelSync,
  storage: Storage,
  purchasing?: Purchasing | null,
  shipmentTracking?: ShipmentTracking | null,
) {
  return new ReceivingService(db, inventoryCore, channelSync, storage, purchasing ?? null, shipmentTracking ?? null);
}

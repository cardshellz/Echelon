import { sql } from "drizzle-orm";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { shipmentUnitOptionsRequestSchema, shipmentUnitOptionsRowSchema, shipmentUnitOptionsResultSchema, type ShipmentUnitOptionsIdentity } from "@shared/procurement/shipment-unit-options";
import type { ShipmentUnits } from "@shared/procurement/shipment-unit-selection";
import { type ShipmentCatalogUnit } from "./domain/shipment-unit-selection";
import { readShipmentUnitOptions } from "./shipment-unit-selection.repository";

const MAX_CATALOG_EVIDENCE_ROWS = 10_000;
export class ShipmentUnitOptionsError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) { super(message); this.name = "ShipmentUnitOptionsError"; }
}
interface PurchaseUnitSource { id: number; productId: number | null; lineType: string; expectedReceiveVariantId: number | null; productVariantId: number | null; expectedReceiveUnitsPerVariant: number | null; }
function problem(code: string, message: string): ShipmentUnits {
  return { productId: null, selectedVariantId: null, unitsPerVariantSnapshot: null, variants: [], issue: { code, message } };
}
function idList(values: readonly number[]) { return sql.join(values.map((value) => sql`${value}`), sql`, `); }
function rows(result: { rows?: unknown }, label: string): any[] {
  if (!Array.isArray(result.rows)) throw new Error(`Invalid ${label} evidence`);
  if (result.rows.length > MAX_CATALOG_EVIDENCE_ROWS) throw new ShipmentUnitOptionsError("The selected source has too many catalog units to review in one request.", 409, "SHIPMENT_UNIT_OPTIONS_LIMIT");
  return result.rows;
}

/** Purchasing-scoped, bounded CSV preview; no writes, no SKU-to-PO guessing. */
export async function readShipmentPackingUnitOptions(db: any, shipmentIdInput: number, input: unknown) {
  const shipmentId = shipmentLineResourceIdSchema.parse(shipmentIdInput);
  const request = shipmentUnitOptionsRequestSchema.parse(input);
  const parsed = request.rows.map((row) => shipmentUnitOptionsRowSchema.safeParse(row));
  const identities = parsed.flatMap((row) => row.success ? [row.data] : []);
  const poIds = [...new Set(identities.flatMap((row) => row.purchaseOrderLineId === undefined ? [] : [row.purchaseOrderLineId]))];
  const variantIds = [...new Set(identities.flatMap((row) => [row.productVariantId, row.selectedVariantId].filter((value): value is number => value !== undefined)))];
  const skus = [...new Set(identities.flatMap((row) => row.sku === undefined ? [] : [row.sku.toLowerCase()]))];
  return db.transaction(async (tx: any) => {
    const shipment = await tx.execute(sql`SELECT id FROM procurement.inbound_shipments WHERE id = ${shipmentId}`);
    if (!rows(shipment, "shipment").length) throw new ShipmentUnitOptionsError("Shipment not found.", 404, "SHIPMENT_LINE_NOT_FOUND");
    const poRows: PurchaseUnitSource[] = poIds.length ? rows(await tx.execute(sql`
      SELECT id, product_id AS "productId", line_type AS "lineType", expected_receive_variant_id AS "expectedReceiveVariantId",
        product_variant_id AS "productVariantId", expected_receive_units_per_variant AS "expectedReceiveUnitsPerVariant"
      FROM procurement.purchase_order_lines WHERE id = ANY(ARRAY[${idList(poIds)}]::integer[])
    `), "purchase unit source") : [];
    const variants: ShipmentCatalogUnit[] = variantIds.length || skus.length ? rows(await tx.execute(sql`
      SELECT id, product_id AS "productId", sku, name, units_per_variant AS "unitsPerVariant", is_active AS "isActive"
      FROM catalog.product_variants WHERE ${variantIds.length ? sql`id = ANY(ARRAY[${idList(variantIds)}]::integer[])` : sql`false`}
        OR ${skus.length ? sql`lower(sku) = ANY(ARRAY[${sql.join(skus.map((sku) => sql`${sku}`), sql`, `)}]::text[])` : sql`false`}
      ORDER BY id LIMIT ${MAX_CATALOG_EVIDENCE_ROWS + 1}
    `), "catalog unit source") : [];
    const poById = new Map(poRows.map((row) => [row.id, row]));
    const variantById = new Map(variants.map((row) => [row.id, row]));
    const resolved = parsed.map((value, index) => {
      if (!value.success) return { key: index + 1, issue: problem("SHIPMENT_UNIT_IDENTITY_INVALID", "Correct the SKU and positive source IDs before choosing a receive unit.") };
      const identity: ShipmentUnitOptionsIdentity = value.data;
      const po = identity.purchaseOrderLineId === undefined ? null : poById.get(identity.purchaseOrderLineId);
      if (identity.purchaseOrderLineId !== undefined && (!po || (po.lineType ?? "product") !== "product" || !Number.isSafeInteger(po.productId) || Number(po.productId) <= 0)) {
        return { key: index + 1, issue: problem("SHIPMENT_UNIT_PRODUCT_REQUIRED", "The supplied purchase line has no available product identity. Review its source.") };
      }
      const explicitVariant = identity.productVariantId === undefined ? null : variantById.get(identity.productVariantId);
      const selectedVariant = identity.selectedVariantId === undefined ? null : variantById.get(identity.selectedVariantId);
      const skuMatches = identity.sku === undefined ? [] : variants.filter((variant) => variant.sku?.toLowerCase() === identity.sku!.toLowerCase());
      const skuProducts = new Set(skuMatches.map((variant) => variant.productId));
      const productId = po?.productId ?? explicitVariant?.productId ?? (skuProducts.size === 1 ? [...skuProducts][0] : null) ?? selectedVariant?.productId ?? null;
      if (productId === null) return { key: index + 1, issue: problem("SHIPMENT_UNIT_PRODUCT_REQUIRED", "The row does not identify one catalog product. Supply its PO line, variant ID, or an unambiguous SKU.") };
      const conflict = (identity.productVariantId !== undefined && (!explicitVariant || explicitVariant.productId !== productId))
        || (identity.selectedVariantId !== undefined && (!selectedVariant || selectedVariant.productId !== productId))
        || (identity.sku !== undefined && (skuProducts.size !== 1 || !skuProducts.has(productId)));
      const selectedVariantId = identity.selectedVariantId ?? identity.productVariantId ?? po?.expectedReceiveVariantId ?? po?.productVariantId ?? (skuMatches.length === 1 ? skuMatches[0].id : null);
      // A PO snapshot describes its own selected variant. A different valid unit
      // must be reviewed against its own factor, not the PO unit's historical factor.
      const poVariantId = po?.expectedReceiveVariantId ?? po?.productVariantId ?? null;
      return { key: index + 1, productId, selectedVariantId,
        unitsPerVariantSnapshot: selectedVariantId === poVariantId ? po?.expectedReceiveUnitsPerVariant ?? null : null,
        conflict: conflict ? { code: "SHIPMENT_UNIT_IDENTITY_CONFLICT", message: "The row's SKU and source IDs disagree. Correct them before importing; selecting a receive unit updates its displayed SKU." } : null };
    });
    const options = await readShipmentUnitOptions(tx, resolved.flatMap((row) => "productId" in row ? [{ key: row.key, productId: row.productId!, selectedVariantId: row.selectedVariantId!, unitsPerVariantSnapshot: row.unitsPerVariantSnapshot! }] : []));
    return shipmentUnitOptionsResultSchema.parse({ shipmentId, rows: resolved.map((row) => ({ row: row.key,
      units: "issue" in row ? row.issue : { ...options.get(row.key)!, ...(row.conflict ? { issue: row.conflict } : {}) },
    })) });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

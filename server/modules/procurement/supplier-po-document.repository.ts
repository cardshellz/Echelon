import { asc, eq, inArray } from "drizzle-orm";
import type { db as applicationDatabase } from "../../db";
import {
  purchaseOrders,
  purchaseOrderLines,
  vendors,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Vendor,
} from "@shared/schema/procurement.schema";
import {
  echelonSettings,
  warehouses,
  type Warehouse,
} from "@shared/schema/warehouse.schema";
import { SupplierPoDocumentError } from "./supplier-po-document";

export type SupplierPoDocumentDatabase = Pick<typeof applicationDatabase, "transaction">;

// Supplier documents deliberately select a narrow source. Internal notes,
// approval commentary and arbitrary metadata never enter the renderer boundary.
const headerFields = {
  id: purchaseOrders.id,
  poNumber: purchaseOrders.poNumber,
  vendorId: purchaseOrders.vendorId,
  warehouseId: purchaseOrders.warehouseId,
  status: purchaseOrders.status,
  physicalStatus: purchaseOrders.physicalStatus,
  revisionNumber: purchaseOrders.revisionNumber,
  createdAt: purchaseOrders.createdAt,
  updatedAt: purchaseOrders.updatedAt,
  orderDate: purchaseOrders.orderDate,
  expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
  paymentTermsType: purchaseOrders.paymentTermsType,
  paymentTermsDays: purchaseOrders.paymentTermsDays,
  shipToAddress: purchaseOrders.shipToAddress,
  vendorContactName: purchaseOrders.vendorContactName,
  vendorContactEmail: purchaseOrders.vendorContactEmail,
  vendorNotes: purchaseOrders.vendorNotes,
  referenceNumber: purchaseOrders.referenceNumber,
  incoterms: purchaseOrders.incoterms,
  shippingMethod: purchaseOrders.shippingMethod,
  freightTerms: purchaseOrders.freightTerms,
  currency: purchaseOrders.currency,
  subtotalCents: purchaseOrders.subtotalCents,
  discountCents: purchaseOrders.discountCents,
  taxCents: purchaseOrders.taxCents,
  shippingCostCents: purchaseOrders.shippingCostCents,
  totalCents: purchaseOrders.totalCents,
};

const lineFields = {
  id: purchaseOrderLines.id,
  purchaseOrderId: purchaseOrderLines.purchaseOrderId,
  lineNumber: purchaseOrderLines.lineNumber,
  lineType: purchaseOrderLines.lineType,
  parentLineId: purchaseOrderLines.parentLineId,
  productId: purchaseOrderLines.productId,
  productVariantId: purchaseOrderLines.productVariantId,
  sku: purchaseOrderLines.sku,
  vendorSku: purchaseOrderLines.vendorSku,
  productName: purchaseOrderLines.productName,
  description: purchaseOrderLines.description,
  orderQty: purchaseOrderLines.orderQty,
  status: purchaseOrderLines.status,
  unitCostCents: purchaseOrderLines.unitCostCents,
  unitCostMills: purchaseOrderLines.unitCostMills,
  totalProductCostCents: purchaseOrderLines.totalProductCostCents,
  packagingCostCents: purchaseOrderLines.packagingCostCents,
  discountPercent: purchaseOrderLines.discountPercent,
  discountCents: purchaseOrderLines.discountCents,
  taxRatePercent: purchaseOrderLines.taxRatePercent,
  taxCents: purchaseOrderLines.taxCents,
  lineTotalCents: purchaseOrderLines.lineTotalCents,
  pricingBasis: purchaseOrderLines.pricingBasis,
  pricingSource: purchaseOrderLines.pricingSource,
  purchaseUom: purchaseOrderLines.purchaseUom,
  purchaseUomQuantity: purchaseOrderLines.purchaseUomQuantity,
  piecesPerPurchaseUom: purchaseOrderLines.piecesPerPurchaseUom,
  quotedUnitCostMills: purchaseOrderLines.quotedUnitCostMills,
  quotedTotalCents: purchaseOrderLines.quotedTotalCents,
  pricingRemainderMills: purchaseOrderLines.pricingRemainderMills,
  quoteReference: purchaseOrderLines.quoteReference,
  quotedAt: purchaseOrderLines.quotedAt,
  quoteValidUntil: purchaseOrderLines.quoteValidUntil,
  expectedDeliveryDate: purchaseOrderLines.expectedDeliveryDate,
  promisedDate: purchaseOrderLines.promisedDate,
};

const vendorFields = {
  id: vendors.id,
  name: vendors.name,
  contactName: vendors.contactName,
  email: vendors.email,
  phone: vendors.phone,
  address: vendors.address,
  country: vendors.country,
};

const warehouseFields = {
  id: warehouses.id,
  name: warehouses.name,
  address: warehouses.address,
  city: warehouses.city,
  state: warehouses.state,
  postalCode: warehouses.postalCode,
  country: warehouses.country,
};

const companySettingKeys = [
  "company_name",
  "company_address",
  "company_city",
  "company_state",
  "company_postal_code",
  "company_country",
] as const;

// IDs are PostgreSQL integer identity columns, not arbitrary safe JS integers.
const MAX_POSTGRES_INTEGER_ID = 2_147_483_647;

export interface SupplierPoDocumentRepositorySource {
  po: Pick<PurchaseOrder, keyof typeof headerFields>;
  lines: Array<Pick<PurchaseOrderLine, keyof typeof lineFields>>;
  vendor: Pick<Vendor, keyof typeof vendorFields>;
  warehouse?: Pick<Warehouse, keyof typeof warehouseFields>;
  companyName?: string;
  companyAddress?: string;
  companyCity?: string;
  companyState?: string;
  companyPostalCode?: string;
  companyCountry?: string;
}

/** Read one current record, not a historical sent/approved document.
 * Repeatable read keeps supplier identity, line economics and header totals
 * coherent even when a concurrent edit commits between these queries.
 * Source validation belongs to the pure document builder; this adapter never
 * recalculates or repairs persisted accounting values during a read. */
export async function loadSupplierPoDocumentSource(
  database: SupplierPoDocumentDatabase,
  poId: number,
): Promise<SupplierPoDocumentRepositorySource> {
  if (!Number.isSafeInteger(poId) || poId <= 0 || poId > MAX_POSTGRES_INTEGER_ID) {
    throw new SupplierPoDocumentError(
      "INVALID_SUPPLIER_DOCUMENT_SOURCE",
      "Purchase order id must be a positive PostgreSQL integer.",
      409,
      { purchaseOrderId: poId },
    );
  }

  return database.transaction(async (tx) => {
    const [po] = await tx.select(headerFields)
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, poId))
      .limit(1);
    if (!po) {
      throw new SupplierPoDocumentError(
        "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found.", 404,
        { purchaseOrderId: poId },
      );
    }

    // Include cancelled rows so the builder can disclose their exclusion.
    // A document must not silently truncate rows or recalculate its totals.
    const lines = await tx.select(lineFields)
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, poId))
      .orderBy(asc(purchaseOrderLines.lineNumber), asc(purchaseOrderLines.id));

    const [vendor] = await tx.select(vendorFields)
      .from(vendors)
      .where(eq(vendors.id, po.vendorId))
      .limit(1);
    if (!vendor) {
      throw new SupplierPoDocumentError(
        "INVALID_SUPPLIER_DOCUMENT_SOURCE",
        "The purchase order supplier is unavailable.",
        409,
        { purchaseOrderId: poId, vendorId: po.vendorId },
      );
    }

    let warehouse: SupplierPoDocumentRepositorySource["warehouse"];
    if (po.warehouseId !== null) {
      [warehouse] = await tx.select(warehouseFields)
        .from(warehouses)
        .where(eq(warehouses.id, po.warehouseId))
        .limit(1);
      if (!warehouse) {
        throw new SupplierPoDocumentError(
          "INVALID_SUPPLIER_DOCUMENT_SOURCE",
          "The purchase order destination warehouse is unavailable.",
          409,
          { purchaseOrderId: poId, warehouseId: po.warehouseId },
        );
      }
    }

    // getAllSettings uses echelon_settings. Select only public company identity
    // keys from that same owner, never every setting or a parallel store.
    const settingRows = await tx.select({
      key: echelonSettings.key,
      value: echelonSettings.value,
    }).from(echelonSettings).where(inArray(echelonSettings.key, [...companySettingKeys]));
    const settings = new Map(settingRows.map((setting) => [setting.key, setting.value]));

    return {
      po,
      lines,
      vendor,
      warehouse,
      companyName: settings.get("company_name") ?? undefined,
      companyAddress: settings.get("company_address") ?? undefined,
      companyCity: settings.get("company_city") ?? undefined,
      companyState: settings.get("company_state") ?? undefined,
      companyPostalCode: settings.get("company_postal_code") ?? undefined,
      companyCountry: settings.get("company_country") ?? undefined,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

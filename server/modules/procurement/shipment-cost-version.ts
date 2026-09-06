import { createHash } from "node:crypto";
import type { InboundFreightCost } from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";

// A content version covers every stored charge field, including AP changes.
// It needs no backfill and never derives a revision from a formatted UI value.
const VERSION_FIELDS = [
  "id", "inboundShipmentId", "costType", "description", "estimatedCents", "actualCents",
  "currency", "exchangeRate", "allocationMethod", "costStatus", "invoiceNumber", "invoiceDate",
  "dueDate", "paidDate", "performedByName", "vendorId", "vendorInvoiceId", "notes", "createdAt", "updatedAt",
] as const satisfies readonly (keyof InboundFreightCost)[];

export function shipmentCostVersion(cost: InboundFreightCost): string {
  const values = Object.fromEntries(VERSION_FIELDS.map((field) => {
    const value = cost[field];
    return [field, value instanceof Date ? value.toISOString() : value ?? null];
  }));
  for (const field of ["estimatedCents", "actualCents"] as const) {
    if (cost[field] !== null && cost[field] !== undefined && !Number.isSafeInteger(cost[field])) {
      throw new RangeError(`Shipment cost ${field} is not safe integer cents`);
    }
  }
  return createHash("sha256").update(canonicalJson(values)).digest("hex");
}

export function versionShipmentCost<T extends InboundFreightCost>(cost: T, hasInvoiceSourceReference: boolean) {
  return { ...cost, version: shipmentCostVersion(cost), hasInvoiceSourceReference };
}

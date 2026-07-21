import { createHash } from "node:crypto";
import { centsToMills } from "@shared/utils/money";

export const PURCHASE_ORDER_INVOICE_MATCH_STATUSES = [
  "pending",
  "matched",
  "po_line_missing",
  "price_discrepancy",
  "qty_discrepancy",
  "over_billed",
] as const;

export type PurchaseOrderInvoiceMatchStatus =
  typeof PURCHASE_ORDER_INVOICE_MATCH_STATUSES[number];

export type PurchaseOrderMatchLine = {
  id: number;
  orderQty: number;
  receivedQty: number | null;
  unitCostCents: number | null;
  unitCostMills: number | null;
};

export type VendorInvoiceMatchLine = {
  id: number;
  vendorInvoiceId: number;
  purchaseOrderLineId: number | null;
  qtyInvoiced: number;
  unitCostCents: number;
  unitCostMills: number | null;
};

export type EvaluatedVendorInvoiceMatchLine = {
  id: number;
  vendorInvoiceId: number;
  purchaseOrderLineId: number | null;
  qtyReceived: number;
  matchStatus: PurchaseOrderInvoiceMatchStatus;
};

export type PurchaseOrderInvoiceMatchFingerprintInvoice = {
  id: number;
  status: string;
};

function requireSafeNonnegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return normalized;
}

function authoritativeUnitCostMills(
  value: { unitCostCents: number | null; unitCostMills: number | null },
  field: string,
): number {
  const mills = value.unitCostMills == null
    ? centsToMills(requireSafeNonnegativeInteger(value.unitCostCents ?? 0, `${field}.unitCostCents`))
    : requireSafeNonnegativeInteger(value.unitCostMills, `${field}.unitCostMills`);
  return requireSafeNonnegativeInteger(mills, `${field}.unitCostMills`);
}

/**
 * Fingerprint every fact that can change a PO's aggregate three-way match.
 * Arrays are normalized by stable IDs before hashing so database row order
 * cannot change the result.
 */
export function computePurchaseOrderInvoiceMatchSourceFingerprint(input: {
  purchaseOrderId: number;
  purchaseOrderLines: PurchaseOrderMatchLine[];
  activeInvoices: PurchaseOrderInvoiceMatchFingerprintInvoice[];
  invoiceLines: VendorInvoiceMatchLine[];
}): string {
  const purchaseOrderId = requireSafeNonnegativeInteger(
    input.purchaseOrderId,
    "purchaseOrderId",
  );
  if (purchaseOrderId === 0) throw new Error("purchaseOrderId must be positive");

  const purchaseOrderLines = input.purchaseOrderLines
    .map((line) => {
      const id = requireSafeNonnegativeInteger(line.id, "purchaseOrderLine.id");
      if (id === 0) throw new Error("purchaseOrderLine.id must be positive");
      return {
        id,
        orderQty: requireSafeNonnegativeInteger(
          line.orderQty,
          `purchaseOrderLine[${id}].orderQty`,
        ),
        receivedQty: requireSafeNonnegativeInteger(
          line.receivedQty ?? 0,
          `purchaseOrderLine[${id}].receivedQty`,
        ),
        unitCostMills: authoritativeUnitCostMills(
          line,
          `purchaseOrderLine[${id}]`,
        ),
      };
    })
    .sort((left, right) => left.id - right.id);

  const activeInvoices = input.activeInvoices
    .map((invoice) => {
      const id = requireSafeNonnegativeInteger(invoice.id, "vendorInvoice.id");
      if (id === 0) throw new Error("vendorInvoice.id must be positive");
      return { id };
    })
    .sort((left, right) => left.id - right.id);

  const invoiceLines = input.invoiceLines
    .map((line) => {
      const id = requireSafeNonnegativeInteger(line.id, "vendorInvoiceLine.id");
      if (id === 0) throw new Error("vendorInvoiceLine.id must be positive");
      const vendorInvoiceId = requireSafeNonnegativeInteger(
        line.vendorInvoiceId,
        `vendorInvoiceLine[${id}].vendorInvoiceId`,
      );
      if (vendorInvoiceId === 0) {
        throw new Error(`vendorInvoiceLine[${id}].vendorInvoiceId must be positive`);
      }
      const purchaseOrderLineId = line.purchaseOrderLineId == null
        ? null
        : requireSafeNonnegativeInteger(
          line.purchaseOrderLineId,
          `vendorInvoiceLine[${id}].purchaseOrderLineId`,
        );
      if (purchaseOrderLineId === 0) {
        throw new Error(`vendorInvoiceLine[${id}].purchaseOrderLineId must be positive`);
      }
      return {
        id,
        vendorInvoiceId,
        purchaseOrderLineId,
        qtyInvoiced: requireSafeNonnegativeInteger(
          line.qtyInvoiced,
          `vendorInvoiceLine[${id}].qtyInvoiced`,
        ),
        unitCostMills: authoritativeUnitCostMills(
          line,
          `vendorInvoiceLine[${id}]`,
        ),
      };
    })
    .sort((left, right) =>
      left.vendorInvoiceId - right.vendorInvoiceId || left.id - right.id
    );

  const source = JSON.stringify({
    version: 1,
    purchaseOrderId,
    purchaseOrderLines,
    activeInvoices,
    invoiceLines,
  });
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Derive three-way match state from current PO, receipt, and invoice facts.
 * Quantity is evaluated at PO-line scope so split invoice lines and split
 * invoices do not each compare themselves to the full ordered quantity.
 */
export function evaluatePurchaseOrderInvoiceMatches(input: {
  purchaseOrderLines: PurchaseOrderMatchLine[];
  invoiceLines: VendorInvoiceMatchLine[];
}): EvaluatedVendorInvoiceMatchLine[] {
  const poLinesById = new Map<number, PurchaseOrderMatchLine>();
  for (const line of input.purchaseOrderLines) {
    const id = requireSafeNonnegativeInteger(line.id, "purchaseOrderLine.id");
    if (id === 0) throw new Error("purchaseOrderLine.id must be positive");
    requireSafeNonnegativeInteger(line.orderQty, `purchaseOrderLine[${id}].orderQty`);
    requireSafeNonnegativeInteger(line.receivedQty ?? 0, `purchaseOrderLine[${id}].receivedQty`);
    authoritativeUnitCostMills(line, `purchaseOrderLine[${id}]`);
    poLinesById.set(id, line);
  }

  const invoicedQtyByPoLineId = new Map<number, bigint>();
  for (const line of input.invoiceLines) {
    const id = requireSafeNonnegativeInteger(line.id, "vendorInvoiceLine.id");
    if (id === 0) throw new Error("vendorInvoiceLine.id must be positive");
    const qtyInvoiced = requireSafeNonnegativeInteger(
      line.qtyInvoiced,
      `vendorInvoiceLine[${id}].qtyInvoiced`,
    );
    authoritativeUnitCostMills(line, `vendorInvoiceLine[${id}]`);
    if (line.purchaseOrderLineId == null) continue;
    const purchaseOrderLineId = requireSafeNonnegativeInteger(
      line.purchaseOrderLineId,
      `vendorInvoiceLine[${id}].purchaseOrderLineId`,
    );
    if (purchaseOrderLineId === 0) {
      throw new Error(`vendorInvoiceLine[${id}].purchaseOrderLineId must be positive`);
    }
    invoicedQtyByPoLineId.set(
      purchaseOrderLineId,
      (invoicedQtyByPoLineId.get(purchaseOrderLineId) ?? BigInt(0)) + BigInt(qtyInvoiced),
    );
  }

  return input.invoiceLines.map((line) => {
    if (line.purchaseOrderLineId == null) {
      return {
        id: line.id,
        vendorInvoiceId: line.vendorInvoiceId,
        purchaseOrderLineId: null,
        qtyReceived: 0,
        matchStatus: "pending",
      };
    }

    const poLine = poLinesById.get(line.purchaseOrderLineId);
    if (!poLine) {
      return {
        id: line.id,
        vendorInvoiceId: line.vendorInvoiceId,
        purchaseOrderLineId: line.purchaseOrderLineId,
        qtyReceived: 0,
        matchStatus: "po_line_missing",
      };
    }

    const receivedQty = requireSafeNonnegativeInteger(
      poLine.receivedQty ?? 0,
      `purchaseOrderLine[${poLine.id}].receivedQty`,
    );
    const aggregateInvoicedQty = invoicedQtyByPoLineId.get(poLine.id) ?? BigInt(0);
    const orderedQty = BigInt(poLine.orderQty);
    const receivedQtyBigInt = BigInt(receivedQty);
    const invoiceUnitCostMills = authoritativeUnitCostMills(
      line,
      `vendorInvoiceLine[${line.id}]`,
    );
    const poUnitCostMills = authoritativeUnitCostMills(
      poLine,
      `purchaseOrderLine[${poLine.id}]`,
    );

    let matchStatus: PurchaseOrderInvoiceMatchStatus;
    if (invoiceUnitCostMills !== poUnitCostMills) {
      matchStatus = "price_discrepancy";
    } else if (aggregateInvoicedQty > receivedQtyBigInt) {
      matchStatus = "over_billed";
    } else if (
      aggregateInvoicedQty !== orderedQty ||
      aggregateInvoicedQty !== receivedQtyBigInt
    ) {
      matchStatus = "qty_discrepancy";
    } else {
      matchStatus = "matched";
    }

    return {
      id: line.id,
      vendorInvoiceId: line.vendorInvoiceId,
      purchaseOrderLineId: line.purchaseOrderLineId,
      qtyReceived: receivedQty,
      matchStatus,
    };
  });
}

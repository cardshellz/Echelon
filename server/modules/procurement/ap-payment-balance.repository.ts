import { eq, inArray } from "drizzle-orm";
import { apPaymentAllocations, vendorInvoices } from "@shared/schema";
import { projectPaymentBalance, type PaymentBalanceHeader } from "./domain/ap-payment-balance";
import type { ApLedgerDbClient } from "./ap-ledger.service";
import type { PaymentBalance } from "@shared/procurement/ap-payment-contract";

/** Left joins preserve broken historical references as review evidence rather than hiding money. */
export async function readPaymentBalances(tx: ApLedgerDbClient, payments: readonly PaymentBalanceHeader[]): Promise<Map<number, PaymentBalance>> {
  if (!payments.length) return new Map();
  const rows = await tx.select({ id: apPaymentAllocations.id, apPaymentId: apPaymentAllocations.apPaymentId,
    vendorInvoiceId: apPaymentAllocations.vendorInvoiceId, appliedAmountCents: apPaymentAllocations.appliedAmountCents,
    invoiceVendorId: vendorInvoices.vendorId, invoiceCurrency: vendorInvoices.currency, invoiceStatus: vendorInvoices.status,
  }).from(apPaymentAllocations).leftJoin(vendorInvoices, eq(vendorInvoices.id, apPaymentAllocations.vendorInvoiceId))
    .where(inArray(apPaymentAllocations.apPaymentId, payments.map(payment => payment.id))).orderBy(apPaymentAllocations.id);
  return new Map(payments.map(payment => [payment.id, projectPaymentBalance(payment, rows.filter(row => row.apPaymentId === payment.id))]));
}

import { supplierHeaderEntriesSchema, type SupplierHeaderEntry } from "@shared/procurement/supplier-header-costs";
import { readIntegerMills } from "@shared/money-read";
import { exactMoneyAsInput, parseExactMoneyInput } from "./exact-money-input";

export type SupplierHeaderEntryForm = Omit<SupplierHeaderEntry, "amountMills" | "shares"> & { amount: string; shares: Array<{ lineId: number; amount: string }> };
export function supplierHeaderEntryForm(entry: SupplierHeaderEntry): SupplierHeaderEntryForm {
  const { amountMills, shares, ...rest } = entry;
  return { ...rest, amount: exactMoneyAsInput(BigInt(amountMills) / BigInt(100), 2), shares: shares.map(row => ({ lineId: row.lineId, amount: exactMoneyAsInput(BigInt(row.amountMills) / BigInt(100), 2) })) };
}
export function supplierHeaderEntriesFromForm(rows: readonly SupplierHeaderEntryForm[]) {
  const mills = (value: string) => readIntegerMills(BigInt(parseExactMoneyInput(value, 2, true)) * BigInt(100), "supplier header amount", true);
  return supplierHeaderEntriesSchema.parse(rows.map(({ amount, shares, ...row }) => ({ ...row, amountMills: mills(amount),
    shares: row.method === "manual" ? shares.map(share => ({ lineId: share.lineId, amountMills: mills(share.amount) })) : [] })));
}

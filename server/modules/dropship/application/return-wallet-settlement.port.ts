import type { DropshipReturnEngineFaultCategory } from "../domain/return-fee-engine";

export type DropshipReturnCreditLedgerType = "return_credit" | "insurance_pool_credit";

export interface DropshipWalletTransaction {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
}

export interface PostDropshipReturnSettlementInput {
  tx: DropshipWalletTransaction;
  returnCaseId: number;
  vendorSettlementId: number;
  vendorId: number;
  currency: string;
  faultCategory: DropshipReturnEngineFaultCategory;
  creditLedgerType: DropshipReturnCreditLedgerType;
  grossCreditCents: number;
  totalFeeCents: number;
  idempotencyKey: string;
  requestHash: string;
  breakdown: Readonly<Record<string, unknown>>;
  now: Date;
}

export interface DropshipWalletSettlementEntry {
  walletLedgerId: number;
  role: "credit" | "fee";
  amountCents: number;
}

/**
 * Dropship owns wallet mutations. Returns may orchestrate this port inside its
 * transaction, but must never write dropship wallet tables directly.
 */
export interface DropshipReturnWalletSettlementPort {
  post(input: PostDropshipReturnSettlementInput): Promise<DropshipWalletSettlementEntry[]>;
}

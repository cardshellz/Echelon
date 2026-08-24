import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnWalletSettlementPort,
  DropshipWalletSettlementEntry,
  DropshipWalletTransaction,
  PostDropshipReturnSettlementInput,
} from "../application/return-wallet-settlement.port";

interface WalletAccountRow extends Record<string, unknown> {
  id: unknown;
  vendor_id: unknown;
  available_balance_cents: unknown;
  pending_balance_cents: unknown;
  currency: unknown;
  status: unknown;
}

interface WalletLedgerRow extends Record<string, unknown> { id: unknown }

export class PostgresDropshipReturnWalletSettlementPort
implements DropshipReturnWalletSettlementPort {
  async post(input: PostDropshipReturnSettlementInput): Promise<DropshipWalletSettlementEntry[]> {
    validateInput(input);
    if (input.grossCreditCents === 0 && input.totalFeeCents === 0) return [];

    let account = await getOrCreateAccount(input.tx, input);
    const entries: DropshipWalletSettlementEntry[] = [];

    if (input.grossCreditCents > 0) {
      account = await updateBalance(input.tx, {
        account,
        vendorId: input.vendorId,
        nextAvailableCents: checkedAdd(account.availableBalanceCents, input.grossCreditCents),
        now: input.now,
      });
      const walletLedgerId = await insertLedger(input.tx, {
        input,
        account,
        role: "credit",
        type: input.creditLedgerType,
        amountCents: input.grossCreditCents,
      });
      entries.push({ walletLedgerId, role: "credit", amountCents: input.grossCreditCents });
    }

    if (input.totalFeeCents > 0) {
      account = await updateBalance(input.tx, {
        account,
        vendorId: input.vendorId,
        nextAvailableCents: checkedAdd(account.availableBalanceCents, -input.totalFeeCents),
        now: input.now,
      });
      const amountCents = -input.totalFeeCents;
      const walletLedgerId = await insertLedger(input.tx, {
        input,
        account,
        role: "fee",
        type: "return_fee",
        amountCents,
      });
      entries.push({ walletLedgerId, role: "fee", amountCents });
    }
    return entries;
  }
}

interface Account {
  walletAccountId: number;
  availableBalanceCents: number;
  pendingBalanceCents: number;
  currency: string;
}

async function getOrCreateAccount(
  tx: DropshipWalletTransaction,
  input: PostDropshipReturnSettlementInput,
): Promise<Account> {
  await tx.query(
    `INSERT INTO dropship.dropship_wallet_accounts
      (vendor_id, available_balance_cents, pending_balance_cents, currency, status, created_at, updated_at)
     VALUES ($1, 0, 0, $2, 'active', $3, $3)
     ON CONFLICT (vendor_id) DO NOTHING`,
    [input.vendorId, input.currency, input.now],
  );
  const result = await tx.query<WalletAccountRow>(
    `SELECT id, vendor_id, available_balance_cents, pending_balance_cents, currency, status
     FROM dropship.dropship_wallet_accounts
     WHERE vendor_id = $1
     FOR UPDATE`,
    [input.vendorId],
  );
  if (result.rows.length !== 1) {
    throw new DropshipError("DROPSHIP_WALLET_ACCOUNT_NOT_FOUND", "Dropship wallet account was not found.", {
      vendorId: input.vendorId,
    });
  }
  const row = result.rows[0];
  const vendorId = positiveInteger(row.vendor_id, "wallet vendor id");
  const currency = requiredText(row.currency, "wallet currency");
  const status = requiredText(row.status, "wallet status");
  if (vendorId !== input.vendorId || status !== "active") {
    throw new DropshipError("DROPSHIP_WALLET_ACCOUNT_NOT_ACTIVE", "Dropship wallet account is not active.", {
      vendorId: input.vendorId,
      status,
    });
  }
  if (currency !== input.currency) {
    throw new DropshipError("DROPSHIP_WALLET_CURRENCY_MISMATCH", "Dropship wallet currency does not match the return settlement.", {
      vendorId: input.vendorId,
      walletCurrency: currency,
      settlementCurrency: input.currency,
    });
  }
  return {
    walletAccountId: positiveInteger(row.id, "wallet account id"),
    availableBalanceCents: safeInteger(row.available_balance_cents, "wallet available balance"),
    pendingBalanceCents: nonNegativeInteger(row.pending_balance_cents, "wallet pending balance"),
    currency,
  };
}

async function updateBalance(
  tx: DropshipWalletTransaction,
  input: { account: Account; vendorId: number; nextAvailableCents: number; now: Date },
): Promise<Account> {
  const result = await tx.query<WalletAccountRow>(
    `UPDATE dropship.dropship_wallet_accounts
     SET available_balance_cents = $3, updated_at = $4
     WHERE id = $1 AND vendor_id = $2
     RETURNING id, vendor_id, available_balance_cents, pending_balance_cents, currency, status`,
    [input.account.walletAccountId, input.vendorId, input.nextAvailableCents, input.now],
  );
  if (result.rows.length !== 1) {
    throw new DropshipError("DROPSHIP_WALLET_BALANCE_UPDATE_FAILED", "Dropship wallet balance could not be updated.", {
      vendorId: input.vendorId,
      walletAccountId: input.account.walletAccountId,
    });
  }
  const row = result.rows[0];
  return {
    walletAccountId: positiveInteger(row.id, "wallet account id"),
    availableBalanceCents: safeInteger(row.available_balance_cents, "wallet available balance"),
    pendingBalanceCents: nonNegativeInteger(row.pending_balance_cents, "wallet pending balance"),
    currency: requiredText(row.currency, "wallet currency"),
  };
}

async function insertLedger(
  tx: DropshipWalletTransaction,
  args: {
    input: PostDropshipReturnSettlementInput;
    account: Account;
    role: "credit" | "fee";
    type: "return_credit" | "insurance_pool_credit" | "return_fee";
    amountCents: number;
  },
): Promise<number> {
  const referenceId = `${args.input.vendorSettlementId}:${args.role}`;
  const idempotencyKey = `${args.input.idempotencyKey}:${args.role}`;
  const result = await tx.query<WalletLedgerRow>(
    `INSERT INTO dropship.dropship_wallet_ledger
      (wallet_account_id, vendor_id, type, status, amount_cents, currency,
       available_balance_after_cents, pending_balance_after_cents,
       reference_type, reference_id, idempotency_key, metadata, created_at, settled_at)
     VALUES ($1, $2, $3, 'settled', $4, $5, $6, $7,
             'return_case_vendor_settlement', $8, $9, $10::jsonb, $11, $11)
     RETURNING id`,
    [
      args.account.walletAccountId,
      args.input.vendorId,
      args.type,
      args.amountCents,
      args.input.currency,
      args.account.availableBalanceCents,
      args.account.pendingBalanceCents,
      referenceId,
      idempotencyKey,
      JSON.stringify({
        returnCaseId: args.input.returnCaseId,
        vendorSettlementId: args.input.vendorSettlementId,
        role: args.role,
        faultCategory: args.input.faultCategory,
        requestHash: args.input.requestHash,
        settlementBreakdown: args.input.breakdown,
      }),
      args.input.now,
    ],
  );
  if (result.rows.length !== 1) {
    throw new DropshipError("DROPSHIP_WALLET_LEDGER_INSERT_FAILED", "Dropship wallet settlement entry was not recorded.");
  }
  return positiveInteger(result.rows[0].id, "wallet ledger id");
}

function validateInput(input: PostDropshipReturnSettlementInput): void {
  positiveInteger(input.returnCaseId, "returnCaseId");
  positiveInteger(input.vendorSettlementId, "vendorSettlementId");
  positiveInteger(input.vendorId, "vendorId");
  nonNegativeInteger(input.grossCreditCents, "grossCreditCents");
  nonNegativeInteger(input.totalFeeCents, "totalFeeCents");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw invalid("currency must be a three-letter uppercase code.");
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) throw invalid("now must be a valid Date.");
  if (!input.idempotencyKey.trim() || !input.requestHash.trim()) throw invalid("Settlement evidence is incomplete.");
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw invalid("Wallet balance exceeds safe integer range.");
  return value;
}
function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalid(`${field} must be a positive safe integer.`);
  return parsed;
}
function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid(`${field} must be a non-negative safe integer.`);
  return parsed;
}
function safeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalid(`${field} must be a safe integer.`);
  return parsed;
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} is invalid.`);
  return value;
}
function invalid(message: string): DropshipError {
  return new DropshipError("DROPSHIP_RETURN_WALLET_SETTLEMENT_INVALID", message);
}

import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { pool } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import type { PoolClient } from "pg";
import type { DropshipReturnWalletSettlementPort } from "../../dropship/application/return-wallet-settlement.port";
import { PostgresDropshipReturnWalletSettlementPort } from "../../dropship/infrastructure/dropship-return-wallet-settlement.repository";
import {
  ReturnCaseFinancialError,
  type CustomerRefundQuote,
  type IssueCustomerRefundResult,
  type ReserveCustomerRefundInput,
  type ReturnCaseCustomerRefundStore,
  type ReturnCaseFinancialSourceStore,
  type ReturnCaseVendorSettlementStore,
  type ReturnFinancialCaseSource,
  type SettleVendorAccountResult,
  type StoredCustomerRefund,
  type VendorSettlementQuote,
} from "../application/return-case-financial.service";
import type {
  ReturnCaseAdminStore,
  ReturnCaseItemRow,
} from "../application/return-case-admin.service";
import { resolveReturnCaseExternalLineItemId } from "../domain/return-case-line-identity";
import { PostgresReturnCaseAdminStore } from "./return-case.repository";

interface OmsSourceRow {
  external_order_id: unknown;
  external_order_number: unknown;
  currency: unknown;
}
interface OmsLineIdentityRow {
  id: unknown;
  external_line_item_id: unknown;
}
interface CustomerRefundRow {
  id: unknown;
  return_case_id: unknown;
  case_number: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
  quote_hash: unknown;
  notify_customer: unknown;
  notes: unknown;
  status: unknown;
  quote: unknown;
  provider_refund_id: unknown;
  requested_at: unknown;
  completed_at: unknown;
  failure_code: unknown;
  failure_message: unknown;
}
interface LockedCaseRow {
  id: unknown;
  case_number: unknown;
  business_context: unknown;
  channel_id: unknown;
  vendor_id: unknown;
  oms_order_id: unknown;
  case_status: unknown;
  approval_status: unknown;
  inspection_status: unknown;
  customer_refund_status: unknown;
  vendor_settlement_status: unknown;
  updated_at: unknown;
}
interface IdRow { id: unknown }
interface CommandRow { request_hash: unknown; response: unknown }
interface VendorSettlementReplayRow {
  id: unknown;
  return_case_id: unknown;
  vendor_id: unknown;
  currency: unknown;
  gross_credit_cents: unknown;
  total_fee_cents: unknown;
  net_settlement_cents: unknown;
  settled_at: unknown;
  request_hash: unknown;
  case_number: unknown;
}

export class PostgresReturnCaseFinancialSourceStore implements ReturnCaseFinancialSourceStore {
  constructor(
    private readonly adminStore: Pick<ReturnCaseAdminStore, "getById"> = new PostgresReturnCaseAdminStore(),
  ) {}

  async loadCase(caseId: number): Promise<ReturnFinancialCaseSource | null> {
    const detail = await this.adminStore.getById(caseId);
    if (!detail) return null;
    if (detail.recordOrigin !== "canonical") {
      throw financialError("RETURN_FINANCIAL_CASE_NOT_CANONICAL", "Financial actions require a canonical Return Case.", 409, { caseId });
    }
    if (detail.omsOrderId === null) {
      throw financialError("RETURN_FINANCIAL_SOURCE_INCOMPLETE", "The Return Case is missing its OMS order identity.", 409, { caseId });
    }
    const oms = await pool.query<OmsSourceRow>(
      `SELECT external_order_id, external_order_number, currency
       FROM oms.oms_orders
       WHERE id = $1
       LIMIT 1`,
      [detail.omsOrderId],
    );
    if (oms.rows.length !== 1) {
      throw financialError("RETURN_FINANCIAL_SOURCE_INCOMPLETE", "The source OMS order was not found.", 409, { caseId, omsOrderId: detail.omsOrderId });
    }
    const source = oms.rows[0];
    const businessContext = readBusinessContext(detail.businessContext);
    const channelProvider = detail.actionContext.channelProvider;
    const items = businessContext === "retail" && channelProvider === "shopify"
      ? await resolveRetailShopifyItems(caseId, detail.omsOrderId, detail.items)
      : detail.items.map((item) => mapFinancialItem(item, item.externalLineItemId));
    return {
      caseId: detail.id,
      caseNumber: detail.caseNumber,
      businessContext,
      channelProvider,
      channelId: detail.channelId,
      vendorId: detail.vendorId,
      storeConnectionId: detail.storeConnectionId,
      omsOrderId: detail.omsOrderId,
      externalOrderId: requiredText(source.external_order_id, "external order id"),
      externalOrderNumber: nullableText(source.external_order_number),
      currency: currencyCode(source.currency, "OMS order currency"),
      policyVersion: detail.policyVersion,
      updatedAt: detail.updatedAt,
      actionContext: detail.actionContext,
      items,
    };
  }
}

export class PostgresReturnCaseCustomerRefundStore implements ReturnCaseCustomerRefundStore {
  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredCustomerRefund | null> {
    const result = await pool.query<CustomerRefundRow>(customerRefundSelect("refund.idempotency_key = $1"), [idempotencyKey]);
    return result.rows[0] ? mapStoredCustomerRefund(result.rows[0]) : null;
  }

  async reserve(input: ReserveCustomerRefundInput): Promise<StoredCustomerRefund> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(client, input.idempotencyKey);
      const channelId = requiredPositiveInteger(input.source.channelId, "customer refund channel id");
      const existing = await client.query<CustomerRefundRow>(customerRefundSelect("refund.idempotency_key = $1"), [input.idempotencyKey]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return mapStoredCustomerRefund(existing.rows[0]);
      }
      const lockedCase = await lockCase(client, input.source.caseId);
      requireFreshSource(lockedCase, input.source);
      const header = await client.query<IdRow>(
        `INSERT INTO returns.return_case_customer_refunds (
          return_case_id, channel_id, provider, external_order_id, currency,
          amount_cents, maximum_refundable_cents, status, idempotency_key,
          request_hash, quote_hash, quote, notify_customer, requested_by,
          notes, requested_at, created_at, updated_at
        ) VALUES ($1,$2,'shopify',$3,$4,$5,$6,'pending',$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$14,$14)
        RETURNING id`,
        [
          input.source.caseId,
          channelId,
          input.source.externalOrderId,
          input.quote.currency,
          input.quote.amountCents,
          input.quote.maximumRefundableCents,
          input.idempotencyKey,
          input.requestHash,
          input.quoteHash,
          JSON.stringify(input.quote),
          input.notifyCustomer,
          input.actor,
          input.notes,
          input.now,
        ],
      );
      const customerRefundId = rowId(header.rows[0], "customer refund id");
      for (const line of input.quote.lines) {
        await client.query(
          `INSERT INTO returns.return_case_customer_refund_items (
            customer_refund_id, return_case_item_id, external_line_item_id,
            quantity, subtotal_cents, tax_cents, total_cents, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [customerRefundId, line.returnCaseItemId, line.externalLineItemId, line.quantity, line.subtotalCents, line.taxCents, line.totalCents, input.now],
        );
      }
      for (const transaction of input.quote.transactions) {
        await client.query(
          `INSERT INTO returns.return_case_customer_refund_transactions (
            customer_refund_id, position, parent_transaction_id, gateway, amount_cents, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [customerRefundId, transaction.position, transaction.parentTransactionId, transaction.gateway, transaction.amountCents, input.now],
        );
      }
      const stored = await client.query<CustomerRefundRow>(customerRefundSelect("refund.id = $1"), [customerRefundId]);
      await client.query("COMMIT");
      if (!stored.rows[0]) throw evidenceInvalid("Reserved customer refund was not found.");
      return mapStoredCustomerRefund(stored.rows[0]);
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) {
        const replay = await this.findByIdempotencyKey(input.idempotencyKey);
        if (replay) return replay;
      }
      throw classifyDatabaseError(error, "RETURN_CUSTOMER_REFUND_RESERVE_FAILED", "Customer refund intent could not be reserved.");
    } finally {
      client.release();
    }
  }

  async complete(input: {
    customerRefundId: number;
    source: ReturnFinancialCaseSource;
    execution: { providerRefundId: string; completedAt: Date; rawResult: Record<string, unknown> };
    actor: string;
    now: Date;
  }): Promise<IssueCustomerRefundResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const refund = await lockCustomerRefund(client, input.customerRefundId);
      const lockedCase = await lockCase(client, input.source.caseId);
      requireFinancialIdentity(lockedCase, input.source);
      if (refund.status === "completed") {
        const result = await loadCustomerRefundCommand(client, refund.idempotencyKey);
        await client.query("COMMIT");
        return { ...result, replayed: true };
      }
      if (refund.status !== "pending") throw evidenceInvalid("Customer refund is not pending completion.");
      const result: IssueCustomerRefundResult = {
        commandType: "issue_customer_refund",
        caseId: input.source.caseId,
        caseNumber: input.source.caseNumber,
        customerRefundId: input.customerRefundId,
        provider: "shopify",
        providerRefundId: input.execution.providerRefundId,
        currency: input.source.currency,
        amountCents: refund.amountCents,
        completedAt: input.execution.completedAt.toISOString(),
        replayed: false,
      };
      const updated = await client.query<IdRow>(
        `UPDATE returns.return_case_customer_refunds
         SET status='completed', provider_refund_id=$2, provider_result=$3::jsonb,
             completed_at=$4, updated_at=$5
         WHERE id=$1 AND status='pending'
         RETURNING id`,
        [input.customerRefundId, input.execution.providerRefundId, JSON.stringify(input.execution.rawResult), input.execution.completedAt, input.now],
      );
      if (updated.rows.length !== 1) throw stale("Customer refund evidence changed during completion.");
      const caseUpdate = await client.query<IdRow>(
        `UPDATE returns.return_cases
         SET customer_refund_status='completed', updated_at=$2
         WHERE id=$1 AND customer_refund_status IN ('pending','failed','completed')
         RETURNING id`,
        [input.source.caseId, input.now],
      );
      if (caseUpdate.rows.length !== 1) {
        throw stale("Customer refund lifecycle changed during completion.");
      }
      await appendEvent(client, input.source.caseId, "return_customer_refund_completed", input.actor, {
        customerRefundId: input.customerRefundId,
        provider: "shopify",
        providerRefundId: input.execution.providerRefundId,
        amountCents: refund.amountCents,
        currency: input.source.currency,
        notifyCustomer: refund.notifyCustomer,
      }, input.now);
      await persistCommand(client, input.source.caseId, "issue_customer_refund", refund.idempotencyKey, refund.requestHash, result, input.actor, input.now);
      await persistFinancialAudit(client, input.actor, "RETURN_CASE_CUSTOMER_REFUND_COMPLETED", input.source.caseId, {
        before: { customerRefundStatus: lockedCase.customerRefundStatus },
        after: { customerRefundStatus: "completed" },
      }, { customerRefundId: input.customerRefundId, providerRefundId: input.execution.providerRefundId, amountCents: refund.amountCents, currency: input.source.currency }, input.now);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollback(client);
      throw classifyDatabaseError(error, "RETURN_CUSTOMER_REFUND_COMPLETE_FAILED", "Confirmed customer refund evidence could not be recorded.");
    } finally {
      client.release();
    }
  }

  async fail(input: {
    customerRefundId: number;
    source: ReturnFinancialCaseSource;
    code: string;
    message: string;
    actor: string;
    now: Date;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const refund = await lockCustomerRefund(client, input.customerRefundId);
      const lockedCase = await lockCase(client, input.source.caseId);
      requireFinancialIdentity(lockedCase, input.source);
      if (refund.status === "failed") {
        await client.query("COMMIT");
        return;
      }
      if (refund.status !== "pending") throw evidenceInvalid("Customer refund is not pending failure recording.");
      const updated = await client.query<IdRow>(
        `UPDATE returns.return_case_customer_refunds
         SET status='failed', failure_code=$2, failure_message=$3, completed_at=$4, updated_at=$4
         WHERE id=$1 AND status='pending'
         RETURNING id`,
        [input.customerRefundId, input.code, input.message, input.now],
      );
      if (updated.rows.length !== 1) throw stale("Customer refund evidence changed during failure recording.");
      const caseUpdate = await client.query<IdRow>(
        `UPDATE returns.return_cases
         SET customer_refund_status='failed', updated_at=$2
         WHERE id=$1 AND customer_refund_status IN ('pending','failed')
         RETURNING id`,
        [input.source.caseId, input.now],
      );
      if (caseUpdate.rows.length !== 1) {
        throw stale("Customer refund lifecycle changed during failure recording.");
      }
      await appendEvent(client, input.source.caseId, "return_customer_refund_failed", input.actor, {
        customerRefundId: input.customerRefundId,
        code: input.code,
        message: input.message,
      }, input.now);
      await persistFinancialAudit(client, input.actor, "RETURN_CASE_CUSTOMER_REFUND_FAILED", input.source.caseId, {
        before: { customerRefundStatus: lockedCase.customerRefundStatus },
        after: { customerRefundStatus: "failed" },
      }, { customerRefundId: input.customerRefundId, code: input.code }, input.now);
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw classifyDatabaseError(error, "RETURN_CUSTOMER_REFUND_FAILURE_RECORD_FAILED", "Customer refund failure evidence could not be recorded.");
    } finally {
      client.release();
    }
  }
}

export class PostgresReturnCaseVendorSettlementStore implements ReturnCaseVendorSettlementStore {
  constructor(
    private readonly wallet: DropshipReturnWalletSettlementPort = new PostgresDropshipReturnWalletSettlementPort(),
  ) {}

  async findReplay(idempotencyKey: string, requestHash: string): Promise<SettleVendorAccountResult | null> {
    const client = await pool.connect();
    try {
      return await findVendorSettlementReplay(client, idempotencyKey, requestHash);
    } finally {
      client.release();
    }
  }

  async settle(input: {
    source: ReturnFinancialCaseSource;
    quote: VendorSettlementQuote;
    quoteHash: string;
    requestHash: string;
    idempotencyKey: string;
    notes: string | null;
    actor: string;
    now: Date;
  }): Promise<SettleVendorAccountResult> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(client, input.idempotencyKey);
      const replay = await findVendorSettlementReplay(client, input.idempotencyKey, input.requestHash);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const lockedCase = await lockCase(client, input.source.caseId);
      requireFreshSource(lockedCase, input.source);
      const vendorId = input.source.vendorId;
      if (vendorId === null) throw evidenceInvalid("Vendor settlement source has no vendor identity.");
      const settlement = input.quote.settlement;
      const inserted = await client.query<IdRow>(
        `INSERT INTO returns.return_case_vendor_settlements (
          return_case_id, vendor_id, fault_category, currency,
          product_credit_cents, original_shipping_credit_cents,
          restocking_fee_cents, processing_fee_cents, return_shipping_fee_cents,
          gross_credit_cents, total_fee_cents, net_settlement_cents,
          return_shipping_actual_cents, restocking_fee_policy_id,
          processing_fee_policy_id, return_shipping_fee_policy_id,
          settlement_breakdown, idempotency_key, request_hash, quote_hash,
          recorded_by, notes, settled_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$23)
        RETURNING id`,
        [
          input.source.caseId, vendorId, input.quote.faultCategory, input.quote.currency,
          settlement.productCreditCents, settlement.originalShippingCreditCents,
          settlement.restockingFeeCents, settlement.processingFeeCents, settlement.returnShippingFeeCents,
          settlement.grossCreditCents, settlement.totalFeeCents, settlement.netSettlementCents,
          input.quote.returnShippingActualCents, input.quote.policyFeeIds.restockingFeeId,
          input.quote.policyFeeIds.processingFeeId, input.quote.policyFeeIds.returnShippingFeeId,
          JSON.stringify(settlement.breakdown), input.idempotencyKey, input.requestHash, input.quoteHash,
          input.actor, input.notes, input.now,
        ],
      );
      const vendorSettlementId = rowId(inserted.rows[0], "vendor settlement id");
      const walletEntries = await this.wallet.post({
        tx: client,
        returnCaseId: input.source.caseId,
        vendorSettlementId,
        vendorId,
        currency: input.quote.currency,
        faultCategory: input.quote.faultCategory,
        creditLedgerType: settlement.creditLedgerType,
        grossCreditCents: settlement.grossCreditCents,
        totalFeeCents: settlement.totalFeeCents,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        breakdown: settlement.breakdown,
        now: input.now,
      });
      for (const entry of walletEntries) {
        await client.query(
          `INSERT INTO returns.return_case_vendor_settlement_ledger_entries
            (vendor_settlement_id, wallet_ledger_id, entry_role, created_at)
           VALUES ($1,$2,$3,$4)`,
          [vendorSettlementId, entry.walletLedgerId, entry.role, input.now],
        );
      }
      const walletLedgerIds = walletEntries.map((entry) => entry.walletLedgerId);
      const result: SettleVendorAccountResult = {
        commandType: "settle_vendor_account",
        caseId: input.source.caseId,
        caseNumber: input.source.caseNumber,
        vendorSettlementId,
        vendorId,
        currency: input.quote.currency,
        grossCreditCents: settlement.grossCreditCents,
        totalFeeCents: settlement.totalFeeCents,
        netSettlementCents: settlement.netSettlementCents,
        walletLedgerIds,
        settledAt: input.now.toISOString(),
        replayed: false,
      };
      const caseUpdate = await client.query<IdRow>(
        `UPDATE returns.return_cases
         SET vendor_settlement_status='completed', updated_at=$2
         WHERE id=$1 AND vendor_settlement_status IN ('pending','eligible','failed')
         RETURNING id`,
        [input.source.caseId, input.now],
      );
      if (caseUpdate.rows.length !== 1) throw stale("Vendor settlement status changed before posting.");
      await appendEvent(client, input.source.caseId, "return_vendor_account_settled", input.actor, {
        vendorSettlementId,
        vendorId,
        faultCategory: input.quote.faultCategory,
        grossCreditCents: settlement.grossCreditCents,
        totalFeeCents: settlement.totalFeeCents,
        netSettlementCents: settlement.netSettlementCents,
        currency: input.quote.currency,
        walletLedgerIds,
      }, input.now);
      await persistCommand(client, input.source.caseId, "settle_vendor_account", input.idempotencyKey, input.requestHash, result, input.actor, input.now);
      await persistFinancialAudit(client, input.actor, "RETURN_CASE_VENDOR_ACCOUNT_SETTLED", input.source.caseId, {
        before: { vendorSettlementStatus: lockedCase.vendorSettlementStatus },
        after: { vendorSettlementStatus: "completed" },
      }, { vendorSettlementId, vendorId, grossCreditCents: settlement.grossCreditCents, totalFeeCents: settlement.totalFeeCents, netSettlementCents: settlement.netSettlementCents, currency: input.quote.currency, walletLedgerIds }, input.now);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) {
        const replayClient = await pool.connect();
        try {
          const replay = await findVendorSettlementReplay(replayClient, input.idempotencyKey, input.requestHash);
          if (replay) return replay;
        } finally {
          replayClient.release();
        }
      }
      throw classifyDatabaseError(error, "RETURN_VENDOR_SETTLEMENT_FAILED", "Vendor account settlement could not be recorded.");
    } finally {
      client.release();
    }
  }
}

function customerRefundSelect(predicate: string): string {
  return `SELECT refund.id, refund.return_case_id, rc.case_number,
                 refund.idempotency_key, refund.request_hash, refund.quote_hash,
                 refund.notify_customer, refund.notes, refund.status, refund.quote,
                 refund.provider_refund_id, refund.requested_at, refund.completed_at,
                 refund.failure_code, refund.failure_message
          FROM returns.return_case_customer_refunds refund
          JOIN returns.return_cases rc ON rc.id = refund.return_case_id
          WHERE ${predicate}
          LIMIT 1`;
}

async function lockCustomerRefund(client: PoolClient, id: number) {
  const result = await client.query<{
    id: unknown; status: unknown; amount_cents: unknown; notify_customer: unknown;
    idempotency_key: unknown; request_hash: unknown;
  }>(
    `SELECT id, status, amount_cents, notify_customer, idempotency_key, request_hash
     FROM returns.return_case_customer_refunds WHERE id=$1 FOR UPDATE`,
    [id],
  );
  if (result.rows.length !== 1) throw evidenceInvalid("Customer refund evidence was not found.");
  const row = result.rows[0];
  return {
    id: positiveInteger(row.id, "customer refund id"),
    status: refundStatus(row.status),
    amountCents: positiveInteger(row.amount_cents, "customer refund amount"),
    notifyCustomer: booleanValue(row.notify_customer, "notify customer"),
    idempotencyKey: requiredText(row.idempotency_key, "customer refund idempotency key"),
    requestHash: hashValue(row.request_hash, "customer refund request hash"),
  };
}

async function lockCase(client: PoolClient, caseId: number): Promise<ReturnType<typeof mapLockedCase>> {
  const result = await client.query<LockedCaseRow>(
    `SELECT id, case_number, business_context, channel_id, vendor_id, oms_order_id,
            case_status, approval_status, inspection_status,
            customer_refund_status, vendor_settlement_status, updated_at
     FROM returns.return_cases
     WHERE id=$1
     FOR UPDATE`,
    [caseId],
  );
  if (result.rows.length !== 1) throw financialError("RETURN_CASE_NOT_FOUND", "Return case was not found.", 404, { caseId });
  return mapLockedCase(result.rows[0]);
}

function mapLockedCase(row: LockedCaseRow) {
  return {
    id: positiveInteger(row.id, "return case id"),
    caseNumber: requiredText(row.case_number, "return case number"),
    businessContext: readBusinessContext(row.business_context),
    channelId: nullablePositiveInteger(row.channel_id, "return case channel id"),
    vendorId: nullablePositiveInteger(row.vendor_id, "return case vendor id"),
    omsOrderId: nullablePositiveInteger(row.oms_order_id, "return case OMS order id"),
    caseStatus: requiredText(row.case_status, "return case status"),
    approvalStatus: requiredText(row.approval_status, "return approval status"),
    inspectionStatus: requiredText(row.inspection_status, "return inspection status"),
    customerRefundStatus: requiredText(row.customer_refund_status, "customer refund status"),
    vendorSettlementStatus: requiredText(row.vendor_settlement_status, "vendor settlement status"),
    updatedAt: dateValue(row.updated_at, "return case updated timestamp"),
  };
}

function requireFreshSource(locked: ReturnType<typeof mapLockedCase>, source: ReturnFinancialCaseSource): void {
  requireFinancialIdentity(locked, source);
  if (locked.updatedAt.getTime() !== source.updatedAt.getTime()) throw stale("Return case changed while the financial action was being prepared.");
}

function requireFinancialIdentity(locked: ReturnType<typeof mapLockedCase>, source: ReturnFinancialCaseSource): void {
  if (locked.id !== source.caseId || locked.caseNumber !== source.caseNumber
    || locked.businessContext !== source.businessContext || locked.channelId !== source.channelId
    || locked.vendorId !== source.vendorId || locked.omsOrderId !== source.omsOrderId) {
    throw evidenceInvalid("Return case financial identity changed or is inconsistent.");
  }
}

async function findVendorSettlementReplay(
  client: Pick<PoolClient, "query">,
  idempotencyKey: string,
  requestHash: string,
): Promise<SettleVendorAccountResult | null> {
  const command = await client.query<CommandRow>(
    `SELECT request_hash, response
     FROM returns.return_case_commands
     WHERE idempotency_key=$1 AND command_type='settle_vendor_account'
     LIMIT 1`,
    [idempotencyKey],
  );
  if (command.rows[0]) {
    if (hashValue(command.rows[0].request_hash, "stored vendor settlement request hash") !== requestHash) {
      throw financialError("RETURN_FINANCIAL_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different vendor settlement.", 409);
    }
    return { ...parseVendorSettlementResult(command.rows[0].response), replayed: true };
  }
  const settlement = await client.query<VendorSettlementReplayRow>(
    `SELECT settlement.id, settlement.return_case_id, settlement.vendor_id,
            settlement.currency, settlement.gross_credit_cents, settlement.total_fee_cents,
            settlement.net_settlement_cents, settlement.settled_at, settlement.request_hash,
            rc.case_number
     FROM returns.return_case_vendor_settlements settlement
     JOIN returns.return_cases rc ON rc.id=settlement.return_case_id
     WHERE settlement.idempotency_key=$1
     LIMIT 1`,
    [idempotencyKey],
  );
  if (!settlement.rows[0]) return null;
  if (hashValue(settlement.rows[0].request_hash, "stored vendor settlement request hash") !== requestHash) {
    throw financialError("RETURN_FINANCIAL_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different vendor settlement.", 409);
  }
  throw evidenceInvalid("Vendor settlement exists without its immutable command response.");
}

async function loadCustomerRefundCommand(client: PoolClient, idempotencyKey: string): Promise<IssueCustomerRefundResult> {
  const result = await client.query<CommandRow>(
    `SELECT request_hash, response FROM returns.return_case_commands
     WHERE idempotency_key=$1 AND command_type='issue_customer_refund' LIMIT 1`,
    [idempotencyKey],
  );
  if (!result.rows[0]) throw evidenceInvalid("Completed customer refund has no immutable command response.");
  return parseCustomerRefundResult(result.rows[0].response);
}

async function advisoryLock(client: PoolClient, idempotencyKey: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-case-financial:${idempotencyKey}`]);
}

async function appendEvent(client: PoolClient, caseId: number, eventType: string, actor: string, details: Record<string, unknown>, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO returns.return_case_events
      (return_case_id,event_type,actor,details,occurred_at,created_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$5)`,
    [caseId, eventType, actor, JSON.stringify(details), now],
  );
}

async function persistCommand(
  client: PoolClient,
  caseId: number,
  commandType: "issue_customer_refund" | "settle_vendor_account",
  idempotencyKey: string,
  requestHash: string,
  response: IssueCustomerRefundResult | SettleVendorAccountResult,
  actor: string,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO returns.return_case_commands
      (return_case_id,command_type,idempotency_key,request_hash,response,actor,created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [caseId, commandType, idempotencyKey, requestHash, JSON.stringify(response), actor, now],
  );
}

async function persistFinancialAudit(
  client: PoolClient,
  actor: string,
  action: string,
  caseId: number,
  changes: { before: Record<string, unknown>; after: Record<string, unknown> },
  context: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const transactionDb = drizzle(client, { schema });
  await persistAuditEvent(transactionDb, {
    actor,
    action,
    target: `returns.return_cases:${caseId}`,
    changes,
    context,
  }, { timestamp: now, emitStructuredLog: false });
}

function mapStoredCustomerRefund(row: CustomerRefundRow): StoredCustomerRefund {
  return {
    customerRefundId: positiveInteger(row.id, "customer refund id"),
    caseId: positiveInteger(row.return_case_id, "return case id"),
    caseNumber: requiredText(row.case_number, "return case number"),
    idempotencyKey: requiredText(row.idempotency_key, "customer refund idempotency key"),
    requestHash: hashValue(row.request_hash, "customer refund request hash"),
    quoteHash: hashValue(row.quote_hash, "customer refund quote hash"),
    notifyCustomer: booleanValue(row.notify_customer, "notify customer"),
    notes: nullableText(row.notes),
    status: refundStatus(row.status),
    quote: parseCustomerRefundQuote(row.quote),
    providerRefundId: nullableText(row.provider_refund_id),
    requestedAt: dateValue(row.requested_at, "customer refund requested timestamp"),
    completedAt: nullableDate(row.completed_at, "customer refund completed timestamp"),
    failureCode: nullableText(row.failure_code),
    failureMessage: nullableText(row.failure_message),
  };
}

function parseCustomerRefundQuote(value: unknown): CustomerRefundQuote {
  if (!isObject(value) || value.provider !== "shopify"
    || !Array.isArray(value.lines) || value.lines.length === 0 || value.lines.length > 200
    || !Array.isArray(value.transactions) || value.transactions.length === 0 || value.transactions.length > 50) {
    throw evidenceInvalid("Stored customer refund quote is invalid.");
  }
  const currency = currencyCode(value.currency, "stored customer refund quote currency");
  const amountCents = positiveInteger(value.amountCents, "stored customer refund quote amount");
  const maximumRefundableCents = positiveInteger(value.maximumRefundableCents, "stored customer refund maximum amount");
  const returnCaseItemIds = new Set<number>();
  const externalLineItemIds = new Set<string>();
  let lineTotalCents = 0;
  const lines = value.lines.map((rawLine) => {
    if (!isObject(rawLine)) throw evidenceInvalid("Stored customer refund quote line is invalid.");
    const returnCaseItemId = positiveInteger(rawLine.returnCaseItemId, "stored customer refund item id");
    const externalLineItemId = requiredText(rawLine.externalLineItemId, "stored customer refund external line id");
    const subtotalCents = nonNegativeInteger(rawLine.subtotalCents, "stored customer refund subtotal");
    const taxCents = nonNegativeInteger(rawLine.taxCents, "stored customer refund tax");
    const totalCents = nonNegativeInteger(rawLine.totalCents, "stored customer refund line total");
    if (totalCents !== subtotalCents + taxCents
      || returnCaseItemIds.has(returnCaseItemId) || externalLineItemIds.has(externalLineItemId)) {
      throw evidenceInvalid("Stored customer refund quote line evidence is inconsistent.");
    }
    returnCaseItemIds.add(returnCaseItemId);
    externalLineItemIds.add(externalLineItemId);
    lineTotalCents = safeInteger(lineTotalCents + totalCents, "stored customer refund line total");
    return {
      returnCaseItemId,
      externalLineItemId,
      quantity: positiveInteger(rawLine.quantity, "stored customer refund quantity"),
      subtotalCents,
      taxCents,
      totalCents,
    };
  });
  const positions = new Set<number>();
  const parentTransactionIds = new Set<string>();
  let transactionTotalCents = 0;
  const transactions = value.transactions.map((rawTransaction) => {
    if (!isObject(rawTransaction)) throw evidenceInvalid("Stored customer refund transaction is invalid.");
    const position = nonNegativeInteger(rawTransaction.position, "stored customer refund transaction position");
    const parentTransactionId = requiredText(rawTransaction.parentTransactionId, "stored customer refund parent transaction id");
    const amountCents = positiveInteger(rawTransaction.amountCents, "stored customer refund transaction amount");
    if (positions.has(position) || parentTransactionIds.has(parentTransactionId)) {
      throw evidenceInvalid("Stored customer refund transaction evidence is duplicated.");
    }
    positions.add(position);
    parentTransactionIds.add(parentTransactionId);
    transactionTotalCents = safeInteger(transactionTotalCents + amountCents, "stored customer refund transaction total");
    return {
      position,
      parentTransactionId,
      gateway: requiredText(rawTransaction.gateway, "stored customer refund gateway"),
      amountCents,
    };
  });
  if (lineTotalCents !== amountCents || transactionTotalCents !== amountCents
    || amountCents > maximumRefundableCents) {
    throw evidenceInvalid("Stored customer refund quote totals are inconsistent.");
  }
  return { provider: "shopify", currency, amountCents, maximumRefundableCents, lines, transactions };
}

function parseCustomerRefundResult(value: unknown): IssueCustomerRefundResult {
  if (!isObject(value) || value.commandType !== "issue_customer_refund") throw evidenceInvalid("Stored customer refund command response is invalid.");
  return {
    commandType: "issue_customer_refund",
    caseId: positiveInteger(value.caseId, "stored customer refund case id"),
    caseNumber: requiredText(value.caseNumber, "stored customer refund case number"),
    customerRefundId: positiveInteger(value.customerRefundId, "stored customer refund id"),
    provider: value.provider === "shopify" ? "shopify" : (() => { throw evidenceInvalid("Stored customer refund provider is invalid."); })(),
    providerRefundId: requiredText(value.providerRefundId, "stored provider refund id"),
    currency: currencyCode(value.currency, "stored customer refund currency"),
    amountCents: positiveInteger(value.amountCents, "stored customer refund amount"),
    completedAt: dateValue(value.completedAt, "stored customer refund completed timestamp").toISOString(),
    replayed: booleanValue(value.replayed, "stored customer refund replay flag"),
  };
}

function parseVendorSettlementResult(value: unknown): SettleVendorAccountResult {
  if (!isObject(value) || value.commandType !== "settle_vendor_account" || !Array.isArray(value.walletLedgerIds)) {
    throw evidenceInvalid("Stored vendor settlement command response is invalid.");
  }
  return {
    commandType: "settle_vendor_account",
    caseId: positiveInteger(value.caseId, "stored vendor settlement case id"),
    caseNumber: requiredText(value.caseNumber, "stored vendor settlement case number"),
    vendorSettlementId: positiveInteger(value.vendorSettlementId, "stored vendor settlement id"),
    vendorId: positiveInteger(value.vendorId, "stored vendor id"),
    currency: currencyCode(value.currency, "stored vendor settlement currency"),
    grossCreditCents: nonNegativeInteger(value.grossCreditCents, "stored gross credit"),
    totalFeeCents: nonNegativeInteger(value.totalFeeCents, "stored fee total"),
    netSettlementCents: safeInteger(value.netSettlementCents, "stored net settlement"),
    walletLedgerIds: value.walletLedgerIds.map((id) => positiveInteger(id, "stored wallet ledger id")),
    settledAt: dateValue(value.settledAt, "stored vendor settlement timestamp").toISOString(),
    replayed: booleanValue(value.replayed, "stored vendor settlement replay flag"),
  };
}

async function resolveRetailShopifyItems(
  caseId: number,
  omsOrderId: number,
  items: ReturnCaseItemRow[],
): Promise<ReturnFinancialCaseSource["items"]> {
  const linkedLineIds = [...new Set(
    items
      .map((item) => item.omsOrderLineId)
      .filter((id): id is number => id !== null),
  )];
  const matchedById = new Map<number, string | null>();
  if (linkedLineIds.length > 0) {
    const result = await pool.query<OmsLineIdentityRow>(
      `SELECT id, external_line_item_id
       FROM oms.oms_order_lines
       WHERE order_id = $1
         AND id = ANY($2::bigint[])
       ORDER BY id`,
      [omsOrderId, linkedLineIds],
    );
    for (const row of result.rows) {
      const id = positiveInteger(row.id, "OMS order line id");
      if (!linkedLineIds.includes(id) || matchedById.has(id)) {
        throw lineIdentityConflict(caseId, null, id, "INVALID_EVIDENCE");
      }
      matchedById.set(id, nullableText(row.external_line_item_id));
    }
  }

  return items.map((item) => {
    const resolution = resolveReturnCaseExternalLineItemId({
      omsOrderLineId: item.omsOrderLineId,
      storedExternalLineItemId: item.externalLineItemId,
      omsExternalLineItemId: item.omsOrderLineId === null ? null : matchedById.get(item.omsOrderLineId) ?? null,
      omsLineMatchedSourceOrder: item.omsOrderLineId !== null && matchedById.has(item.omsOrderLineId),
    });
    if (resolution.status === "conflict") {
      throw lineIdentityConflict(caseId, item.id, item.omsOrderLineId, resolution.reason);
    }
    return mapFinancialItem(
      item,
      resolution.status === "resolved" ? resolution.externalLineItemId : null,
    );
  });
}

function mapFinancialItem(
  item: ReturnCaseItemRow,
  externalLineItemId: string | null,
): ReturnFinancialCaseSource["items"][number] {
  return {
    returnCaseItemId: item.id,
    omsOrderLineId: item.omsOrderLineId,
    externalLineItemId,
    productVariantId: item.productVariantId,
    quantity: item.quantity,
    sku: item.sku,
    title: item.title,
  };
}

function lineIdentityConflict(
  caseId: number,
  returnCaseItemId: number | null,
  omsOrderLineId: number | null,
  reason: string,
): ReturnCaseFinancialError {
  return financialError(
    "RETURN_FINANCIAL_LINE_IDENTITY_CONFLICT",
    "A returned item has conflicting OMS line identity evidence.",
    409,
    { caseId, returnCaseItemId, omsOrderLineId, reason },
  );
}

function rowId(row: IdRow | undefined, field: string): number {
  if (!row) throw evidenceInvalid(`${field} was not returned.`);
  return positiveInteger(row.id, field);
}

function readBusinessContext(value: unknown): "retail" | "dropship" {
  if (value !== "retail" && value !== "dropship") throw evidenceInvalid("Return business context is invalid.");
  return value;
}
function refundStatus(value: unknown): "pending" | "completed" | "failed" {
  if (value !== "pending" && value !== "completed" && value !== "failed") throw evidenceInvalid("Stored customer refund status is invalid.");
  return value;
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw evidenceInvalid(`${field} is invalid.`);
  return value.trim();
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredText(value, "stored optional text");
}
function currencyCode(value: unknown, field: string): string {
  const result = requiredText(value, field);
  if (!/^[A-Z]{3}$/.test(result)) throw evidenceInvalid(`${field} is invalid.`);
  return result;
}
function hashValue(value: unknown, field: string): string {
  const result = requiredText(value, field);
  if (!/^[0-9a-f]{64}$/.test(result)) throw evidenceInvalid(`${field} is invalid.`);
  return result;
}
function positiveInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw evidenceInvalid(`${field} is invalid.`);
  return result;
}
function requiredPositiveInteger(value: unknown, field: string): number {
  return positiveInteger(value, field);
}
function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : positiveInteger(value, field);
}
function nonNegativeInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw evidenceInvalid(`${field} is invalid.`);
  return result;
}
function safeInteger(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw evidenceInvalid(`${field} is invalid.`);
  return result;
}
function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw evidenceInvalid(`${field} is invalid.`);
  return value;
}
function dateValue(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw evidenceInvalid(`${field} is invalid.`);
  return date;
}
function nullableDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : dateValue(value, field);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stale(message: string): ReturnCaseFinancialError {
  return financialError("RETURN_FINANCIAL_STATE_STALE", message, 409);
}
function evidenceInvalid(message: string): ReturnCaseFinancialError {
  return financialError("RETURN_FINANCIAL_EVIDENCE_INVALID", message, 500);
}
function financialError(code: string, message: string, status: number, context?: Record<string, unknown>): ReturnCaseFinancialError {
  return new ReturnCaseFinancialError(code, message, status, context);
}
function isUniqueViolation(error: unknown): boolean {
  return isObject(error) && error.code === "23505";
}
function classifyDatabaseError(error: unknown, code: string, message: string): ReturnCaseFinancialError {
  if (error instanceof ReturnCaseFinancialError) return error;
  return financialError(code, message, 500, {
    databaseCode: isObject(error) && typeof error.code === "string" ? error.code : null,
    error: error instanceof Error ? error.message : String(error),
  });
}
async function rollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
}

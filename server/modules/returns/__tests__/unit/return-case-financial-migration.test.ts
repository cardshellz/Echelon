import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/207_return_case_financial_actions.sql", "utf8");

describe("return case financial actions migration", () => {
  it("keeps retail refunds and dropship settlements as separate evidence streams", () => {
    expect(migration).toContain("CREATE TABLE returns.return_case_customer_refunds");
    expect(migration).toContain("CREATE TABLE returns.return_case_vendor_settlements");
    expect(migration).toContain("'issue_customer_refund'");
    expect(migration).toContain("'settle_vendor_account'");
    expect(migration).not.toMatch(/UPDATE\s+(?:inventory\.|wms\.|oms\.)/i);
  });

  it("binds every Shopify refund child row to the reviewed quote and Return Case", () => {
    expect(migration).toContain("guard_customer_refund_item_evidence");
    expect(migration).toContain("item_case_id <> header.return_case_id");
    expect(migration).toContain("jsonb_array_elements(header.quote->'lines')");
    expect(migration).toContain("quoted.line->>'externalLineItemId' = NEW.external_line_item_id");
    expect(migration).toContain("guard_customer_refund_transaction_evidence");
    expect(migration).toContain("jsonb_array_elements(header.quote->'transactions')");
    expect(migration).toContain("quoted.transaction->>'parentTransactionId' = NEW.parent_transaction_id");
  });

  it("requires exact refund line and transaction totals at commit", () => {
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("item_total <> header.amount_cents");
    expect(migration).toContain("transaction_total <> header.amount_cents");
    expect(migration).toContain("item_count <> jsonb_array_length(header.quote->'lines')");
    expect(migration).toContain("transaction_count <> jsonb_array_length(header.quote->'transactions')");
    expect(migration).toContain("return_case_customer_refund_header_totals_guard");
  });

  it("correlates vendor settlement evidence to exact settled wallet rows", () => {
    expect(migration).toContain("guard_vendor_settlement_ledger_evidence");
    expect(migration).toContain("ledger.vendor_id <> settlement.vendor_id");
    expect(migration).toContain("ledger.amount_cents <> expected_amount");
    expect(migration).toContain("ledger.reference_type <> 'return_case_vendor_settlement'");
    expect(migration).toContain("ledger.reference_id <> (settlement.id::text || ':' || NEW.entry_role)");
    expect(migration).toContain("ledger.idempotency_key <> (settlement.idempotency_key || ':' || NEW.entry_role)");
  });

  it("requires the exact number of credit and fee ledger entries", () => {
    expect(migration).toContain("validate_vendor_settlement_ledger_evidence");
    expect(migration).toContain("credit_count <> CASE WHEN settlement.gross_credit_cents > 0 THEN 1 ELSE 0 END");
    expect(migration).toContain("fee_count <> CASE WHEN settlement.total_fee_cents > 0 THEN 1 ELSE 0 END");
    expect(migration).toContain("return_case_vendor_settlement_header_ledger_guard");
    expect(migration).toContain("return_case_vendor_settlement_child_ledger_guard");
  });

  it("requires coherent terminal inspection evidence for financial actions", () => {
    expect(migration).toContain("target.policy_snapshot->>'inspectionRequirement' = 'none'");
    expect(migration.match(/FROM returns\.return_case_inspections inspection/g)).toHaveLength(3);
    expect(migration.match(/inspection\.status = 'approved'/g)).toHaveLength(2);
  });

  it("mirrors the retail and dropship ownership rules at the database boundary", () => {
    expect(migration).toContain("channel_provider IS DISTINCT FROM 'shopify'");
    expect(migration).toContain("target.policy_snapshot->>'customerRefundAuthority' IS DISTINCT FROM 'card_shellz'");
    expect(migration).toContain("target.policy_snapshot->>'vendorSettlementTrigger' IS DISTINCT FROM 'inspection_approved'");
    expect(migration).toContain("FOR SHARE");
    expect(migration).toContain("AND NOT EXISTS (");
    expect(migration).toContain("WHERE inspection.return_case_id = target.id");
  });

  it("requires full receipt and complete immutable disposition evidence", () => {
    expect(migration).toContain("return_case_disposition_is_complete");
    expect(migration).toContain("wms_item.received_qty <> wms_item.expected_qty");
    expect(migration).toContain("recorded.recorded_quantity <> wms_item.received_qty");
    expect(migration).toContain("FROM returns.return_case_disposition_items disposition_item");
    expect(migration.match(/NOT returns\.return_case_disposition_is_complete\(target\.id\)/g)).toHaveLength(2);
    expect(migration).not.toMatch(/UPDATE\s+(?:inventory\.|wms\.|oms\.)/i);
  });

  it("requires bidirectional immutable command evidence for completed financial actions", () => {
    expect(migration).toContain("validate_customer_refund_command_evidence");
    expect(migration).toContain("return_case_customer_refund_command_evidence_guard");
    expect(migration).toContain("validate_vendor_settlement_command_evidence");
    expect(migration).toContain("return_case_vendor_settlement_command_evidence_guard");
    expect(migration).toContain("validate_return_case_financial_command");
    expect(migration).toContain("return_case_financial_commands_evidence_guard");
    expect(migration).toContain("(command.response->>'customerRefundId')::bigint = NEW.id");
    expect(migration).toContain("(command.response->>'vendorSettlementId')::bigint = NEW.id");
    expect(migration).toContain("(NEW.response->>'customerRefundId')::bigint = refund.id");
    expect(migration).toContain("(NEW.response->>'vendorSettlementId')::bigint = settlement.id");
  });
});

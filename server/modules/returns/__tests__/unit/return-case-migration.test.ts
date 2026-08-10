import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/0613_return_cases.sql", "utf8");

describe("Return Case migration invariants", () => {
  it("creates the canonical case, item snapshot, and event tables", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS returns.return_cases");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS returns.return_case_items");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS returns.return_case_events");
    expect(migration).toContain("case_number varchar(32) NOT NULL DEFAULT");
  });

  it("deduplicates source events and WMS returns", () => {
    expect(migration).toContain(
      "CONSTRAINT return_cases_source_uq UNIQUE (source_provider, source_event_type, source_event_id)",
    );
    expect(migration).toContain("CONSTRAINT return_cases_wms_return_uq UNIQUE (wms_return_id)");
  });

  it("requires exact policy and operational lineage", () => {
    expect(migration).toContain("channel_id integer NOT NULL REFERENCES channels.channels(id)");
    expect(migration).toContain("oms_order_id bigint NOT NULL REFERENCES oms.oms_orders(id)");
    expect(migration).toContain("wms_order_id integer NOT NULL REFERENCES wms.orders(id)");
    expect(migration).toContain("wms_return_id bigint NOT NULL REFERENCES wms.returns(id)");
    expect(migration).toContain("policy_id integer NOT NULL REFERENCES returns.return_policies(id)");
    expect(migration).toContain("policy_version integer NOT NULL");
    expect(migration).toContain("policy_snapshot jsonb NOT NULL");
    expect(migration).toContain("CONSTRAINT return_cases_policy_snapshot_chk CHECK");
  });

  it("enforces every independent lifecycle axis in the database", () => {
    expect(migration).toContain("CONSTRAINT return_cases_case_status_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_cases_approval_status_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_cases_logistics_status_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_cases_inspection_status_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_cases_customer_refund_status_chk CHECK");
    expect(migration).toContain("CONSTRAINT return_cases_vendor_settlement_status_chk CHECK");
  });

  it("stores quantities and money snapshots as constrained integers", () => {
    expect(migration).toContain("quantity integer NOT NULL");
    expect(migration).toContain("unit_paid_price_cents bigint NOT NULL");
    expect(migration).toContain("source_line_total_cents bigint NOT NULL");
    expect(migration).toContain("CONSTRAINT return_case_items_quantity_chk CHECK (quantity > 0)");
    expect(migration).toContain("CONSTRAINT return_case_items_money_chk CHECK");
  });

  it("makes item and event evidence append-only and protects case identity", () => {
    expect(migration).toContain("CREATE TRIGGER return_case_items_immutable");
    expect(migration).toContain("CREATE TRIGGER return_case_events_immutable");
    expect(migration.match(/BEFORE UPDATE OR DELETE ON returns\.return_case_(?:items|events)/g)).toHaveLength(2);
    expect(migration).toContain("CREATE TRIGGER return_cases_mutation_guard");
    expect(migration).toContain("Return Cases are permanent operational records; DELETE is not allowed");
    expect(migration).toContain("Return Case identity, source linkage, and policy evidence are immutable");
  });
});

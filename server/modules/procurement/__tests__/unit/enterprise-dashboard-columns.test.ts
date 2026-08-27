import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_SRC = readFileSync(
  resolve(__dirname, "../../enterprise-dashboard.service.ts"),
  "utf8",
);
const DB_SRC = readFileSync(resolve(__dirname, "../../../../db.ts"), "utf8");
/** db.ts with `//` comment lines stripped, so guards assert on real DDL rather
 *  than on prose that documents the DDL we removed. */
const DB_CODE = DB_SRC.split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

/**
 * The enterprise dashboard queried columns that do not exist:
 *
 *   [EnterpriseDashboard] financialKpis failed: column "total_amount_cents" does not exist
 *   [EnterpriseDashboard] procurementPipeline failed: column "total_amount_cents" does not exist
 *
 * `getEnterpriseDashboard` wraps each section in `safe()`, so the endpoint still
 * returned 200 and the dashboard rendered 0 for open PO value and the financial
 * KPIs rather than failing. Against production the correct columns return
 * $265,518.50 of open POs and $69,976.55 pending AP - the screen was showing
 * zero for both.
 *
 * `total_amount_cents` exists only on procurement.ap_payments. These assertions
 * pin each query to the column its own table actually has, since a wrong name
 * here fails silently at runtime rather than at build time.
 */
describe("enterprise dashboard column names", () => {
  it("sums purchase orders on total_cents", () => {
    // procurement.purchase_orders has total_cents (plus subtotal/tax/discount).
    expect(DASHBOARD_SRC).toMatch(/SUM\(total_cents\) FILTER \(WHERE status IN/);
    expect(DASHBOARD_SRC).toMatch(
      /SELECT COALESCE\(SUM\(total_cents\), 0\)::bigint AS value\s*\n\s*FROM procurement\.purchase_orders/,
    );
  });

  it("sums pending AP on the outstanding balance, not the invoiced total", () => {
    // vendor_invoices carries invoiced_amount_cents, paid_amount_cents and
    // balance_cents. Pending AP is what is still owed, and the status filter
    // includes partially_paid - invoiced_amount_cents would count money already
    // paid. Verified in production: balance_cents == invoiced - paid.
    expect(DASHBOARD_SRC).toMatch(
      /SELECT COALESCE\(SUM\(balance_cents\), 0\)::bigint AS value\s*\n\s*FROM procurement\.vendor_invoices/,
    );
  });

  it("never reaches for total_amount_cents, which lives only on ap_payments", () => {
    expect(DASHBOARD_SRC).not.toMatch(/total_amount_cents/);
  });
});

/**
 * The boot-time schema routine created three membership-domain tables. The first
 * of them declared a foreign key whose type could not match its target:
 *
 *   member_subscription_id INTEGER REFERENCES membership.member_subscriptions(id)
 *
 * member_subscriptions.id is varchar, so Postgres refused the constraint with
 * "cannot be implemented". Because that block ran first, it aborted the routine
 * and every remaining schema fallback was skipped on every boot.
 *
 * The file's own comment already forbids this ("NEVER reintroduce membership.*
 * DDL in this startup routine") after a 2026-06 incident where boot-time DDL
 * dropped plans.tier_level. These assertions make that rule enforceable.
 */
describe("startup schema routine stays out of the membership domain", () => {
  it("does not create the subscription engine tables", () => {
    for (const table of ["subscription_billing_log", "subscription_events", "selling_plan_map"]) {
      expect(DB_CODE).not.toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
  });

  it("declares no foreign key into membership.*", () => {
    // The failing constraint referenced membership.member_subscriptions(id).
    expect(DB_CODE).not.toMatch(/REFERENCES\s+membership\./);
  });

  it("keeps the rule that prompted this documented", () => {
    expect(DB_SRC).toMatch(/NEVER reintroduce\s*\n?\s*\/\/\s*membership\.\* DDL in this startup routine/);
  });
});

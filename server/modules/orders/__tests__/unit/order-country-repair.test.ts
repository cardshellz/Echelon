import { describe, expect, it, vi } from "vitest";
import { parseCountryRepairArguments } from "../../../../../scripts/repair-order-countries";
import {
  applyOrderCountryRepair, orderCountryRepairDigest, validateOrderCountryRepairPlan,
} from "../../infrastructure/order-country-repair";

const row = { tableName: "oms.oms_orders", rowId: "12", beforeCountry: "United States", afterCountry: "US" };
const plan = { version: 1, rows: [row], unrecognized: [] };

describe("country repair approval contract", () => {
  it("defaults to a dry-run and requires explicit attribution plus digest to apply", () => {
    expect(parseCountryRepairArguments(["--plan=preview.json"]).apply).toBe(false);
    expect(parseCountryRepairArguments(["--dry-run", "--plan=preview.json"]).apply).toBe(false);
    expect(parseCountryRepairArguments(["--apply", "--plan=preview.json", "--actor=admin",
      "--operation-key=country-cleanup", `--confirm-digest=${orderCountryRepairDigest(plan)}`]).apply).toBe(true);
  });
  it.each([
    [], ["--apply"], ["--plan=p", "--apply"], ["--dry-run", "--apply", "--plan=p"],
    ["--plan=a", "--plan=b"], ["--plan=a", "--force"], ["--plan=a", "--actor=admin"],
  ].map(args => ({ args })))("rejects incomplete, ambiguous or unknown options: $args", ({ args }) => {
    expect(() => parseCountryRepairArguments(args)).toThrow();
  });
  it("binds approval to exact country changes and stable field/row order", () => {
    const second = { ...row, rowId: "14", beforeCountry: "Canada", afterCountry: "CA" };
    expect(orderCountryRepairDigest({ ...plan, rows: [row, second] }))
      .toBe(orderCountryRepairDigest({ rows: [second, row], unrecognized: [], version: 1 }));
    expect(orderCountryRepairDigest(plan)).not.toBe(orderCountryRepairDigest({ ...plan, rows: [second] }));
  });
  it.each([
    { ...plan, rows: [{ ...row, tableName: "public.shopify_orders" }] },
    { ...plan, rows: [{ ...row, afterCountry: "CA" }] },
    { ...plan, rows: [{ ...row, beforeCountry: "Atlantis" }] },
    { ...plan, rows: [{ ...row, beforeCountry: "US" }] },
    { ...plan, rows: [{ ...row, rowId: "1;DELETE" }] },
    { ...plan, rows: [{ ...row, rowId: "9223372036854775808" }] },
    { ...plan, rows: [row, row] },
    { ...plan, extra: "unexpected" },
  ])("rejects invalid, duplicate, unsafe or non-equivalent changes", value => {
    expect(() => validateOrderCountryRepairPlan(value)).toThrow("COUNTRY_REPAIR_PLAN_INVALID");
  });
  it("rejects unapproved work before opening a connection", async () => {
    const pool = { connect: vi.fn() };
    await expect(applyOrderCountryRepair(pool, {
      plan, approvedDigest: "0".repeat(64), operationKey: "cleanup", actor: "admin",
    })).rejects.toMatchObject({ code: "COUNTRY_REPAIR_APPROVAL_MISMATCH" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it("blocks unknown values even if an operator supplies the matching plan digest", async () => {
    const pool = { connect: vi.fn() };
    const unknownPlan = { ...plan, unrecognized: [{ tableName: "wms.orders", rowId: "99", valueHash: "a".repeat(64) }] };
    await expect(applyOrderCountryRepair(pool, {
      plan: unknownPlan, approvedDigest: orderCountryRepairDigest(unknownPlan), operationKey: "cleanup", actor: "admin",
    })).rejects.toMatchObject({ code: "COUNTRY_REPAIR_UNRECOGNIZED_VALUES" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

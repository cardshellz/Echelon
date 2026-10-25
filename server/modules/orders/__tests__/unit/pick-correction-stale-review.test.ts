import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveCorrectivePick } from "../../../wms/pick-correction.repository";

// #64254 (2026-10-18): after the shipped-line fix, 7 of 20 units posted but the
// card kept showing the pre-fix error, so the picker believed nothing worked.

function db(row: Record<string, unknown>) {
  const statements: string[] = [];
  return { statements, execute: async (statement: any) => {
    const text = new PgDialect().sqlToQuery(statement).sql;
    statements.push(text);
    return text.includes('AS "orderNumber"') ? { rows: [{ id: 209, orderId: 209703, orderItemId: 324152,
      orderNumber: "#64254", sku: "SHLZ-TOP-180PT-BLU-P10", name: "Toploaders", barcode: null, location: "A-06",
      declaredQuantity: 20, revision: 12, state: "picking_required", answer: "no", assignedPickerId: "picker",
      updatedAt: new Date("2026-10-18T17:20:00Z"), ...row }] } : { rows: [] };
  } };
}

describe("a partial corrective pick that posted", () => {
  it("clears the earlier failure so the card stops showing it", async () => {
    const fake = db({ pickedQuantity: 7, reviewReason: "A canonical runtime pick must atomically add one positive WMS progress delta." });
    await resolveCorrectivePick(fake, 209, "picker", new Date("2026-10-18T17:21:00Z"));
    expect(fake.statements.some((text) => text.startsWith("UPDATE wms.pick_corrections SET review_reason=NULL"))).toBe(true);
    expect(fake.statements.some((text) => text.includes("state='resolved'"))).toBe(false);
  });

  it("writes nothing when there is no saved failure", async () => {
    const fake = db({ pickedQuantity: 7, reviewReason: null });
    await resolveCorrectivePick(fake, 209, "picker", new Date("2026-10-18T17:21:00Z"));
    expect(fake.statements.filter((text) => text.startsWith("UPDATE"))).toEqual([]);
  });
});

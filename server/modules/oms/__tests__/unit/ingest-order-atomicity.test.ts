import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OMS_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../oms.service.ts"),
  "utf8",
);

describe("ingestOrder atomicity — order + lines + event in one transaction", () => {
  it("wraps the insert path in db.transaction()", () => {
    expect(OMS_SERVICE_SRC).toMatch(/const order = await db\.transaction\(async \(tx: any\)/);
  });

  it("inserts the order row using tx, not db", () => {
    expect(OMS_SERVICE_SRC).toMatch(/const \[inserted\] = await tx\s*\n\s*\.insert\(omsOrders\)/);
  });

  it("inserts line items using tx inside the transaction", () => {
    expect(OMS_SERVICE_SRC).toMatch(/await tx\.insert\(omsOrderLines\)\.values\(\{/);
  });

  it("inserts the created event using tx inside the transaction", () => {
    expect(OMS_SERVICE_SRC).toMatch(/await tx\.insert\(omsOrderEvents\)\.values\(\{/);
  });

  it("variant lookup uses tx so it sees transaction-local state", () => {
    const txBlock = OMS_SERVICE_SRC.slice(
      OMS_SERVICE_SRC.indexOf("db.transaction(async (tx"),
      OMS_SERVICE_SRC.indexOf("return inserted;"),
    );
    expect(txBlock).toMatch(/await tx\s*\n\s*\.select\(/);
  });

  it("line items and event are inserted BEFORE the transaction commits (ordering)", () => {
    const txStart = OMS_SERVICE_SRC.indexOf("db.transaction(async (tx");
    const lineInsert = OMS_SERVICE_SRC.indexOf("tx.insert(omsOrderLines)");
    const eventInsert = OMS_SERVICE_SRC.indexOf('eventType: "created"');
    const returnInserted = OMS_SERVICE_SRC.indexOf("return inserted;", txStart);
    expect(txStart).toBeGreaterThan(0);
    expect(lineInsert).toBeGreaterThan(txStart);
    expect(eventInsert).toBeGreaterThan(lineInsert);
    expect(returnInserted).toBeGreaterThan(eventInsert);
  });
});

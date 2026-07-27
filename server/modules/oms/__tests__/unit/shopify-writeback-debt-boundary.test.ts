import fs from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schedulerSource = fs.readFileSync(
  resolve(__dirname, "../../fulfillment-sweeper.scheduler.ts"),
  "utf8",
);
const operatorSource = fs.readFileSync(
  resolve(__dirname, "../../../../../scripts/reconcile-shopify-writeback-debt.ts"),
  "utf8",
);

describe("Shopify writeback debt recovery boundary", () => {
  it("uses a read-only Shopify snapshot and never calls fulfillment ingestion", () => {
    const recoveryStart = schedulerSource.indexOf(
      "export async function recoverShopifyWritebackDebt",
    );
    const recoveryEnd = schedulerSource.indexOf("function getReconciler", recoveryStart);
    const recovery = schedulerSource.slice(recoveryStart, recoveryEnd);

    expect(recovery).toContain("ShopifyFulfillmentSnapshotReader");
    expect(recovery).not.toContain("syncFulfillmentsFromChannel");
    expect(recovery).not.toContain("channelFulfillmentIngress");
    expect(operatorSource).toContain("ShopifyFulfillmentSnapshotReader");
    expect(operatorSource).not.toContain("ShopifyFulfillmentReconciler");
    expect(operatorSource).not.toContain("createServices");
  });
});

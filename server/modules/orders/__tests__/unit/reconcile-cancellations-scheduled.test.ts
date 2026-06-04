import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RECONCILE_SRC = readFileSync(
  resolve(__dirname, "../../shopify-order-reconciliation.ts"),
  "utf8",
);

const INDEX_SRC = readFileSync(
  resolve(__dirname, "../../../../index.ts"),
  "utf8",
);

describe("reconcileCancellations is wired into the 15-min reconciliation interval", () => {
  it("initReconciliation accepts a WmsSyncService parameter", () => {
    expect(RECONCILE_SRC).toMatch(
      /export function initReconciliation\(\s*oms\?:\s*OmsService,\s*wmsSync\?:\s*WmsSyncService/,
    );
  });

  it("stores the wmsSyncService reference", () => {
    expect(RECONCILE_SRC).toMatch(
      /wmsSyncService = wmsSync \|\| null/,
    );
  });

  it("runCancellationReconciliation calls wmsSyncService.reconcileCancellations()", () => {
    expect(RECONCILE_SRC).toMatch(
      /wmsSyncService\.reconcileCancellations\(\)/,
    );
  });

  it("cancellation sweep runs inside the periodic interval", () => {
    expect(RECONCILE_SRC).toMatch(
      /setInterval\(async \(\) => \{[\s\S]*?runCancellationReconciliation\(\)/,
    );
  });

  it("index.ts passes services.wmsSync to initReconciliation", () => {
    expect(INDEX_SRC).toMatch(
      /initReconciliation\(services\.oms,\s*services\.wmsSync\)/,
    );
  });
});

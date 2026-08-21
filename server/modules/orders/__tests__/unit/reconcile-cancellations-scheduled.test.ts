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
    expect(RECONCILE_SRC).toMatch(/wmsSyncService = wmsSync \|\| null/);
  });

  it("runCancellationReconciliation calls wmsSyncService.reconcileCancellations()", () => {
    expect(RECONCILE_SRC).toMatch(/wmsSyncService\.reconcileCancellations\(\)/);
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

const READINESS_SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../../oms/shopify-line-readiness.service.ts"),
  "utf8",
);

describe("delayed Shopify fulfillability recovery", () => {
  it("checks existing OMS orders instead of discarding them from reconciliation", () => {
    expect(RECONCILE_SRC).toContain("reconcileExistingOmsOrderReadiness");
    expect(RECONCILE_SRC).toContain("existingByShopifyId");
    expect(RECONCILE_SRC).toContain("loadDelayedReadinessCandidates");
  });

  it("keeps recovery bounded and retries incomplete WMS materialization", () => {
    expect(RECONCILE_SRC).toContain("SHOPIFY_READINESS_RECOVERY_LIMIT");
    expect(RECONCILE_SRC).toContain("READINESS_RECOVERY_CURSOR_KEY");
    expect(RECONCILE_SRC).toContain("CASE WHEN oo.id > ${afterOmsOrderId}");
    expect(RECONCILE_SRC).toContain("setReadinessRecoveryCursor");
    expect(RECONCILE_SRC).toContain("authority_fulfillable_quantity");
    expect(RECONCILE_SRC).toContain("wms_materialized_quantity");
    expect(RECONCILE_SRC).toContain("syncOmsOrderToWms(omsOrderId)");
  });

  it("locks OMS lines and records authority through the OMS-owned service", () => {
    expect(READINESS_SERVICE_SRC).toContain('.for("update")');
    expect(READINESS_SERVICE_SRC).toContain("deriveOmsLineAuthority");
    expect(READINESS_SERVICE_SRC).toContain("recordOmsLineAuthorityEvent");
  });
});

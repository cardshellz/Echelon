import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { loadShopifyReadinessCandidates } from "../../../oms/infrastructure/shopify-readiness-candidates.repository";

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

  it("passes the recovery limit and persisted cursor to the candidate repository", () => {
    expect(RECONCILE_SRC).toContain("SHOPIFY_READINESS_RECOVERY_LIMIT");
    expect(RECONCILE_SRC).toContain("READINESS_RECOVERY_CURSOR_KEY");
    expect(RECONCILE_SRC).toContain("loadShopifyReadinessCandidates(db,");
    expect(RECONCILE_SRC).toContain("setReadinessRecoveryCursor");
  });

  it("binds the batch limit and rotating cursor while selecting incomplete WMS materialization", async () => {
    const execute = vi.fn(async (_statement: SQL) => ({
      rows: [{ oms_order_id: "41", shopify_order_id: "1001", needs_paid_replay: false }],
    }));

    expect(await loadShopifyReadinessCandidates({ execute }, {
      channelId: 36, afterOmsOrderId: 40, limit: 7,
    })).toEqual([{ omsOrderId: 41, shopifyOrderId: "1001", needsPaidReplay: false }]);

    expect(execute).toHaveBeenCalledOnce();
    const { sql: query, params } = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    const cursorParameter = query.match(
      /ORDER BY\s+CASE WHEN oo\.id > \$(\d+) THEN 0 ELSE 1 END ASC,\s+oo\.id ASC/,
    );
    const limitParameter = query.match(/LIMIT \$(\d+)/);

    expect(cursorParameter).not.toBeNull();
    expect(params[Number(cursorParameter?.[1]) - 1]).toBe(40);
    expect(limitParameter).not.toBeNull();
    expect(params[Number(limitParameter?.[1]) - 1]).toBe(7);
    expect(query).toMatch(
      /COALESCE\(ol\.authority_fulfillable_quantity, 0\) >\s+COALESCE\(ol\.wms_materialized_quantity, 0\)/,
    );
  });

  it("locks OMS lines and records authority through the OMS-owned service", () => {
    expect(READINESS_SERVICE_SRC).toContain('.for("update")');
    expect(READINESS_SERVICE_SRC).toContain("deriveOmsLineAuthority");
    expect(READINESS_SERVICE_SRC).toContain("recordOmsLineAuthorityEvent");
  });
});

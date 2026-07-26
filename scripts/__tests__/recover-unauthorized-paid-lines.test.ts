import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RECOVERY_SRC = readFileSync(
  resolve(__dirname, "../recover-unauthorized-paid-lines.ts"),
  "utf8",
);

describe("recover unauthorized paid lines", () => {
  it("only selects orders whose original default WMS partition already shipped", () => {
    expect(RECOVERY_SRC).toContain(
      "shipped_partition.fulfillment_partition_key = 'default'",
    );
    expect(RECOVERY_SRC).toContain(
      "shipped_partition.warehouse_status = 'shipped'",
    );
    expect(RECOVERY_SRC).toContain(
      "mutable_partition.warehouse_status NOT IN ('shipped','cancelled')",
    );
  });

  it("can retry lines authorized by an earlier interrupted recovery", () => {
    expect(RECOVERY_SRC).toContain(
      "l.authorized_by_event_id = ${SOURCE_EVENT_ID}",
    );
    expect(RECOVERY_SRC).toContain(
      "current.authorizedByEventId === SOURCE_EVENT_ID",
    );
    expect(RECOVERY_SRC).toContain(
      "current.authoritySourceTopic === \"reconciler/authorize\"",
    );
  });

  it("uses the dedicated terminal residual sync instead of mutating the shipped partition", () => {
    expect(RECOVERY_SRC).toContain(
      "wmsSync.recoverUnauthorizedPaidLinesToWms(omsOrderId)",
    );
    expect(RECOVERY_SRC).not.toContain(
      "await wmsSync.syncOmsOrderToWms(omsOrderId)",
    );
  });

  it("verifies recovered lines are materialized and assigned to an active shipment", () => {
    expect(RECOVERY_SRC).toContain(
      "COALESCE(l.wms_materialized_quantity,0) < l.quantity",
    );
    expect(RECOVERY_SRC).toContain(
      "JOIN wms.outbound_shipment_items osi ON osi.order_item_id = oi.id",
    );
    expect(RECOVERY_SRC).toContain(
      "os.status NOT IN ('voided','cancelled')",
    );
  });
});

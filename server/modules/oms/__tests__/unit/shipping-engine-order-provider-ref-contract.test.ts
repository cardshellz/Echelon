import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const authoritySource = readFileSync(
  resolve(process.cwd(), "server/modules/oms/channel-fulfillment-authority.repository.ts"),
  "utf8",
);
const trackingSource = readFileSync(
  resolve(process.cwd(), "server/modules/shipping/carrier-tracking.repository.ts"),
  "utf8",
);
const migrationSource = readFileSync(
  resolve(process.cwd(), "migrations/173_shipping_engine_order_provider_refs.sql"),
  "utf8",
);

describe("shipping-engine provider order reference contract", () => {
  it("stores every provider order id under one canonical logical order", () => {
    expect(migrationSource).toContain(
      "CONSTRAINT uq_shipping_engine_order_provider_refs_identity",
    );
    expect(migrationSource).toContain(
      "UNIQUE(provider, provider_order_id)",
    );
    expect(migrationSource).toContain(
      "'shipping_engine_order_backfill'",
    );
  });

  it("resolves known aliases and rejects aliases already owned by another order", () => {
    expect(authoritySource).toContain(
      "FROM wms.shipping_engine_order_provider_refs AS provider_ref",
    );
    expect(authoritySource).toContain(
      "Provider order id is already assigned to another canonical shipping-engine order",
    );
    expect(authoritySource).toContain(
      "WHERE provider_ref.shipping_engine_order_id = EXCLUDED.shipping_engine_order_id",
    );
  });

  it("allows carrier label reconciliation to follow a known provider order alias", () => {
    expect(trackingSource).toContain(
      "FROM wms.shipping_engine_order_provider_refs AS provider_ref",
    );
    expect(trackingSource).toContain(
      "provider_ref.provider_order_id = label.provider_order_id",
    );
  });
});

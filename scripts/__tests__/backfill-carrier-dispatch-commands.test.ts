import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  parseFlags,
  runCarrierDispatchBackfill,
  type CarrierDispatchBackfillCandidate,
} from "../backfill-carrier-dispatch-commands";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "..", "backfill-carrier-dispatch-commands.ts"),
  "utf8",
);

const candidate: CarrierDispatchBackfillCandidate = {
  shippingProviderLabelId: 10,
  carrierTrackingEventId: 101,
  provider: "shipstation",
  providerLabelId: "442000001",
  trackingNumber: "1Z999AA10123456784",
  orderNumbers: ["#60001"],
  dispatchOccurredAt: new Date("2026-07-20T11:30:00.000Z"),
};

describe("backfill carrier dispatch commands", () => {
  it("is dry-run by default and requires an operator for execution", () => {
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 25,
      orderNumber: null,
      operator: null,
    });
    expect(() => parseFlags(["--execute"])).toThrow(
      "--operator is required in execute mode",
    );
    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--order-number=#60001",
      "--operator=owner@example.com",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      orderNumber: "#60001",
      operator: "owner@example.com",
    });
  });

  it("previews candidates without writes", async () => {
    const enqueue = vi.fn();
    const log = vi.fn();

    const result = await runCarrierDispatchBackfill(parseFlags([]), {
      loadCandidates: vi.fn().mockResolvedValue([candidate]),
      enqueue,
      log,
    });

    expect(result).toEqual({
      mode: "dry-run",
      candidates: 1,
      inserted: 0,
      alreadyPresent: 0,
      noLongerEligible: 0,
      failures: [],
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PLAN"));
  });

  it("records inserted, idempotent, stale, and failed candidates independently", async () => {
    const candidates = [
      candidate,
      { ...candidate, shippingProviderLabelId: 11 },
      { ...candidate, shippingProviderLabelId: 12 },
      { ...candidate, shippingProviderLabelId: 13 },
    ];
    const enqueue = vi.fn()
      .mockResolvedValueOnce("inserted")
      .mockResolvedValueOnce("already_present")
      .mockResolvedValueOnce("no_longer_eligible")
      .mockRejectedValueOnce(new Error("database unavailable"));

    const result = await runCarrierDispatchBackfill(parseFlags([
      "--execute",
      "--operator=owner@example.com",
    ]), {
      loadCandidates: vi.fn().mockResolvedValue(candidates),
      enqueue,
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      mode: "execute",
      candidates: 4,
      inserted: 1,
      alreadyPresent: 1,
      noLongerEligible: 1,
      failures: [{
        shippingProviderLabelId: 13,
        carrierTrackingEventId: 101,
        message: "database unavailable",
      }],
    });
    expect(enqueue).toHaveBeenCalledWith(candidate, "owner@example.com");
  });

  it("selects only confirmed matched linked labels missing physical shipment authority", () => {
    expect(source).toContain("event.dispatch_evidence = 'confirmed'");
    expect(source).toContain("match.match_status = 'matched'");
    expect(source).toContain("wms.shipping_provider_label_links");
    expect(source).toContain("label.label_status IN ('active', 'unknown')");
    expect(source).toContain("wms.physical_shipments");
    expect(source).toContain("wms.carrier_dispatch_commands");
  });

  it("uses the canonical physical shipment provider column in preview and execution", () => {
    expect(source).not.toContain("physical.shipping_provider");
    expect(source.match(/physical\.provider = label\.provider/g)).toHaveLength(2);
  });

  it("uses one idempotent command per label and retains the operator identity", () => {
    expect(source).toContain("ON CONFLICT (shipping_provider_label_id) DO NOTHING");
    expect(source).toContain("'shadow_cutover_backfill'");
    expect(source).toContain("$4::text");
    expect(source).toContain("created_by");
  });
});

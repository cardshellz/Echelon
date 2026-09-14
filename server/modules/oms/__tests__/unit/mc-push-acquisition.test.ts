import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  reads: 0,
  raw: {} as Record<string, unknown>,
  logError: vi.fn(),
}));
vi.mock("../../../../db", () => ({
  db: {
    select: () => {
      const step = fixture.reads++ % 3;
      const rows =
        step === 0
          ? [
              {
                id: 42,
                channelId: 1,
                externalOrderId: "100",
                rawPayload: fixture.raw,
                totalCents: 12345,
                subtotalCents: 11000,
                shippingCents: 1000,
                taxCents: 345,
                discountCents: 0,
                orderedAt: new Date("2026-09-13T12:00:00Z"),
              },
            ]
          : step === 1
            ? [{ name: "Shopify" }]
            : [];
      return {
        from: () => ({
          where: () =>
            step === 2
              ? Promise.resolve(rows)
              : { limit: () => Promise.resolve(rows) },
        }),
      };
    },
  },
}));
vi.mock("@shared/schema", () => ({
  omsOrders: { id: "id" },
  omsOrderLines: { orderId: "orderId" },
  channels: { id: "id", name: "name" },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { error: fixture.logError },
}));
import { pushToMissionControl } from "../../mc-push";

describe("OMS to Archon acquisition payload", () => {
  const sent: Array<{ order: Record<string, unknown> }> = [];
  beforeEach(() => {
    fixture.reads = 0;
    fixture.raw = {};
    fixture.logError.mockReset();
    sent.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ action: "updated" }), {
          status: 200,
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("forwards exact acquisition evidence on each ordinary order push", async () => {
    const touch = {
      source: "alex",
      medium: "affiliate",
      occurredAt: "2026-09-13T10:00:00Z",
      partnerKey: "alex",
      linkId: "fall",
    };
    fixture.raw = {
      note_attributes: [
        { name: "__archon_acquisition_v1", value: JSON.stringify([touch]) },
      ],
    };
    await pushToMissionControl(42, "order.created");
    await pushToMissionControl(42, "order.updated");
    expect(sent).toHaveLength(2);
    for (const payload of sent) {
      expect(payload.order.marketing_attribution).toEqual([touch]);
      expect(payload.order.total_cents).toBe(12345);
      expect(payload.order.external_order_id).toBe("100");
    }
    expect(fixture.logError).not.toHaveBeenCalled();
  });
  it("still delivers the financial order and emits a sanitized diagnostic when tracking is invalid", async () => {
    fixture.raw = { marketing_attribution: [{ source: "do-not-log-this" }] };
    await pushToMissionControl(42, "order.created");
    expect(sent).toHaveLength(1);
    expect(sent[0].order.total_cents).toBe(12345);
    expect(sent[0].order.marketing_attribution).toEqual([]);
    expect(fixture.logError).toHaveBeenCalledWith(
      "oms.archon_acquisition.forward",
      expect.objectContaining({
        error_code: "INVALID_MARKETING_ATTRIBUTION",
        oms_order_id: 42,
        outcome: "tracking_requires_review",
      }),
    );
    expect(JSON.stringify(fixture.logError.mock.calls)).not.toContain(
      "do-not-log-this",
    );
  });
  it("keeps untracked orders unattributed", async () => {
    await pushToMissionControl(42, "order.created");
    expect(sent[0].order.marketing_attribution).toEqual([]);
    expect(fixture.logError).not.toHaveBeenCalled();
  });
});

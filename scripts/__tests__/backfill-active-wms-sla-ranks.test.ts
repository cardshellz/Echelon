import { describe, expect, it } from "vitest";

async function loadBackfillModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../backfill-active-wms-sla-ranks");
}

describe("backfill-active-wms-sla-ranks", () => {
  it("defaults to dry-run and parses execution flags", async () => {
    const { parseFlags } = await loadBackfillModule();

    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: null,
      orderNumber: null,
      wmsOrderId: null,
      pushShipStation: false,
    });

    expect(parseFlags(["--execute", "--limit=25", "--order-number=#58173", "--push-shipstation"]))
      .toMatchObject({
        mode: "execute",
        limit: 25,
        orderNumber: "#58173",
        pushShipStation: true,
      });
  });

  it("rejects conflicting and invalid flags", async () => {
    const { parseFlags } = await loadBackfillModule();

    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--wms-order-id=abc"])).toThrow(/positive integer/);
  });

  it("extracts missing eBay ship-by dates from raw OMS payloads", async () => {
    const { resolveBackfillChannelShipByDate } = await loadBackfillModule();

    const shipBy = resolveBackfillChannelShipByDate({
      channel_provider: "ebay",
      channel_ship_by_date: null,
      oms_channel_ship_by_date: null,
      oms_raw_payload: {
        lineItems: [
          {
            lineItemFulfillmentInstructions: {
              shipByDate: "2026-06-02T06:59:59.000Z",
            },
          },
        ],
      },
    });

    expect(shipBy?.toISOString()).toBe("2026-06-02T06:59:59.000Z");
  });

  it("uses OMS channel ship-by as the source of truth before the WMS mirror", async () => {
    const { resolveBackfillChannelShipByDate } = await loadBackfillModule();

    const shipBy = resolveBackfillChannelShipByDate({
      channel_provider: "ebay",
      channel_ship_by_date: "2026-06-05T06:59:59.000Z",
      oms_channel_ship_by_date: "2026-06-03T06:59:59.000Z",
      oms_raw_payload: null,
    });

    expect(shipBy?.toISOString()).toBe("2026-06-03T06:59:59.000Z");
  });
});

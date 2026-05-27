import { describe, expect, it } from "vitest";

async function loadParseFlags() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  const mod = await import("../backfill-active-wms-sla-ranks");
  return mod.parseFlags;
}

describe("backfill-active-wms-sla-ranks flags", () => {
  it("defaults to dry-run", async () => {
    const parseFlags = await loadParseFlags();
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: null,
      orderNumber: null,
      wmsOrderId: null,
      pushShipStation: false,
    });
  });

  it("parses targeted execute mode", async () => {
    const parseFlags = await loadParseFlags();
    expect(parseFlags(["--execute", "--order-number=#57954", "--limit=25", "--push-shipstation"])).toMatchObject({
      mode: "execute",
      orderNumber: "#57954",
      limit: 25,
      pushShipStation: true,
    });
  });

  it("rejects conflicting modes", async () => {
    const parseFlags = await loadParseFlags();
    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
  });
});

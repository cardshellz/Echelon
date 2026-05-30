import { describe, expect, it } from "vitest";

async function loadParseFlags() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  const mod = await import("../sync-active-wms-sort-ranks-to-shipstation");
  return mod.parseFlags;
}

describe("sync-active-wms-sort-ranks-to-shipstation flags", () => {
  it("defaults to dry-run with a conservative ShipStation delay", async () => {
    const parseFlags = await loadParseFlags();
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: null,
      orderNumber: null,
      wmsOrderId: null,
      delayMs: 250,
    });
  });

  it("parses targeted execute mode", async () => {
    const parseFlags = await loadParseFlags();
    expect(parseFlags([
      "--execute",
      "--order-number=#58258",
      "--limit=25",
      "--delay-ms=100",
    ])).toMatchObject({
      mode: "execute",
      orderNumber: "#58258",
      limit: 25,
      delayMs: 100,
    });
  });

  it("rejects conflicting modes", async () => {
    const parseFlags = await loadParseFlags();
    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
  });
});

import { describe, expect, it } from "vitest";

async function loadModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return import("../recover-shipstation-combined-shipments");
}

describe("recover-shipstation-combined-shipments", () => {
  it("defaults to a bounded dry run", async () => {
    const { parseFlags } = await loadModule();

    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 25,
      orderNumber: null,
      minAgeHours: 6,
      maxAgeDays: null,
      requestTimeoutMs: 20_000,
      minimumRequestIntervalMs: 500,
      maxRetries: 2,
      retryBaseDelayMs: 2_000,
    });
  });

  it("accepts an exact-order execute run with retries disabled", async () => {
    const { parseFlags } = await loadModule();

    expect(parseFlags([
      "--execute",
      "--order-number=#59564",
      "--limit=all",
      "--max-age-days=all",
      "--delay-ms=0",
      "--max-retries=0",
      "--retry-base-delay-ms=0",
    ])).toMatchObject({
      mode: "execute",
      orderNumber: "#59564",
      limit: null,
      maxAgeDays: null,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      retryBaseDelayMs: 0,
    });
  });

  it("rejects conflicting or malformed flags", async () => {
    const { parseFlags } = await loadModule();

    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--delay-ms=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--max-retries=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--unknown"])).toThrow(/Unknown flag/);
  });
});

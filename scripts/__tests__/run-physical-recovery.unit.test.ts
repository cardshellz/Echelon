import { describe, expect, it } from "vitest";

async function loadModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../run-physical-recovery");
}

describe("run-physical-recovery", () => {
  it("defaults to dry-run with no age cap", async () => {
    const { parseCli } = await loadModule();
    expect(parseCli([])).toEqual({
      orderNumber: null,
      execute: false,
      limit: 50,
      maxAgeDays: null,
      minAgeMinutes: 15,
    });
    expect(parseCli(["--order=#59896", "--execute", "--limit=200"])).toMatchObject({
      orderNumber: "#59896",
      execute: true,
      limit: 200,
    });
  });

  it("tries both #-prefixed and bare order numbers (WMS stores the #)", async () => {
    const { orderNumberCandidates } = await loadModule();
    expect(orderNumberCandidates("59896")).toEqual(["#59896", "59896"]);
    expect(orderNumberCandidates("#59896")).toEqual(["#59896", "59896"]);
  });
});

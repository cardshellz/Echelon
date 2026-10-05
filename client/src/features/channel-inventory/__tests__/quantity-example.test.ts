import { describe, expect, it } from "vitest";

import { channelDefaultValueToForm, policyValueToForm, type PolicyForm } from "../model";
import { buildPolicyQuantityExample } from "../quantity-example";
import { policyValue } from "./fixtures";

const example = (stock: string, overrides: Partial<PolicyForm> = {}) =>
  buildPolicyQuantityExample({ ...channelDefaultValueToForm(null), ...overrides }, stock);

describe("hypothetical inventory settings example", () => {
  it("keeps buffer subtraction and the low-stock cutoff distinct, with an inclusive threshold", () => {
    const settings: Partial<PolicyForm> = { sharePercent: "50", holdbackUnits: "5", minUnits: "3" };
    expect(example("14", settings)).toMatchObject({ ok: true, publishedUnits: "0", steps: [
      { units: "7" }, { units: "2" }, { units: "0" },
    ] });
    expect(example("16", settings)).toMatchObject({ ok: true, publishedUnits: "3", steps: [
      { units: "8" }, { units: "3" }, { units: "3" },
    ] });
  });

  it("applies the cap before checking the cutoff, and clamps a large buffer at zero", () => {
    expect(example("100", { maxMode: "units", maxUnits: "2", minUnits: "3" })).toMatchObject({
      ok: true, publishedUnits: "0", steps: [{ units: "100" }, { units: "2" }, { units: "0" }],
    });
    expect(example("5", { holdbackUnits: "10" })).toMatchObject({ ok: true, publishedUnits: "0" });
  });

  it("preserves exact large counts and floors fractional shares without number coercion", () => {
    expect(example("9007199254740993", { sharePercent: "50" })).toMatchObject({ ok: true, publishedUnits: "4503599627370496" });
    expect(example("51", { sharePercent: "12.5" })).toMatchObject({ ok: true, publishedUnits: "6" });
    expect(example("0")).toMatchObject({ ok: true, publishedUnits: "0" });
  });

  it("distinguishes zero cap from unlimited and respects explicit unavailable and zero percentage", () => {
    expect(example("100", { maxMode: "units", maxUnits: "0" })).toMatchObject({ ok: true, publishedUnits: "0" });
    expect(example("100", { maxMode: "unlimited" })).toMatchObject({ ok: true, publishedUnits: "100" });
    expect(example("100", { eligible: "no" })).toMatchObject({
      ok: true, publishedUnits: "0", steps: [{ label: "Marked as out of stock", units: "0" }],
    });
    expect(example("100", { sharePercent: "0" })).toMatchObject({ ok: true, publishedUnits: "0" });
  });

  it.each(["", "-1", "1.5", "01", "Infinity", "abc"])("rejects invalid example stock %j without a fabricated result", stock => {
    expect(example(stock)).toMatchObject({ ok: false, stockError: expect.any(String) });
    expect(example(stock)).not.toHaveProperty("publishedUnits");
  });

  it("does not invent missing settings, accept invalid settings, or mutate the form", () => {
    const partial = policyValueToForm(policyValue({ shareBps: 5_000 }));
    const before = { ...partial };
    expect(buildPolicyQuantityExample(partial, "100").ok).toBe(false);
    expect(partial).toEqual(before);
    expect(example("100", { sharePercent: "101" }).ok).toBe(false);
    expect(example("100", { holdbackUnits: "1.5" }).ok).toBe(false);
    expect(example("100", { maxMode: "units", maxUnits: "" }).ok).toBe(false);
  });

  it("does not pretend to resolve cross-channel limits from a one-channel example", () => {
    expect(example("100", { semantics: "partitioned", sharePercent: "50" }))
      .toEqual(example("100", { semantics: "exposure", sharePercent: "50" }));
  });
});

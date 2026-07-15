import { describe, expect, it } from "vitest";
import { parseAutomaticPurchasingPilotArgs } from "../../../../scripts/run-automatic-purchasing-pilot";

describe("automatic purchasing pilot CLI", () => {
  it("defaults to read-only preflight", () => {
    expect(parseAutomaticPurchasingPilotArgs(["--sku=SKU-1"])).toEqual({
      sku: "SKU-1",
      execute: false,
      actor: null,
    });
  });

  it("requires an attributable operator for execution", () => {
    expect(() => parseAutomaticPurchasingPilotArgs(["--sku=SKU-1", "--execute"]))
      .toThrow("--actor is required with --execute");
    expect(parseAutomaticPurchasingPilotArgs([
      "--sku=SKU-1",
      "--execute",
      "--actor=buyer-user-id",
    ])).toEqual({
      sku: "SKU-1",
      execute: true,
      actor: "buyer-user-id",
    });
  });

  it("rejects missing SKUs and unknown arguments", () => {
    expect(() => parseAutomaticPurchasingPilotArgs([])).toThrow("--sku is required");
    expect(() => parseAutomaticPurchasingPilotArgs(["--sku=SKU-1", "--all"]))
      .toThrow("Unknown argument: --all");
    expect(() => parseAutomaticPurchasingPilotArgs([`--sku=${"S".repeat(101)}`]))
      .toThrow("--sku must be 100 characters or fewer");
    expect(() => parseAutomaticPurchasingPilotArgs([
      "--sku=SKU-1",
      "--execute",
      `--actor=${"U".repeat(101)}`,
    ])).toThrow("--actor must be 100 characters or fewer");
  });
});

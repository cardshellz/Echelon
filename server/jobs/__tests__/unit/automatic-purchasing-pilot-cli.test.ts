import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dotenvConfig: vi.fn() }));

vi.mock("dotenv", () => ({ config: mocks.dotenvConfig }));

import {
  loadLocalEnvironmentIfNeeded,
  parseAutomaticPurchasingPilotArgs,
} from "../../../../scripts/run-automatic-purchasing-pilot";

describe("automatic purchasing pilot CLI", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalExternalDatabaseUrl = process.env.EXTERNAL_DATABASE_URL;

  beforeEach(() => {
    mocks.dotenvConfig.mockReset();
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalExternalDatabaseUrl === undefined) delete process.env.EXTERNAL_DATABASE_URL;
    else process.env.EXTERNAL_DATABASE_URL = originalExternalDatabaseUrl;
  });

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

  it("does not load the optional local dotenv package when the runtime provides a database URL", async () => {
    process.env.DATABASE_URL = "postgresql://runtime-provided";
    delete process.env.EXTERNAL_DATABASE_URL;

    await loadLocalEnvironmentIfNeeded();

    expect(mocks.dotenvConfig).not.toHaveBeenCalled();
  });

  it("loads local dotenv configuration only when no runtime database URL exists", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.EXTERNAL_DATABASE_URL;

    await loadLocalEnvironmentIfNeeded();

    expect(mocks.dotenvConfig).toHaveBeenCalledWith({ quiet: true });
  });
});

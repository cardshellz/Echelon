/**
 * loadPackaging must never fall back to legacy packaging assignments silently,
 * and must refuse the fallback entirely once SHIPPING_PACKAGING_POLICY_REQUIRED
 * is on. The canonical resolver and the legacy query run against a stubbed pool
 * so the branch logic is exercised without a database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { logger } from "../../../../platform/observability/logger";
import { SharedShippingConfigurationRepository } from "../../infrastructure/shared-configuration.repository";
import {
  SHIPPING_PACKAGING_POLICY_REQUIRED_ENV,
  isPackagingPolicyRequired,
} from "../../application/packaging-policy-requirement";

const LEGACY_ROW = {
  channel: "dropship",
  warehouseId: 1,
  suiteId: 5,
  revision: 2,
  suiteRevision: 3,
  boxes: [{ id: 9, code: "BOX-10x8x4", kind: "box", lengthMm: 254, widthMm: 203.2, heightMm: 101.6,
    outerLengthMm: null, outerWidthMm: null, outerHeightMm: null, tareWeightGrams: 100, maxWeightGrams: 20000,
    costCents: 50, fillFactorBps: 8500, isActive: true }],
};

function createFakePool(options: { policyRows?: unknown[]; legacyRows?: unknown[] } = {}) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.includes("FROM shipping.channel_packaging_policies")) return { rows: options.policyRows ?? [] };
    return { rows: [] };
  });
  const client = { query: clientQuery, release: vi.fn() };
  const poolQuery = vi.fn(async (sql: string) => {
    if (sql.includes("FROM shipping.packaging_assignments a")) return { rows: options.legacyRows ?? [LEGACY_ROW] };
    throw new Error(`Unexpected pool statement: ${sql.slice(0, 60)}`);
  });
  const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as Pool;
  return { pool, poolQuery, clientQuery };
}

describe("isPackagingPolicyRequired", () => {
  it("is off unless the variable is exactly true", () => {
    expect(isPackagingPolicyRequired({})).toBe(false);
    expect(isPackagingPolicyRequired({ [SHIPPING_PACKAGING_POLICY_REQUIRED_ENV]: "1" })).toBe(false);
    expect(isPackagingPolicyRequired({ [SHIPPING_PACKAGING_POLICY_REQUIRED_ENV]: " TRUE " })).toBe(true);
  });
});

describe("SharedShippingConfigurationRepository.loadPackaging legacy fallback", () => {
  const originalEnv = process.env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV];
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    debugSpy.mockRestore();
    if (originalEnv === undefined) delete process.env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV];
    else process.env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV] = originalEnv;
  });

  it("logs a warning with channel and warehouse when a channel has no saved policy", async () => {
    const { pool, poolQuery } = createFakePool();
    const repository = new SharedShippingConfigurationRepository(pool);

    const packaging = await repository.loadPackaging("dropship", 1, 11);

    expect(packaging).toMatchObject({ suiteId: 5, suiteRevision: 3, assignmentRevision: 2 });
    expect(packaging.boxes.map((box) => box.id)).toEqual([9]);
    expect("requirement" in packaging).toBe(false);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("packaging_resolution", expect.objectContaining({
      outcome: "legacy_fallback",
      reason: "no_channel_packaging_policy",
      source: "legacy_packaging_assignments",
      channel_id: 11,
      warehouse_id: 1,
    }));
  });

  it("fails closed without touching the legacy table when the policy requirement is on", async () => {
    process.env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV] = "true";
    const { pool, poolQuery } = createFakePool();
    const repository = new SharedShippingConfigurationRepository(pool);

    await expect(repository.loadPackaging("dropship", 1, 11)).rejects.toMatchObject({
      code: "SHIPPING_PACKAGING_POLICY_REQUIRED",
    });
    expect(poolQuery).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("records the null-channel path as detail and still resolves legacy packaging", async () => {
    process.env[SHIPPING_PACKAGING_POLICY_REQUIRED_ENV] = "true";
    const { pool, clientQuery } = createFakePool({ legacyRows: [{ ...LEGACY_ROW, channel: "internal" }] });
    const repository = new SharedShippingConfigurationRepository(pool);

    const packaging = await repository.loadPackaging("internal", 1, null);

    expect(packaging.suiteId).toBe(5);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith("packaging_resolution", expect.objectContaining({
      outcome: "legacy_fallback",
      reason: "channel_id_unavailable",
      channel_id: null,
      warehouse_id: 1,
    }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still fails closed when the legacy suite has no available boxes", async () => {
    const { pool } = createFakePool({ legacyRows: [{ ...LEGACY_ROW, boxes: [] }] });
    const repository = new SharedShippingConfigurationRepository(pool);

    await expect(repository.loadPackaging("dropship", 1, 11)).rejects.toMatchObject({
      code: "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
    });
  });
});

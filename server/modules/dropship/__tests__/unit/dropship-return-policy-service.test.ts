import { describe, expect, it } from "vitest";
import {
  compareReturnPolicyPrecedence,
  isReturnPolicyEffectiveAt,
  returnPolicyScopeFor,
  returnPolicyScopeMatches,
  selectReturnPolicyCandidate,
  type ReturnPolicyScopeCandidate,
} from "../../domain/return-policy";
import {
  DropshipReturnPolicyService,
  type DropshipReturnPolicyRepository,
  type DropshipReturnPolicyVersionRecord,
  type DropshipResolvedReturnFees,
  type DropshipReturnFeeScheduleRecord,
} from "../../application/dropship-return-policy-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";

const now = new Date("2026-08-05T19:00:00.000Z");

function candidate(
  overrides: Partial<ReturnPolicyScopeCandidate> = {},
): ReturnPolicyScopeCandidate {
  return {
    id: 1,
    vendorId: null,
    storeConnectionId: null,
    priority: 0,
    isActive: true,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    ...overrides,
  };
}

describe("return-policy domain precedence", () => {
  it("classifies scope from vendor/store columns", () => {
    expect(
      returnPolicyScopeFor({ vendorId: null, storeConnectionId: null }),
    ).toBe("global");
    expect(returnPolicyScopeFor({ vendorId: null, storeConnectionId: 7 })).toBe(
      "store",
    );
    expect(returnPolicyScopeFor({ vendorId: 3, storeConnectionId: null })).toBe(
      "vendor",
    );
    expect(returnPolicyScopeFor({ vendorId: 3, storeConnectionId: 7 })).toBe(
      "vendor_store",
    );
  });

  it("matches candidates against the requested scope", () => {
    const scope = { vendorId: 3, storeConnectionId: 7 };
    expect(returnPolicyScopeMatches(candidate({}), scope)).toBe(true);
    expect(
      returnPolicyScopeMatches(candidate({ storeConnectionId: 7 }), scope),
    ).toBe(true);
    expect(
      returnPolicyScopeMatches(candidate({ storeConnectionId: 8 }), scope),
    ).toBe(false);
    expect(returnPolicyScopeMatches(candidate({ vendorId: 3 }), scope)).toBe(
      true,
    );
    expect(returnPolicyScopeMatches(candidate({ vendorId: 4 }), scope)).toBe(
      false,
    );
    expect(
      returnPolicyScopeMatches(
        candidate({ vendorId: 3, storeConnectionId: 7 }),
        scope,
      ),
    ).toBe(true);
    expect(
      returnPolicyScopeMatches(
        candidate({ vendorId: 3, storeConnectionId: 8 }),
        scope,
      ),
    ).toBe(false);
  });

  it("store-scoped candidates do not match vendor-only lookups and vice versa", () => {
    expect(
      returnPolicyScopeMatches(candidate({ storeConnectionId: 7 }), {
        vendorId: 3,
        storeConnectionId: null,
      }),
    ).toBe(false);
    expect(
      returnPolicyScopeMatches(candidate({ vendorId: 3 }), {
        vendorId: null,
        storeConnectionId: 7,
      }),
    ).toBe(false);
    expect(
      returnPolicyScopeMatches(
        candidate({ vendorId: 3, storeConnectionId: 7 }),
        { vendorId: 3, storeConnectionId: null },
      ),
    ).toBe(false);
  });

  it("vendor+store beats vendor beats store beats global", () => {
    const global = candidate({ id: 1 });
    const store = candidate({ id: 2, storeConnectionId: 7 });
    const vendor = candidate({ id: 3, vendorId: 3 });
    const vendorStore = candidate({ id: 4, vendorId: 3, storeConnectionId: 7 });
    const scope = { vendorId: 3, storeConnectionId: 7 };

    expect(
      selectReturnPolicyCandidate(
        [global, store, vendor, vendorStore],
        scope,
        now,
      )?.id,
    ).toBe(4);
    expect(
      selectReturnPolicyCandidate([global, store, vendor], scope, now)?.id,
    ).toBe(3);
    expect(selectReturnPolicyCandidate([global, store], scope, now)?.id).toBe(
      2,
    );
    expect(selectReturnPolicyCandidate([global], scope, now)?.id).toBe(1);
  });

  it("breaks ties within a scope by priority DESC then id DESC", () => {
    const low = candidate({ id: 1, vendorId: 3, priority: 0 });
    const high = candidate({ id: 2, vendorId: 3, priority: 10 });
    const samePriorityNewer = candidate({ id: 5, vendorId: 3, priority: 10 });
    const scope = { vendorId: 3, storeConnectionId: null };

    expect(selectReturnPolicyCandidate([low, high], scope, now)?.id).toBe(2);
    expect(
      selectReturnPolicyCandidate([high, samePriorityNewer], scope, now)?.id,
    ).toBe(5);
    expect(
      compareReturnPolicyPrecedence(high, samePriorityNewer),
    ).toBeGreaterThan(0);
    expect(compareReturnPolicyPrecedence(samePriorityNewer, high)).toBeLessThan(
      0,
    );
  });

  it("excludes inactive rows and rows outside their effective window", () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    expect(isReturnPolicyEffectiveAt(candidate({ isActive: false }), at)).toBe(
      false,
    );
    expect(
      isReturnPolicyEffectiveAt(
        candidate({ effectiveFrom: new Date("2026-07-01T00:00:00.000Z") }),
        at,
      ),
    ).toBe(false);
    expect(
      isReturnPolicyEffectiveAt(
        candidate({ effectiveTo: new Date("2026-05-01T00:00:00.000Z") }),
        at,
      ),
    ).toBe(false);
    expect(
      isReturnPolicyEffectiveAt(
        candidate({ effectiveTo: new Date("2026-06-01T00:00:00.000Z") }),
        at,
      ),
    ).toBe(false);
    expect(
      isReturnPolicyEffectiveAt(
        candidate({ effectiveTo: new Date("2026-07-01T00:00:00.000Z") }),
        at,
      ),
    ).toBe(true);

    const scope = { vendorId: null, storeConnectionId: null };
    const expired = candidate({
      id: 1,
      effectiveTo: new Date("2026-05-01T00:00:00.000Z"),
    });
    const future = candidate({
      id: 2,
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    });
    const current = candidate({ id: 3 });
    expect(
      selectReturnPolicyCandidate([expired, future, current], scope, at)?.id,
    ).toBe(3);
    expect(
      selectReturnPolicyCandidate([expired, future], scope, at),
    ).toBeNull();
  });

  it("falls back to global when no scoped row matches", () => {
    const global = candidate({ id: 9 });
    const otherVendor = candidate({ id: 2, vendorId: 99 });
    const selected = selectReturnPolicyCandidate(
      [global, otherVendor],
      { vendorId: 3, storeConnectionId: null },
      now,
    );
    expect(selected?.id).toBe(9);
  });
});

describe("DropshipReturnPolicyService", () => {
  it("delegates policy resolution with parsed scope and clock time", async () => {
    const repository = new FakeReturnPolicyRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    await service.resolveReturnPolicy({ vendorId: 3, storeConnectionId: 7 });

    expect(repository.lastResolvePolicyInput).toEqual({
      vendorId: 3,
      storeConnectionId: 7,
      at: now,
    });
  });

  it("delegates fee resolution with the fault category", async () => {
    const repository = new FakeReturnPolicyRepository();
    const service = makeService(repository, []);

    await service.resolveReturnFees({
      vendorId: 3,
      storeConnectionId: 7,
      faultCategory: "vendor",
    });

    expect(repository.lastResolveFeesInput).toEqual({
      vendorId: 3,
      storeConnectionId: 7,
      faultCategory: "vendor",
      at: now,
    });
  });

  it("delegates default fee resolution with parsed scope and clock time", async () => {
    const repository = new FakeReturnPolicyRepository();
    const service = makeService(repository, []);

    await service.resolveDefaultReturnFees({
      vendorId: 3,
      storeConnectionId: 7,
    });

    expect(repository.lastResolveDefaultFeesInput).toEqual({
      vendorId: 3,
      storeConnectionId: 7,
      at: now,
    });
  });

  it("rejects store-scoped policies without a vendor", async () => {
    const repository = new FakeReturnPolicyRepository();
    const service = makeService(repository, []);

    await expect(
      service.createPolicyVersion({
        returnWindowDays: 30,
        storeConnectionId: 7,
        idempotencyKey: "policy-no-vendor",
        actor: { actorType: "admin" },
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_POLICY_INVALID_INPUT" });
    expect(repository.lastCreatePolicyInput).toBeNull();
  });

  it("rejects non-integer flat-cent fee amounts and out-of-range percents", async () => {
    const repository = new FakeReturnPolicyRepository();
    const service = makeService(repository, []);

    await expect(
      service.createFeeVersion({
        feeType: "restocking_fee",
        faultCategory: "vendor",
        amountType: "flat_cents",
        amount: 10.5,
        idempotencyKey: "fee-fractional",
        actor: { actorType: "admin" },
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_FEE_INVALID_INPUT" });

    await expect(
      service.createFeeVersion({
        feeType: "restocking_fee",
        faultCategory: "vendor",
        amountType: "percent",
        amount: 120,
        idempotencyKey: "fee-over-100",
        actor: { actorType: "admin" },
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_FEE_INVALID_INPUT" });
    expect(repository.lastCreateFeeInput).toBeNull();
  });

  it("rejects future-dated defaults without displacing the current default", async () => {
    const repository = new FakeReturnPolicyRepository();
    const service = makeService(repository, []);

    await expect(
      service.createFeeVersion({
        feeType: "restocking_fee",
        faultCategory: "vendor",
        amountType: "flat_cents",
        amount: 500,
        isDefault: true,
        effectiveFrom: new Date("2026-08-06T19:00:00.000Z"),
        idempotencyKey: "future-default-fee",
        actor: { actorType: "admin" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_FEE_FUTURE_DEFAULT_UNSUPPORTED",
    });
    expect(repository.lastCreateFeeInput).toBeNull();
  });

  it("creates policy versions with actor and clock context and logs the event", async () => {
    const repository = new FakeReturnPolicyRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.createPolicyVersion({
      returnWindowDays: 45,
      vendorId: 3,
      priority: 5,
      idempotencyKey: "policy-version-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.policy.returnWindowDays).toBe(45);
    expect(repository.lastCreatePolicyInput).toMatchObject({
      returnWindowDays: 45,
      vendorId: 3,
      storeConnectionId: null,
      priority: 5,
      effectiveFrom: now,
      idempotencyKey: "policy-version-1",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_RETURN_POLICY_VERSION_CREATED",
    });
  });

  it("does not log a creation event for idempotent replays", async () => {
    const repository = new FakeReturnPolicyRepository();
    repository.nextPolicyReplay = true;
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    await service.createPolicyVersion({
      returnWindowDays: 45,
      idempotencyKey: "policy-replay",
      actor: { actorType: "admin" },
    });

    expect(logs).toHaveLength(0);
  });

  it("creates fee versions and logs the fee event", async () => {
    const repository = new FakeReturnPolicyRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.createFeeVersion({
      feeType: "restocking_fee",
      faultCategory: "customer",
      amountType: "flat_cents",
      amount: 500,
      isDefault: true,
      idempotencyKey: "fee-version-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.fee.amount).toBe(500);
    expect(repository.lastCreateFeeInput).toMatchObject({
      feeType: "restocking_fee",
      faultCategory: "customer",
      amountType: "flat_cents",
      amount: 500,
      isDefault: true,
      idempotencyKey: "fee-version-1",
      now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_RETURN_FEE_VERSION_CREATED",
    });
  });

  it("deactivates policies and fees idempotently", async () => {
    const repository = new FakeReturnPolicyRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    await service.deactivatePolicy({
      policyId: 11,
      idempotencyKey: "deactivate-policy",
      actor: { actorType: "admin" },
    });
    await service.deactivateFee({
      feeId: 21,
      idempotencyKey: "deactivate-fee",
      actor: { actorType: "admin" },
    });

    expect(repository.lastDeactivatePolicyInput).toMatchObject({
      policyId: 11,
      idempotencyKey: "deactivate-policy",
    });
    expect(repository.lastDeactivateFeeInput).toMatchObject({
      feeId: 21,
      idempotencyKey: "deactivate-fee",
    });
    expect(logs.map((event) => event.code)).toEqual([
      "DROPSHIP_RETURN_POLICY_DEACTIVATED",
      "DROPSHIP_RETURN_FEE_DEACTIVATED",
    ]);
  });
});

class FakeReturnPolicyRepository implements DropshipReturnPolicyRepository {
  lastResolvePolicyInput: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  } | null = null;
  lastResolveDefaultFeesInput: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  } | null = null;
  lastResolveFeesInput: {
    vendorId: number | null;
    storeConnectionId: number | null;
    faultCategory: string;
    at: Date;
  } | null = null;
  lastCreatePolicyInput: Record<string, unknown> | null = null;
  lastCreateFeeInput: Record<string, unknown> | null = null;
  lastDeactivatePolicyInput: {
    policyId: number;
    idempotencyKey: string;
  } | null = null;
  lastDeactivateFeeInput: { feeId: number; idempotencyKey: string } | null =
    null;
  nextPolicyReplay = false;

  async resolveReturnPolicy(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  }) {
    this.lastResolvePolicyInput = input;
    return makePolicyRecord();
  }

  async resolveReturnFees(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    faultCategory: DropshipReturnFeeScheduleRecord["faultCategory"];
    at: Date;
  }): Promise<DropshipResolvedReturnFees> {
    this.lastResolveFeesInput = input;
    return {
      restockingFee: null,
      processingFee: null,
      returnShippingFee: null,
    };
  }

  async resolveDefaultReturnFees(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  }): Promise<DropshipResolvedReturnFees> {
    this.lastResolveDefaultFeesInput = input;
    return {
      restockingFee: null,
      processingFee: null,
      returnShippingFee: null,
    };
  }

  async listPolicies() {
    return [makePolicyRecord()];
  }

  async listFees() {
    return [makeFeeRecord()];
  }

  async createPolicyVersion(
    input: Record<string, unknown> & { returnWindowDays: number },
  ) {
    this.lastCreatePolicyInput = input;
    return {
      policy: makePolicyRecord({ returnWindowDays: input.returnWindowDays }),
      idempotentReplay: this.nextPolicyReplay,
    };
  }

  async createFeeVersion(input: Record<string, unknown> & { amount: number }) {
    this.lastCreateFeeInput = input;
    return {
      fee: makeFeeRecord({ amount: input.amount }),
      idempotentReplay: false,
    };
  }

  async deactivatePolicy(input: { policyId: number; idempotencyKey: string }) {
    this.lastDeactivatePolicyInput = input;
    return {
      policy: makePolicyRecord({ isActive: false }),
      idempotentReplay: false,
    };
  }

  async deactivateFee(input: { feeId: number; idempotencyKey: string }) {
    this.lastDeactivateFeeInput = input;
    return { fee: makeFeeRecord({ isActive: false }), idempotentReplay: false };
  }
}

function makeService(
  repository: DropshipReturnPolicyRepository,
  logs: DropshipLogEvent[],
): DropshipReturnPolicyService {
  return new DropshipReturnPolicyService({
    repository,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
  });
}

function makePolicyRecord(
  overrides: Partial<DropshipReturnPolicyVersionRecord> = {},
): DropshipReturnPolicyVersionRecord {
  return {
    policyId: 1,
    version: 1,
    returnWindowDays: 30,
    vendorId: null,
    storeConnectionId: null,
    priority: 0,
    isActive: true,
    effectiveFrom: now,
    effectiveTo: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeFeeRecord(
  overrides: Partial<DropshipReturnFeeScheduleRecord> = {},
): DropshipReturnFeeScheduleRecord {
  return {
    feeId: 1,
    version: 1,
    feeType: "restocking_fee",
    faultCategory: "vendor",
    amountType: "flat_cents",
    amount: 0,
    vendorId: null,
    storeConnectionId: null,
    priority: 0,
    isActive: true,
    isDefault: false,
    effectiveFrom: now,
    effectiveTo: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

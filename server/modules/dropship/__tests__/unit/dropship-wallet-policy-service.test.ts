import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipWalletPolicyLimits } from "../../domain/wallet-policy";
import {
  DropshipWalletPolicyService,
  hashWalletPolicyRequest,
  type CreateDropshipWalletPolicyVersionRepositoryInput,
  type DropshipWalletPolicyMutationResult,
  type DropshipWalletPolicyRecord,
  type DropshipWalletPolicyRepository,
  type DropshipWalletPolicyVendorImpactCounts,
} from "../../application/dropship-wallet-policy-service";

const now = new Date("2026-09-19T10:00:00.000Z");

/** Env with no dropship overrides, so the fallback layer is the documented defaults. */
const emptyEnv: NodeJS.ProcessEnv = {};

const publishedLimits: DropshipWalletPolicyLimits = {
  autoReloadMinTriggerCents: 9_000,
  autoReloadMinAmountCents: 20_000,
  manualFundingMinCents: 2_500,
  manualFundingMaxCents: 60_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 45,
};

const validInput = {
  autoReloadMinTriggerCents: 9_000,
  autoReloadMinAmountCents: 20_000,
  manualFundingMinCents: 2_500,
  manualFundingMaxCents: 60_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 45,
  changeNote: "Raising the floors for the autumn cohort.",
  idempotencyKey: "wallet-policy-001",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
};

describe("DropshipWalletPolicyService", () => {
  let repository: FakeWalletPolicyRepository;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipWalletPolicyService;

  beforeEach(() => {
    repository = new FakeWalletPolicyRepository();
    logs = [];
    service = new DropshipWalletPolicyService({
      repository,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      env: emptyEnv,
      cardFundingFeeBps: 300,
    });
  });

  describe("resolveWalletLimits", () => {
    it("serves the active policy row when one is published", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      await expect(service.resolveWalletLimits()).resolves.toEqual(publishedLimits);
    });

    it("falls back to the environment limits when no row exists", async () => {
      repository.activePolicy = null;
      await expect(service.resolveWalletLimits()).resolves.toEqual({
        autoReloadMinTriggerCents: 5_000,
        autoReloadMinAmountCents: 10_000,
        manualFundingMinCents: 1_000,
        manualFundingMaxCents: 500_000,
        defaultPaymentHoldTimeoutMinutes: 2_880,
        holdExpiryWarningMinutes: 120,
      });
    });

    it("falls back to the environment when the table does not exist yet, and says so at WARN", async () => {
      repository.getActiveError = new DropshipError(
        "DROPSHIP_WALLET_POLICY_TABLE_MISSING",
        "Dropship wallet policy table does not exist yet.",
        { classification: "transient" },
      );

      await expect(service.resolveWalletLimits()).resolves.toMatchObject({
        autoReloadMinTriggerCents: 5_000,
      });
      expect(logs).toEqual([
        expect.objectContaining({ level: "warn", code: "DROPSHIP_WALLET_POLICY_ENV_FALLBACK" }),
      ]);
    });

    it("propagates every other read failure instead of quietly serving stale floors", async () => {
      repository.getActiveError = new DropshipError(
        "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
        "Stored wallet policy money is not a positive integer number of cents.",
        { classification: "fatal" },
      );

      await expect(service.resolveWalletLimits()).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
      });
    });
  });

  describe("getOverview", () => {
    it("serves the policy, the env values it overrides, the read-only fee and the impact", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      repository.counts = {
        vendorsBelowMinimumFloor: 4,
        vendorsBelowMinimumSingleTopUpLimit: 7,
        activeVendorsWithAutoReloadSettings: 31,
      };

      const overview = await service.getOverview();

      expect(overview.limitsSource).toBe("policy");
      expect(overview.limits).toEqual(publishedLimits);
      expect(overview.policy?.version).toBe(3);
      expect(overview.envLimits).toEqual({
        autoReloadMinTriggerCents: 5_000,
        autoReloadMinAmountCents: 10_000,
        manualFundingMinCents: 1_000,
        manualFundingMaxCents: 500_000,
        defaultPaymentHoldTimeoutMinutes: 2_880,
        holdExpiryWarningMinutes: 120,
      });
      expect(overview.envKeys.autoReloadMinTriggerCents).toBe("DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS");
      expect(overview.cardFundingFee).toMatchObject({
        bps: 300,
        envKey: "DROPSHIP_CARD_FUNDING_FEE_BPS",
        editable: false,
      });
      expect(overview.cardFundingFee.readOnlyReason).toContain("never agreed to");
      expect(overview.impact).toMatchObject({
        proposedAutoReloadMinTriggerCents: 9_000,
        proposedAutoReloadMinAmountCents: 20_000,
        vendorsBelowMinimumFloor: 4,
        vendorsBelowMinimumSingleTopUpLimit: 7,
        activeVendorsWithAutoReloadSettings: 31,
        evaluatedAt: now,
      });
    });

    it("reports the environment as the source when nothing is published", async () => {
      repository.activePolicy = null;
      const overview = await service.getOverview();
      expect(overview.policy).toBeNull();
      expect(overview.limitsSource).toBe("environment");
      expect(overview.limits).toEqual(overview.envLimits);
      // Impact is measured against the limits actually in force.
      expect(repository.countInputs).toEqual([
        { autoReloadMinTriggerCents: 5_000, autoReloadMinAmountCents: 10_000 },
      ]);
    });

    it("measures a proposal before it is saved, leaving the limits in force untouched", async () => {
      repository.activePolicy = makePolicy(publishedLimits);

      const overview = await service.getOverview({ autoReloadMinTriggerCents: 25_000 });

      expect(repository.countInputs).toEqual([
        // The unspecified half falls back to the limit in force.
        { autoReloadMinTriggerCents: 25_000, autoReloadMinAmountCents: 20_000 },
      ]);
      expect(overview.impact.proposedAutoReloadMinTriggerCents).toBe(25_000);
      expect(overview.limits).toEqual(publishedLimits);
      // A read must not write: no version was published.
      expect(repository.created).toEqual([]);
    });

    it("refuses a proposal that is not positive integer cents", async () => {
      await expect(service.getOverview({ autoReloadMinTriggerCents: 0 }))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
      await expect(service.getOverview({ autoReloadMinAmountCents: 10.5 }))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
    });
  });

  describe("createPolicyVersion", () => {
    it("publishes a version and logs before -> after", async () => {
      repository.activePolicy = makePolicy({
        ...publishedLimits,
        autoReloadMinTriggerCents: 5_000,
        autoReloadMinAmountCents: 10_000,
      });

      const result = await service.createPolicyVersion(validInput);

      expect(result.idempotentReplay).toBe(false);
      expect(repository.created).toEqual([
        expect.objectContaining({
          limits: publishedLimits,
          changeNote: "Raising the floors for the autumn cohort.",
          idempotencyKey: "wallet-policy-001",
          actor: { actorType: "admin", actorId: "admin-1" },
          now,
        }),
      ]);
      expect(logs).toEqual([
        expect.objectContaining({
          level: "info",
          code: "DROPSHIP_WALLET_POLICY_VERSION_PUBLISHED",
          context: expect.objectContaining({
            before: expect.objectContaining({ autoReloadMinTriggerCents: 5_000 }),
            after: expect.objectContaining({ autoReloadMinTriggerCents: 9_000 }),
            actorId: "admin-1",
          }),
        }),
      ]);
    });

    it("hashes the proposal, not the key, so the same key with different values conflicts", async () => {
      const first = hashWalletPolicyRequest({ limits: publishedLimits, changeNote: null });
      const same = hashWalletPolicyRequest({ limits: { ...publishedLimits }, changeNote: null });
      const different = hashWalletPolicyRequest({
        limits: { ...publishedLimits, autoReloadMinTriggerCents: 9_001 },
        changeNote: null,
      });
      expect(first).toBe(same);
      expect(first).not.toBe(different);
    });

    it("reports a replay without a before -> after, because nothing changed", async () => {
      repository.replay = true;
      const result = await service.createPolicyVersion(validInput);

      expect(result.idempotentReplay).toBe(true);
      expect(result.previousPolicy).toBeNull();
      expect(logs).toEqual([
        expect.objectContaining({
          code: "DROPSHIP_WALLET_POLICY_VERSION_REPLAYED",
          context: expect.objectContaining({ before: null }),
        }),
      ]);
    });

    it("refuses a manual minimum above the manual maximum", async () => {
      await expect(service.createPolicyVersion({
        ...validInput,
        manualFundingMinCents: 70_000,
      })).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT",
        context: expect.objectContaining({
          classification: "permanent",
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "manualFundingMaxCents" }),
          ]),
        }),
      });
      expect(repository.created).toEqual([]);
    });

    it("refuses a top-up limit below the floor, and a warning window at or beyond the hold", async () => {
      await expect(service.createPolicyVersion({
        ...validInput,
        autoReloadMinAmountCents: 5_000,
      })).rejects.toMatchObject({
        context: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "autoReloadMinAmountCents" }),
          ]),
        }),
      });

      await expect(service.createPolicyVersion({
        ...validInput,
        holdExpiryWarningMinutes: 1_440,
      })).rejects.toMatchObject({
        context: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "holdExpiryWarningMinutes" }),
          ]),
        }),
      });
      expect(repository.created).toEqual([]);
    });

    it("refuses zero, negative, fractional and out-of-range values", async () => {
      for (const patch of [
        { autoReloadMinTriggerCents: 0 },
        { manualFundingMinCents: -1 },
        { manualFundingMaxCents: 1_000.5 },
        { defaultPaymentHoldTimeoutMinutes: 0 },
        { defaultPaymentHoldTimeoutMinutes: 43_201 },
        { holdExpiryWarningMinutes: 0 },
      ]) {
        await expect(service.createPolicyVersion({ ...validInput, ...patch }))
          .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
      }
      expect(repository.created).toEqual([]);
    });

    it("refuses an unknown field rather than silently dropping it", async () => {
      await expect(service.createPolicyVersion({ ...validInput, cardFundingFeeBps: 500 }))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
    });

    it("requires an idempotency key long enough to be meaningful", async () => {
      await expect(service.createPolicyVersion({ ...validInput, idempotencyKey: "short" }))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
    });

    it("accepts the boundary case where the limit equals the floor", async () => {
      const result = await service.createPolicyVersion({
        ...validInput,
        autoReloadMinTriggerCents: 20_000,
        autoReloadMinAmountCents: 20_000,
      });
      expect(result.policy.limits.autoReloadMinAmountCents).toBe(20_000);
    });
  });

  describe("getImpact", () => {
    it("defaults the proposal to the limits in force", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      const impact = await service.getImpact();
      expect(impact).toMatchObject({
        proposedAutoReloadMinTriggerCents: 9_000,
        proposedAutoReloadMinAmountCents: 20_000,
      });
    });

    it("reports zero when no vendor is below the proposal", async () => {
      repository.counts = {
        vendorsBelowMinimumFloor: 0,
        vendorsBelowMinimumSingleTopUpLimit: 0,
        activeVendorsWithAutoReloadSettings: 12,
      };
      const impact = await service.getImpact({ autoReloadMinTriggerCents: 1 });
      expect(impact.vendorsBelowMinimumFloor).toBe(0);
      expect(impact.activeVendorsWithAutoReloadSettings).toBe(12);
    });
  });
});

function makePolicy(
  limits: DropshipWalletPolicyLimits,
  overrides: Partial<DropshipWalletPolicyRecord> = {},
): DropshipWalletPolicyRecord {
  return {
    policyId: 3,
    version: 3,
    limits,
    isActive: true,
    changeNote: null,
    createdAt: now,
    createdBy: { actorType: "admin", actorId: "admin-1" },
    deactivatedAt: null,
    ...overrides,
  };
}

class FakeWalletPolicyRepository implements DropshipWalletPolicyRepository {
  activePolicy: DropshipWalletPolicyRecord | null = null;
  getActiveError: unknown = null;
  replay = false;
  created: CreateDropshipWalletPolicyVersionRepositoryInput[] = [];
  countInputs: Array<{ autoReloadMinTriggerCents: number; autoReloadMinAmountCents: number }> = [];
  counts: DropshipWalletPolicyVendorImpactCounts = {
    vendorsBelowMinimumFloor: 0,
    vendorsBelowMinimumSingleTopUpLimit: 0,
    activeVendorsWithAutoReloadSettings: 0,
  };

  async getActivePolicy(): Promise<DropshipWalletPolicyRecord | null> {
    if (this.getActiveError) throw this.getActiveError;
    return this.activePolicy;
  }

  async createPolicyVersion(
    input: CreateDropshipWalletPolicyVersionRepositoryInput,
  ): Promise<DropshipWalletPolicyMutationResult> {
    this.created.push(input);
    const previousPolicy = this.replay ? null : this.activePolicy;
    return {
      policy: makePolicy(input.limits, {
        policyId: 9,
        version: (previousPolicy?.version ?? 0) + 1,
        changeNote: input.changeNote,
      }),
      previousPolicy,
      idempotentReplay: this.replay,
    };
  }

  async countVendorsBelowLimits(input: {
    autoReloadMinTriggerCents: number;
    autoReloadMinAmountCents: number;
  }): Promise<DropshipWalletPolicyVendorImpactCounts> {
    this.countInputs.push(input);
    return this.counts;
  }
}

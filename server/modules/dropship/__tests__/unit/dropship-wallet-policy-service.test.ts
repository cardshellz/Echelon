import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipVendorCreditProfile } from "../../domain/vendor-credit";
import type { DropshipWalletPolicyLimits } from "../../domain/wallet-policy";
import {
  DropshipWalletPolicyService,
  hashVendorCreditProfileRequest,
  hashWalletPolicyRequest,
  type CreateDropshipWalletPolicyVersionRepositoryInput,
  type DropshipVendorCreditProfileMutationResult,
  type DropshipVendorCreditProfileRepository,
  type DropshipWalletPolicyMutationResult,
  type DropshipWalletPolicyRecord,
  type DropshipWalletPolicyRepository,
  type DropshipWalletPolicyVendorImpactCounts,
  type SetDropshipVendorCreditProfileRepositoryInput,
} from "../../application/dropship-wallet-policy-service";

const now = new Date("2026-09-19T10:00:00.000Z");

/** Env with no dropship overrides, so the fallback layer is the documented defaults. */
const emptyEnv: NodeJS.ProcessEnv = {};

/** What the fallback layer serves with no policy row and no env overrides. */
const fallbackLimits: DropshipWalletPolicyLimits = {
  autoReloadMinTriggerCents: 10_000,
  caseTierMinimumCents: 50_000,
  autoReloadMinAmountCents: 10_000,
  manualFundingMinCents: 1_000,
  manualFundingMaxCents: 500_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 120,
  advanceFeeBps: 100,
  advanceCapCents: 50_000,
  tierChangeGraceDays: 14,
};

const publishedLimits: DropshipWalletPolicyLimits = {
  autoReloadMinTriggerCents: 9_000,
  caseTierMinimumCents: 55_000,
  autoReloadMinAmountCents: 20_000,
  manualFundingMinCents: 2_500,
  manualFundingMaxCents: 60_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 45,
  advanceFeeBps: 150,
  advanceCapCents: 75_000,
  tierChangeGraceDays: 21,
};

const validInput = {
  ...publishedLimits,
  changeNote: "Raising the floors for the autumn cohort.",
  idempotencyKey: "wallet-policy-001",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
};

const validCreditProfileInput = {
  vendorId: 10,
  advanceCapOverrideCents: 200_000,
  note: "Six months of clean settlements.",
  idempotencyKey: "credit-profile-001",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
};

describe("DropshipWalletPolicyService", () => {
  let repository: FakeWalletPolicyRepository;
  let creditProfiles: FakeCreditProfileRepository;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipWalletPolicyService;

  beforeEach(() => {
    repository = new FakeWalletPolicyRepository();
    creditProfiles = new FakeCreditProfileRepository();
    logs = [];
    service = new DropshipWalletPolicyService({
      repository,
      creditProfiles,
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

    it("falls back to the documented defaults when no row exists", async () => {
      repository.activePolicy = null;
      await expect(service.resolveWalletLimits()).resolves.toEqual(fallbackLimits);
    });

    it("falls back to the defaults when the table does not exist yet, and says so at WARN", async () => {
      repository.getActiveError = new DropshipError(
        "DROPSHIP_WALLET_POLICY_TABLE_MISSING",
        "Dropship wallet policy table does not exist yet.",
        { classification: "transient" },
      );

      await expect(service.resolveWalletLimits()).resolves.toMatchObject({
        autoReloadMinTriggerCents: 10_000,
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

  describe("resolveListingTierMinimums", () => {
    const day = 24 * 60 * 60 * 1000;

    it("enforces a raise only after the grace period of the version that raised it", async () => {
      const seeded = makePolicy(fallbackLimits, {
        policyId: 1, version: 1, isActive: false, createdAt: new Date(now.getTime() - 10 * day),
        createdBy: { actorType: "system", actorId: null }, deactivatedAt: new Date(now.getTime() - 2 * day),
      });
      const raised = makePolicy(
        { ...publishedLimits, autoReloadMinTriggerCents: 15_000, caseTierMinimumCents: 75_000, tierChangeGraceDays: 14 },
        { policyId: 2, version: 2, createdAt: new Date(now.getTime() - 2 * day) },
      );
      repository.activePolicy = raised;
      repository.versions = [raised, seeded];

      const minimums = await service.resolveListingTierMinimums(now);

      expect(minimums.pack).toEqual({
        tier: "pack", minimumCents: fallbackLimits.autoReloadMinTriggerCents, version: 1,
        upcoming: { minimumCents: 15_000, version: 2, enforcesAt: new Date(now.getTime() + 12 * day) },
      });
      expect(minimums.case).toEqual({
        tier: "case", minimumCents: fallbackLimits.caseTierMinimumCents, version: 1,
        upcoming: { minimumCents: 75_000, version: 2, enforcesAt: new Date(now.getTime() + 12 * day) },
      });
      const later = await service.resolveListingTierMinimums(new Date(now.getTime() + 12 * day));
      expect(later.pack).toEqual({ tier: "pack", minimumCents: 15_000, version: 2, upcoming: null });
      expect(later.case).toEqual({ tier: "case", minimumCents: 75_000, version: 2, upcoming: null });
    });

    it("uses the clock when none is given and the published values with nothing in grace", async () => {
      repository.activePolicy = makePolicy(publishedLimits);

      const minimums = await service.resolveListingTierMinimums();

      expect(minimums.pack).toEqual({ tier: "pack", minimumCents: publishedLimits.autoReloadMinTriggerCents, version: 3, upcoming: null });
      expect(minimums.case).toEqual({ tier: "case", minimumCents: publishedLimits.caseTierMinimumCents, version: 3, upcoming: null });
    });

    it("treats the environment fallback as a version enforced from the start, at WARN when the table is missing", async () => {
      repository.getActiveError = new DropshipError(
        "DROPSHIP_WALLET_POLICY_TABLE_MISSING",
        "Dropship wallet policy table does not exist yet.",
        { classification: "transient" },
      );

      const minimums = await service.resolveListingTierMinimums(now);

      expect(minimums.pack).toEqual({ tier: "pack", minimumCents: fallbackLimits.autoReloadMinTriggerCents, version: 1, upcoming: null });
      expect(minimums.case).toEqual({ tier: "case", minimumCents: fallbackLimits.caseTierMinimumCents, version: 1, upcoming: null });
      expect(logs).toEqual([expect.objectContaining({ level: "warn", code: "DROPSHIP_WALLET_POLICY_ENV_FALLBACK" })]);

      repository.getActiveError = null;
      repository.activePolicy = null;
      repository.versions = [];
      const empty = await service.resolveListingTierMinimums(now);
      expect(empty.pack.minimumCents).toBe(fallbackLimits.autoReloadMinTriggerCents);
    });

    it("propagates every other history read failure", async () => {
      repository.getActiveError = new DropshipError(
        "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
        "Stored wallet policy money is not a positive integer number of cents.",
        { classification: "fatal" },
      );
      await expect(service.resolveListingTierMinimums(now)).rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE" });
    });
  });

  describe("getOverview", () => {
    it("serves the policy, the fallback values it overrides, the read-only fee and the impact", async () => {
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
      expect(overview.envLimits).toEqual(fallbackLimits);
      expect(overview.envKeys.autoReloadMinTriggerCents).toBe("DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS");
      expect(overview.envKeys.caseTierMinimumCents).toBeNull();
      expect(overview.envKeys.advanceCapCents).toBeNull();
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
      // The staff screen sees what the tiers enforce today; a lone version has nothing in grace.
      expect(overview.listingTierEnforcement).toEqual({
        pack: { tier: "pack", minimumCents: publishedLimits.autoReloadMinTriggerCents, version: 3, upcoming: null },
        case: { tier: "case", minimumCents: publishedLimits.caseTierMinimumCents, version: 3, upcoming: null },
      });
      expect(overview.generatedAt).toEqual(now);
    });

    it("reports the environment as the source when nothing is published", async () => {
      repository.activePolicy = null;
      const overview = await service.getOverview();
      expect(overview.policy).toBeNull();
      expect(overview.limitsSource).toBe("environment");
      expect(overview.limits).toEqual(overview.envLimits);
      // Impact is measured against the limits actually in force.
      expect(repository.countInputs).toEqual([
        { autoReloadMinTriggerCents: 10_000, autoReloadMinAmountCents: 10_000 },
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
            after: expect.objectContaining({ autoReloadMinTriggerCents: 9_000, advanceCapCents: 75_000 }),
            actorId: "admin-1",
          }),
        }),
      ]);
    });

    it("hashes the whole proposal, not the key, so the same key with different values conflicts", async () => {
      const first = hashWalletPolicyRequest({ limits: publishedLimits, changeNote: null });
      const same = hashWalletPolicyRequest({ limits: { ...publishedLimits }, changeNote: null });
      expect(first).toBe(same);
      for (const patch of [
        { autoReloadMinTriggerCents: 9_001 },
        { caseTierMinimumCents: 55_001 },
        { advanceFeeBps: 151 },
        { advanceCapCents: 75_001 },
        { tierChangeGraceDays: 22 },
      ]) {
        expect(hashWalletPolicyRequest({ limits: { ...publishedLimits, ...patch }, changeNote: null }))
          .not.toBe(first);
      }
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

    it("refuses a top-up limit below the floor, a case tier below the pack tier, and a warning window at or beyond the hold", async () => {
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
        caseTierMinimumCents: 8_999,
      })).rejects.toMatchObject({
        context: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: "caseTierMinimumCents",
              message: "Case tier minimum must be at least the pack tier minimum.",
            }),
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
        { caseTierMinimumCents: 0 },
        { manualFundingMinCents: -1 },
        { manualFundingMaxCents: 1_000.5 },
        { defaultPaymentHoldTimeoutMinutes: 0 },
        { defaultPaymentHoldTimeoutMinutes: 43_201 },
        { holdExpiryWarningMinutes: 0 },
        { advanceFeeBps: -1 },
        { advanceFeeBps: 10_001 },
        { advanceFeeBps: 1.5 },
        { advanceCapCents: -1 },
        { advanceCapCents: 0.5 },
        { tierChangeGraceDays: -1 },
        { tierChangeGraceDays: 366 },
      ]) {
        await expect(service.createPolicyVersion({ ...validInput, ...patch }))
          .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
      }
      expect(repository.created).toEqual([]);
    });

    it("accepts zero for the advance fee, the advance cap and the grace: each is a policy, not an error", async () => {
      const result = await service.createPolicyVersion({
        ...validInput,
        advanceFeeBps: 0,
        advanceCapCents: 0,
        tierChangeGraceDays: 0,
      });
      expect(result.policy.limits).toMatchObject({ advanceFeeBps: 0, advanceCapCents: 0, tierChangeGraceDays: 0 });
    });

    it("refuses an unknown field rather than silently dropping it", async () => {
      await expect(service.createPolicyVersion({ ...validInput, cardFundingFeeBps: 500 }))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
    });

    it("refuses a version that omits one of the new limits", async () => {
      const { advanceCapCents: _omitted, ...withoutCap } = validInput;
      await expect(service.createPolicyVersion(withoutCap))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
    });

    it("requires an idempotency key long enough to be meaningful", async () => {
      await expect(service.createPolicyVersion({ ...validInput, idempotencyKey: "short" }))
        .rejects.toMatchObject({ code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT" });
    });

    it("accepts the boundary case where the limit equals the floor and the case tier equals the pack tier", async () => {
      const result = await service.createPolicyVersion({
        ...validInput,
        autoReloadMinTriggerCents: 20_000,
        caseTierMinimumCents: 20_000,
        autoReloadMinAmountCents: 20_000,
      });
      expect(result.policy.limits.autoReloadMinAmountCents).toBe(20_000);
      expect(result.policy.limits.caseTierMinimumCents).toBe(20_000);
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

  describe("getVendorCreditProfile", () => {
    it("resolves the policy cap when the vendor has no profile", async () => {
      repository.activePolicy = makePolicy(publishedLimits);

      const view = await service.getVendorCreditProfile(10);

      expect(view).toEqual({
        vendorId: 10,
        profile: null,
        policyAdvanceCapCents: 75_000,
        effectiveAdvanceCapCents: 75_000,
        effectiveAdvanceCapSource: "policy",
        generatedAt: now,
      });
    });

    it("resolves a vendor override over the policy cap", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      creditProfiles.profiles.set(10, makeProfile({ advanceCapOverrideCents: 200_000 }));

      const view = await service.getVendorCreditProfile(10);

      expect(view).toMatchObject({
        profile: expect.objectContaining({ advanceCapOverrideCents: 200_000 }),
        policyAdvanceCapCents: 75_000,
        effectiveAdvanceCapCents: 200_000,
        effectiveAdvanceCapSource: "vendor_override",
      });
    });

    it("falls back to the policy cap when the profile table is missing, and says so at WARN", async () => {
      creditProfiles.getError = new DropshipError(
        "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_MISSING",
        "missing",
        { classification: "transient" },
      );

      const view = await service.getVendorCreditProfile(10);

      expect(view).toMatchObject({ profile: null, effectiveAdvanceCapCents: 50_000, effectiveAdvanceCapSource: "policy" });
      expect(logs).toEqual([
        expect.objectContaining({ level: "warn", code: "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_FALLBACK" }),
      ]);
    });

    it("propagates every other profile read failure", async () => {
      creditProfiles.getError = new DropshipError(
        "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE",
        "bad",
        { classification: "fatal" },
      );
      await expect(service.getVendorCreditProfile(10)).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE",
      });
    });

    it("refuses a vendor id that is not a positive integer", async () => {
      for (const bad of [0, -1, 1.5, "10", null]) {
        await expect(service.getVendorCreditProfile(bad))
          .rejects.toMatchObject({ code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT" });
      }
    });
  });

  describe("resolveAdvanceCapForVendor", () => {
    it("is the read the acceptance waterfall uses: override when set, policy otherwise", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      await expect(service.resolveAdvanceCapForVendor(10))
        .resolves.toEqual({ advanceCapCents: 75_000, source: "policy" });

      creditProfiles.profiles.set(10, makeProfile({ advanceCapOverrideCents: 0 }));
      await expect(service.resolveAdvanceCapForVendor(10))
        .resolves.toEqual({ advanceCapCents: 0, source: "vendor_override" });
    });
  });

  describe("setVendorCreditProfile", () => {
    it("sets the override, resolves the effective cap and logs before -> after", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      creditProfiles.profiles.set(10, makeProfile({ advanceCapOverrideCents: 100_000, note: "old" }));

      const result = await service.setVendorCreditProfile(validCreditProfileInput);

      expect(result.idempotentReplay).toBe(false);
      expect(result.profile.advanceCapOverrideCents).toBe(200_000);
      expect(result.previousProfile?.advanceCapOverrideCents).toBe(100_000);
      expect(result).toMatchObject({
        policyAdvanceCapCents: 75_000,
        effectiveAdvanceCapCents: 200_000,
        effectiveAdvanceCapSource: "vendor_override",
      });
      expect(creditProfiles.set_).toEqual([
        expect.objectContaining({
          vendorId: 10,
          advanceCapOverrideCents: 200_000,
          note: "Six months of clean settlements.",
          idempotencyKey: "credit-profile-001",
          requestHash: hashVendorCreditProfileRequest({
            vendorId: 10,
            advanceCapOverrideCents: 200_000,
            note: "Six months of clean settlements.",
          }),
          actor: { actorType: "admin", actorId: "admin-1" },
          now,
        }),
      ]);
      expect(logs).toEqual([
        expect.objectContaining({
          level: "info",
          code: "DROPSHIP_VENDOR_CREDIT_PROFILE_SET",
          context: expect.objectContaining({
            vendorId: 10,
            before: { advanceCapOverrideCents: 100_000, note: "old" },
            after: { advanceCapOverrideCents: 200_000, note: "Six months of clean settlements." },
            effectiveAdvanceCapCents: 200_000,
          }),
        }),
      ]);
    });

    it("clears the override with null so the policy cap applies again", async () => {
      repository.activePolicy = makePolicy(publishedLimits);
      creditProfiles.profiles.set(10, makeProfile({ advanceCapOverrideCents: 100_000 }));

      const result = await service.setVendorCreditProfile({
        ...validCreditProfileInput,
        advanceCapOverrideCents: null,
        note: null,
      });

      expect(result.profile.advanceCapOverrideCents).toBeNull();
      expect(result).toMatchObject({ effectiveAdvanceCapCents: 75_000, effectiveAdvanceCapSource: "policy" });
    });

    it("hashes the vendor, the cap and the note, so a reused key with different values conflicts", () => {
      const base = { vendorId: 10, advanceCapOverrideCents: 200_000, note: null };
      expect(hashVendorCreditProfileRequest(base)).toBe(hashVendorCreditProfileRequest({ ...base }));
      expect(hashVendorCreditProfileRequest({ ...base, vendorId: 11 })).not.toBe(hashVendorCreditProfileRequest(base));
      expect(hashVendorCreditProfileRequest({ ...base, advanceCapOverrideCents: null })).not.toBe(hashVendorCreditProfileRequest(base));
      expect(hashVendorCreditProfileRequest({ ...base, note: "x" })).not.toBe(hashVendorCreditProfileRequest(base));
    });

    it("reports a replay without a before, because nothing changed", async () => {
      creditProfiles.replay = true;
      const result = await service.setVendorCreditProfile(validCreditProfileInput);
      expect(result).toMatchObject({ idempotentReplay: true, previousProfile: null });
      expect(logs).toEqual([
        expect.objectContaining({ code: "DROPSHIP_VENDOR_CREDIT_PROFILE_REPLAYED" }),
      ]);
    });

    it("refuses a negative or fractional override, an unknown field, a bad vendor id and a short key", async () => {
      for (const patch of [
        { advanceCapOverrideCents: -1 },
        { advanceCapOverrideCents: 10.5 },
        { vendorId: 0 },
        { idempotencyKey: "short" },
        { trustTier: "gold" },
      ]) {
        await expect(service.setVendorCreditProfile({ ...validCreditProfileInput, ...patch }))
          .rejects.toMatchObject({ code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT" });
      }
      expect(creditProfiles.set_).toEqual([]);
    });

    it("propagates a repository refusal such as an unknown vendor", async () => {
      creditProfiles.setError = new DropshipError(
        "DROPSHIP_VENDOR_CREDIT_PROFILE_VENDOR_NOT_FOUND",
        "No dropship vendor exists with that id.",
        { classification: "permanent" },
      );
      await expect(service.setVendorCreditProfile(validCreditProfileInput)).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_CREDIT_PROFILE_VENDOR_NOT_FOUND",
      });
      expect(logs).toEqual([]);
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

function makeProfile(overrides: Partial<DropshipVendorCreditProfile> = {}): DropshipVendorCreditProfile {
  return {
    vendorId: 10,
    advanceCapOverrideCents: null,
    note: null,
    createdAt: now,
    updatedAt: now,
    updatedBy: { actorType: "admin", actorId: "admin-1" },
    ...overrides,
  };
}

class FakeWalletPolicyRepository implements DropshipWalletPolicyRepository {
  activePolicy: DropshipWalletPolicyRecord | null = null;
  /** The version history; defaults to the active policy alone. */
  versions: DropshipWalletPolicyRecord[] | null = null;
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

  async listPolicyVersions(): Promise<DropshipWalletPolicyRecord[]> {
    if (this.getActiveError) throw this.getActiveError;
    if (this.versions) return this.versions;
    return this.activePolicy ? [this.activePolicy] : [];
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

class FakeCreditProfileRepository implements DropshipVendorCreditProfileRepository {
  readonly profiles = new Map<number, DropshipVendorCreditProfile>();
  getError: unknown = null;
  setError: unknown = null;
  replay = false;
  set_: SetDropshipVendorCreditProfileRepositoryInput[] = [];

  async getByVendorId(vendorId: number): Promise<DropshipVendorCreditProfile | null> {
    if (this.getError) throw this.getError;
    return this.profiles.get(vendorId) ?? null;
  }

  async set(input: SetDropshipVendorCreditProfileRepositoryInput): Promise<DropshipVendorCreditProfileMutationResult> {
    if (this.setError) throw this.setError;
    this.set_.push(input);
    const previousProfile = this.replay ? null : this.profiles.get(input.vendorId) ?? null;
    const profile = makeProfile({
      vendorId: input.vendorId,
      advanceCapOverrideCents: input.advanceCapOverrideCents,
      note: input.note,
      updatedAt: input.now,
    });
    this.profiles.set(input.vendorId, profile);
    return { profile, previousProfile, idempotentReplay: this.replay };
  }
}

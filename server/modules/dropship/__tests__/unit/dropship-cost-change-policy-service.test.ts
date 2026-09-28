import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DROPSHIP_COST_CHANGE_POLICY,
  type DropshipCostChangePolicySettings,
} from "../../../../../shared/dropship/cost-change-policy";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  COST_CHANGE_POLICY_HISTORY_LIMIT,
  DROPSHIP_COST_CHANGE_ENFORCEMENT,
  DropshipCostChangePolicyService,
  hashCostChangePolicyRequest,
  resolveDropshipCostChangeEnforcement,
  type CreateDropshipCostChangePolicyVersionRepositoryInput,
  type DropshipCostChangePolicyMutationResult,
  type DropshipCostChangePolicyRecord,
  type DropshipCostChangePolicyRepository,
} from "../../application/dropship-cost-change-policy-service";

const now = new Date("2026-09-27T10:00:00.000Z");

const publishedSettings: DropshipCostChangePolicySettings = {
  increaseNoticeDays: 21,
  decreaseTiming: "after_notice",
  priceProtection: true,
  retailChangesGetNotice: false,
  notifyByEmail: true,
  notifyInPortal: true,
  notifyOnDecrease: false,
  noticeMinimumChangeCents: 25,
  noticeMinimumChangeBps: 150,
  rulePricedListings: "wait_for_review",
  belowCostFixedListings: "pause_listing",
  detectionIntervalMinutes: 30,
};

const validInput = {
  settings: publishedSettings,
  changeNote: "  Three weeks' notice for the holiday catalog.  ",
  idempotencyKey: "cost-change-policy-001",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
};

const tableMissing = () => new DropshipError(
  "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING",
  "Dropship cost change policy table does not exist yet.",
  { classification: "transient" },
);

describe("DropshipCostChangePolicyService", () => {
  let repository: FakeCostChangePolicyRepository;
  let logs: Array<DropshipLogEvent & { level: "info" | "warn" | "error" }>;
  let service: DropshipCostChangePolicyService;

  beforeEach(() => {
    repository = new FakeCostChangePolicyRepository();
    logs = [];
    service = new DropshipCostChangePolicyService({
      repository,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push({ ...event, level: "info" }),
        warn: (event) => logs.push({ ...event, level: "warn" }),
        error: (event) => logs.push({ ...event, level: "error" }),
      },
      enforcement: resolveDropshipCostChangeEnforcement({ detectionWorkerEnabled: true }),
    });
  });

  describe("resolvePolicy", () => {
    it("serves the active version's id and settings", async () => {
      repository.activePolicy = makePolicy(publishedSettings);
      await expect(service.resolvePolicy()).resolves.toEqual({ policyId: repository.activePolicy.policyId, settings: publishedSettings });
    });

    it("has no policy id when the defaults apply", async () => {
      await expect(service.resolvePolicy()).resolves.toEqual({ policyId: null, settings: DEFAULT_DROPSHIP_COST_CHANGE_POLICY });
    });
  });

  describe("resolveDropshipCostChangeEnforcement", () => {
    it("calls detection live only where its worker is switched on; the later parts stay off", () => {
      expect(resolveDropshipCostChangeEnforcement({ detectionWorkerEnabled: true }))
        .toEqual({ detection: true, priceProtection: true, vendorNotices: true, listingActions: true });
      expect(resolveDropshipCostChangeEnforcement({ detectionWorkerEnabled: false }))
        .toEqual({ detection: false, priceProtection: true, vendorNotices: true, listingActions: true });
    });
  });

  describe("resolvePolicySettings", () => {
    it("serves the active version's settings", async () => {
      repository.activePolicy = makePolicy(publishedSettings);
      await expect(service.resolvePolicySettings()).resolves.toEqual(publishedSettings);
      expect(logs).toEqual([]);
    });

    it("serves an editable copy of the defaults when no version exists", async () => {
      const settings = await service.resolvePolicySettings();
      expect(settings).toEqual(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);
      expect(settings).not.toBe(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);
      expect(Object.isFrozen(settings)).toBe(false);
    });

    it("falls back to the defaults when the table does not exist yet, and says so at WARN", async () => {
      repository.readError = tableMissing();

      await expect(service.resolvePolicySettings()).resolves.toEqual(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);
      expect(logs).toEqual([expect.objectContaining({
        level: "warn",
        code: "DROPSHIP_COST_CHANGE_POLICY_DEFAULTS_FALLBACK",
        context: expect.objectContaining({ errorCode: "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING" }),
      })]);
    });

    it("never masks any other read failure with the defaults", async () => {
      const corrupt = new DropshipError(
        "DROPSHIP_COST_CHANGE_POLICY_INVALID_STORED_VALUE",
        "A stored cost change policy version failed the settings contract.",
        { classification: "fatal" },
      );
      repository.readError = corrupt;
      await expect(service.resolvePolicySettings()).rejects.toBe(corrupt);

      const outage = Object.assign(new Error("connection reset"), { code: "08006" });
      repository.readError = outage;
      await expect(service.resolvePolicySettings()).rejects.toBe(outage);
      expect(logs).toEqual([]);
    });
  });

  describe("getOverview", () => {
    it("describes the active version, its history and what is enforced today", async () => {
      const retired = makePolicy(DEFAULT_DROPSHIP_COST_CHANGE_POLICY, {
        policyId: 1,
        version: 1,
        isActive: false,
        deactivatedAt: now,
      });
      repository.activePolicy = makePolicy(publishedSettings);
      repository.versions = [repository.activePolicy, retired];

      const overview = await service.getOverview();

      expect(overview).toEqual({
        policy: repository.activePolicy,
        settings: publishedSettings,
        settingsSource: "policy",
        defaults: { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY },
        versions: [repository.activePolicy, retired],
        enforcement: { detection: true, priceProtection: true, vendorNotices: true, listingActions: true },
        generatedAt: now,
      });
      expect(repository.historyLimits).toEqual([COST_CHANGE_POLICY_HISTORY_LIMIT]);
    });

    it("says the defaults apply when nothing is published", async () => {
      const overview = await service.getOverview();
      expect(overview).toMatchObject({
        policy: null,
        settings: { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY },
        settingsSource: "defaults",
        versions: [],
      });
    });

    it("still answers before the migration lands", async () => {
      repository.readError = tableMissing();

      const overview = await service.getOverview();

      expect(overview).toMatchObject({ policy: null, settingsSource: "defaults", versions: [] });
      expect(logs.every((log) => log.level === "warn" && log.code === "DROPSHIP_COST_CHANGE_POLICY_DEFAULTS_FALLBACK"))
        .toBe(true);
    });

    it("hands out copies, so a caller cannot change the shared defaults or enforcement flags", async () => {
      const overview = await service.getOverview();
      overview.defaults.increaseNoticeDays = 0;
      overview.enforcement.detection = false;

      expect(DEFAULT_DROPSHIP_COST_CHANGE_POLICY.increaseNoticeDays).toBe(14);
      expect((await service.getOverview()).enforcement.detection).toBe(true);
      expect(DROPSHIP_COST_CHANGE_ENFORCEMENT.detection).toBe(true);
      expect(Object.isFrozen(DROPSHIP_COST_CHANGE_ENFORCEMENT)).toBe(true);
    });

    it("reports the enforcement it was given, not the shipped constant", async () => {
      const offline = new DropshipCostChangePolicyService({
        repository,
        clock: { now: () => now },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        enforcement: resolveDropshipCostChangeEnforcement({ detectionWorkerEnabled: false }),
      });
      expect((await offline.getOverview()).enforcement.detection).toBe(false);
    });
  });

  describe("createPolicyVersion", () => {
    it("publishes a validated version with the clock's time and a stable request hash", async () => {
      repository.activePolicy = makePolicy(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);

      const outcome = await service.createPolicyVersion(validInput);

      expect(repository.created).toEqual([{
        settings: publishedSettings,
        changeNote: "Three weeks' notice for the holiday catalog.",
        idempotencyKey: "cost-change-policy-001",
        requestHash: hashCostChangePolicyRequest({
          settings: publishedSettings,
          changeNote: "Three weeks' notice for the holiday catalog.",
        }),
        actor: { actorType: "admin", actorId: "admin-1" },
        now,
      }]);
      expect(outcome).toMatchObject({ idempotentReplay: false, policy: { version: 4, settings: publishedSettings } });
    });

    it("logs who changed what, from what, at INFO", async () => {
      repository.activePolicy = makePolicy(DEFAULT_DROPSHIP_COST_CHANGE_POLICY);

      await service.createPolicyVersion(validInput);

      expect(logs).toEqual([expect.objectContaining({
        level: "info",
        code: "DROPSHIP_COST_CHANGE_POLICY_VERSION_PUBLISHED",
        context: expect.objectContaining({
          action: "cost_change_policy_version_created",
          outcome: "published",
          policyId: 9,
          version: 4,
          actorType: "admin",
          actorId: "admin-1",
          before: expect.objectContaining({ policyId: 3, version: 3, increaseNoticeDays: 14 }),
          after: expect.objectContaining({ policyId: 9, version: 4, increaseNoticeDays: 21 }),
        }),
      })]);
    });

    it("logs a replay as a replay, with no before", async () => {
      repository.activePolicy = makePolicy(publishedSettings);
      repository.replay = true;

      const outcome = await service.createPolicyVersion(validInput);

      expect(outcome.idempotentReplay).toBe(true);
      expect(logs).toEqual([expect.objectContaining({
        code: "DROPSHIP_COST_CHANGE_POLICY_VERSION_REPLAYED",
        context: expect.objectContaining({ outcome: "replayed", before: null }),
      })]);
    });

    it("refuses input outside the contract before touching the repository", async () => {
      const invalid: unknown[] = [
        null,
        { ...validInput, changeNote: undefined },
        { ...validInput, changeNote: "   " },
        { ...validInput, changeNote: "x".repeat(1_001) },
        { ...validInput, idempotencyKey: "short" },
        { ...validInput, idempotencyKey: "k".repeat(201) },
        { ...validInput, actor: { actorType: "vendor", actorId: "v-1" } },
        { ...validInput, actor: { actorType: "admin", actorId: "" } },
        { ...validInput, surprise: true },
        { ...validInput, settings: { ...publishedSettings, increaseNoticeDays: 91 } },
        { ...validInput, settings: { ...publishedSettings, increaseNoticeDays: -1 } },
        { ...validInput, settings: { ...publishedSettings, decreaseTiming: "never" } },
        { ...validInput, settings: { ...publishedSettings, noticeMinimumChangeCents: 100_001 } },
        { ...validInput, settings: { ...publishedSettings, noticeMinimumChangeBps: 2.5 } },
        { ...validInput, settings: { ...publishedSettings, detectionIntervalMinutes: 14 } },
        { ...validInput, settings: { ...publishedSettings, notifyByEmail: "yes" } },
        { ...validInput, settings: { ...publishedSettings, extra: 1 } },
        { ...validInput, settings: { increaseNoticeDays: 21 } },
      ];
      for (const input of invalid) {
        await expect(service.createPolicyVersion(input)).rejects.toMatchObject({
          code: "DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT",
          context: expect.objectContaining({ classification: "permanent", issues: expect.any(Array) }),
        });
      }
      expect(repository.created).toEqual([]);
      expect(logs).toEqual([]);
    });

    it("accepts the edges of every range", async () => {
      const edges: DropshipCostChangePolicySettings = {
        ...publishedSettings,
        increaseNoticeDays: 0,
        noticeMinimumChangeCents: 100_000,
        noticeMinimumChangeBps: 10_000,
        detectionIntervalMinutes: 15,
      };
      await expect(service.createPolicyVersion({ ...validInput, settings: edges })).resolves.toMatchObject({
        policy: { settings: edges },
      });
    });

    it("propagates a repository failure without logging a publish", async () => {
      const conflict = new DropshipError(
        "DROPSHIP_COST_CHANGE_POLICY_CONFLICT",
        "Another cost change policy version was published concurrently; retry the request.",
        { classification: "transient" },
      );
      repository.createError = conflict;

      await expect(service.createPolicyVersion(validInput)).rejects.toBe(conflict);
      expect(logs).toEqual([]);
    });
  });
});

describe("hashCostChangePolicyRequest", () => {
  const note = "Three weeks' notice for the holiday catalog.";

  it("does not depend on key order", () => {
    const reversed = Object.fromEntries(Object.entries(publishedSettings).reverse()) as DropshipCostChangePolicySettings;
    expect(hashCostChangePolicyRequest({ settings: reversed, changeNote: note }))
      .toBe(hashCostChangePolicyRequest({ settings: publishedSettings, changeNote: note }));
  });

  it("changes when any setting or the note changes", () => {
    const base = hashCostChangePolicyRequest({ settings: publishedSettings, changeNote: note });
    const patches: Array<Partial<DropshipCostChangePolicySettings>> = [
      { increaseNoticeDays: 22 },
      { decreaseTiming: "immediate" },
      { priceProtection: false },
      { retailChangesGetNotice: true },
      { notifyByEmail: false },
      { notifyInPortal: false },
      { notifyOnDecrease: true },
      { noticeMinimumChangeCents: 26 },
      { noticeMinimumChangeBps: 151 },
      { rulePricedListings: "reprice_automatically" },
      { belowCostFixedListings: "warn" },
      { detectionIntervalMinutes: 31 },
    ];
    const hashes = patches.map((patch) =>
      hashCostChangePolicyRequest({ settings: { ...publishedSettings, ...patch }, changeNote: note }));
    expect(hashes.every((hash) => hash !== base)).toBe(true);
    expect(new Set(hashes).size).toBe(patches.length);
    expect(hashCostChangePolicyRequest({ settings: publishedSettings, changeNote: `${note}.` })).not.toBe(base);
  });

  it("refuses settings outside the contract", () => {
    expect(() => hashCostChangePolicyRequest({
      settings: { ...publishedSettings, increaseNoticeDays: 91 },
      changeNote: note,
    })).toThrow();
  });
});

function makePolicy(
  settings: DropshipCostChangePolicySettings,
  overrides: Partial<DropshipCostChangePolicyRecord> = {},
): DropshipCostChangePolicyRecord {
  return {
    policyId: 3,
    version: 3,
    settings: { ...settings },
    isActive: true,
    changeNote: "Initial defaults from migration 0710. Confirm or change them in Dropship, Cost changes.",
    createdAt: now,
    createdBy: { actorType: "system", actorId: "migration:0710" },
    deactivatedAt: null,
    ...overrides,
  };
}

class FakeCostChangePolicyRepository implements DropshipCostChangePolicyRepository {
  activePolicy: DropshipCostChangePolicyRecord | null = null;
  /** The version history; defaults to the active policy alone. */
  versions: DropshipCostChangePolicyRecord[] | null = null;
  readError: unknown = null;
  createError: unknown = null;
  replay = false;
  readonly created: CreateDropshipCostChangePolicyVersionRepositoryInput[] = [];
  readonly historyLimits: number[] = [];

  async getActivePolicy(): Promise<DropshipCostChangePolicyRecord | null> {
    if (this.readError) throw this.readError;
    return this.activePolicy;
  }

  async listPolicyVersions(limit: number): Promise<DropshipCostChangePolicyRecord[]> {
    this.historyLimits.push(limit);
    if (this.readError) throw this.readError;
    if (this.versions) return this.versions;
    return this.activePolicy ? [this.activePolicy] : [];
  }

  async createPolicyVersion(
    input: CreateDropshipCostChangePolicyVersionRepositoryInput,
  ): Promise<DropshipCostChangePolicyMutationResult> {
    if (this.createError) throw this.createError;
    this.created.push(input);
    const previousPolicy = this.replay ? null : this.activePolicy;
    return {
      policy: makePolicy(input.settings, {
        policyId: this.replay ? (this.activePolicy?.policyId ?? 9) : 9,
        version: this.replay ? (this.activePolicy?.version ?? 1) : (previousPolicy?.version ?? 0) + 1,
        changeNote: input.changeNote,
        createdBy: { actorType: input.actor.actorType, actorId: input.actor.actorId ?? null },
      }),
      previousPolicy,
      idempotentReplay: this.replay,
    };
  }
}

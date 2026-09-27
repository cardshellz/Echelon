import { createHash } from "crypto";
import { z } from "zod";
import {
  DEFAULT_DROPSHIP_COST_CHANGE_POLICY,
  dropshipCostChangePolicySettingsSchema,
  type DropshipCostChangePolicySettings,
} from "../../../../shared/dropship/cost-change-policy";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

/**
 * Dropship .ops cost change policy service.
 *
 * Staff set how cost changes reach vendors: the notice before an increase is
 * charged, price protection, notices, and what happens to listings when a new
 * cost takes effect (docs/DROPSHIP-COST-CHANGE-CONTROLS.md). A change is a NEW
 * VERSION of `dropship.dropship_cost_change_policies` (migration 0710);
 * published rows are immutable and exactly one is active. Reads fall back to
 * the shared defaults only when no row exists (an empty database, or the window
 * before the migration lands).
 */

const idempotencyKeySchema = z.string().trim().min(8).max(200);
const changeNoteSchema = z.string().trim().min(1).max(1000);
const actorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

/** How many past versions the admin module lists. The table keeps them all. */
export const COST_CHANGE_POLICY_HISTORY_LIMIT = 20;

export const createDropshipCostChangePolicyVersionInputSchema = z.object({
  settings: dropshipCostChangePolicySettingsSchema,
  changeNote: changeNoteSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: actorSchema,
}).strict();

export type CreateDropshipCostChangePolicyVersionInput = z.infer<typeof createDropshipCostChangePolicyVersionInputSchema>;

export interface DropshipCostChangePolicyActor {
  actorType: "admin" | "system";
  actorId: string | null;
}

export interface DropshipCostChangePolicyRecord {
  policyId: number;
  version: number;
  settings: DropshipCostChangePolicySettings;
  isActive: boolean;
  changeNote: string;
  createdAt: Date;
  createdBy: DropshipCostChangePolicyActor;
  deactivatedAt: Date | null;
}

/**
 * Which parts of the cost change controls act on the saved settings today.
 * Each later part of the design flips its own flag, so the admin module never
 * implies a setting is enforced before the code that enforces it ships.
 */
export interface DropshipCostChangeEnforcement {
  /** Live costs are compared with the cost schedule and changes recorded. */
  detection: boolean;
  /** Acceptance charges the cost in force instead of the live cost. */
  priceProtection: boolean;
  /** Vendors are emailed and alerted in the portal. */
  vendorNotices: boolean;
  /** Listings are repriced, flagged or paused when a new cost takes effect. */
  listingActions: boolean;
}

export const DROPSHIP_COST_CHANGE_ENFORCEMENT: Readonly<DropshipCostChangeEnforcement> = Object.freeze({
  detection: false,
  priceProtection: false,
  vendorNotices: false,
  listingActions: false,
});

export interface DropshipCostChangePolicyOverview {
  /** The active version, or null when none exists and the defaults apply. */
  policy: DropshipCostChangePolicyRecord | null;
  /** The settings in force. */
  settings: DropshipCostChangePolicySettings;
  settingsSource: "policy" | "defaults";
  defaults: DropshipCostChangePolicySettings;
  /** Newest first, at most COST_CHANGE_POLICY_HISTORY_LIMIT. */
  versions: DropshipCostChangePolicyRecord[];
  enforcement: DropshipCostChangeEnforcement;
  generatedAt: Date;
}

export interface DropshipCostChangePolicyMutationResult {
  policy: DropshipCostChangePolicyRecord;
  /** The version this one retired, read in the same transaction; null on a first version and on a replay. */
  previousPolicy: DropshipCostChangePolicyRecord | null;
  idempotentReplay: boolean;
}

export interface CreateDropshipCostChangePolicyVersionRepositoryInput {
  settings: DropshipCostChangePolicySettings;
  changeNote: string;
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
}

export interface DropshipCostChangePolicyRepository {
  getActivePolicy(): Promise<DropshipCostChangePolicyRecord | null>;
  listPolicyVersions(limit: number): Promise<DropshipCostChangePolicyRecord[]>;
  createPolicyVersion(input: CreateDropshipCostChangePolicyVersionRepositoryInput): Promise<DropshipCostChangePolicyMutationResult>;
}

/** The single read every cost change component uses for the settings in force. */
export interface DropshipCostChangePolicyResolver {
  resolvePolicySettings(): Promise<DropshipCostChangePolicySettings>;
}

export class DropshipCostChangePolicyService implements DropshipCostChangePolicyResolver {
  constructor(
    private readonly deps: {
      repository: DropshipCostChangePolicyRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async resolvePolicySettings(): Promise<DropshipCostChangePolicySettings> {
    return (await this.readActivePolicy())?.settings ?? { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };
  }

  async getOverview(): Promise<DropshipCostChangePolicyOverview> {
    const [policy, versions] = await Promise.all([this.readActivePolicy(), this.readPolicyVersions()]);
    return {
      policy,
      settings: policy?.settings ?? { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY },
      settingsSource: policy ? "policy" : "defaults",
      defaults: { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY },
      versions,
      enforcement: { ...DROPSHIP_COST_CHANGE_ENFORCEMENT },
      generatedAt: this.deps.clock.now(),
    };
  }

  async createPolicyVersion(input: unknown): Promise<DropshipCostChangePolicyMutationResult> {
    const parsed = parseCostChangePolicyInput(createDropshipCostChangePolicyVersionInputSchema, input);
    const now = this.deps.clock.now();
    const result = await this.deps.repository.createPolicyVersion({
      settings: parsed.settings,
      changeNote: parsed.changeNote,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: hashCostChangePolicyRequest({ settings: parsed.settings, changeNote: parsed.changeNote }),
      actor: parsed.actor,
      now,
    });

    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_COST_CHANGE_POLICY_VERSION_REPLAYED"
        : "DROPSHIP_COST_CHANGE_POLICY_VERSION_PUBLISHED",
      message: "Dropship cost change policy version command completed.",
      context: {
        action: "cost_change_policy_version_created",
        outcome: result.idempotentReplay ? "replayed" : "published",
        policyId: result.policy.policyId,
        version: result.policy.version,
        actorType: parsed.actor.actorType,
        actorId: parsed.actor.actorId ?? null,
        changeNote: parsed.changeNote,
        before: result.previousPolicy
          ? { policyId: result.previousPolicy.policyId, version: result.previousPolicy.version, ...result.previousPolicy.settings }
          : null,
        after: { policyId: result.policy.policyId, version: result.policy.version, ...result.policy.settings },
      },
    });
    return result;
  }

  private async readActivePolicy(): Promise<DropshipCostChangePolicyRecord | null> {
    try {
      return await this.deps.repository.getActivePolicy();
    } catch (error) {
      if (isTableMissing(error)) {
        this.warnDefaults("active policy");
        return null;
      }
      throw error;
    }
  }

  private async readPolicyVersions(): Promise<DropshipCostChangePolicyRecord[]> {
    try {
      return await this.deps.repository.listPolicyVersions(COST_CHANGE_POLICY_HISTORY_LIMIT);
    } catch (error) {
      if (isTableMissing(error)) {
        this.warnDefaults("version history");
        return [];
      }
      throw error;
    }
  }

  private warnDefaults(read: string): void {
    // Auto-recovered anomaly: the defaults are a complete, valid policy.
    this.deps.logger.warn({
      code: "DROPSHIP_COST_CHANGE_POLICY_DEFAULTS_FALLBACK",
      message: `Dropship cost change policy table is missing; the ${read} falls back to the shared defaults.`,
      context: { classification: "transient", errorCode: "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING" },
    });
  }
}

/** Stable fingerprint of a version write: an idempotency key may replay only the same request. */
export function hashCostChangePolicyRequest(value: {
  settings: DropshipCostChangePolicySettings;
  changeNote: string;
}): string {
  const settings = dropshipCostChangePolicySettingsSchema.parse(value.settings);
  return createHash("sha256").update(JSON.stringify({
    command: "cost_change_policy_version_created",
    // Listed explicitly so the hash does not depend on object key order.
    settings: {
      increaseNoticeDays: settings.increaseNoticeDays,
      decreaseTiming: settings.decreaseTiming,
      priceProtection: settings.priceProtection,
      retailChangesGetNotice: settings.retailChangesGetNotice,
      notifyByEmail: settings.notifyByEmail,
      notifyInPortal: settings.notifyInPortal,
      notifyOnDecrease: settings.notifyOnDecrease,
      noticeMinimumChangeCents: settings.noticeMinimumChangeCents,
      noticeMinimumChangeBps: settings.noticeMinimumChangeBps,
      rulePricedListings: settings.rulePricedListings,
      belowCostFixedListings: settings.belowCostFixedListings,
      detectionIntervalMinutes: settings.detectionIntervalMinutes,
    },
    changeNote: value.changeNote,
  })).digest("hex");
}

export function makeDropshipCostChangePolicyLogger(): DropshipLogger {
  return {
    info: (event) => logCostChangePolicyEvent("info", event),
    warn: (event) => logCostChangePolicyEvent("warn", event),
    error: (event) => logCostChangePolicyEvent("error", event),
  };
}

export const systemDropshipCostChangePolicyClock: DropshipClock = {
  now: () => new Date(),
};

function isTableMissing(error: unknown): boolean {
  return error instanceof DropshipError && error.code === "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING";
}

function parseCostChangePolicyInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError("DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT", "Dropship cost change policy input failed validation.", {
      classification: "permanent",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function logCostChangePolicyEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({ level, code: event.code, message: event.message, context: event.context ?? {} });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}

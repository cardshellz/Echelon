import { createHash } from "crypto";
import { z } from "zod";
import { MAX_CARD_FUNDING_FEE_BPS } from "../../../../shared/dropship/wallet-funding-fee";
import { DropshipError } from "../domain/errors";
import {
  resolveEffectiveAdvanceCapCents,
  type DropshipAdvanceCapSource,
  type DropshipVendorCreditProfile,
} from "../domain/vendor-credit";
import {
  DROPSHIP_WALLET_POLICY_ENV_KEYS,
  MAX_ADVANCE_FEE_BPS,
  MAX_PAYMENT_HOLD_TIMEOUT_MINUTES,
  MAX_TIER_CHANGE_GRACE_DAYS,
  resolveDropshipWalletPolicyLimitsFromEnv,
  walletPolicyInvariantViolations,
  type DropshipWalletPolicyLimits,
  type DropshipWalletPolicyResolver,
} from "../domain/wallet-policy";
import {
  resolveEnforcedListingTierMinimums,
  type DropshipEnforcedListingTierMinimums,
  type DropshipListingTierPolicyVersion,
} from "../domain/listing-tiers";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

/**
 * Dropship wallet policy service.
 *
 * Staff edit the wallet's limits here instead of through dyno config. A change
 * is a NEW VERSION of `dropship.dropship_wallet_policies` (migrations 0682,
 * 0683 and 0701); published rows are immutable, and exactly one row is active. Reads
 * fall back to the documented defaults when no row exists, so an empty
 * database (dev) or the window before the migration lands still serves a
 * wallet.
 *
 * Nothing here rewrites stored vendor configuration. Raising a minimum changes
 * what the wallet will ACCEPT on the next write; every saved auto-reload row
 * keeps working until its vendor next saves it. The impact report exists so
 * staff can see, before they save, how many vendors that will be.
 *
 * The service also owns the per-vendor CREDIT PROFILE: today an override of
 * the policy's pending-ACH advance cap, audited like every other operator
 * mutation, and resolved together with the policy into the cap that actually
 * applies to a vendor.
 */

const positiveCentsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const noteSchema = z.string().trim().min(1).max(1000).nullable().optional();
const actorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

/**
 * Boundary schema for a new policy version. Per-field range lives here; the
 * cross-field rules come from the domain so the Zod schema, the SQL CHECK
 * constraints and the unit tests all state the same thing once.
 */
export const createDropshipWalletPolicyVersionInputSchema = z.object({
  autoReloadMinTriggerCents: positiveCentsSchema,
  caseTierMinimumCents: positiveCentsSchema,
  autoReloadMinAmountCents: positiveCentsSchema,
  manualFundingMinCents: positiveCentsSchema,
  manualFundingMaxCents: positiveCentsSchema,
  defaultPaymentHoldTimeoutMinutes: z.number().int().min(1).max(MAX_PAYMENT_HOLD_TIMEOUT_MINUTES),
  holdExpiryWarningMinutes: z.number().int().min(1).max(MAX_PAYMENT_HOLD_TIMEOUT_MINUTES),
  advanceFeeBps: z.number().int().min(0).max(MAX_ADVANCE_FEE_BPS),
  advanceCapCents: nonNegativeCentsSchema,
  tierChangeGraceDays: z.number().int().min(0).max(MAX_TIER_CHANGE_GRACE_DAYS),
  // The card fee is bounded by the shared misconfiguration guard (10%), not a
  // business ceiling: zero is the policy since funding design phase 7.
  cardFundingFeeBps: z.number().int().min(0).max(MAX_CARD_FUNDING_FEE_BPS),
  cardFundingMinCents: positiveCentsSchema,
  changeNote: noteSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: actorSchema,
}).strict().superRefine((input, context) => {
  for (const violation of walletPolicyInvariantViolations(input)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [violation.field],
      message: violation.message,
    });
  }
});

export type CreateDropshipWalletPolicyVersionInput =
  z.infer<typeof createDropshipWalletPolicyVersionInputSchema>;

/** Proposed floors to measure the vendor population against. */
export const dropshipWalletPolicyImpactInputSchema = z.object({
  autoReloadMinTriggerCents: positiveCentsSchema.optional(),
  autoReloadMinAmountCents: positiveCentsSchema.optional(),
}).strict();

export type DropshipWalletPolicyImpactInput = z.infer<typeof dropshipWalletPolicyImpactInputSchema>;

/**
 * Boundary schema for setting a vendor's credit profile. `advanceCapOverrideCents`
 * null clears the override (the policy cap applies again); zero is an
 * override that advances nothing.
 */
export const setDropshipVendorCreditProfileInputSchema = z.object({
  vendorId: positiveIdSchema,
  advanceCapOverrideCents: nonNegativeCentsSchema.nullable(),
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: actorSchema,
}).strict();

export type SetDropshipVendorCreditProfileInput =
  z.infer<typeof setDropshipVendorCreditProfileInputSchema>;

export interface DropshipWalletPolicyActor {
  actorType: "admin" | "system";
  actorId: string | null;
}

export interface DropshipWalletPolicyRecord {
  policyId: number;
  version: number;
  limits: DropshipWalletPolicyLimits;
  isActive: boolean;
  changeNote: string | null;
  createdAt: Date;
  createdBy: DropshipWalletPolicyActor;
  deactivatedAt: Date | null;
}

/**
 * How many ALREADY-SAVED vendor auto-reload rows sit below a proposed floor.
 *
 * Counts are read-only and change nothing: enforcement stays on write
 * (`assertAutoReloadConfigIsUsable`), so these vendors keep their saved
 * settings and are only asked to raise them the next time they save.
 *
 * Scope: vendors whose lifecycle status is `active` and that have an
 * auto-reload settings row. A row with no single-reload cap (NULL) is NOT
 * counted as below the limit — an enabled row without a cap is already refused
 * for a different reason (`DROPSHIP_AUTO_RELOAD_AMOUNT_REQUIRED`), and raising
 * a floor neither creates nor fixes that.
 */
export interface DropshipWalletPolicyImpact {
  proposedAutoReloadMinTriggerCents: number;
  proposedAutoReloadMinAmountCents: number;
  vendorsBelowMinimumFloor: number;
  vendorsBelowMinimumSingleTopUpLimit: number;
  /** Denominator: active vendors that have an auto-reload settings row at all. */
  activeVendorsWithAutoReloadSettings: number;
  evaluatedAt: Date;
}

export interface DropshipWalletPolicyOverview {
  /** The active policy row, or null when the wallet is still on the fallback defaults. */
  policy: DropshipWalletPolicyRecord | null;
  /** The limits actually in force. */
  limits: DropshipWalletPolicyLimits;
  limitsSource: "policy" | "environment";
  /** What the fallback layer would serve — the values the policy row overrides. */
  envLimits: DropshipWalletPolicyLimits;
  /** Which environment variable backs each limit (null: no env override exists). */
  envKeys: typeof DROPSHIP_WALLET_POLICY_ENV_KEYS;
  impact: DropshipWalletPolicyImpact;
  /**
   * The listing tier minimums enforced right now and any raise still inside
   * its grace period, from the version history (see `listing-tiers.ts`).
   */
  listingTierEnforcement: DropshipEnforcedListingTierMinimums;
  generatedAt: Date;
}

export interface DropshipWalletPolicyMutationResult {
  policy: DropshipWalletPolicyRecord;
  /**
   * The row this version superseded, read inside the same transaction, so the
   * before -> after log line is not a stale read. Null on a first version and
   * on an idempotent replay (a replay changes nothing, so it has no "before").
   */
  previousPolicy: DropshipWalletPolicyRecord | null;
  idempotentReplay: boolean;
}

export interface CreateDropshipWalletPolicyVersionRepositoryInput {
  limits: DropshipWalletPolicyLimits;
  changeNote: string | null;
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
}

export interface DropshipWalletPolicyVendorImpactCounts {
  vendorsBelowMinimumFloor: number;
  vendorsBelowMinimumSingleTopUpLimit: number;
  activeVendorsWithAutoReloadSettings: number;
}

export interface DropshipWalletPolicyRepository {
  getActivePolicy(): Promise<DropshipWalletPolicyRecord | null>;
  /** Every published version, oldest first. */
  listPolicyVersions(): Promise<DropshipWalletPolicyRecord[]>;
  createPolicyVersion(
    input: CreateDropshipWalletPolicyVersionRepositoryInput,
  ): Promise<DropshipWalletPolicyMutationResult>;
  countVendorsBelowLimits(input: {
    autoReloadMinTriggerCents: number;
    autoReloadMinAmountCents: number;
  }): Promise<DropshipWalletPolicyVendorImpactCounts>;
}

export interface SetDropshipVendorCreditProfileRepositoryInput {
  vendorId: number;
  advanceCapOverrideCents: number | null;
  note: string | null;
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
}

export interface DropshipVendorCreditProfileMutationResult {
  profile: DropshipVendorCreditProfile;
  /** The row before this write, read in the same transaction; null when none existed or on a replay. */
  previousProfile: DropshipVendorCreditProfile | null;
  idempotentReplay: boolean;
}

export interface DropshipVendorCreditProfileRepository {
  getByVendorId(vendorId: number): Promise<DropshipVendorCreditProfile | null>;
  set(input: SetDropshipVendorCreditProfileRepositoryInput): Promise<DropshipVendorCreditProfileMutationResult>;
}

/** A vendor's credit profile next to the cap it resolves to. */
export interface DropshipVendorCreditProfileView {
  vendorId: number;
  profile: DropshipVendorCreditProfile | null;
  policyAdvanceCapCents: number;
  effectiveAdvanceCapCents: number;
  effectiveAdvanceCapSource: DropshipAdvanceCapSource;
  generatedAt: Date;
}

export type DropshipVendorCreditProfileSetResult =
  DropshipVendorCreditProfileMutationResult & Pick<
    DropshipVendorCreditProfileView,
    "policyAdvanceCapCents" | "effectiveAdvanceCapCents" | "effectiveAdvanceCapSource"
  >;

export class DropshipWalletPolicyService implements DropshipWalletPolicyResolver {
  constructor(
    private readonly deps: {
      repository: DropshipWalletPolicyRepository;
      creditProfiles: DropshipVendorCreditProfileRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
      /** Environment used for the fallback layer. Injected so reads are deterministic under test. */
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  /**
   * The limits in force: the active policy row, else the fallback defaults.
   * This is the single read the wallet and the hold-expiry sweeper use.
   */
  async resolveWalletLimits(): Promise<DropshipWalletPolicyLimits> {
    return (await this.resolveEffectiveLimits()).limits;
  }

  /** The active policy row, or null when none has been published. */
  async getActivePolicy(): Promise<DropshipWalletPolicyRecord | null> {
    return this.readActivePolicy();
  }

  /**
   * Everything the admin screen needs in one read: the active policy, the
   * fallback values it overrides, and the impact of a proposal (defaulting to
   * the limits already in force). The card fee is one of the limits since
   * funding design phase 7; it is no longer a read-only environment value.
   */
  async getOverview(proposal: unknown = {}): Promise<DropshipWalletPolicyOverview> {
    const parsed = parseWalletPolicyInput(dropshipWalletPolicyImpactInputSchema, proposal);
    const effective = await this.resolveEffectiveLimits();
    const impact = await this.measureImpact(effective.limits, parsed);
    const generatedAt = this.deps.clock.now();
    return {
      policy: effective.policy,
      limits: effective.limits,
      limitsSource: effective.policy ? "policy" : "environment",
      envLimits: this.envLimits(),
      envKeys: DROPSHIP_WALLET_POLICY_ENV_KEYS,
      impact,
      listingTierEnforcement: await this.resolveListingTierMinimums(generatedAt),
      generatedAt,
    };
  }

  /**
   * The listing tier minimums in force at `now`, with grace: a version that
   * raised a tier is enforced `tier_change_grace_days` after it was published,
   * a lowering immediately. Resolved from the whole immutable version history,
   * so the answer for a given instant never changes. With no published
   * version (unmigrated database, empty table) the environment fallback
   * behaves like a version published at the epoch: enforced, no grace.
   */
  async resolveListingTierMinimums(now: Date = this.deps.clock.now()): Promise<DropshipEnforcedListingTierMinimums> {
    const versions = await this.readPolicyVersions();
    const history: DropshipListingTierPolicyVersion[] = versions.length > 0
      ? versions.map((record) => ({
          version: record.version,
          packTierMinimumCents: record.limits.autoReloadMinTriggerCents,
          caseTierMinimumCents: record.limits.caseTierMinimumCents,
          tierChangeGraceDays: record.limits.tierChangeGraceDays,
          createdAt: record.createdAt,
        }))
      : [environmentFallbackTierVersion(this.envLimits())];
    return resolveEnforcedListingTierMinimums(history, now);
  }

  /**
   * How many active vendors a proposal would ask to change something. Omitted
   * fields fall back to the limits in force, so an empty proposal reports the
   * standing population against today's policy.
   */
  async getImpact(proposal: unknown = {}): Promise<DropshipWalletPolicyImpact> {
    const parsed = parseWalletPolicyInput(dropshipWalletPolicyImpactInputSchema, proposal);
    const effective = await this.resolveEffectiveLimits();
    return this.measureImpact(effective.limits, parsed);
  }

  /**
   * Publish a new version. The previous active row is retired in the SAME
   * transaction as the insert, the command row and the audit row, so a partial
   * failure cannot leave two active policies or an unattributed change.
   */
  async createPolicyVersion(input: unknown): Promise<DropshipWalletPolicyMutationResult> {
    const parsed = parseWalletPolicyInput(createDropshipWalletPolicyVersionInputSchema, input);
    const limits: DropshipWalletPolicyLimits = {
      autoReloadMinTriggerCents: parsed.autoReloadMinTriggerCents,
      caseTierMinimumCents: parsed.caseTierMinimumCents,
      autoReloadMinAmountCents: parsed.autoReloadMinAmountCents,
      manualFundingMinCents: parsed.manualFundingMinCents,
      manualFundingMaxCents: parsed.manualFundingMaxCents,
      defaultPaymentHoldTimeoutMinutes: parsed.defaultPaymentHoldTimeoutMinutes,
      holdExpiryWarningMinutes: parsed.holdExpiryWarningMinutes,
      advanceFeeBps: parsed.advanceFeeBps,
      advanceCapCents: parsed.advanceCapCents,
      tierChangeGraceDays: parsed.tierChangeGraceDays,
      cardFundingFeeBps: parsed.cardFundingFeeBps,
      cardFundingMinCents: parsed.cardFundingMinCents,
    };
    const changeNote = parsed.changeNote ?? null;
    const now = this.deps.clock.now();
    const result = await this.deps.repository.createPolicyVersion({
      limits,
      changeNote,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: hashWalletPolicyRequest({ limits, changeNote }),
      actor: parsed.actor,
      now,
    });

    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_WALLET_POLICY_VERSION_REPLAYED"
        : "DROPSHIP_WALLET_POLICY_VERSION_PUBLISHED",
      message: "Dropship wallet policy version command completed.",
      context: {
        policyId: result.policy.policyId,
        version: result.policy.version,
        idempotentReplay: result.idempotentReplay,
        actorType: parsed.actor.actorType,
        actorId: parsed.actor.actorId ?? null,
        changeNote,
        before: result.previousPolicy
          ? { policyId: result.previousPolicy.policyId, version: result.previousPolicy.version, ...result.previousPolicy.limits }
          : null,
        after: { policyId: result.policy.policyId, version: result.policy.version, ...result.policy.limits },
      },
    });
    return result;
  }

  /** A vendor's credit profile (null when none was ever set) and the advance cap it resolves to. */
  async getVendorCreditProfile(vendorId: unknown): Promise<DropshipVendorCreditProfileView> {
    const parsedVendorId = parseVendorCreditProfileInput(positiveIdSchema, vendorId);
    const [profile, limits] = await Promise.all([
      this.readCreditProfile(parsedVendorId),
      this.resolveWalletLimits(),
    ]);
    return this.creditProfileView(parsedVendorId, profile, limits);
  }

  /**
   * The advance cap that applies to a vendor right now: their override when
   * one is set, otherwise the policy cap. This is the read the acceptance
   * waterfall uses; it tolerates a missing profile table the same way the
   * wallet tolerates a missing policy table.
   */
  async resolveAdvanceCapForVendor(vendorId: number): Promise<{
    advanceCapCents: number;
    source: DropshipAdvanceCapSource;
  }> {
    const parsedVendorId = parseVendorCreditProfileInput(positiveIdSchema, vendorId);
    const [profile, limits] = await Promise.all([
      this.readCreditProfile(parsedVendorId),
      this.resolveWalletLimits(),
    ]);
    return resolveEffectiveAdvanceCapCents({ policyAdvanceCapCents: limits.advanceCapCents, profile });
  }

  /**
   * Set (or clear) a vendor's advance-cap override. Idempotent per attempt
   * through the admin config command ledger; the audit row carries the real
   * staff actor and the before -> after values.
   */
  async setVendorCreditProfile(input: unknown): Promise<DropshipVendorCreditProfileSetResult> {
    const parsed = parseVendorCreditProfileInput(setDropshipVendorCreditProfileInputSchema, input);
    const note = parsed.note ?? null;
    const now = this.deps.clock.now();
    const result = await this.deps.creditProfiles.set({
      vendorId: parsed.vendorId,
      advanceCapOverrideCents: parsed.advanceCapOverrideCents,
      note,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: hashVendorCreditProfileRequest({
        vendorId: parsed.vendorId,
        advanceCapOverrideCents: parsed.advanceCapOverrideCents,
        note,
      }),
      actor: parsed.actor,
      now,
    });
    const limits = await this.resolveWalletLimits();
    const effective = resolveEffectiveAdvanceCapCents({
      policyAdvanceCapCents: limits.advanceCapCents,
      profile: result.profile,
    });

    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_VENDOR_CREDIT_PROFILE_REPLAYED"
        : "DROPSHIP_VENDOR_CREDIT_PROFILE_SET",
      message: "Dropship vendor credit profile command completed.",
      context: {
        vendorId: parsed.vendorId,
        idempotentReplay: result.idempotentReplay,
        actorType: parsed.actor.actorType,
        actorId: parsed.actor.actorId ?? null,
        note,
        before: result.previousProfile
          ? { advanceCapOverrideCents: result.previousProfile.advanceCapOverrideCents, note: result.previousProfile.note }
          : null,
        after: { advanceCapOverrideCents: result.profile.advanceCapOverrideCents, note: result.profile.note },
        effectiveAdvanceCapCents: effective.advanceCapCents,
        effectiveAdvanceCapSource: effective.source,
      },
    });
    return {
      ...result,
      policyAdvanceCapCents: limits.advanceCapCents,
      effectiveAdvanceCapCents: effective.advanceCapCents,
      effectiveAdvanceCapSource: effective.source,
    };
  }

  private creditProfileView(
    vendorId: number,
    profile: DropshipVendorCreditProfile | null,
    limits: DropshipWalletPolicyLimits,
  ): DropshipVendorCreditProfileView {
    const effective = resolveEffectiveAdvanceCapCents({ policyAdvanceCapCents: limits.advanceCapCents, profile });
    return {
      vendorId,
      profile,
      policyAdvanceCapCents: limits.advanceCapCents,
      effectiveAdvanceCapCents: effective.advanceCapCents,
      effectiveAdvanceCapSource: effective.source,
      generatedAt: this.deps.clock.now(),
    };
  }

  private async measureImpact(
    effectiveLimits: DropshipWalletPolicyLimits,
    proposal: DropshipWalletPolicyImpactInput,
  ): Promise<DropshipWalletPolicyImpact> {
    const proposed = {
      autoReloadMinTriggerCents: proposal.autoReloadMinTriggerCents ?? effectiveLimits.autoReloadMinTriggerCents,
      autoReloadMinAmountCents: proposal.autoReloadMinAmountCents ?? effectiveLimits.autoReloadMinAmountCents,
    };
    const counts = await this.deps.repository.countVendorsBelowLimits(proposed);
    return {
      proposedAutoReloadMinTriggerCents: proposed.autoReloadMinTriggerCents,
      proposedAutoReloadMinAmountCents: proposed.autoReloadMinAmountCents,
      vendorsBelowMinimumFloor: counts.vendorsBelowMinimumFloor,
      vendorsBelowMinimumSingleTopUpLimit: counts.vendorsBelowMinimumSingleTopUpLimit,
      activeVendorsWithAutoReloadSettings: counts.activeVendorsWithAutoReloadSettings,
      evaluatedAt: this.deps.clock.now(),
    };
  }

  private async resolveEffectiveLimits(): Promise<{
    policy: DropshipWalletPolicyRecord | null;
    limits: DropshipWalletPolicyLimits;
  }> {
    const policy = await this.readActivePolicy();
    return { policy, limits: policy ? policy.limits : this.envLimits() };
  }

  /**
   * Reads the active row, tolerating exactly one failure: the table not
   * existing yet. An unmigrated database (dev, or a dyno that booted ahead of
   * the release-phase migration) must fall back to the documented defaults
   * rather than take the vendor wallet page down. The fallback is announced at
   * WARN — it is an anomaly that recovered, not a silent swallow — and every
   * other failure propagates.
   */
  private async readActivePolicy(): Promise<DropshipWalletPolicyRecord | null> {
    try {
      return await this.deps.repository.getActivePolicy();
    } catch (error) {
      if (error instanceof DropshipError && error.code === "DROPSHIP_WALLET_POLICY_TABLE_MISSING") {
        this.deps.logger.warn({
          code: "DROPSHIP_WALLET_POLICY_ENV_FALLBACK",
          message: "Dropship wallet policy table is missing; falling back to the environment limits.",
          context: { classification: "transient", errorCode: error.code },
        });
        return null;
      }
      throw error;
    }
  }

  /** Same tolerance as the active-row read: a missing table means "no history", at WARN. */
  private async readPolicyVersions(): Promise<DropshipWalletPolicyRecord[]> {
    try {
      return await this.deps.repository.listPolicyVersions();
    } catch (error) {
      if (error instanceof DropshipError && error.code === "DROPSHIP_WALLET_POLICY_TABLE_MISSING") {
        this.deps.logger.warn({
          code: "DROPSHIP_WALLET_POLICY_ENV_FALLBACK",
          message: "Dropship wallet policy table is missing; listing tier minimums fall back to the environment limits.",
          context: { classification: "transient", errorCode: error.code },
        });
        return [];
      }
      throw error;
    }
  }

  /** Same tolerance as the policy read: a missing profile table means "no override", at WARN. */
  private async readCreditProfile(vendorId: number): Promise<DropshipVendorCreditProfile | null> {
    try {
      return await this.deps.creditProfiles.getByVendorId(vendorId);
    } catch (error) {
      if (error instanceof DropshipError && error.code === "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_MISSING") {
        this.deps.logger.warn({
          code: "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_FALLBACK",
          message: "Dropship vendor credit profile table is missing; the policy advance cap applies.",
          context: { classification: "transient", errorCode: error.code, vendorId },
        });
        return null;
      }
      throw error;
    }
  }

  private envLimits(): DropshipWalletPolicyLimits {
    return resolveDropshipWalletPolicyLimitsFromEnv(this.deps.env);
  }
}

/** Stable request fingerprint: the same proposal under the same key is a replay. */
export function hashWalletPolicyRequest(value: {
  limits: DropshipWalletPolicyLimits;
  changeNote: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    command: "wallet_policy_version_created",
    limits: {
      autoReloadMinTriggerCents: value.limits.autoReloadMinTriggerCents,
      caseTierMinimumCents: value.limits.caseTierMinimumCents,
      autoReloadMinAmountCents: value.limits.autoReloadMinAmountCents,
      manualFundingMinCents: value.limits.manualFundingMinCents,
      manualFundingMaxCents: value.limits.manualFundingMaxCents,
      defaultPaymentHoldTimeoutMinutes: value.limits.defaultPaymentHoldTimeoutMinutes,
      holdExpiryWarningMinutes: value.limits.holdExpiryWarningMinutes,
      advanceFeeBps: value.limits.advanceFeeBps,
      advanceCapCents: value.limits.advanceCapCents,
      tierChangeGraceDays: value.limits.tierChangeGraceDays,
      cardFundingFeeBps: value.limits.cardFundingFeeBps,
      cardFundingMinCents: value.limits.cardFundingMinCents,
    },
    changeNote: value.changeNote,
  })).digest("hex");
}

/** Stable fingerprint of a credit profile write, for the same replay rule. */
export function hashVendorCreditProfileRequest(value: {
  vendorId: number;
  advanceCapOverrideCents: number | null;
  note: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    command: "vendor_credit_profile_set",
    vendorId: value.vendorId,
    advanceCapOverrideCents: value.advanceCapOverrideCents,
    note: value.note,
  })).digest("hex");
}

function parseWalletPolicyInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  return parseOrThrow(schema, input, "DROPSHIP_WALLET_POLICY_INVALID_INPUT", "Dropship wallet policy input failed validation.");
}

function parseVendorCreditProfileInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  return parseOrThrow(
    schema,
    input,
    "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT",
    "Dropship vendor credit profile input failed validation.",
  );
}

function parseOrThrow<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  code: string,
  message: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(code, message, {
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

/**
 * The fallback limits as a policy version: version 1, published at the epoch,
 * so it is enforced from the start and nothing is in grace.
 */
function environmentFallbackTierVersion(limits: DropshipWalletPolicyLimits): DropshipListingTierPolicyVersion {
  return {
    version: 1,
    packTierMinimumCents: limits.autoReloadMinTriggerCents,
    caseTierMinimumCents: limits.caseTierMinimumCents,
    tierChangeGraceDays: limits.tierChangeGraceDays,
    createdAt: new Date(0),
  };
}

export function makeDropshipWalletPolicyLogger(): DropshipLogger {
  return {
    info: (event) => logWalletPolicyEvent("info", event),
    warn: (event) => logWalletPolicyEvent("warn", event),
    error: (event) => logWalletPolicyEvent("error", event),
  };
}

export const systemDropshipWalletPolicyClock: DropshipClock = {
  now: () => new Date(),
};

function logWalletPolicyEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}

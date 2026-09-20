/**
 * Dropship wallet policy — the pure model behind the staff "Wallet policy" tab.
 *
 * Everything the tab decides lives here: how a dollar or percent box becomes
 * an integer, which cross-field rules reject a form BEFORE it reaches
 * `POST /api/dropship/admin/wallet/policy`, whether the form still matches the
 * limits in force, what the request body looks like, and what a server error
 * code means to a human. The panel renders; it does not decide.
 *
 * The cross-field rules and their exact messages mirror
 * `server/modules/dropship/domain/wallet-policy.ts`
 * (`walletPolicyInvariantViolations`) and the CHECK constraints in migrations
 * 0682 and 0683, so staff read the same sentence client-side that the server
 * would send back. The client is a convenience, never the authority: the
 * server re-checks every rule.
 *
 * Money is integer cents throughout — no floating point anywhere in this file.
 * Fees are basis points. Timings are whole minutes or whole days.
 */

import { z } from "zod";

/** The one admin route this surface talks to (GET overview, POST new version). */
export const DROPSHIP_WALLET_POLICY_ADMIN_URL = "/api/dropship/admin/wallet/policy";

/** Prefix for the per-save idempotency key, so the audit trail names the surface. */
export const DROPSHIP_WALLET_POLICY_IDEMPOTENCY_PREFIX = "dropship-wallet-policy";

/**
 * 30 days. Mirrors MAX_PAYMENT_HOLD_TIMEOUT_MINUTES in the server domain and
 * `dropship_wallet_policies_hold_timeout_chk`. Duplicated rather than imported
 * because the client must not import server code; the unit test pins the value.
 */
export const DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES = 43_200;

/** 100%. Mirrors MAX_ADVANCE_FEE_BPS and `dropship_wallet_policies_advance_fee_chk`. */
export const DROPSHIP_WALLET_POLICY_MAX_ADVANCE_FEE_BPS = 10_000;

/** A year. Mirrors MAX_TIER_CHANGE_GRACE_DAYS and `dropship_wallet_policies_grace_days_chk`. */
export const DROPSHIP_WALLET_POLICY_MAX_TIER_CHANGE_GRACE_DAYS = 365;

/** The server bound on every cents field (`positiveCentsSchema`). */
const MAX_CENTS = Number.MAX_SAFE_INTEGER;

/** `changeNote` is `z.string().trim().min(1).max(1000).nullable().optional()`. */
const MAX_CHANGE_NOTE_LENGTH = 1_000;

/** The server's idempotency key bounds (`idempotencyKeySchema`). */
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

// --- Response contracts -----------------------------------------------------

const walletPolicyLimitsSchema = z.object({
  autoReloadMinTriggerCents: z.number().int(),
  caseTierMinimumCents: z.number().int(),
  autoReloadMinAmountCents: z.number().int(),
  manualFundingMinCents: z.number().int(),
  manualFundingMaxCents: z.number().int(),
  defaultPaymentHoldTimeoutMinutes: z.number().int(),
  holdExpiryWarningMinutes: z.number().int(),
  advanceFeeBps: z.number().int(),
  advanceCapCents: z.number().int(),
  tierChangeGraceDays: z.number().int(),
});

const walletPolicyRecordSchema = z.object({
  policyId: z.number().int(),
  version: z.number().int(),
  limits: walletPolicyLimitsSchema,
  isActive: z.boolean(),
  changeNote: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().nullable(),
  }),
  deactivatedAt: z.string().nullable(),
});

const walletPolicyImpactSchema = z.object({
  proposedAutoReloadMinTriggerCents: z.number().int(),
  proposedAutoReloadMinAmountCents: z.number().int(),
  vendorsBelowMinimumFloor: z.number().int(),
  vendorsBelowMinimumSingleTopUpLimit: z.number().int(),
  activeVendorsWithAutoReloadSettings: z.number().int(),
  evaluatedAt: z.string(),
});

/**
 * `editable` is typed as a boolean rather than the literal `false` the server
 * serves today: this surface never renders an input for the fee, so a future
 * server that flipped the flag must not take the whole page down over a
 * display-only field.
 */
const walletPolicyCardFeeSchema = z.object({
  bps: z.number().int(),
  envKey: z.string(),
  editable: z.boolean(),
  readOnlyReason: z.string(),
});

const walletPolicyEnvKeysSchema = z.object({
  autoReloadMinTriggerCents: z.string().nullable(),
  caseTierMinimumCents: z.string().nullable(),
  autoReloadMinAmountCents: z.string().nullable(),
  manualFundingMinCents: z.string().nullable(),
  manualFundingMaxCents: z.string().nullable(),
  // The hold timeout, the case tier, the advance and the grace have no
  // environment override; the server serves null for each.
  defaultPaymentHoldTimeoutMinutes: z.string().nullable(),
  holdExpiryWarningMinutes: z.string().nullable(),
  advanceFeeBps: z.string().nullable(),
  advanceCapCents: z.string().nullable(),
  tierChangeGraceDays: z.string().nullable(),
});

/**
 * What a listing tier enforces right now and, when a raise is still inside its
 * grace period, what it will enforce and from when. Read-only evidence from
 * the version history; publishing a version is what changes it.
 */
const walletPolicyTierEnforcementSchema = z.object({
  tier: z.enum(["pack", "case"]),
  minimumCents: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  upcoming: z.object({
    minimumCents: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    enforcesAt: z.string(),
  }).nullable(),
});

export const dropshipWalletPolicyOverviewSchema = z.object({
  policy: walletPolicyRecordSchema.nullable(),
  limits: walletPolicyLimitsSchema,
  limitsSource: z.enum(["policy", "environment"]),
  envLimits: walletPolicyLimitsSchema,
  envKeys: walletPolicyEnvKeysSchema,
  cardFundingFee: walletPolicyCardFeeSchema,
  impact: walletPolicyImpactSchema,
  /** Absent from a server one release behind; the panel then shows no enforcement line. */
  listingTierEnforcement: z.object({
    pack: walletPolicyTierEnforcementSchema,
    case: walletPolicyTierEnforcementSchema,
  }).optional(),
  generatedAt: z.string(),
});

export type DropshipWalletPolicyTierEnforcement = z.infer<typeof walletPolicyTierEnforcementSchema>;

/**
 * One line per tier for the staff screen: the minimum enforced today and, if
 * a raise is still in grace, the number and date it lands. Dollars only; the
 * cents of a tier minimum are always zero in practice but are kept exact.
 */
export function describeDropshipWalletPolicyTierEnforcement(
  enforcement: DropshipWalletPolicyTierEnforcement,
  formatMoney: (cents: number) => string,
  formatDate: (iso: string) => string,
): string {
  const label = enforcement.tier === "case" ? "Case tier" : "Pack tier";
  const now = `${label}: ${formatMoney(enforcement.minimumCents)} enforced now (version ${enforcement.version})`;
  if (!enforcement.upcoming) return now;
  return `${now}; rises to ${formatMoney(enforcement.upcoming.minimumCents)} on ${formatDate(enforcement.upcoming.enforcesAt)} (version ${enforcement.upcoming.version}, grace running)`;
}

export const dropshipWalletPolicyMutationSchema = z.object({
  policy: walletPolicyRecordSchema,
  previousPolicy: walletPolicyRecordSchema.nullable(),
  idempotentReplay: z.boolean(),
});

export type DropshipWalletPolicyLimitsView = z.infer<typeof walletPolicyLimitsSchema>;
export type DropshipWalletPolicyRecordView = z.infer<typeof walletPolicyRecordSchema>;
export type DropshipWalletPolicyImpactView = z.infer<typeof walletPolicyImpactSchema>;
export type DropshipWalletPolicyCardFeeView = z.infer<typeof walletPolicyCardFeeSchema>;
export type DropshipWalletPolicyEnvKeysView = z.infer<typeof walletPolicyEnvKeysSchema>;
export type DropshipWalletPolicyOverview = z.infer<typeof dropshipWalletPolicyOverviewSchema>;
export type DropshipWalletPolicyMutation = z.infer<typeof dropshipWalletPolicyMutationSchema>;

/** Validates a GET payload. A shape the page cannot trust is an error, not a guess. */
export function parseDropshipWalletPolicyOverview(value: unknown): DropshipWalletPolicyOverview {
  return parseResponse(dropshipWalletPolicyOverviewSchema, value, "wallet policy");
}

/** Validates a POST payload (201 create and 200 idempotent replay share the shape). */
export function parseDropshipWalletPolicyMutation(value: unknown): DropshipWalletPolicyMutation {
  return parseResponse(dropshipWalletPolicyMutationSchema, value, "wallet policy save");
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(
    `The ${subject} response was not in the expected shape at `
    + `${issue?.path.join(".") || "response"}: ${issue?.message ?? "invalid response"}.`,
  );
}

// --- Request URLs -----------------------------------------------------------

/**
 * The overview URL, optionally carrying the candidate minimums the server
 * should measure the vendor population against. Omitted values make the server
 * measure the limits already in force.
 */
export function buildDropshipWalletPolicyOverviewUrl(proposal?: {
  autoReloadMinTriggerCents?: number;
  autoReloadMinAmountCents?: number;
} | null): string {
  const parameters = new URLSearchParams();
  if (isPositiveInteger(proposal?.autoReloadMinTriggerCents)) {
    parameters.set(
      "proposedAutoReloadMinTriggerCents",
      String(proposal?.autoReloadMinTriggerCents),
    );
  }
  if (isPositiveInteger(proposal?.autoReloadMinAmountCents)) {
    parameters.set(
      "proposedAutoReloadMinAmountCents",
      String(proposal?.autoReloadMinAmountCents),
    );
  }
  const query = parameters.toString();
  return query
    ? `${DROPSHIP_WALLET_POLICY_ADMIN_URL}?${query}`
    : DROPSHIP_WALLET_POLICY_ADMIN_URL;
}

// --- Form shape -------------------------------------------------------------

export interface DropshipWalletPolicyForm {
  /** Dollars as typed; converted to integer cents on parse. */
  autoReloadMinTriggerDollars: string;
  caseTierMinimumDollars: string;
  autoReloadMinAmountDollars: string;
  manualFundingMinDollars: string;
  manualFundingMaxDollars: string;
  /** Whole minutes as typed. */
  defaultPaymentHoldTimeoutMinutes: string;
  holdExpiryWarningMinutes: string;
  /** Percent as typed ("1.5"); converted to integer basis points on parse. */
  advanceFeePercent: string;
  advanceCapDollars: string;
  /** Whole days as typed. */
  tierChangeGraceDays: string;
  /** Optional operator note recorded with the new version. */
  changeNote: string;
}

export type DropshipWalletPolicyFormField = keyof DropshipWalletPolicyForm;

export type DropshipWalletPolicyLimitField = keyof DropshipWalletPolicyLimitsView;

export type DropshipWalletPolicyLimitUnit = "cents" | "minutes" | "bps" | "days";

export interface DropshipWalletPolicyLimitDescriptor {
  limitField: DropshipWalletPolicyLimitField;
  formField: DropshipWalletPolicyFormField;
  label: string;
  unit: DropshipWalletPolicyLimitUnit;
  /** Whether zero is a legitimate value (an advance cap of zero advances nothing). */
  allowZero: boolean;
  help: string;
}

/**
 * The ten limits in display order, with the form field each one edits. The
 * panel walks this list instead of hard-coding ten rows twice (form + "where
 * the value came from" table).
 */
export const DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS: readonly DropshipWalletPolicyLimitDescriptor[] = [
  {
    limitField: "autoReloadMinTriggerCents",
    formField: "autoReloadMinTriggerDollars",
    label: "Pack tier minimum",
    unit: "cents",
    allowZero: false,
    help: "The lowest minimum balance any vendor may keep; applies to vendors selling eaches and inner packs. Auto-reload fires below a vendor's minimum.",
  },
  {
    limitField: "caseTierMinimumCents",
    formField: "caseTierMinimumDollars",
    label: "Case tier minimum",
    unit: "cents",
    allowZero: false,
    help: "Vendors with case listings enabled must keep at least this. Never below the pack tier minimum.",
  },
  {
    limitField: "autoReloadMinAmountCents",
    formField: "autoReloadMinAmountDollars",
    label: "Minimum single top-up limit",
    unit: "cents",
    allowZero: false,
    help: "Smallest permitted single auto-reload top-up. Never below the pack tier minimum, or a top-up could not clear the trigger.",
  },
  {
    limitField: "manualFundingMinCents",
    formField: "manualFundingMinDollars",
    label: "Manual top-up minimum",
    unit: "cents",
    allowZero: false,
    help: "Smallest vendor-initiated manual top-up.",
  },
  {
    limitField: "manualFundingMaxCents",
    formField: "manualFundingMaxDollars",
    label: "Manual top-up maximum",
    unit: "cents",
    allowZero: false,
    help: "Largest vendor-initiated manual top-up.",
  },
  {
    limitField: "defaultPaymentHoldTimeoutMinutes",
    formField: "defaultPaymentHoldTimeoutMinutes",
    label: "Payment hold timeout",
    unit: "minutes",
    allowZero: false,
    help: "How long an unfunded order waits in payment hold before it is cancelled. Applies to every wallet; vendors do not choose it.",
  },
  {
    limitField: "holdExpiryWarningMinutes",
    formField: "holdExpiryWarningMinutes",
    label: "Hold expiry warning",
    unit: "minutes",
    allowZero: false,
    help: "How long before a hold expires the vendor is warned. Must be shorter than the timeout.",
  },
  {
    limitField: "advanceFeeBps",
    formField: "advanceFeePercent",
    label: "Advance fee",
    unit: "bps",
    allowZero: true,
    help: "Service fee on the pending bank money an order is accepted against, charged only on the amount used.",
  },
  {
    limitField: "advanceCapCents",
    formField: "advanceCapDollars",
    label: "Advance cap",
    unit: "cents",
    allowZero: true,
    help: "The most pending bank money an order may be accepted against, per vendor. Zero advances nothing. A vendor's credit profile can override it.",
  },
  {
    limitField: "tierChangeGraceDays",
    formField: "tierChangeGraceDays",
    label: "Tier change grace",
    unit: "days",
    allowZero: true,
    help: "How long a vendor below a raised tier minimum keeps that tier's listings before they are unpublished. Zero enforces immediately.",
  },
];

const FORM_FIELD_BY_LIMIT_FIELD: Record<
  DropshipWalletPolicyLimitField,
  DropshipWalletPolicyFormField
> = {
  autoReloadMinTriggerCents: "autoReloadMinTriggerDollars",
  caseTierMinimumCents: "caseTierMinimumDollars",
  autoReloadMinAmountCents: "autoReloadMinAmountDollars",
  manualFundingMinCents: "manualFundingMinDollars",
  manualFundingMaxCents: "manualFundingMaxDollars",
  defaultPaymentHoldTimeoutMinutes: "defaultPaymentHoldTimeoutMinutes",
  holdExpiryWarningMinutes: "holdExpiryWarningMinutes",
  advanceFeeBps: "advanceFeePercent",
  advanceCapCents: "advanceCapDollars",
  tierChangeGraceDays: "tierChangeGraceDays",
};

/** A blank form, used before the overview has loaded. Never submitted. */
export const emptyDropshipWalletPolicyForm: DropshipWalletPolicyForm = Object.freeze({
  autoReloadMinTriggerDollars: "",
  caseTierMinimumDollars: "",
  autoReloadMinAmountDollars: "",
  manualFundingMinDollars: "",
  manualFundingMaxDollars: "",
  defaultPaymentHoldTimeoutMinutes: "",
  holdExpiryWarningMinutes: "",
  advanceFeePercent: "",
  advanceCapDollars: "",
  tierChangeGraceDays: "",
  changeNote: "",
});

/** The form that represents the limits in force. The save baseline. */
export function dropshipWalletPolicyFormFromLimits(
  limits: DropshipWalletPolicyLimitsView,
): DropshipWalletPolicyForm {
  return {
    autoReloadMinTriggerDollars: centsToDollarInput(limits.autoReloadMinTriggerCents),
    caseTierMinimumDollars: centsToDollarInput(limits.caseTierMinimumCents),
    autoReloadMinAmountDollars: centsToDollarInput(limits.autoReloadMinAmountCents),
    manualFundingMinDollars: centsToDollarInput(limits.manualFundingMinCents),
    manualFundingMaxDollars: centsToDollarInput(limits.manualFundingMaxCents),
    defaultPaymentHoldTimeoutMinutes: String(limits.defaultPaymentHoldTimeoutMinutes),
    holdExpiryWarningMinutes: String(limits.holdExpiryWarningMinutes),
    advanceFeePercent: basisPointsToPercentInput(limits.advanceFeeBps),
    advanceCapDollars: centsToDollarInput(limits.advanceCapCents),
    tierChangeGraceDays: String(limits.tierChangeGraceDays),
    // A note describes THIS change, so it never carries over from the version in force.
    changeNote: "",
  };
}

/** Integer-cents -> "12.34". No floating point: the fraction is string-padded. */
export function centsToDollarInput(cents: number): string {
  return hundredthsToDecimalInput(cents);
}

/** Integer basis points -> "1.50" (percent). Same digit arithmetic as cents. */
export function basisPointsToPercentInput(bps: number): string {
  return hundredthsToDecimalInput(bps);
}

function hundredthsToDecimalInput(value: number): string {
  if (!Number.isSafeInteger(value)) return "";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const whole = Math.trunc(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

/** Basis points -> "2.90%". Integer math only; the fee is never re-computed here. */
export function formatDropshipBasisPoints(bps: number): string {
  if (!Number.isSafeInteger(bps)) return "unknown";
  return `${hundredthsToDecimalInput(bps)}%`;
}

// --- Cross-field rules ------------------------------------------------------

export interface DropshipWalletPolicyInvariantViolation {
  field: DropshipWalletPolicyLimitField;
  message: string;
}

/**
 * The cross-field rules, word for word from the server domain. Returns every
 * violation rather than the first, so staff fix one form instead of playing
 * whack-a-mole.
 */
export function dropshipWalletPolicyInvariantViolations(
  limits: DropshipWalletPolicyLimitsView,
): DropshipWalletPolicyInvariantViolation[] {
  const violations: DropshipWalletPolicyInvariantViolation[] = [];
  if (limits.manualFundingMinCents > limits.manualFundingMaxCents) {
    violations.push({
      field: "manualFundingMaxCents",
      message: "Manual top-up maximum must be at least the manual top-up minimum.",
    });
  }
  if (limits.autoReloadMinAmountCents < limits.autoReloadMinTriggerCents) {
    violations.push({
      field: "autoReloadMinAmountCents",
      message:
        "Minimum single top-up limit must be at least the minimum floor, otherwise a top-up can never clear the trigger.",
    });
  }
  if (limits.caseTierMinimumCents < limits.autoReloadMinTriggerCents) {
    violations.push({
      field: "caseTierMinimumCents",
      message: "Case tier minimum must be at least the pack tier minimum.",
    });
  }
  if (limits.holdExpiryWarningMinutes >= limits.defaultPaymentHoldTimeoutMinutes) {
    violations.push({
      field: "holdExpiryWarningMinutes",
      message: "Hold expiry warning window must be shorter than the payment hold timeout.",
    });
  }
  return violations;
}

// --- Parsing ----------------------------------------------------------------

export type DropshipWalletPolicyFormErrors = Partial<
  Record<DropshipWalletPolicyFormField, string>
>;

export type ParsedDropshipWalletPolicyForm =
  | { success: true; limits: DropshipWalletPolicyLimitsView; changeNote: string | null }
  | { success: false; errors: DropshipWalletPolicyFormErrors };

/**
 * Parses the whole form, reporting EVERY problem at once. Per-field ranges
 * first; the cross-field rules only run once all ten numbers are known, since
 * comparing a missing value to a present one says nothing useful.
 */
export function parseDropshipWalletPolicyForm(
  form: DropshipWalletPolicyForm,
): ParsedDropshipWalletPolicyForm {
  const errors: DropshipWalletPolicyFormErrors = {};

  const trigger = readDollars(form.autoReloadMinTriggerDollars, "Pack tier minimum", errors, "autoReloadMinTriggerDollars");
  const caseTier = readDollars(form.caseTierMinimumDollars, "Case tier minimum", errors, "caseTierMinimumDollars");
  const amount = readDollars(form.autoReloadMinAmountDollars, "Minimum single top-up limit", errors, "autoReloadMinAmountDollars");
  const manualMin = readDollars(form.manualFundingMinDollars, "Manual top-up minimum", errors, "manualFundingMinDollars");
  const manualMax = readDollars(form.manualFundingMaxDollars, "Manual top-up maximum", errors, "manualFundingMaxDollars");
  const holdTimeout = readMinutes(
    form.defaultPaymentHoldTimeoutMinutes,
    "Payment hold timeout",
    DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES,
    errors,
    "defaultPaymentHoldTimeoutMinutes",
  );
  const warning = readMinutes(
    form.holdExpiryWarningMinutes,
    "Hold expiry warning",
    DROPSHIP_WALLET_POLICY_MAX_HOLD_TIMEOUT_MINUTES,
    errors,
    "holdExpiryWarningMinutes",
  );
  const advanceFee = readPercent(form.advanceFeePercent, "Advance fee", errors, "advanceFeePercent");
  const advanceCap = readDollars(form.advanceCapDollars, "Advance cap", errors, "advanceCapDollars", { allowZero: true });
  const graceDays = readDays(form.tierChangeGraceDays, "Tier change grace", errors, "tierChangeGraceDays");

  const note = form.changeNote.trim();
  if (note.length > MAX_CHANGE_NOTE_LENGTH) {
    errors.changeNote = `Change note must be ${MAX_CHANGE_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  }

  if (
    trigger === null || caseTier === null || amount === null || manualMin === null || manualMax === null
    || holdTimeout === null || warning === null || advanceFee === null || advanceCap === null || graceDays === null
  ) {
    return { success: false, errors };
  }

  const limits: DropshipWalletPolicyLimitsView = {
    autoReloadMinTriggerCents: trigger,
    caseTierMinimumCents: caseTier,
    autoReloadMinAmountCents: amount,
    manualFundingMinCents: manualMin,
    manualFundingMaxCents: manualMax,
    defaultPaymentHoldTimeoutMinutes: holdTimeout,
    holdExpiryWarningMinutes: warning,
    advanceFeeBps: advanceFee,
    advanceCapCents: advanceCap,
    tierChangeGraceDays: graceDays,
  };
  for (const violation of dropshipWalletPolicyInvariantViolations(limits)) {
    const field = FORM_FIELD_BY_LIMIT_FIELD[violation.field];
    // Keep the first message on a field: a range error is more specific than a
    // relationship error and is the one that has to be fixed first.
    if (!errors[field]) errors[field] = violation.message;
  }
  if (Object.keys(errors).length > 0) return { success: false, errors };

  return { success: true, limits, changeNote: note ? note : null };
}

function readDollars(
  value: string,
  label: string,
  errors: DropshipWalletPolicyFormErrors,
  field: DropshipWalletPolicyFormField,
  options: { allowZero?: boolean } = {},
): number | null {
  const parsed = parseDollarsToCents(value, options);
  if (parsed.ok) return parsed.cents;
  errors[field] = parsed.reason === "range"
    ? `${label} is larger than this system can record.`
    : options.allowZero
      ? `${label} must be a dollar amount of zero or more, with at most two decimal places.`
      : `${label} must be a dollar amount greater than zero, with at most two decimal places.`;
  return null;
}

function readMinutes(
  value: string,
  label: string,
  maximum: number,
  errors: DropshipWalletPolicyFormErrors,
  field: DropshipWalletPolicyFormField,
): number | null {
  const parsed = parseWholeMinutes(value, maximum);
  if (parsed.ok) return parsed.minutes;
  errors[field] = parsed.reason === "range"
    ? `${label} cannot exceed ${maximum.toLocaleString("en-US")} minutes (30 days).`
    : `${label} must be a whole number of minutes greater than zero.`;
  return null;
}

function readPercent(
  value: string,
  label: string,
  errors: DropshipWalletPolicyFormErrors,
  field: DropshipWalletPolicyFormField,
): number | null {
  const parsed = parsePercentToBasisPoints(value);
  if (parsed.ok) return parsed.bps;
  errors[field] = parsed.reason === "range"
    ? `${label} cannot exceed 100%.`
    : `${label} must be a percentage of zero or more, with at most two decimal places.`;
  return null;
}

function readDays(
  value: string,
  label: string,
  errors: DropshipWalletPolicyFormErrors,
  field: DropshipWalletPolicyFormField,
): number | null {
  const parsed = parseWholeDays(value, DROPSHIP_WALLET_POLICY_MAX_TIER_CHANGE_GRACE_DAYS);
  if (parsed.ok) return parsed.days;
  errors[field] = parsed.reason === "range"
    ? `${label} cannot exceed ${DROPSHIP_WALLET_POLICY_MAX_TIER_CHANGE_GRACE_DAYS} days.`
    : `${label} must be a whole number of days, zero or more.`;
  return null;
}

type ParsedDollars = { ok: true; cents: number } | { ok: false; reason: "format" | "range" };

/**
 * "12", "12.3", "12.34" -> 1200, 1230, 1234. The digits are concatenated and
 * read as one integer, so no value ever passes through a float (0.1 + 0.2
 * arithmetic cannot round a cent here).
 */
export function parseDollarsToCents(
  value: string,
  options: { allowZero?: boolean } = {},
): ParsedDollars {
  const parsed = parseHundredths(value);
  if (!parsed.ok) return parsed.reason === "range" ? { ok: false, reason: "range" } : { ok: false, reason: "format" };
  if (parsed.value > MAX_CENTS) return { ok: false, reason: "range" };
  // The server requires a positive amount for most limits; "0" and "0.00" are
  // a format error to the operator, not a range error, because the fix is to
  // type a real amount. A cap may be zero: that is "advance nothing".
  if (parsed.value <= 0 && !options.allowZero) return { ok: false, reason: "format" };
  return { ok: true, cents: parsed.value };
}

type ParsedPercent = { ok: true; bps: number } | { ok: false; reason: "format" | "range" };

/** "1", "1.5", "1.25" -> 100, 150, 125 basis points. Zero is allowed; above 100% is a range error. */
export function parsePercentToBasisPoints(value: string): ParsedPercent {
  const parsed = parseHundredths(value);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.value > DROPSHIP_WALLET_POLICY_MAX_ADVANCE_FEE_BPS) return { ok: false, reason: "range" };
  return { ok: true, bps: parsed.value };
}

type ParsedHundredths = { ok: true; value: number } | { ok: false; reason: "format" | "range" };

function parseHundredths(value: string): ParsedHundredths {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return { ok: false, reason: "format" };
  const whole = match[1] ?? "";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const parsed = Number(`${whole}${fraction}`);
  if (!Number.isSafeInteger(parsed)) return { ok: false, reason: "range" };
  return { ok: true, value: parsed };
}

type ParsedMinutes = { ok: true; minutes: number } | { ok: false; reason: "format" | "range" };

export function parseWholeMinutes(value: string, maximum: number): ParsedMinutes {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return { ok: false, reason: "format" };
  const minutes = Number(normalized);
  if (!Number.isSafeInteger(minutes)) return { ok: false, reason: "range" };
  if (minutes <= 0) return { ok: false, reason: "format" };
  if (minutes > maximum) return { ok: false, reason: "range" };
  return { ok: true, minutes };
}

type ParsedDays = { ok: true; days: number } | { ok: false; reason: "format" | "range" };

/** Whole days, zero allowed (a grace of zero enforces a raised tier immediately). */
export function parseWholeDays(value: string, maximum: number): ParsedDays {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return { ok: false, reason: "format" };
  const days = Number(normalized);
  if (!Number.isSafeInteger(days)) return { ok: false, reason: "range" };
  if (days > maximum) return { ok: false, reason: "range" };
  return { ok: true, days };
}

// --- Dirty check ------------------------------------------------------------

/**
 * Has the operator changed a limit? A note alone is not a change: a version
 * records limits, so publishing one with identical numbers would be a no-op
 * row. An unparseable field counts as changed — it is an edit in progress, and
 * a form that cannot be read certainly does not match what is in force.
 */
export function isDropshipWalletPolicyFormDirty(
  form: DropshipWalletPolicyForm,
  limits: DropshipWalletPolicyLimitsView,
): boolean {
  const parsed = parseDropshipWalletPolicyForm(form);
  if (!parsed.success) return true;
  return DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.some(
    (descriptor) => parsed.limits[descriptor.limitField] !== limits[descriptor.limitField],
  );
}

/** Stable identity of a set of limits, for resetting the form when they move. */
export function dropshipWalletPolicyLimitsKey(
  limits: DropshipWalletPolicyLimitsView,
): string {
  return DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS
    .map((descriptor) => `${descriptor.limitField}=${limits[descriptor.limitField]}`)
    .join("|");
}

// --- Impact proposal --------------------------------------------------------

export interface DropshipWalletPolicyProposedMinimums {
  autoReloadMinTriggerCents: number;
  autoReloadMinAmountCents: number;
}

/**
 * The candidate minimums to re-measure the vendor population against, or null
 * when the form still asks for exactly what is in force (the overview already
 * carries that measurement, so there is nothing to re-query).
 *
 * A field that does not parse falls back to the value in force rather than
 * blocking the count: staff mid-keystroke on one box still get a truthful
 * answer for the other.
 */
export function dropshipWalletPolicyProposedMinimums(
  form: DropshipWalletPolicyForm,
  limits: DropshipWalletPolicyLimitsView,
): DropshipWalletPolicyProposedMinimums | null {
  const trigger = parseDollarsToCents(form.autoReloadMinTriggerDollars);
  const amount = parseDollarsToCents(form.autoReloadMinAmountDollars);
  const proposed: DropshipWalletPolicyProposedMinimums = {
    autoReloadMinTriggerCents: trigger.ok ? trigger.cents : limits.autoReloadMinTriggerCents,
    autoReloadMinAmountCents: amount.ok ? amount.cents : limits.autoReloadMinAmountCents,
  };
  const unchanged =
    proposed.autoReloadMinTriggerCents === limits.autoReloadMinTriggerCents
    && proposed.autoReloadMinAmountCents === limits.autoReloadMinAmountCents;
  return unchanged ? null : proposed;
}

// --- Request body -----------------------------------------------------------

/**
 * Exactly the keys `createDropshipWalletPolicyVersionInputSchema` accepts. That
 * schema is `.strict()` and the route spreads the body before adding the actor,
 * so an extra key here is a 400, not a harmless field.
 */
export interface DropshipWalletPolicyVersionRequest {
  autoReloadMinTriggerCents: number;
  caseTierMinimumCents: number;
  autoReloadMinAmountCents: number;
  manualFundingMinCents: number;
  manualFundingMaxCents: number;
  defaultPaymentHoldTimeoutMinutes: number;
  holdExpiryWarningMinutes: number;
  advanceFeeBps: number;
  advanceCapCents: number;
  tierChangeGraceDays: number;
  changeNote: string | null;
  idempotencyKey: string;
}

export function buildDropshipWalletPolicyVersionRequest(input: {
  limits: DropshipWalletPolicyLimitsView;
  changeNote: string | null;
  idempotencyKey: string;
}): DropshipWalletPolicyVersionRequest {
  const violations = dropshipWalletPolicyInvariantViolations(input.limits);
  if (violations.length > 0) {
    throw new Error(violations.map((violation) => violation.message).join(" "));
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH
    || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new Error(
      `Idempotency key must be between ${MIN_IDEMPOTENCY_KEY_LENGTH} and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  const changeNote = input.changeNote?.trim() ?? "";
  if (changeNote.length > MAX_CHANGE_NOTE_LENGTH) {
    throw new Error(
      `Change note must be ${MAX_CHANGE_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    );
  }
  return {
    autoReloadMinTriggerCents: input.limits.autoReloadMinTriggerCents,
    caseTierMinimumCents: input.limits.caseTierMinimumCents,
    autoReloadMinAmountCents: input.limits.autoReloadMinAmountCents,
    manualFundingMinCents: input.limits.manualFundingMinCents,
    manualFundingMaxCents: input.limits.manualFundingMaxCents,
    defaultPaymentHoldTimeoutMinutes: input.limits.defaultPaymentHoldTimeoutMinutes,
    holdExpiryWarningMinutes: input.limits.holdExpiryWarningMinutes,
    advanceFeeBps: input.limits.advanceFeeBps,
    advanceCapCents: input.limits.advanceCapCents,
    tierChangeGraceDays: input.limits.tierChangeGraceDays,
    changeNote: changeNote ? changeNote : null,
    idempotencyKey,
  };
}

// --- Server faces -----------------------------------------------------------

/**
 * Turns a structured server code into something staff can act on. Anything not
 * listed keeps the server's own message: inventing a friendlier sentence for an
 * error nobody anticipated hides what actually happened.
 */
export function dropshipWalletPolicySaveErrorMessage(
  code: string | null,
  serverMessage: string,
): string {
  switch (code) {
    case "DROPSHIP_WALLET_POLICY_CONFLICT":
      return "Another wallet policy version was published while this form was open, so nothing was saved. "
        + "Reload the policy and re-apply the change on top of the new version.";
    case "DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT":
      return "This save key was already used for a different wallet policy, so nothing was saved. "
        + "Reload the policy to see what is in force, then save again.";
    case "DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE":
      return "An earlier save did not finish, so this one was not applied. "
        + "Reload the policy to see whether that version was published before saving again.";
    case "DROPSHIP_WALLET_POLICY_TABLE_MISSING":
      return "The wallet policy table is not available yet, so the limits in force still come from the environment. "
        + "Retry once the migration has run.";
    default:
      return serverMessage;
  }
}

/** Where the value in force came from, per limit. */
export function dropshipWalletPolicySourceLabel(
  limitsSource: "policy" | "environment",
  envKey: string | null,
): string {
  if (limitsSource === "policy") return "Published policy version";
  return envKey
    ? `Environment variable ${envKey}`
    : "Built-in default (no environment variable exists)";
}

/** What the environment layer would serve for this limit, named. */
export function dropshipWalletPolicyEnvLabel(envKey: string | null): string {
  return envKey ?? "Built-in default (no environment variable exists)";
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

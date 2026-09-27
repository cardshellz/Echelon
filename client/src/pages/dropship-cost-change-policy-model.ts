/**
 * Dropship cost change policy — the pure model behind the staff "Cost changes"
 * tab (docs/DROPSHIP-COST-CHANGE-CONTROLS.md).
 *
 * Everything the tab decides lives here: the words for each setting, how a
 * day, dollar or percent box becomes an integer, whether the form still
 * matches the settings in force, the request body, what changed between two
 * versions, which settings act today, and what a server error code means to a
 * human. The panel renders; it does not decide.
 *
 * Every range comes from `shared/dropship/cost-change-policy.ts`, the same
 * module the server validates with, and the finished settings are checked
 * against its schema before a request is built. The client is a convenience,
 * never the authority: the server re-checks everything.
 *
 * Money is integer cents throughout; percentages are integer basis points.
 */

import { z } from "zod";
import {
  BASIS_POINTS_PER_WHOLE,
  MAX_DETECTION_INTERVAL_MINUTES,
  MAX_INCREASE_NOTICE_DAYS,
  MAX_NOTICE_MINIMUM_CHANGE_CENTS,
  MIN_DETECTION_INTERVAL_MINUTES,
  belowCostListingActionValues,
  costDecreaseTimingValues,
  dropshipCostChangePolicySettingsSchema,
  rulePricedListingActionValues,
  type BelowCostListingAction,
  type CostDecreaseTiming,
  type DropshipCostChangePolicySettings,
  type RulePricedListingAction,
} from "@shared/dropship/cost-change-policy";
import {
  basisPointsToPercentInput,
  centsToDollarInput,
  formatDropshipBasisPoints,
  parseDollarsToCents,
  parsePercentToBasisPoints,
  parseWholeDays,
  parseWholeMinutes,
} from "./dropship-wallet-policy-model";

/** The one admin route this surface talks to (GET overview, POST new version). */
export const DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL = "/api/dropship/admin/cost-changes/policy";

/** Prefix for the save idempotency key, so the audit trail names the surface. */
export const DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_PREFIX = "dropship-cost-change-policy";

/** Mirrors the server's change note bounds (`changeNoteSchema`, CHECK in migration 0710). */
export const DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH = 1_000;

/** Mirrors the server's idempotency key bounds. */
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export type DropshipCostChangeSettingKey = keyof DropshipCostChangePolicySettings;

/** Every setting, in the order the panel lists them. */
export const DROPSHIP_COST_CHANGE_SETTING_KEYS: readonly DropshipCostChangeSettingKey[] = Object.freeze([
  "increaseNoticeDays",
  "priceProtection",
  "decreaseTiming",
  "retailChangesGetNotice",
  "notifyByEmail",
  "notifyInPortal",
  "noticeMinimumChangeCents",
  "noticeMinimumChangeBps",
  "notifyOnDecrease",
  "rulePricedListings",
  "belowCostFixedListings",
  "detectionIntervalMinutes",
]);

// --- Response contracts -----------------------------------------------------

const actorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().nullable(),
});

const policyRecordSchema = z.object({
  policyId: z.number().int().positive(),
  version: z.number().int().positive(),
  settings: dropshipCostChangePolicySettingsSchema,
  isActive: z.boolean(),
  changeNote: z.string(),
  createdAt: z.string(),
  createdBy: actorSchema,
  deactivatedAt: z.string().nullable(),
});

const enforcementSchema = z.object({
  detection: z.boolean(),
  priceProtection: z.boolean(),
  vendorNotices: z.boolean(),
  listingActions: z.boolean(),
});

export const dropshipCostChangePolicyOverviewSchema = z.object({
  policy: policyRecordSchema.nullable(),
  settings: dropshipCostChangePolicySettingsSchema,
  settingsSource: z.enum(["policy", "defaults"]),
  defaults: dropshipCostChangePolicySettingsSchema,
  versions: z.array(policyRecordSchema),
  enforcement: enforcementSchema,
  generatedAt: z.string(),
});

export const dropshipCostChangePolicyMutationSchema = z.object({
  policy: policyRecordSchema,
  previousPolicy: policyRecordSchema.nullable(),
  idempotentReplay: z.boolean(),
});

export type DropshipCostChangePolicyRecordView = z.infer<typeof policyRecordSchema>;
export type DropshipCostChangeEnforcementView = z.infer<typeof enforcementSchema>;
export type DropshipCostChangePolicyOverview = z.infer<typeof dropshipCostChangePolicyOverviewSchema>;
export type DropshipCostChangePolicyMutation = z.infer<typeof dropshipCostChangePolicyMutationSchema>;

export function parseDropshipCostChangePolicyOverview(value: unknown): DropshipCostChangePolicyOverview {
  return parseResponse(dropshipCostChangePolicyOverviewSchema, value, "cost change policy");
}

/** Validates a POST payload (201 create and 200 idempotent replay share the shape). */
export function parseDropshipCostChangePolicyMutation(value: unknown): DropshipCostChangePolicyMutation {
  return parseResponse(dropshipCostChangePolicyMutationSchema, value, "cost change policy save");
}

function parseResponse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(
    `The ${subject} response was not in the expected shape at `
    + `${issue?.path.join(".") || "response"}: ${issue?.message ?? "invalid response"}.`,
  );
}

// --- Words for each setting ---------------------------------------------------

export type DropshipCostChangeSettingGroup = "notice" | "notices" | "listings" | "detection";

export interface DropshipCostChangeSettingGroupDescriptor {
  group: DropshipCostChangeSettingGroup;
  title: string;
  description: string;
}

export const DROPSHIP_COST_CHANGE_SETTING_GROUPS: readonly DropshipCostChangeSettingGroupDescriptor[] = Object.freeze([
  {
    group: "notice",
    title: "Notice and charging",
    description: "When a changed .ops cost starts to be charged on vendor orders.",
  },
  {
    group: "notices",
    title: "Who is told",
    description: "How vendors hear about a cost change.",
  },
  {
    group: "listings",
    title: "Listings when a new cost takes effect",
    description: "What happens to vendor listings on the day a higher cost starts.",
  },
  {
    group: "detection",
    title: "Checking for changes",
    description: "How often live .ops costs are compared with the costs in force.",
  },
]);

export interface DropshipCostChangeChoice<T extends string> {
  value: T;
  label: string;
}

export const DROPSHIP_COST_DECREASE_TIMING_CHOICES: readonly DropshipCostChangeChoice<CostDecreaseTiming>[] =
  choicesFor(costDecreaseTimingValues, {
    immediate: "Apply at once",
    after_notice: "Apply after the same notice as an increase",
  });

export const DROPSHIP_RULE_PRICED_LISTING_CHOICES: readonly DropshipCostChangeChoice<RulePricedListingAction>[] =
  choicesFor(rulePricedListingActionValues, {
    reprice_automatically: "Reprice them automatically",
    wait_for_review: "Wait for the vendor to review them",
  });

export const DROPSHIP_BELOW_COST_LISTING_CHOICES: readonly DropshipCostChangeChoice<BelowCostListingAction>[] =
  choicesFor(belowCostListingActionValues, {
    no_action: "Do nothing",
    warn: "Warn the vendor",
    pause_listing: "Pause the listing",
  });

export interface DropshipCostChangeSettingDescriptor {
  setting: DropshipCostChangeSettingKey;
  group: DropshipCostChangeSettingGroup;
  label: string;
  help: string;
}

export const DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS: readonly DropshipCostChangeSettingDescriptor[] = Object.freeze([
  {
    setting: "increaseNoticeDays",
    group: "notice",
    label: "Notice before a higher cost is charged",
    help: `Whole days, 0 to ${MAX_INCREASE_NOTICE_DAYS}. A higher cost starts at midnight UTC once this many full days `
      + "have passed. 0 starts it at once.",
  },
  {
    setting: "priceProtection",
    group: "notice",
    label: "Keep charging the current cost during the notice",
    help: "On: orders accepted during the notice are charged the current cost. Off: orders are charged the new cost "
      + "as soon as it changes, and the notice is only a warning.",
  },
  {
    setting: "decreaseTiming",
    group: "notice",
    label: "When a lower cost applies",
    help: "At once: the lower cost is charged from the moment it is seen. After notice: it waits as long as an "
      + "increase would.",
  },
  {
    setting: "retailChangesGetNotice",
    group: "notice",
    label: "Give Shopify retail price changes the same notice",
    help: "For costs set as a percentage of the Shopify retail price. Off: a change caused only by a retail price "
      + "move applies at once.",
  },
  {
    setting: "notifyByEmail",
    group: "notices",
    label: "Email vendors",
    help: "Email vendors when a cost on their plan changes.",
  },
  {
    setting: "notifyInPortal",
    group: "notices",
    label: "Show changes in the vendor portal's Alerts",
    help: "Add an alert to the vendor's Alerts page when a cost on their plan changes.",
  },
  {
    setting: "noticeMinimumChangeCents",
    group: "notices",
    label: "Skip notices for changes under",
    help: `Dollars per unit, 0 to ${formatDollarsFromCents(MAX_NOTICE_MINIMUM_CHANGE_CENTS)}. 0 announces every change.`,
  },
  {
    setting: "noticeMinimumChangeBps",
    group: "notices",
    label: "Skip notices for changes under this share of the current cost",
    help: "Percent, 0 to 100. A change must reach both minimums to be announced. A skipped change is still "
      + "recorded and still gets its notice period.",
  },
  {
    setting: "notifyOnDecrease",
    group: "notices",
    label: "Also tell vendors when a cost goes down",
    help: "Off: only increases are announced. A lower cost still applies either way.",
  },
  {
    setting: "rulePricedListings",
    group: "listings",
    label: "Listings priced by pricing rules",
    help: "Reprice: the listing is updated to the price its rule gives for the new cost. Wait: it keeps its "
      + "current price until the vendor reviews it.",
  },
  {
    setting: "belowCostFixedListings",
    group: "listings",
    label: "Fixed-price listings the new cost puts below cost",
    help: "A fixed price the vendor typed is never changed. Warn: the vendor is told. Pause: the listing stops "
      + "selling until the vendor changes the price.",
  },
  {
    setting: "detectionIntervalMinutes",
    group: "detection",
    label: "Check live costs every",
    help: `Whole minutes, ${MIN_DETECTION_INTERVAL_MINUTES} to ${MAX_DETECTION_INTERVAL_MINUTES.toLocaleString("en-US")} `
      + "(one day).",
  },
]);

/** The descriptor for one setting. Every setting has exactly one. */
export function dropshipCostChangeSettingDescriptor(setting: DropshipCostChangeSettingKey): DropshipCostChangeSettingDescriptor {
  const descriptor = DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS.find((candidate) => candidate.setting === setting);
  if (!descriptor) throw new Error(`No descriptor for cost change setting ${setting}.`);
  return descriptor;
}

/** A setting's value as staff read it: "14 days", "$0.25", "1.50%", "On", "Warn the vendor". */
export function formatDropshipCostChangeSetting(
  settings: DropshipCostChangePolicySettings,
  setting: DropshipCostChangeSettingKey,
): string {
  switch (setting) {
    case "increaseNoticeDays":
      return settings.increaseNoticeDays === 0 ? "None (at once)" : pluralDays(settings.increaseNoticeDays);
    case "decreaseTiming":
      return choiceLabel(DROPSHIP_COST_DECREASE_TIMING_CHOICES, settings.decreaseTiming);
    case "priceProtection":
    case "retailChangesGetNotice":
    case "notifyByEmail":
    case "notifyInPortal":
    case "notifyOnDecrease":
      return settings[setting] ? "On" : "Off";
    case "noticeMinimumChangeCents":
      return settings.noticeMinimumChangeCents === 0
        ? "No minimum"
        : formatDollarsFromCents(settings.noticeMinimumChangeCents);
    case "noticeMinimumChangeBps":
      return settings.noticeMinimumChangeBps === 0
        ? "No minimum"
        : formatDropshipBasisPoints(settings.noticeMinimumChangeBps);
    case "rulePricedListings":
      return choiceLabel(DROPSHIP_RULE_PRICED_LISTING_CHOICES, settings.rulePricedListings);
    case "belowCostFixedListings":
      return choiceLabel(DROPSHIP_BELOW_COST_LISTING_CHOICES, settings.belowCostFixedListings);
    case "detectionIntervalMinutes":
      return `${settings.detectionIntervalMinutes.toLocaleString("en-US")} minutes`;
  }
}

// --- Which settings act today -------------------------------------------------

export type DropshipCostChangeEnforcementPart = keyof DropshipCostChangeEnforcementView;

export const DROPSHIP_COST_CHANGE_ENFORCEMENT_PARTS: readonly {
  part: DropshipCostChangeEnforcementPart;
  label: string;
}[] = Object.freeze([
  { part: "detection", label: "Finding cost changes and scheduling them" },
  { part: "priceProtection", label: "Charging the cost in force when an order is accepted" },
  { part: "vendorNotices", label: "Telling vendors" },
  { part: "listingActions", label: "Updating listings when a new cost takes effect" },
]);

/**
 * The parts each setting needs before it changes anything. Nothing is
 * scheduled until detection runs, so every setting needs it.
 */
const SETTING_ENFORCEMENT: Readonly<Record<DropshipCostChangeSettingKey, readonly DropshipCostChangeEnforcementPart[]>> =
  Object.freeze({
    increaseNoticeDays: ["detection", "priceProtection"],
    priceProtection: ["detection", "priceProtection"],
    decreaseTiming: ["detection", "priceProtection"],
    retailChangesGetNotice: ["detection", "priceProtection"],
    notifyByEmail: ["detection", "vendorNotices"],
    notifyInPortal: ["detection", "vendorNotices"],
    notifyOnDecrease: ["detection", "vendorNotices"],
    noticeMinimumChangeCents: ["detection", "vendorNotices"],
    noticeMinimumChangeBps: ["detection", "vendorNotices"],
    rulePricedListings: ["detection", "listingActions"],
    belowCostFixedListings: ["detection", "listingActions"],
    detectionIntervalMinutes: ["detection"],
  });

/** Whether a setting changes anything today: every part it needs has shipped. */
export function isDropshipCostChangeSettingInEffect(
  setting: DropshipCostChangeSettingKey,
  enforcement: DropshipCostChangeEnforcementView,
): boolean {
  return SETTING_ENFORCEMENT[setting].every((part) => enforcement[part]);
}

/** True while at least one part has not shipped, so the page must say what happens today. */
export function isDropshipCostChangePolicyPartlyEnforced(enforcement: DropshipCostChangeEnforcementView): boolean {
  return DROPSHIP_COST_CHANGE_ENFORCEMENT_PARTS.some(({ part }) => !enforcement[part]);
}

/**
 * What happens to a cost change today, before these settings act. Grounded in
 * the code as of migration 0710: acceptance charges the live cost
 * (`dropship-order-acceptance.repository.ts`, `loadProductCosts` inside the
 * acceptance transaction) and rule prices are computed from the live cost on
 * every preview and push (`loadRulePricesWithClient`, and the push worker's
 * `refreshListingIntent`). Nothing sends a cost change notice.
 */
export const DROPSHIP_COST_CHANGE_TODAY_SUMMARY =
  "Until the parts below are live, a .ops cost change is charged on the next order accepted, with no notice to the "
  + "vendor, and listings priced by pricing rules use the new cost the next time they are previewed or pushed. "
  + "Settings saved here are kept and apply as each part goes live.";

// --- Form -----------------------------------------------------------------------

/** Text boxes hold what staff typed; switches and choices hold their values. */
export interface DropshipCostChangePolicyForm {
  increaseNoticeDays: string;
  priceProtection: boolean;
  decreaseTiming: CostDecreaseTiming;
  retailChangesGetNotice: boolean;
  notifyByEmail: boolean;
  notifyInPortal: boolean;
  notifyOnDecrease: boolean;
  /** Dollars per unit, e.g. "0.25". */
  noticeMinimumChange: string;
  /** Percent of the current cost, e.g. "1.50". */
  noticeMinimumChangePercent: string;
  rulePricedListings: RulePricedListingAction;
  belowCostFixedListings: BelowCostListingAction;
  detectionIntervalMinutes: string;
  changeNote: string;
}

export type DropshipCostChangePolicyTextField =
  | "increaseNoticeDays"
  | "noticeMinimumChange"
  | "noticeMinimumChangePercent"
  | "detectionIntervalMinutes"
  | "changeNote";

export type DropshipCostChangePolicyFormErrors = Partial<Record<DropshipCostChangePolicyTextField, string>>;

export type ParsedDropshipCostChangePolicyForm =
  | { success: true; settings: DropshipCostChangePolicySettings; changeNote: string }
  | { success: false; errors: DropshipCostChangePolicyFormErrors };

export function dropshipCostChangePolicyFormFromSettings(
  settings: DropshipCostChangePolicySettings,
): DropshipCostChangePolicyForm {
  return {
    increaseNoticeDays: String(settings.increaseNoticeDays),
    priceProtection: settings.priceProtection,
    decreaseTiming: settings.decreaseTiming,
    retailChangesGetNotice: settings.retailChangesGetNotice,
    notifyByEmail: settings.notifyByEmail,
    notifyInPortal: settings.notifyInPortal,
    notifyOnDecrease: settings.notifyOnDecrease,
    noticeMinimumChange: centsToDollarInput(settings.noticeMinimumChangeCents),
    noticeMinimumChangePercent: basisPointsToPercentInput(settings.noticeMinimumChangeBps),
    rulePricedListings: settings.rulePricedListings,
    belowCostFixedListings: settings.belowCostFixedListings,
    detectionIntervalMinutes: String(settings.detectionIntervalMinutes),
    changeNote: "",
  };
}

/**
 * Reads the form into settings. Each box is parsed as digits, never through a
 * float, and the result is checked against the shared schema so the client can
 * never send a value the server would refuse for range.
 */
export function parseDropshipCostChangePolicyForm(form: DropshipCostChangePolicyForm): ParsedDropshipCostChangePolicyForm {
  const settings = parseDropshipCostChangePolicySettings(form);
  const errors: DropshipCostChangePolicyFormErrors = settings.success ? {} : { ...settings.errors };

  const changeNote = form.changeNote.trim();
  if (!changeNote) {
    errors.changeNote = "Say why the policy is changing. The note is kept with the version.";
  } else if (changeNote.length > DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH) {
    errors.changeNote =
      `Keep the note to ${DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  }

  if (!settings.success || Object.keys(errors).length > 0) return { success: false, errors };
  return { success: true, settings: settings.settings, changeNote };
}

type ParsedDropshipCostChangePolicySettings =
  | { success: true; settings: DropshipCostChangePolicySettings }
  | { success: false; errors: DropshipCostChangePolicyFormErrors };

/** The settings boxes alone; the change note is checked by the caller. */
function parseDropshipCostChangePolicySettings(form: DropshipCostChangePolicyForm): ParsedDropshipCostChangePolicySettings {
  const errors: DropshipCostChangePolicyFormErrors = {};

  const noticeDays = parseWholeDays(form.increaseNoticeDays, MAX_INCREASE_NOTICE_DAYS);
  if (!noticeDays.ok) {
    errors.increaseNoticeDays = `Enter whole days from 0 to ${MAX_INCREASE_NOTICE_DAYS}.`;
  }

  const minimumCents = parseDollarsToCents(form.noticeMinimumChange, { allowZero: true });
  if (!minimumCents.ok || minimumCents.cents > MAX_NOTICE_MINIMUM_CHANGE_CENTS) {
    errors.noticeMinimumChange =
      `Enter dollars and cents from 0 to ${formatDollarsFromCents(MAX_NOTICE_MINIMUM_CHANGE_CENTS)}, for example 0.25.`;
  }

  const minimumBps = parsePercentToBasisPoints(form.noticeMinimumChangePercent);
  if (!minimumBps.ok || minimumBps.bps > BASIS_POINTS_PER_WHOLE) {
    errors.noticeMinimumChangePercent = "Enter a percentage from 0 to 100 with at most two decimals, for example 1.5.";
  }

  const interval = parseWholeMinutes(form.detectionIntervalMinutes, MAX_DETECTION_INTERVAL_MINUTES);
  if (!interval.ok || interval.minutes < MIN_DETECTION_INTERVAL_MINUTES) {
    errors.detectionIntervalMinutes =
      `Enter whole minutes from ${MIN_DETECTION_INTERVAL_MINUTES} to ${MAX_DETECTION_INTERVAL_MINUTES.toLocaleString("en-US")}.`;
  }

  if (!noticeDays.ok || !minimumCents.ok || !minimumBps.ok || !interval.ok || Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  const settings = dropshipCostChangePolicySettingsSchema.safeParse({
    increaseNoticeDays: noticeDays.days,
    decreaseTiming: form.decreaseTiming,
    priceProtection: form.priceProtection,
    retailChangesGetNotice: form.retailChangesGetNotice,
    notifyByEmail: form.notifyByEmail,
    notifyInPortal: form.notifyInPortal,
    notifyOnDecrease: form.notifyOnDecrease,
    noticeMinimumChangeCents: minimumCents.cents,
    noticeMinimumChangeBps: minimumBps.bps,
    rulePricedListings: form.rulePricedListings,
    belowCostFixedListings: form.belowCostFixedListings,
    detectionIntervalMinutes: interval.minutes,
  });
  if (!settings.success) {
    // Unreachable while the checks above mirror the schema (the choices are
    // typed to its values); kept so a drift between them blocks the save
    // instead of sending an invalid request.
    const setting = settings.error.issues[0]?.path.join(".") ?? "settings";
    return {
      success: false,
      errors: { changeNote: `The ${setting} setting does not match the policy rules. Reload the policy and try again.` },
    };
  }
  return { success: true, settings: settings.data };
}

/**
 * Has the operator changed a setting? The note does not count: it explains a
 * change, it is not one. An unreadable box counts as changed — it is an edit in
 * progress, and a form that cannot be read does not match what is in force.
 */
export function isDropshipCostChangePolicyFormDirty(
  form: DropshipCostChangePolicyForm,
  settings: DropshipCostChangePolicySettings,
): boolean {
  const parsed = parseDropshipCostChangePolicySettings(form);
  if (!parsed.success) return true;
  return dropshipCostChangePolicySettingsKey(parsed.settings) !== dropshipCostChangePolicySettingsKey(settings);
}

/** A stable string for a set of settings, in the fixed setting order. */
export function dropshipCostChangePolicySettingsKey(settings: DropshipCostChangePolicySettings): string {
  return JSON.stringify(DROPSHIP_COST_CHANGE_SETTING_KEYS.map((setting) => [setting, settings[setting]]));
}

/**
 * Publishing the settings already in force is allowed only to confirm a
 * version nobody on staff has approved: the migration's seed, or the code
 * defaults when no version exists. It records who approved the policy.
 */
export function dropshipCostChangePolicyNeedsStaffConfirmation(overview: DropshipCostChangePolicyOverview): boolean {
  return overview.policy === null || overview.policy.createdBy.actorType === "system";
}

// --- Request ----------------------------------------------------------------------

export interface DropshipCostChangePolicyVersionRequest {
  settings: DropshipCostChangePolicySettings;
  changeNote: string;
  idempotencyKey: string;
}

export function buildDropshipCostChangePolicyVersionRequest(input: {
  settings: DropshipCostChangePolicySettings;
  changeNote: string;
  idempotencyKey: string;
}): DropshipCostChangePolicyVersionRequest {
  const settings = dropshipCostChangePolicySettingsSchema.safeParse(input.settings);
  if (!settings.success) {
    throw new Error("Cost change policy settings are outside the policy rules.");
  }
  const changeNote = input.changeNote.trim();
  if (!changeNote || changeNote.length > DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH) {
    throw new Error(
      `Change note must be 1 to ${DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(
      `Idempotency key must be between ${MIN_IDEMPOTENCY_KEY_LENGTH} and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  return {
    settings: Object.fromEntries(
      DROPSHIP_COST_CHANGE_SETTING_KEYS.map((setting) => [setting, settings.data[setting]]),
    ) as DropshipCostChangePolicySettings,
    changeNote,
    idempotencyKey,
  };
}

/**
 * Identifies one save request. The panel reuses its idempotency key while this
 * stays the same, so retrying after a lost response replays the first attempt
 * instead of publishing a second identical version.
 */
export function dropshipCostChangePolicyRequestFingerprint(
  settings: DropshipCostChangePolicySettings,
  changeNote: string,
): string {
  return JSON.stringify([dropshipCostChangePolicySettingsKey(settings), changeNote.trim()]);
}

// --- Version history ----------------------------------------------------------------

export interface DropshipCostChangeSettingChange {
  setting: DropshipCostChangeSettingKey;
  label: string;
  from: string;
  to: string;
}

/** Each setting that differs between two versions, in the fixed setting order. */
export function describeDropshipCostChangePolicyChanges(
  previous: DropshipCostChangePolicySettings,
  next: DropshipCostChangePolicySettings,
): DropshipCostChangeSettingChange[] {
  return DROPSHIP_COST_CHANGE_SETTING_KEYS
    .filter((setting) => previous[setting] !== next[setting])
    .map((setting) => ({
      setting,
      label: dropshipCostChangeSettingDescriptor(setting).label,
      from: formatDropshipCostChangeSetting(previous, setting),
      to: formatDropshipCostChangeSetting(next, setting),
    }));
}

export type DropshipCostChangeVersionSummary =
  | { kind: "first" }
  | { kind: "changes"; changes: DropshipCostChangeSettingChange[] }
  | { kind: "confirmed" }
  | { kind: "earlier_not_listed" };

/**
 * What a listed version changed, compared with the version before it. The list
 * is newest first and capped, so the oldest listed version may have no
 * predecessor in it.
 */
export function summarizeDropshipCostChangePolicyVersion(
  versions: readonly DropshipCostChangePolicyRecordView[],
  index: number,
): DropshipCostChangeVersionSummary {
  const version = versions[index];
  if (!version) throw new Error(`No cost change policy version at index ${index}.`);
  if (version.version === 1) return { kind: "first" };
  const previous = versions[index + 1];
  if (!previous || previous.version !== version.version - 1) return { kind: "earlier_not_listed" };
  const changes = describeDropshipCostChangePolicyChanges(previous.settings, version.settings);
  return changes.length === 0 ? { kind: "confirmed" } : { kind: "changes", changes };
}

export function formatDropshipCostChangePolicyActor(actor: DropshipCostChangePolicyRecordView["createdBy"]): string {
  if (actor.actorType === "system") return actor.actorId ? `System (${actor.actorId})` : "System";
  return actor.actorId ? `Staff user ${actor.actorId}` : "Staff user (not recorded)";
}

// --- Server faces ----------------------------------------------------------------

/**
 * Turns a structured server code into something staff can act on. Anything not
 * listed keeps the server's own message: inventing a friendlier sentence for an
 * error nobody anticipated hides what actually happened.
 */
export function dropshipCostChangePolicySaveErrorMessage(code: string | null, serverMessage: string): string {
  switch (code) {
    case "DROPSHIP_COST_CHANGE_POLICY_CONFLICT":
      return "Another version was published at the same moment, so nothing was saved. "
        + "Reload the policy, check the new version, and save again if your change is still needed.";
    case "DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT":
      return "This save was already used for different settings, so nothing was saved. "
        + "Reload the policy to see what is in force, then save again.";
    case "DROPSHIP_COST_CHANGE_POLICY_COMMAND_INCOMPLETE":
      return "An earlier attempt at this save did not finish, so nothing was saved. "
        + "Reload the policy to see whether that version was published before saving again.";
    case "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING":
      return "The cost change policy table is not available yet, so nothing was saved and the defaults apply. "
        + "Save again once the migration has run.";
    case "DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT":
      return `The server refused these settings: ${serverMessage}`;
    case null:
      // No structured answer (a timeout, a dropped connection, a proxy page):
      // the save may or may not have landed. The panel keeps the same
      // idempotency key for the same request, so a retry replays it.
      return `${serverMessage.trim().replace(/[.!?]+$/, "")}. The server did not confirm the save, so it may or may `
        + "not have been published. Try again: retrying the same change cannot publish it twice.";
    default:
      return serverMessage;
  }
}

// --- Helpers ------------------------------------------------------------------------

function choicesFor<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): readonly DropshipCostChangeChoice<T>[] {
  return Object.freeze(values.map((value) => ({ value, label: labels[value] })));
}

function choiceLabel<T extends string>(choices: readonly DropshipCostChangeChoice<T>[], value: T): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

function pluralDays(days: number): string {
  return `${days.toLocaleString("en-US")} ${days === 1 ? "day" : "days"}`;
}

/** Integer cents -> "$1,000.00". Digit arithmetic only. */
function formatDollarsFromCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
}

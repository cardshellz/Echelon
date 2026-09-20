/**
 * Wallet flow model (spec §1.3–§1.5, §2.5 copy, §4.3 request builders).
 *
 * Pure functions behind the rebuilt Wallet page. They decide which step the
 * vendor is on from server facts (the adapted wallet view, the vendor status)
 * plus a browser-local draft of not-yet-authorized choices; they word the
 * mandate the vendor agrees to; and they build the exact request bodies the
 * wallet routes accept. The page renders what these functions return and
 * never decides on its own. Integer cents throughout; no clock except where
 * `now` is passed in.
 */

import { z } from "zod";
import { formatFeeRate } from "@shared/dropship/wallet-funding-fee";
import type { DropshipAutoReloadConfigInput } from "./dropship-ops-surface";
import {
  BANK_SETTLEMENT_DAYS_PHRASE,
  BANK_SETTLEMENT_PHRASE,
  EXAMPLE_SHORTFALL,
  activationTopUp,
  assertCents,
  cardExpiryState,
  derivedLimitCents,
  capAfterFloorChange,
  firstFillFeeCents,
  formatDurationMinutes,
  formatWholeDollars,
  shortfallExample,
  type WalletSourceRail,
} from "./dropship-wallet-guidance";
import type {
  DropshipWalletView,
  WalletFundingMethod,
  WalletLedgerReason,
  WalletLimits,
} from "./dropship-wallet-view-adapter";

/** The setup flow, in order. The list is the model's; the page renders it and never reorders it. */
export const STEP_ORDER = ["intro", "source", "floor", "backup", "authorize", "deposit"] as const;
export type WalletFlowStep = (typeof STEP_ORDER)[number];
export type WalletVendorStatus = "onboarding" | "active" | "paused" | "lapsed" | "suspended" | "closed" | string;

/** The one-based number a step carries in the list and in copy ("back at step 4"). */
export function walletStepNumber(step: WalletFlowStep): number {
  return STEP_ORDER.indexOf(step) + 1;
}

/** The step before this one, or null for the first. */
export function previousWalletStep(step: WalletFlowStep): WalletFlowStep | null {
  return STEP_ORDER[STEP_ORDER.indexOf(step) - 1] ?? null;
}

/** -1 for null and for anything not in STEP_ORDER, so an unknown step is simply out of reach. */
function stepIndex(step: WalletFlowStep | null): number {
  return step === null ? -1 : STEP_ORDER.indexOf(step);
}

/** The vendor statuses the server lets turn auto-reload off (rule 13; S4 extends the refusal to paused — Assumption). */
export const AUTO_RELOAD_OFF_ALLOWED_STATUSES: ReadonlySet<string> = new Set(["onboarding", "lapsed", "suspended", "closed"]);

/** Polling after a successful Stripe return, bounded so a broken webhook cannot poll forever. */
export const CARD_CONFIRMATION_POLL_INTERVAL_MS = 3_000;
export const CARD_CONFIRMATION_POLL_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// The draft: browser-local, vendor-scoped, validated on read (spec §1.4)
// ---------------------------------------------------------------------------

export const DRAFT_STORAGE_KEY_PREFIX = "dropship-wallet-setup-draft:v1:";

export function draftStorageKey(vendorId: number): string {
  return `${DRAFT_STORAGE_KEY_PREFIX}${vendorId}`;
}

const sourceRailSchema = z.enum(["stripe_ach", "stripe_card"]);
const stepSchema = z.enum(STEP_ORDER);
const optionalCents = z.number().int().nonnegative().nullable();
const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date");

const pendingStripeSchema = z.object({
  rail: sourceRailSchema,
  purpose: z.enum(["source", "backup", "deposit", "manage_add"]),
  knownMethods: z.array(z.object({ id: z.number().int().positive(), updatedAt: z.string().min(1) })),
  ledgerMark: z.object({
    newestLedgerEntryId: z.number().int().nullable(),
    availableBalanceCents: z.number().int(),
    pendingBalanceCents: z.number().int(),
  }).nullable(),
  startedAt: isoDate,
  expiresAt: isoDate,
}).strict();

export const walletDraftSchema = z.object({
  v: z.literal(1),
  seenIntro: z.boolean(),
  sourceRail: sourceRailSchema.nullable(),
  sourceMethodId: z.number().int().positive().nullable(),
  floorCents: optionalCents,
  dailyCostCents: optionalCents,
  backupMethodId: z.number().int().positive().nullable(),
  pendingStripe: pendingStripeSchema.nullable(),
  deposit: z.enum(["pending", "skipped", "done"]).nullable(),
  // Where the vendor asked to be, when that is not where the flow left them.
  // Optional with a default so a draft written before step navigation existed
  // still parses (no version bump, nothing re-picked); an unreadable value is
  // dropped to null rather than discarding the whole draft, because a bad
  // override costs one click and a discarded draft costs every choice.
  stepOverride: stepSchema.nullable().catch(null).default(null),
}).strict();

export type WalletDraft = z.infer<typeof walletDraftSchema>;
export type PendingStripe = z.infer<typeof pendingStripeSchema>;
export type StripePurpose = PendingStripe["purpose"];

export const EMPTY_DRAFT: WalletDraft = Object.freeze({
  v: 1,
  seenIntro: false,
  sourceRail: null,
  sourceMethodId: null,
  floorCents: null,
  dailyCostCents: null,
  backupMethodId: null,
  pendingStripe: null,
  deposit: null,
  stepOverride: null,
}) as WalletDraft;

/** A malformed or foreign draft is discarded, never repaired: a lost draft costs one re-pick, nothing more. */
export function parseWalletDraft(raw: unknown): WalletDraft | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = walletDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface DraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Storage can throw (private mode, blocked site data); a failure means an in-memory draft plus a notice, never an error. */
export function readWalletDraft(storage: DraftStorageLike | null, vendorId: number): { draft: WalletDraft; storageFailed: boolean } {
  if (!storage) return { draft: { ...EMPTY_DRAFT }, storageFailed: true };
  try {
    return { draft: parseWalletDraft(storage.getItem(draftStorageKey(vendorId))) ?? { ...EMPTY_DRAFT }, storageFailed: false };
  } catch {
    return { draft: { ...EMPTY_DRAFT }, storageFailed: true };
  }
}

export function writeWalletDraft(storage: DraftStorageLike | null, vendorId: number, draft: WalletDraft): boolean {
  if (!storage) return false;
  try {
    storage.setItem(draftStorageKey(vendorId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearWalletDraft(storage: DraftStorageLike | null, vendorId: number): void {
  if (!storage) return;
  try {
    storage.removeItem(draftStorageKey(vendorId));
  } catch {
    // Nothing to do: a draft that cannot be removed is discarded on its next read once it no longer parses or applies.
  }
}

/** A pending redirect past Stripe's own session expiry is discarded silently. */
export function isPendingStripeLive(pending: PendingStripe | null, now: Date): pending is PendingStripe {
  return pending !== null && now.getTime() < Date.parse(pending.expiresAt);
}

// ---------------------------------------------------------------------------
// Stripe redirects (spec §1.4)
// ---------------------------------------------------------------------------

/** Stripe's hosted page returns with one of these query parameters (server-owned names). */
export const STRIPE_RETURN_PARAMS = ["funding_setup", "wallet_funding"] as const;
export type StripeReturnKind = (typeof STRIPE_RETURN_PARAMS)[number];

export interface StripeReturn {
  kind: StripeReturnKind;
  status: "success" | "cancelled";
}

export function parseStripeReturn(search: string): StripeReturn | null {
  const params = new URLSearchParams(search);
  for (const kind of STRIPE_RETURN_PARAMS) {
    const value = params.get(kind);
    if (value === "success" || value === "cancelled") return { kind, status: value };
  }
  return null;
}

/** The query string with the Stripe return markers removed, so a reload does not replay the banner. */
export function stripStripeReturn(search: string): string {
  const params = new URLSearchParams(search);
  for (const kind of STRIPE_RETURN_PARAMS) params.delete(kind);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : "";
}

/**
 * What to remember before leaving for Stripe: every method id with its
 * `updatedAt` (a re-added instrument refreshes an existing row rather than
 * creating one) and, for a deposit, the ledger mark.
 */
export function buildPendingStripe(input: {
  rail: WalletSourceRail;
  purpose: StripePurpose;
  wallet: DropshipWalletView;
  startedAt: Date;
  /** Stripe's own session expiry as the server echoes it; a null echo falls back to one hour so the draft never lives forever. */
  expiresAt: string | null;
}): PendingStripe {
  const fallbackExpiry = new Date(input.startedAt.getTime() + 60 * 60 * 1000).toISOString();
  return {
    rail: input.rail,
    purpose: input.purpose,
    knownMethods: input.wallet.fundingMethods.map((method) => ({ id: method.fundingMethodId, updatedAt: method.updatedAt })),
    ledgerMark: input.purpose === "deposit"
      ? {
        newestLedgerEntryId: input.wallet.recentLedger.reduce<number | null>((max, entry) => (max === null || entry.ledgerEntryId > max ? entry.ledgerEntryId : max), null),
        availableBalanceCents: input.wallet.account.availableBalanceCents,
        pendingBalanceCents: input.wallet.account.pendingBalanceCents,
      }
      : null,
    startedAt: input.startedAt.toISOString(),
    expiresAt: input.expiresAt ?? fallbackExpiry,
  };
}

export type StripeReturnResolution =
  | { kind: "method"; method: WalletFundingMethod }
  | { kind: "deposit_seen" }
  | null;

/** Deterministic, no clock: the redirect's result is a new or refreshed ACTIVE method of the rail, or a moved ledger mark. */
export function resolveStripeReturn(pending: PendingStripe, wallet: DropshipWalletView): StripeReturnResolution {
  if (pending.purpose === "deposit") {
    const mark = pending.ledgerMark;
    if (!mark) return wallet.recentLedger.length > 0 ? { kind: "deposit_seen" } : null;
    const newer = wallet.recentLedger.some((entry) => mark.newestLedgerEntryId === null || entry.ledgerEntryId > mark.newestLedgerEntryId);
    const moved = wallet.account.availableBalanceCents !== mark.availableBalanceCents || wallet.account.pendingBalanceCents !== mark.pendingBalanceCents;
    return newer || moved ? { kind: "deposit_seen" } : null;
  }
  const known = new Map(pending.knownMethods.map((entry) => [entry.id, entry.updatedAt]));
  const candidates = wallet.fundingMethods
    .filter((method) => method.rail === pending.rail && method.status === "active")
    .filter((method) => !known.has(method.fundingMethodId) || known.get(method.fundingMethodId) !== method.updatedAt)
    .sort(newestFirst);
  return candidates[0] ? { kind: "method", method: candidates[0] } : null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function describeFundingMethod(method: WalletFundingMethod): string {
  if (method.card) return `${method.card.brand} ending in ${method.card.last4}`;
  if (method.bankAccount) return `${method.bankAccount.bankName ?? "Bank account"} ending in ${method.bankAccount.last4}`;
  if (method.rail === "usdc_base" && method.usdcWalletAddress) return `USDC · ${maskAddress(method.usdcWalletAddress)}`;
  if (method.displayLabel?.trim()) return method.displayLabel.trim();
  switch (method.rail) {
    case "stripe_card":
      return "Card";
    case "stripe_ach":
      return "Bank account";
    case "usdc_base":
      return method.usdcWalletAddress ? `USDC · ${maskAddress(method.usdcWalletAddress)}` : "USDC on Base";
    default:
      return "Funding method";
  }
}

/** "Visa ending in 4242 · expires 12/27" / "Chase ending in 1234 · checking" / "USDC · 0x1234…5678". */
export function describeFundingMethodDetailed(method: WalletFundingMethod): string {
  const label = describeFundingMethod(method);
  if (method.card && method.card.expMonth !== null && method.card.expYear !== null) return `${label} · expires ${formatExpiry(method.card)}`;
  if (method.bankAccount?.accountType) return `${label} · ${method.bankAccount.accountType}`;
  return label;
}

export function formatExpiry(card: { expMonth: number | null; expYear: number | null }): string {
  if (card.expMonth === null || card.expYear === null) return "unknown";
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

export function maskAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export const LEDGER_REASON_LABELS: Readonly<Record<WalletLedgerReason, string>> = Object.freeze({
  daily_top_up: "Daily top-up",
  after_order_top_up: "Top-up after an order",
  activation_top_up: "First top-up at activation",
  covered_held_order: "Covered a held order",
  manual_top_up: "Money you added",
  usdc_deposit: "USDC deposit",
  admin_credit: "Credit from Card Shellz",
  order: "Order",
  return_fee: "Return fee",
  return_credit: "Return credit",
  insurance_pool_credit: "Insurance pool credit",
  other: "Other",
});

export function isSourceRail(rail: string): rail is WalletSourceRail {
  return rail === "stripe_ach" || rail === "stripe_card";
}

function newestFirst(left: WalletFundingMethod, right: WalletFundingMethod): number {
  return right.createdAt.localeCompare(left.createdAt) || right.fundingMethodId - left.fundingMethodId;
}

/** A card the vendor may pick as backup: active, chargeable and not expired (expiry unknown counts as not expired). */
export function isEligibleBackupCard(method: WalletFundingMethod, now: Date): boolean {
  if (method.rail !== "stripe_card" || method.status !== "active" || !method.roles.chargeable) return false;
  return method.card === null || cardExpiryState(method.card, now) !== "expired";
}

export function activeMethodsOfRail(wallet: DropshipWalletView, rail: WalletSourceRail): WalletFundingMethod[] {
  return wallet.fundingMethods.filter((method) => method.rail === rail && method.status === "active").sort(newestFirst);
}

// ---------------------------------------------------------------------------
// The derived state (spec §1.3)
// ---------------------------------------------------------------------------

export interface WalletFlowState {
  mode: "flow" | "manage";
  /** The step on screen: the one the vendor asked for when it is reachable, else `furthestStep`. */
  step: WalletFlowStep | null;
  /** How far the choices themselves have carried the flow, whatever the vendor is looking at. */
  furthestStep: WalletFlowStep | null;
  /** Every step up to and including `furthestStep`; the page makes exactly these clickable. */
  reachableSteps: WalletFlowStep[];
  needsAcknowledgement: boolean;
  feeRecordMissing: boolean;
  feeChange: { recordedBps: number; currentBps: number } | null;
  source: { rail: WalletSourceRail; method: WalletFundingMethod } | null;
  suggestedSourceMethodId: number | null;
  backup: { method: WalletFundingMethod; satisfiedBySource: boolean } | null;
  floorCents: number;
  limitCents: number;
  holdTimeoutMinutes: number;
  roleGaps: { backupCard: boolean; source: boolean };
  canTurnOffAutoReload: boolean;
  /** Auto-reload is on and points at a method (the seed row `enabled, fundingMethodId NULL` is not authorized). */
  authorized: boolean;
}

export function deriveWalletFlow(input: {
  wallet: DropshipWalletView;
  vendorStatus: WalletVendorStatus;
  draft: WalletDraft;
  now: Date;
}): WalletFlowState {
  const { wallet, draft, now } = input;
  const autoReload = wallet.autoReload;
  const authorized = autoReload !== null && autoReload.enabled && autoReload.fundingMethodId !== null;
  const done = wallet.setupStatus.done;
  const onboarding = input.vendorStatus === "onboarding";

  const needsAcknowledgement = done && !wallet.setupStatus.acknowledged;
  const feeRecordMissing = authorized && autoReload.acknowledgedAt === null;
  const feeChange = autoReload && autoReload.acknowledgedCardFeeBps !== null && autoReload.acknowledgedCardFeeBps !== wallet.cardFundingFeeBps
    ? { recordedBps: autoReload.acknowledgedCardFeeBps, currentBps: wallet.cardFundingFeeBps }
    : null;

  const sourceCandidates = wallet.fundingMethods.filter((method) => method.status === "active" && isSourceRail(method.rail));
  const configuredSource = authorized ? sourceCandidates.find((method) => method.fundingMethodId === autoReload.fundingMethodId) ?? null : null;
  const draftSource = draft.sourceMethodId === null ? null : sourceCandidates.find((method) => method.fundingMethodId === draft.sourceMethodId) ?? null;
  const sourceMethod = draftSource ?? configuredSource;
  const source = sourceMethod && isSourceRail(sourceMethod.rail) ? { rail: sourceMethod.rail, method: sourceMethod } : null;
  const suggested = source ? null : (activeMethodsOfRail(wallet, "stripe_ach")[0] ?? activeMethodsOfRail(wallet, "stripe_card")[0] ?? null);

  const floorFromServer = authorized ? autoReload.minimumBalanceCents : null;
  const floorCents = draft.floorCents ?? floorFromServer ?? (source ? derivedDefaultFloor(source.rail) : derivedDefaultFloor("stripe_ach"));
  const floorValid = (draft.floorCents ?? floorFromServer) !== null && floorCents >= wallet.limits.autoReloadMinTriggerCents;

  const eligibleCards = wallet.fundingMethods.filter((method) => isEligibleBackupCard(method, now));
  const configuredBackup = authorized ? eligibleCards.find((method) => method.fundingMethodId === autoReload.backstopFundingMethodId) ?? null : null;
  const draftBackup = draft.backupMethodId === null ? null : eligibleCards.find((method) => method.fundingMethodId === draft.backupMethodId) ?? null;
  const backup = source?.rail === "stripe_card"
    ? { method: source.method, satisfiedBySource: true }
    : (draftBackup ?? configuredBackup) ? { method: (draftBackup ?? configuredBackup) as WalletFundingMethod, satisfiedBySource: false } : null;

  const derivedLimit = derivedLimitCents(floorCents, wallet.limits);
  const limitCents = authorized && autoReload.maxSingleReloadCents !== null
    ? capAfterFloorChange(autoReload.minimumBalanceCents, floorCents, autoReload.maxSingleReloadCents, wallet.limits)
    : derivedLimit;
  const holdTimeoutMinutes = autoReload?.paymentHoldTimeoutMinutes ?? wallet.limits.defaultPaymentHoldTimeoutMinutes;

  // Step 6 applies only to a bank-source onboarding vendor whose settled plus
  // pending money is below the floor; otherwise the flow ends in manage.
  const belowFloor = wallet.account.availableBalanceCents + wallet.account.pendingBalanceCents < (autoReload?.minimumBalanceCents ?? 0);
  const depositStepApplies = done && draft.deposit === "pending" && source?.rail === "stripe_ach" && belowFloor;
  const mode: "flow" | "manage" = onboarding && (!done || depositStepApplies) ? "flow" : "manage";

  // How far the choices carry the flow on their own: the first unsatisfied
  // requirement. It is the limit on where an override may land, and the step a
  // Continue returns to.
  let furthestStep: WalletFlowStep | null = null;
  if (mode === "flow") {
    if (done) {
      furthestStep = "deposit";
    } else if (!draft.seenIntro) {
      // Every vendor is shown the charge rules once, whatever is already saved
      // on the wallet — a card carried over from the old flow is not evidence
      // that anyone read them. Showing them twice after a lost draft costs one
      // click; never showing them costs an unexplained charge.
      furthestStep = "intro";
    } else if (!source) {
      furthestStep = "source";
    } else if (!floorValid) {
      furthestStep = "floor";
    } else if (!backup) {
      furthestStep = "backup";
    } else {
      furthestStep = "authorize";
    }
  }

  // A step is reachable once the flow has been there: its place in STEP_ORDER
  // is at or before the furthest step. Once the plan is authorized, though, the
  // choices are the server's: reopening them would edit a draft that no longer
  // decides anything, so navigation stops at the review. The intro is only ever
  // a page of rules, so it stays reachable from everywhere.
  const furthestIndex = stepIndex(furthestStep);
  const earliestNavigable = done ? STEP_ORDER.indexOf("authorize") : 0;
  const reachableSteps: WalletFlowStep[] = furthestIndex < 0
    ? []
    : [...(earliestNavigable > 0 ? (["intro"] as WalletFlowStep[]) : []), ...STEP_ORDER.slice(earliestNavigable, furthestIndex + 1)];
  // An override for a step that is not (or no longer) reachable — or for a step
  // this build does not know — is ignored rather than refused: the vendor simply
  // stays where the flow left them.
  const overrideReachable = draft.stepOverride !== null && reachableSteps.includes(draft.stepOverride);
  const step: WalletFlowStep | null = overrideReachable ? draft.stepOverride : furthestStep;

  const backupDesignated = authorized && wallet.fundingMethods.some((method) => method.roles.isBackupCard && method.roles.chargeable && method.status === "active");
  const sourceDesignated = authorized && wallet.fundingMethods.some((method) => method.roles.isAutoReloadSource && method.status === "active");

  return {
    mode,
    step,
    furthestStep,
    reachableSteps,
    needsAcknowledgement,
    feeRecordMissing,
    feeChange,
    source,
    suggestedSourceMethodId: suggested?.fundingMethodId ?? null,
    backup,
    floorCents,
    limitCents,
    holdTimeoutMinutes,
    roleGaps: { backupCard: authorized && !backupDesignated, source: authorized && !sourceDesignated },
    canTurnOffAutoReload: authorized && AUTO_RELOAD_OFF_ALLOWED_STATUSES.has(input.vendorStatus),
    authorized,
  };
}

function derivedDefaultFloor(rail: WalletSourceRail): number {
  return rail === "stripe_ach" ? 25_000 : 10_000;
}

/** Manage-mode target for a `{ step }` recovery (spec §1.3 rule 12). */
export function manageEditorForStep(step: "source" | "floor" | "backup"): "source" | "floor" | "backup" {
  return step;
}

/**
 * How one row of the step list reads.
 *
 * The intro is a page, not a choice: it is done when it has been read and never
 * because the flow moved past it (a vendor whose wallet already held a card was
 * sent straight to step 2 by the old rule and still saw a green tick on a page
 * they were never shown). Every other step is done once the choices reach past
 * it, which is what keeps its result on screen while an earlier step is
 * revisited.
 */
export function walletStepState(step: WalletFlowStep, input: { current: WalletFlowStep | null; furthestStep: WalletFlowStep | null; seenIntro: boolean }): "done" | "current" | "later" {
  if (step === input.current) return "current";
  if (step === "intro") return input.seenIntro ? "done" : "later";
  return stepIndex(step) < stepIndex(input.furthestStep) ? "done" : "later";
}

/**
 * The line under the source picker, or nothing when no method is preselected.
 *
 * "Where you left off" is said only to a vendor who actually left off: a saved
 * method the flow preselected on its own is described as exactly that.
 */
export function describeSourcePreselection(input: {
  selected: WalletFundingMethod | null;
  draftSourceMethodId: number | null;
  suggestedSourceMethodId: number | null;
  /** A method Stripe has just added announces itself; it needs no second line. */
  justAdded: boolean;
}): string | null {
  if (input.justAdded || input.selected === null) return null;
  const label = describeFundingMethod(input.selected);
  if (input.draftSourceMethodId === input.selected.fundingMethodId) return `Pick up where you left off: ${label} is the source you chose earlier.`;
  if (input.draftSourceMethodId === null && input.suggestedSourceMethodId === input.selected.fundingMethodId) {
    return `${label} is already saved on your wallet, so we picked it — choose ${input.selected.rail === "stripe_ach" ? "a card" : "a bank account"} instead if you would rather.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Moving through the flow. Every transition is a pure draft→draft function, so
// what a click keeps and what it clears is decided here and unit-tested, never
// in the page. The rule: a visit changes nothing but where you are, and a
// downstream value is cleared only when the value above it actually changed.
// ---------------------------------------------------------------------------

/** Clicking a step in the list, or a Back control: only where the vendor is. */
export function draftAtStep(draft: WalletDraft, step: WalletFlowStep): WalletDraft {
  return { ...draft, stepOverride: step };
}

/** The intro's button. Seen is recorded once and never withdrawn; a revisit lands back where the flow was. */
export function draftAfterIntro(draft: WalletDraft): WalletDraft {
  return { ...draft, seenIntro: true, stepOverride: null };
}

/**
 * Continue on the source step.
 *
 * The floor is cleared only when the rail actually changes, because the floor's
 * default and its guidance are rail-specific ($250 of cover for a transfer that
 * takes days, $100 when top-ups land at once). Picking the same method again —
 * or another account on the same rail — keeps the floor and the backup card, so
 * a plain revisit costs nothing. A card source still becomes the backup card,
 * which `deriveWalletFlow` derives from the rail; no draft value moves for it.
 */
export function draftAfterSourceChoice(draft: WalletDraft, method: WalletFundingMethod, savedSource: WalletFundingMethod | null): WalletDraft {
  const railChanged = savedSource !== null && savedSource.rail !== method.rail;
  return {
    ...draft,
    stepOverride: null,
    sourceMethodId: method.fundingMethodId,
    sourceRail: isSourceRail(method.rail) ? method.rail : draft.sourceRail,
    floorCents: railChanged ? null : draft.floorCents,
  };
}

/** Continue on the floor step. The daily cost is the vendor's own note and never leaves the browser. */
export function draftAfterFloorChoice(draft: WalletDraft, floorCents: number, dailyCostCents: number | null): WalletDraft {
  assertCents(floorCents, "floorCents");
  if (dailyCostCents !== null) assertCents(dailyCostCents, "dailyCostCents");
  return { ...draft, stepOverride: null, floorCents, dailyCostCents };
}

/** Continue on the backup step. Nothing downstream depends on which card it is. */
export function draftAfterBackupChoice(draft: WalletDraft, card: WalletFundingMethod): WalletDraft {
  return { ...draft, stepOverride: null, backupMethodId: card.fundingMethodId };
}

// ---------------------------------------------------------------------------
// The mandate and the intro (spec §2.1, §2.5)
// ---------------------------------------------------------------------------

export interface WalletTerms {
  sourceRail: WalletSourceRail;
  sourceLabel: string;
  backupLabel: string;
  floorCents: number;
  limitCents: number;
  holdTimeoutMinutes: number;
  holdExpiryWarningMinutes: number;
  cardFundingFeeBps: number;
}

/**
 * Activation wording. The server does not yet start a top-up at activation
 * (spec S9), so every screen says what the code does today: the first daily
 * check after activation.
 */
export function describeActivationTopUp(terms: Pick<WalletTerms, "cardFundingFeeBps">): string {
  return `Your first automatic top-up runs on the first daily check after you activate (about midnight UTC). Until it lands, orders are charged to your backup card at ${formatFeeRate(terms.cardFundingFeeBps)}. Adding money by card now avoids that.`;
}

/** The activation line for a given balance, in the words of what the code does today. */
export function describeActivationQuote(input: {
  terms: WalletTerms;
  availableCents: number;
  pendingCents: number;
}): string {
  const { terms } = input;
  const fee = formatFeeRate(terms.cardFundingFeeBps);
  const result = activationTopUp({
    sourceRail: terms.sourceRail,
    floorCents: terms.floorCents,
    limitCents: terms.limitCents,
    availableCents: input.availableCents,
    pendingCents: input.pendingCents,
    bps: terms.cardFundingFeeBps,
  });
  switch (result.outcome) {
    case "not_needed":
      return "Your balance already covers your floor, so the first daily check after you activate starts no top-up.";
    case "skipped_over_limit":
      return `Your balance is ${formatWholeDollars(input.availableCents)}, so the top-up needed (${formatWholeDollars(result.amountCents)}) is more than your ${formatWholeDollars(result.limitCents)} single top-up limit; the daily check charges nothing and we email you instead. Add money or raise the limit under Limits.`;
    case "top_up":
      return terms.sourceRail === "stripe_card"
        ? `Balance now ${formatWholeDollars(input.availableCents)}, so the first daily check after you activate charges ${formatWholeDollars(result.chargedCents)} to ${terms.sourceLabel} (${formatWholeDollars(result.amountCents)} plus ${formatWholeDollars(result.feeCents)} fee), landing at once.`
        : `Balance now ${formatWholeDollars(input.availableCents)}, so the first daily check after you activate starts a ${formatWholeDollars(result.amountCents)} bank transfer from ${terms.sourceLabel} (no fee; ${BANK_SETTLEMENT_PHRASE} to land). Until it lands, any shortfall goes to ${terms.backupLabel} at ${fee}.`;
    default:
      return "";
  }
}

/** One topic of the intro: the lead sentence, set in bold, and the detail under it. */
export interface WalletIntroTopic {
  lead: string;
  detail: string;
}

export interface WalletIntroCopy {
  /** The line above the list: what the wallet is, before any of the detail. */
  lede: string;
  topics: readonly WalletIntroTopic[];
}

/**
 * "How your wallet works": five topics, each a lead sentence and its detail, in
 * the order a seller meets them — what the wallet is, what filling it costs,
 * how it stays funded, what covers a gap, and what a failure does.
 *
 * Only two numbers are quoted, and each is a served value the server enforces:
 * the card fee and the floor minimum (stated by its purpose, not as a figure
 * Card Shellz picked). Amounts that are environment defaults rather than
 * product rules — the manual funding band, the single top-up limit's own
 * minimum — are deliberately absent: quoting them would promise a rule the
 * product does not have. The single top-up limit is explained in full on the
 * review step, beside the number the vendor actually sets.
 *
 * USDC carries a fee statement and nothing else: the code credits USDC only
 * through an admin endpoint and watches no chain, so any timing claim would be
 * unfounded.
 */
export function describeIntro(input: {
  cardFundingFeeBps: number;
  usdcOffered: boolean;
  holdTimeoutMinutes: number;
  limits: WalletLimits;
}): WalletIntroCopy {
  const fee = formatFeeRate(input.cardFundingFeeBps);
  const hold = formatDurationMinutes(input.holdTimeoutMinutes);
  const usdc = input.usdcOffered ? " USDC costs nothing." : "";
  return {
    lede: "Your wallet is how Card Shellz gets paid for the orders you sell. Here is what it does, what it costs, and what happens if a payment fails.",
    topics: [
      {
        lead: "What your wallet is.",
        detail: "It is a prepaid balance Card Shellz holds for your store. Every order you accept is paid from it: the product cost plus shipping, with nothing added on top. When a return is processed its return fee comes out of the wallet too, and that can take your balance below zero.",
      },
      {
        lead: "Payment methods and fees.",
        detail: `A bank account costs nothing and takes ${BANK_SETTLEMENT_DAYS_PHRASE} to land (our estimate). A card lands at once and costs ${fee} on top of the amount, whether it is a routine top-up, money you add yourself, or a backup charge.${usdc}`,
      },
      {
        lead: "Keeping it funded.",
        detail: `You choose a floor: the balance you want to hold. We top you back up to it once a day, and after any order that drops you below it. Your floor has to be at least ${formatWholeDollars(input.limits.autoReloadMinTriggerCents)}, so there is always enough to cover a normal order. Money already on its way counts toward your floor, so the same gap is never charged twice. You can also add money yourself at any time.`,
      },
      {
        lead: "Your backup card.",
        detail: "Every seller keeps a card on file. Only money that has landed can pay for an order, so if an order needs more than your balance we charge that card for the difference and send the order straight out. That is what covers you while a bank transfer is still on its way.",
      },
      {
        lead: "If a payment fails.",
        detail: `Selling pauses: your listings show nothing for sale, and orders already waiting are cancelled after your hold time (${hold}). We email you, and we do not retry the charge ourselves. Selling starts again on its own once your balance is back at your floor.`,
      },
    ],
  };
}

export const INTRO_VERIFICATION_NOTE = "We will ask you to confirm it is you when you add your first account or card (a 6-digit code by email), again if setup takes longer than ten minutes, and once more if you add money.";

/** The standing authorization, one numbered line per charge it allows. */
export function describeMandate(terms: WalletTerms): string[] {
  assertCents(terms.floorCents, "floorCents");
  assertCents(terms.limitCents, "limitCents");
  const fee = formatFeeRate(terms.cardFundingFeeBps);
  const floor = formatWholeDollars(terms.floorCents);
  const limit = formatWholeDollars(terms.limitCents);
  const hold = formatDurationMinutes(terms.holdTimeoutMinutes);
  const warning = formatDurationMinutes(terms.holdExpiryWarningMinutes);
  const example = shortfallExample({ orderCents: EXAMPLE_SHORTFALL.orderCents, availableCents: EXAMPLE_SHORTFALL.availableCents, bps: terms.cardFundingFeeBps });
  const exampleText = `a ${formatWholeDollars(EXAMPLE_SHORTFALL.orderCents)} order with ${formatWholeDollars(EXAMPLE_SHORTFALL.availableCents)} available charges ${formatWholeDollars(example.shortfallCents)} + ${formatWholeDollars(example.feeCents)}`;
  const belowZero = "If a return fee has taken your balance below zero, the shortfall includes that amount.";
  const limitLine = `Never charge more than ${limit} in one top-up. An order needing more than your available balance plus ${limit} is not charged: it waits for you to add money and is cancelled if still unpaid after ${hold}. We email you ${warning} before that.`;
  const termsLine = `While your account is active, auto-reload stays on; the source, floor, limit, hold time and backup card can be changed at any time in Wallet. The ${fee} card fee is the rate you agree to today for automatic top-ups and covers; if Card Shellz ever raises it, we ask you to confirm before charging those at the higher rate. Money you add yourself shows the current fee on Stripe's page before you pay.`;

  if (terms.sourceRail === "stripe_card") {
    const fill = firstFillFeeCents(terms.floorCents, terms.cardFundingFeeBps);
    return [
      `Charge ${terms.sourceLabel}, plus the ${fee} fee, to bring your balance up to ${floor} — once a day and after any order that takes it lower (${floor} + ${formatWholeDollars(fill)} = ${formatWholeDollars(terms.floorCents + fill)} when the wallet is empty).`,
      `${terms.sourceLabel} is also your backup card: while your account is active, an order needing more than your available balance is charged the shortfall plus ${fee} (up to the single top-up limit) and goes out at once; the next routine top-up then brings the balance back to ${floor} (also plus ${fee}). Example: ${exampleText}. ${belowZero}`,
      limitLine,
      `${describeActivationTopUp(terms)} Once it runs, it charges ${terms.sourceLabel} to bring your balance to ${floor} — unless you add money first.`,
      `Pause selling if a charge is declined, or a bank transfer you started is returned before it lands, and resume on its own once your balance is back to ${floor}. We do not retry the failed charge ourselves; if a top-up fails for any other reason, we email you.`,
      termsLine,
    ];
  }
  return [
    `Debit ${terms.sourceLabel} to bring your balance up to ${floor} — once a day, and after any order that takes it lower. No fee. Money already on its way counts, so the same gap is not debited twice.`,
    `While your account is active, charge ${terms.backupLabel} only when an order needs more than your available balance: the shortfall plus the ${fee} card fee, up to the single top-up limit in the next line, and accept the order at once — even while a bank top-up is still landing or your top-up source cannot be charged. Example: ${exampleText}. Money still on its way from your bank does not count for this. ${belowZero}`,
    limitLine,
    `${describeActivationTopUp(terms)} Once it runs, it debits ${terms.sourceLabel} for the amount that brings you to ${floor}, and that transfer takes ${BANK_SETTLEMENT_PHRASE} to land; a bank transfer you start now helps once it lands.`,
    `Pause selling if a top-up is declined or a bank transfer is returned before it lands, and resume on its own once settled money brings your balance back to ${floor}. We do not retry the failed charge ourselves; if a top-up fails for any other reason, we email you.`,
    termsLine,
  ];
}

export function describePlanSentence(terms: WalletTerms): string {
  const fee = formatFeeRate(terms.cardFundingFeeBps);
  const floor = formatWholeDollars(terms.floorCents);
  return terms.sourceRail === "stripe_card"
    ? `In one sentence: you keep ${floor} in your wallet, refilled from your ${terms.sourceLabel} at ${fee}; the same card covers any shortfall.`
    : `In one sentence: you keep ${floor} in your wallet, refilled from your bank for free; if an order ever needs more than what is there, your ${terms.backupLabel} covers the shortfall plus ${fee}.`;
}

// ---------------------------------------------------------------------------
// Acknowledgement and request builders (spec §1.5, §4.3)
// ---------------------------------------------------------------------------

export interface AcknowledgementForSave {
  acknowledgedCardFeeBps: number;
  saveLabel: string;
  /** Shown above Save when the rate changed since the record: this save confirms nothing. */
  feeChangeNote: string | null;
}

/** The rate an ordinary save carries: the record when one exists (never a confirmation), else the rate in force. */
export function acknowledgementForSave(input: {
  autoReload: DropshipWalletView["autoReload"];
  cardFundingFeeBps: number;
}): AcknowledgementForSave {
  const recorded = input.autoReload?.acknowledgedCardFeeBps ?? null;
  const inForce = formatFeeRate(input.cardFundingFeeBps);
  if (recorded === null) {
    return { acknowledgedCardFeeBps: input.cardFundingFeeBps, saveLabel: `Save and accept the ${inForce} card fee`, feeChangeNote: null };
  }
  if (recorded !== input.cardFundingFeeBps) {
    return {
      acknowledgedCardFeeBps: recorded,
      saveLabel: "Save",
      feeChangeNote: `The card fee is now ${inForce} (you agreed to ${formatFeeRate(recorded)}). Automatic top-ups and covers stay at ${formatFeeRate(recorded)} until you confirm the new terms above; this save does not change that.`,
    };
  }
  return { acknowledgedCardFeeBps: recorded, saveLabel: "Save", feeChangeNote: null };
}

export interface WalletPlanInput {
  fundingMethodId: number;
  backupFundingMethodId: number;
  floorCents: number;
  limitCents: number;
  holdTimeoutMinutes: number;
}

function assertPlan(plan: WalletPlanInput, limits: WalletLimits): void {
  if (!Number.isSafeInteger(plan.fundingMethodId) || plan.fundingMethodId <= 0) throw new Error("A top-up source is required.");
  if (!Number.isSafeInteger(plan.backupFundingMethodId) || plan.backupFundingMethodId <= 0) throw new Error("A backup card is required.");
  assertCents(plan.floorCents, "floorCents");
  assertCents(plan.limitCents, "limitCents");
  if (plan.floorCents < limits.autoReloadMinTriggerCents) throw new Error(`The floor must be at least ${formatWholeDollars(limits.autoReloadMinTriggerCents)}.`);
  if (plan.limitCents < plan.floorCents) throw new Error("The single top-up limit must be at least your floor.");
  if (plan.limitCents < limits.autoReloadMinAmountCents) throw new Error(`The single top-up limit must be at least ${formatWholeDollars(limits.autoReloadMinAmountCents)}.`);
  if (!Number.isSafeInteger(plan.holdTimeoutMinutes) || plan.holdTimeoutMinutes < 1) throw new Error("The hold time must be at least one minute.");
}

/** Step 5: the one PUT that turns auto-reload on; always carries the rate in force. */
export function buildAuthorizeInput(plan: WalletPlanInput, wallet: Pick<DropshipWalletView, "cardFundingFeeBps" | "limits">): DropshipAutoReloadConfigInput {
  assertPlan(plan, wallet.limits);
  return {
    enabled: true,
    fundingMethodId: plan.fundingMethodId,
    backstopFundingMethodId: plan.backupFundingMethodId,
    minimumBalanceCents: plan.floorCents,
    maxSingleReloadCents: plan.limitCents,
    paymentHoldTimeoutMinutes: plan.holdTimeoutMinutes,
    acknowledgedCardFeeBps: wallet.cardFundingFeeBps,
  };
}

/** A manage-mode Save: the whole row with the acknowledgement rule of `acknowledgementForSave`. */
export function buildPlanSaveInput(plan: WalletPlanInput, wallet: Pick<DropshipWalletView, "cardFundingFeeBps" | "limits" | "autoReload">): DropshipAutoReloadConfigInput {
  assertPlan(plan, wallet.limits);
  return {
    enabled: true,
    fundingMethodId: plan.fundingMethodId,
    backstopFundingMethodId: plan.backupFundingMethodId,
    minimumBalanceCents: plan.floorCents,
    maxSingleReloadCents: plan.limitCents,
    paymentHoldTimeoutMinutes: plan.holdTimeoutMinutes,
    acknowledgedCardFeeBps: acknowledgementForSave({ autoReload: wallet.autoReload, cardFundingFeeBps: wallet.cardFundingFeeBps }).acknowledgedCardFeeBps,
  };
}

/** Confirm terms: the same values, the rate in force; the only manage-mode write that moves the record. */
export function buildConfirmTermsInput(plan: WalletPlanInput, wallet: Pick<DropshipWalletView, "cardFundingFeeBps" | "limits">): DropshipAutoReloadConfigInput {
  return buildAuthorizeInput(plan, wallet);
}

/** Turn auto-reload off while keeping the saved amounts; the acknowledgement is withdrawn with it. */
export function buildAutoReloadDisableInput(wallet: Pick<DropshipWalletView, "autoReload" | "limits">): DropshipAutoReloadConfigInput {
  const existing = wallet.autoReload;
  return {
    enabled: false,
    fundingMethodId: existing?.fundingMethodId ?? null,
    backstopFundingMethodId: existing?.backstopFundingMethodId ?? null,
    minimumBalanceCents: existing?.minimumBalanceCents ?? 25_000,
    maxSingleReloadCents: existing?.maxSingleReloadCents ?? null,
    paymentHoldTimeoutMinutes: existing?.paymentHoldTimeoutMinutes ?? wallet.limits.defaultPaymentHoldTimeoutMinutes,
    acknowledgedCardFeeBps: null,
  };
}

/** The saved plan as an editable input, or null when nothing is authorized. */
export function planFromWallet(wallet: DropshipWalletView): WalletPlanInput | null {
  const autoReload = wallet.autoReload;
  if (!autoReload || !autoReload.enabled || autoReload.fundingMethodId === null || autoReload.backstopFundingMethodId === null) return null;
  return {
    fundingMethodId: autoReload.fundingMethodId,
    backupFundingMethodId: autoReload.backstopFundingMethodId,
    floorCents: autoReload.minimumBalanceCents,
    limitCents: autoReload.maxSingleReloadCents ?? derivedLimitCents(autoReload.minimumBalanceCents, wallet.limits),
    holdTimeoutMinutes: autoReload.paymentHoldTimeoutMinutes,
  };
}

/** Switching the source to a card makes that card the backup (client invariant); to a bank keeps the chosen backup. */
export function planAfterSourceChange(plan: WalletPlanInput, newSource: WalletFundingMethod, chosenBackupId: number | null): WalletPlanInput {
  if (newSource.rail === "stripe_card") return { ...plan, fundingMethodId: newSource.fundingMethodId, backupFundingMethodId: newSource.fundingMethodId };
  return { ...plan, fundingMethodId: newSource.fundingMethodId, backupFundingMethodId: chosenBackupId ?? plan.backupFundingMethodId };
}

/** "Your backup card becomes Visa ending in 9999 (was Visa ending in 4242)." when a source switch moves the backup. */
export function describeBackupFollow(previousBackup: WalletFundingMethod | null, newSource: WalletFundingMethod): string | null {
  if (newSource.rail !== "stripe_card") return "Choose your backup card below.";
  if (previousBackup && previousBackup.fundingMethodId === newSource.fundingMethodId) return null;
  const was = previousBackup ? ` (was ${describeFundingMethod(previousBackup)})` : "";
  return `Your backup card becomes ${describeFundingMethod(newSource)}${was}.`;
}

export function buildRemoveFundingMethodPath(fundingMethodId: number): string {
  if (!Number.isSafeInteger(fundingMethodId) || fundingMethodId <= 0) throw new Error("fundingMethodId must be a positive whole number.");
  return `/api/dropship/wallet/funding-methods/${fundingMethodId}`;
}

/** The exact server reason a removal would be refused, so the click never fails for a reason the page already knows. */
export function disabledReasonForRemoval(method: WalletFundingMethod, canTurnOffAutoReload: boolean): string | null {
  const suffix = canTurnOffAutoReload ? " — or turn off auto-reload." : "";
  if (method.roles.isBackupCard) return `This is your backup card — choose another backup card first, then remove this one.${suffix}`;
  if (method.roles.isAutoReloadSource) return `This is your top-up source — choose another source first, then remove this one.${suffix}`;
  return null;
}

/** The instrument a deposit is paid with: the configured source when its rail matches, else the newest active method of that rail. */
export function depositFundingMethodFor(wallet: DropshipWalletView, rail: WalletSourceRail): WalletFundingMethod | null {
  const configuredId = wallet.autoReload?.enabled ? wallet.autoReload.fundingMethodId : null;
  const active = activeMethodsOfRail(wallet, rail);
  return active.find((method) => method.fundingMethodId === configuredId) ?? active[0] ?? null;
}

/** Copy for the Limits editor's hold-time line: only orders held from now on take the new deadline. */
export function describeHoldTimeLine(holdExpiryWarningMinutes: number): string {
  return `How long a waiting order stays open before it is cancelled, for orders held from now on — an order already waiting keeps the deadline it was given. We email you ${formatDurationMinutes(holdExpiryWarningMinutes)} before.`;
}

/** Copy for the pending-balance line. */
export function describePendingBalance(pendingCents: number): string {
  return `${formatWholeDollars(pendingCents)} on the way — a bank transfer takes ${BANK_SETTLEMENT_PHRASE} to land; this money cannot pay orders yet.`;
}

/** The role-warning texts (spec §2.8); they name no card label, because the view does not identify the archived card. */
export function describeRoleGap(gap: "backupCard" | "source", input: { holdTimeoutMinutes: number; holdExpiryWarningMinutes: number }): string {
  if (gap === "backupCard") {
    return `Backup card needed — your backup card was removed at Stripe or can no longer be charged. Until you choose one, an order your balance cannot cover waits for you to add money and is cancelled after ${formatDurationMinutes(input.holdTimeoutMinutes)} (we email you ${formatDurationMinutes(input.holdExpiryWarningMinutes)} before).`;
  }
  return "Top-up source needed — your top-up source was removed at Stripe or can no longer be charged, so routine top-ups are not running. Held orders are still covered by your backup card. Choose another source.";
}

/** The acknowledgement banner's three faces (spec §2.8). */
export function describeAcknowledgementBanner(input: { feeChange: { recordedBps: number; currentBps: number } | null; onboarding: boolean }): string {
  if (!input.feeChange) {
    return `Please review and confirm your auto-reload terms. Nothing changes until you confirm.${input.onboarding ? " You cannot activate until you do." : ""}`;
  }
  const recorded = formatFeeRate(input.feeChange.recordedBps);
  const current = formatFeeRate(input.feeChange.currentBps);
  if (input.feeChange.currentBps > input.feeChange.recordedBps) {
    return `Card Shellz changed the card fee from ${recorded} to ${current}. Until you confirm, automatic top-ups and covers stay at ${recorded}; money you add yourself shows the current fee on Stripe's page before you pay.`;
  }
  return `Card Shellz lowered the card fee from ${recorded} to ${current}. Automatic charges already use the lower rate; confirm to keep your record current.`;
}

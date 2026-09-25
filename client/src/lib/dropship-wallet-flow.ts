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
  chargeBoundCents,
  firstFillFeeCents,
  formatDurationMinutes,
  formatPoints,
  formatSignedCents,
  formatWholeDollars,
  shortfallExample,
  type WalletSourceRail,
} from "./dropship-wallet-guidance";
import type {
  DropshipWalletView,
  WalletFundingMethod,
  WalletLedgerEntry,
  WalletLedgerReason,
  WalletLimits,
  WalletAdvance,
  WalletAdvanceReason,
  WalletRewardsNextExpiry,
  WalletUsdcDeposit,
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
  // The optional top-up amount (funding design phase 5); null is "the minimum".
  // Defaulted so a draft written before it existed still parses.
  topUpCents: optionalCents.default(null),
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
  topUpCents: null,
  backupMethodId: null,
  pendingStripe: null,
  deposit: null,
  stepOverride: null,
}) as WalletDraft;

/** A malformed or foreign draft is discarded, never repaired: a lost draft costs one re-pick, nothing more. */
export function parseWalletDraft(raw: unknown): WalletDraft | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = walletDraftSchema.safeParse(withoutRetiredDraftKeys(JSON.parse(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Keys a v1 draft once carried and the schema no longer has. `dailyCostCents`
 * was the vendor's own daily order cost, which drove a recommended minimum
 * until the step became the two tier minimums; a draft written with it still
 * reads, minus the key, so a vendor mid-setup loses nothing.
 */
function withoutRetiredDraftKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { dailyCostCents: _retired, ...rest } = value as Record<string, unknown>;
  return rest;
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

/** USDC is offered when the vendor can be handed their own address, or a shared one is configured. */
export function usdcOfferedFor(wallet: Pick<DropshipWalletView, "usdcDeposit" | "usdcBaseDepositAddress">): boolean {
  return wallet.usdcDeposit?.offered === true || wallet.usdcBaseDepositAddress !== null;
}

function confirmationsPhrase(count: number): string {
  return `${count} confirmation${count === 1 ? "" : "s"}`;
}

/** The intro's USDC sentence, leading with a space so it appends to the ways-to-pay detail; empty when USDC is not offered. */
export function describeUsdcIntroSentence(deposit: WalletUsdcDeposit | null, sharedOffered: boolean): string {
  if (deposit?.offered) {
    return deposit.watched
      ? ` USDC on Base costs nothing: a transfer to your own deposit address shows in your wallet after ${confirmationsPhrase(deposit.minConfirmations)} and is available once the network settles it.`
      : " USDC on Base costs nothing; a member of our team credits a transfer to your own deposit address after confirming it.";
  }
  return sharedOffered ? " USDC costs nothing." : "";
}

/**
 * The deposit panel's words: the timing the watcher enforces (or the manual
 * credit when nothing watches the chain) and the one warning that matters,
 * because a token or network other than USDC on Base cannot be recovered.
 */
export function describeUsdcDeposit(deposit: WalletUsdcDeposit): { timing: string; warning: string } {
  return {
    timing: deposit.watched
      ? `No fee. A transfer shows in your wallet after ${confirmationsPhrase(deposit.minConfirmations)} and is available for orders once the network settles it — usually within a few minutes (our estimate).`
      : "No fee. A member of the Card Shellz team credits your wallet after confirming the transfer — this is not instant.",
    warning: "Send only USDC on the Base network to this address. Anything else sent here cannot be recovered.",
  };
}

/** The setup step's aside about USDC: what it is good for and why it can never be the autopay source. */
export function describeUsdcSourceNote(deposit: WalletUsdcDeposit | null): string {
  if (deposit?.offered && deposit.watched) {
    return "Prefer USDC? It costs nothing: send USDC on Base to your own deposit address under Add money and it lands in your wallet on its own. It cannot be pulled, so it can never be your autopay source.";
  }
  if (deposit?.offered) {
    return "Prefer USDC? It costs nothing: send USDC on Base to your own deposit address under Add money and a member of our team credits your wallet after confirming the transfer. It cannot be pulled, so it can never be your autopay source.";
  }
  return "Prefer USDC? It is free too, but manual: you send USDC on Base to Card Shellz's deposit address and a member of our team credits your wallet after confirming the transfer. Because it cannot be pulled automatically, it can never be your autopay source. Use it any time under Add money.";
}

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
  advance_fee: "Fee for paying an order from money on its way",
  funding_reversed: "Payment reversed by your bank",
  funding_reinstated: "Reversed payment returned",
  rewards_earned: "Rewards earned",
  rewards_spent: "Rewards used on an order",
  rewards_reversed: "Rewards taken back with a reversed payment",
  rewards_reinstated: "Rewards returned",
  rewards_expired: "Rewards expired",
  return_fee: "Return fee",
  return_credit: "Return credit",
  insurance_pool_credit: "Insurance pool credit",
  other: "Other",
});

// ---------------------------------------------------------------------------
// Rewards (funding design phase 7): points earned on bank and USDC transfers
// when they land, at the per-rail rates the server serves, 100 points per
// dollar (one point per cent, so the stored cents are the points). They are
// used only on .ops orders, and only once the vendor chooses to auto-apply
// them; until then they are saved. Auto-apply is never a default. Staff may
// set an expiry (migration 0705): points keep the setting they were earned
// under, and the ones closest to expiring are used first.
// ---------------------------------------------------------------------------

/** The ledger kinds that move the rewards balance rather than the cash balance. */
export const REWARDS_LEDGER_REASONS: ReadonlySet<WalletLedgerReason> = new Set<WalletLedgerReason>([
  "rewards_earned", "rewards_spent", "rewards_reversed", "rewards_reinstated", "rewards_expired",
]);

export type WalletRewardsRates = Pick<WalletLimits, "rewardsRateBankBps" | "rewardsRateUsdcBps" | "rewardsRateCardBps">;
/** The rates and the expiry setting: everything the rules sentence states. */
export type WalletRewardsRules = WalletRewardsRates & Pick<WalletLimits, "rewardsExpiryDays">;

/** The server's bound on the expiry setting (domain/wallet-rewards-expiry.ts): ten years. */
const MAX_REWARDS_EXPIRY_DAYS = 3_650;
export type WalletRewardsRail = WalletSourceRail | "usdc_base";

const REWARDS_RATE_FIELDS = ["rewardsRateBankBps", "rewardsRateUsdcBps", "rewardsRateCardBps"] as const;

/** Only the three rates are checked: callers pass the whole served limits object, which carries other fields. */
function assertRewardsRates(rates: WalletRewardsRates): void {
  for (const field of REWARDS_RATE_FIELDS) {
    const value = rates[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative integer number of basis points, got ${value}`);
  }
}

/** True while any way to pay earns rewards; with every rate at zero the program is off and nothing mentions it. */
export function rewardsOffered(rates: WalletRewardsRates): boolean {
  assertRewardsRates(rates);
  return rates.rewardsRateBankBps > 0 || rates.rewardsRateUsdcBps > 0 || rates.rewardsRateCardBps > 0;
}

function rewardsRateForRail(rail: WalletRewardsRail, rates: WalletRewardsRates): number {
  if (rail === "stripe_ach") return rates.rewardsRateBankBps;
  if (rail === "usdc_base") return rates.rewardsRateUsdcBps;
  return rates.rewardsRateCardBps;
}

/**
 * One bullet for the way to pay the vendor picked: what it earns, and when
 * (a bank or USDC transfer earns once it lands; a card charge, at once).
 * A rail that earns nothing says so only while another rail earns, and
 * nothing at all is said when the program is off.
 */
export function describeRewardsEarning(rail: WalletRewardsRail, rates: WalletRewardsRates): string | null {
  if (!rewardsOffered(rates)) return null;
  const bps = rewardsRateForRail(rail, rates);
  if (bps === 0) return "Earns no rewards points.";
  const rate = formatFeeRate(bps);
  if (rail === "stripe_card") return `Earns ${rate} in rewards points, at once.`;
  if (rail === "usdc_base") return `Earns ${rate} in rewards points once the transfer settles.`;
  return `Earns ${rate} in rewards points once it lands.`;
}

/**
 * The rewards rule for the rules page: the per-rail rates, what a point is
 * worth, how points are used, when they expire, and what they can never do.
 * Empty when the program is off. The rates are named per rail whenever they
 * differ, and as one rate when bank and USDC match (the launch setting: "bank
 * and USDC earn 1%").
 */
export function describeRewardsRule(rates: WalletRewardsRules, usdcOffered: boolean): string {
  if (!rewardsOffered(rates)) return "";
  const expiry = describeRewardsExpiryRule(rates.rewardsExpiryDays);
  const bank = formatFeeRate(rates.rewardsRateBankBps);
  const usdc = formatFeeRate(rates.rewardsRateUsdcBps);
  const card = formatFeeRate(rates.rewardsRateCardBps);
  // USDC is named only where the vendor can pay with it, like the rest of the rules page.
  const earning = !usdcOffered
    ? `A bank transfer earns ${bank} in rewards points when it lands`
    : rates.rewardsRateBankBps === rates.rewardsRateUsdcBps
      ? `Bank and USDC transfers earn ${bank} in rewards points when they land`
      : `A bank transfer earns ${bank} in rewards points when it lands, a USDC transfer ${usdc}`;
  const cardClause = rates.rewardsRateCardBps > 0 ? `a card charge earns ${card} at once` : "a card charge earns none";
  return ` ${earning}; ${cardClause}. ${REWARDS_POINTS_SENTENCE} Points are used only on your orders here, and only once you choose in Wallet to auto-apply them; until you choose, they are saved up. ${expiry} They are not cash: they cannot be paid out, do not count toward your minimum, and a payment your bank takes back takes its points back too.`;
}

/**
 * What happens to points earned from now on (migration 0705). Points keep the
 * setting they were earned under, so the sentence speaks of new points; the
 * next-expiry line under the points figure says what is actually due.
 */
export function describeRewardsExpiryRule(rewardsExpiryDays: number | null): string {
  if (rewardsExpiryDays === null) return "New points do not expire.";
  if (!Number.isSafeInteger(rewardsExpiryDays) || rewardsExpiryDays < 1 || rewardsExpiryDays > MAX_REWARDS_EXPIRY_DAYS) {
    throw new RangeError(`rewardsExpiryDays must be null or a whole number of days from 1 to ${MAX_REWARDS_EXPIRY_DAYS}, got ${rewardsExpiryDays}`);
  }
  const days = `${rewardsExpiryDays.toLocaleString("en-US")} day${rewardsExpiryDays === 1 ? "" : "s"}`;
  return `New points expire ${days} after they are earned, and the points closest to expiring are used first.`;
}

/**
 * The soonest points leave the balance unless used, for the line under the
 * points figure, or null when none are set to expire. The date is the
 * viewer's own calendar date of the expiry instant (`timeZone` pins it for a
 * test). Points past their instant stay in the balance until the wallet run
 * removes them, and the line says so rather than showing a date gone by as
 * still ahead.
 */
export function describeRewardsNextExpiry(
  next: WalletRewardsNextExpiry | null,
  options: { now: Date; timeZone?: string },
): string | null {
  if (next === null) return null;
  if (!Number.isSafeInteger(next.cents) || next.cents <= 0) {
    throw new RangeError(`next expiry cents must be a positive safe integer, got ${next.cents}`);
  }
  const expiresAt = new Date(next.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) throw new RangeError(`next expiry expiresAt must be a valid instant, got ${next.expiresAt}`);
  const date = expiresAt.toLocaleDateString("en-US", { timeZone: options.timeZone, year: "numeric", month: "long", day: "numeric" });
  const amount = `${formatPoints(next.cents)} (${formatSignedCents(next.cents)})`;
  const plural = next.cents !== 1;
  if (expiresAt.getTime() <= options.now.getTime()) {
    return `${amount} reached ${plural ? "their" : "its"} expiry date on ${date} and ${plural ? "are" : "is"} being removed.`;
  }
  return `${amount} ${plural ? "expire" : "expires"} on ${date}.`;
}

/** The one sentence that names the unit, worded once and quoted wherever points are explained. */
export const REWARDS_POINTS_SENTENCE = "100 points are worth $1 on your orders.";

/**
 * The line under the points figure: what the vendor's choice is doing today,
 * or that no choice has been made yet (auto-apply is never assumed).
 */
export function describeRewardsUse(spendRewardsFirst: boolean | null): string {
  if (spendRewardsFirst === null) {
    return `Not chosen yet, so your points are saved up. Choose to auto-apply them to your orders, or keep saving them. ${REWARDS_POINTS_SENTENCE}`;
  }
  return spendRewardsFirst
    ? `Auto-applied to your orders before your cash. ${REWARDS_POINTS_SENTENCE}`
    : `Saved up: your cash pays for orders. Auto-apply them whenever you want to use them. ${REWARDS_POINTS_SENTENCE}`;
}

/** The request body of the choice: the server's flag is exactly the choice, true to auto-apply, false to save up. */
export function buildRewardsPreferenceInput(spendRewardsFirst: boolean): { spendRewardsFirst: boolean } {
  return { spendRewardsFirst };
}

export function describeRewardsPreferenceSaved(spendRewardsFirst: boolean): string {
  return spendRewardsFirst
    ? "Saved. Your points are auto-applied to your orders before your cash."
    : "Saved. Your points are kept; your cash pays for orders.";
}

/** The rewards figure as the vendor reads it: points first, the dollar value beside. */
export function describeRewardsBalance(rewardsBalanceCents: number): { points: string; value: string } {
  return { points: formatPoints(rewardsBalanceCents), value: formatSignedCents(rewardsBalanceCents) };
}

/** An activity row's amount in its own unit: points for a rewards row, money for every other row; a debit carries the minus. */
export function describeLedgerAmount(entry: Pick<WalletLedgerEntry, "reason" | "amountCents">): string {
  return REWARDS_LEDGER_REASONS.has(entry.reason) ? formatPoints(entry.amountCents) : formatSignedCents(entry.amountCents);
}

/**
 * Which balance an activity row's "balance after" figure belongs to: a
 * rewards row moved the rewards balance, every other row the cash balance.
 * Null when the row did not record the balance it moved.
 */
export function ledgerBalanceAfter(entry: Pick<WalletLedgerEntry, "reason" | "availableBalanceAfterCents" | "rewardsBalanceAfterCents">): { balance: "cash" | "rewards"; cents: number } | null {
  if (REWARDS_LEDGER_REASONS.has(entry.reason)) {
    return entry.rewardsBalanceAfterCents === null ? null : { balance: "rewards", cents: entry.rewardsBalanceAfterCents };
  }
  return entry.availableBalanceAfterCents === null ? null : { balance: "cash", cents: entry.availableBalanceAfterCents };
}

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

/**
 * The rail the source picker opens on when the vendor has not chosen one.
 *
 * Bank is the rail the page recommends (it carries no card fee), so it is also
 * the rail the page defaults to. A card already saved on the wallet does NOT
 * flip the default: defaulting to the more expensive rail because a card
 * happens to exist contradicts the recommendation shown beside it. The saved
 * card stays one click away and is named on screen.
 */
export const RECOMMENDED_SOURCE_RAIL: WalletSourceRail = "stripe_ach";

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
  /** The minimum the vendor keeps ("keep $X"). */
  floorCents: number;
  /** What each automatic refill pulls; null is the minimum. */
  topUpCents: number | null;
  /** The single-charge bound the server holds autopay to: max(minimum, top-up), or the stored one while nothing here changes the amounts. */
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

  const feeRecordMissing = authorized && autoReload.acknowledgedAt === null;
  const feeChange = autoReload && autoReload.acknowledgedCardFeeBps !== null && autoReload.acknowledgedCardFeeBps !== wallet.cardFundingFeeBps
    ? { recordedBps: autoReload.acknowledgedCardFeeBps, currentBps: wallet.cardFundingFeeBps }
    : null;
  // A banner is owed while the server says the agreement is missing or stale,
  // and after a fee cut too: the cut applies to unattended charges at once (the
  // record still covers the vendor), but the plan row points at the banner to
  // refresh it. A raise stays the server's verdict, never second-guessed here.
  const feeCut = feeChange !== null && feeChange.currentBps < feeChange.recordedBps;
  const needsAcknowledgement = done && (!wallet.setupStatus.acknowledged || feeCut);

  const sourceCandidates = wallet.fundingMethods.filter((method) => method.status === "active" && isSourceRail(method.rail));
  const configuredSource = authorized ? sourceCandidates.find((method) => method.fundingMethodId === autoReload.fundingMethodId) ?? null : null;
  const draftSource = draft.sourceMethodId === null ? null : sourceCandidates.find((method) => method.fundingMethodId === draft.sourceMethodId) ?? null;
  const sourceMethod = draftSource ?? configuredSource;
  const source = sourceMethod && isSourceRail(sourceMethod.rail) ? { rail: sourceMethod.rail, method: sourceMethod } : null;
  // Only a saved BANK account is preselected. A saved card is offered by name
  // (describeSavedCardAlternative) instead of being chosen for the vendor.
  const suggested = source ? null : (activeMethodsOfRail(wallet, RECOMMENDED_SOURCE_RAIL)[0] ?? null);

  const floorFromServer = authorized ? autoReload.minimumBalanceCents : null;
  const floorCents = draft.floorCents ?? floorFromServer ?? defaultMinimumCents(wallet);
  const floorValid = (draft.floorCents ?? floorFromServer) !== null && floorCents >= wallet.limits.autoReloadMinTriggerCents;

  const eligibleCards = wallet.fundingMethods.filter((method) => isEligibleBackupCard(method, now));
  const configuredBackup = authorized ? eligibleCards.find((method) => method.fundingMethodId === autoReload.backstopFundingMethodId) ?? null : null;
  const draftBackup = draft.backupMethodId === null ? null : eligibleCards.find((method) => method.fundingMethodId === draft.backupMethodId) ?? null;
  const backup = source?.rail === "stripe_card"
    ? { method: source.method, satisfiedBySource: true }
    : (draftBackup ?? configuredBackup) ? { method: (draftBackup ?? configuredBackup) as WalletFundingMethod, satisfiedBySource: false } : null;

  // The top-up amount: the draft's choice, else what the server holds; null means "the minimum".
  const topUpCents = draft.topUpCents ?? (authorized ? autoReload.topUpAmountCents : null);
  // The single-charge bound is the server's: the stored one while nothing here
  // changes the amounts, else the one it will derive from the new amounts.
  const amountsUntouched = draft.floorCents === null && draft.topUpCents === null;
  const limitCents = authorized && amountsUntouched && autoReload.maxSingleReloadCents !== null
    ? autoReload.maxSingleReloadCents
    : chargeBoundCents(floorCents, topUpCents);
  // The hold is set by staff for every wallet (the wallet policy governs at
  // acceptance time); the saved row's value is only what this client last
  // echoed back, so it is never what the vendor is shown.
  const holdTimeoutMinutes = wallet.limits.defaultPaymentHoldTimeoutMinutes;

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
    topUpCents,
    limitCents,
    holdTimeoutMinutes,
    roleGaps: { backupCard: authorized && !backupDesignated, source: authorized && !sourceDesignated },
    canTurnOffAutoReload: authorized && AUTO_RELOAD_OFF_ALLOWED_STATUSES.has(input.vendorStatus),
    authorized,
  };
}

// ---------------------------------------------------------------------------
// The minimum: one of the two tier minimums
// ---------------------------------------------------------------------------

export type WalletMinimumTier = "pack" | "case";

export interface WalletMinimumOption {
  tier: WalletMinimumTier;
  cents: number;
}

/**
 * The minimums a vendor can choose: the pack tier's and the case tier's, as
 * the served policy sets them. There is no third amount — the minimum exists
 * to decide what the vendor can sell, and those are the two gates. A policy
 * whose case minimum is not above the pack minimum degrades to the one option
 * rather than two that read the same.
 */
export function minimumOptions(limits: Pick<WalletLimits, "autoReloadMinTriggerCents" | "caseTierMinimumCents">): WalletMinimumOption[] {
  const pack: WalletMinimumOption = { tier: "pack", cents: limits.autoReloadMinTriggerCents };
  const cases: WalletMinimumOption = { tier: "case", cents: limits.caseTierMinimumCents };
  return cases.cents > pack.cents ? [pack, cases] : [pack];
}

/** What each option lets the vendor sell, shown under its amount. */
export function describeMinimumOption(tier: WalletMinimumTier): string {
  return tier === "pack" ? "Singles, packs and inner packs" : "Cases too";
}

/**
 * The option an amount reads as: the case minimum once it reaches it, else
 * the pack minimum. A minimum saved before the step offered only the two
 * tiers opens on the tier it falls in, and saving keeps that tier's amount.
 */
export function minimumOptionFor(cents: number, limits: Pick<WalletLimits, "autoReloadMinTriggerCents" | "caseTierMinimumCents">): number {
  assertCents(cents, "cents");
  const options = minimumOptions(limits);
  const highest = options[options.length - 1];
  return cents >= highest.cents ? highest.cents : options[0].cents;
}

/**
 * The minimum the step opens on when nothing is saved or drafted: the case
 * minimum while the vendor's case tier is on sale, because anything lower
 * would take cases off sale; otherwise the pack minimum.
 */
export function defaultMinimumCents(wallet: Pick<DropshipWalletView, "limits" | "listingTiers">): number {
  const options = minimumOptions(wallet.limits);
  const cases = options.find((option) => option.tier === "case");
  return wallet.listingTiers?.case.eligible && cases ? cases.cents : options[0].cents;
}

// ---------------------------------------------------------------------------
// The top-up amount: the minimum, a multiple of it, or an amount of the vendor's own
// ---------------------------------------------------------------------------

/** The quick picks offered beside the minimum itself, as multiples of it. */
export const TOP_UP_MULTIPLES = [2, 3, 5] as const;
export type TopUpMultiple = (typeof TOP_UP_MULTIPLES)[number];

export interface WalletTopUpOption {
  /** 1 is the minimum itself; the rest are multiples of it. */
  factor: 1 | TopUpMultiple;
  cents: number;
}

/**
 * The top-up amounts offered for a minimum: the minimum itself (what a blank
 * amount has always meant) and its multiples, recomputed whenever the minimum
 * changes so a vendor who picked "2×" keeps 2× of whatever minimum they settle
 * on. A multiple below the policy's smallest top-up is not offered; the
 * minimum itself always is.
 */
export function topUpOptions(minimumCents: number, limits: Pick<WalletLimits, "autoReloadMinAmountCents">): WalletTopUpOption[] {
  assertCents(minimumCents, "minimumCents");
  const multiples: WalletTopUpOption[] = TOP_UP_MULTIPLES
    .map((factor) => ({ factor, cents: minimumCents * factor }))
    .filter((option) => option.cents >= limits.autoReloadMinAmountCents);
  return [{ factor: 1, cents: minimumCents }, ...multiples];
}

/** What each quick pick is, under its amount. */
export function describeTopUpOption(option: WalletTopUpOption): string {
  return option.factor === 1 ? "Your minimum" : `${option.factor}× your minimum`;
}

export type WalletTopUpChoice =
  | { kind: "minimum" }
  | { kind: "multiple"; factor: TopUpMultiple }
  | { kind: "custom"; cents: number };

/**
 * How a saved top-up amount reads against a minimum: the minimum itself
 * (null, or the same number), one of its multiples, or the vendor's own
 * amount. The multiples are matched first so a saved 2× keeps following the
 * minimum rather than freezing as a custom number.
 */
export function topUpChoiceFor(savedTopUpCents: number | null, minimumCents: number): WalletTopUpChoice {
  assertCents(minimumCents, "minimumCents");
  if (savedTopUpCents === null || savedTopUpCents === minimumCents) return { kind: "minimum" };
  assertCents(savedTopUpCents, "savedTopUpCents");
  const factor = TOP_UP_MULTIPLES.find((candidate) => candidate * minimumCents === savedTopUpCents);
  return factor ? { kind: "multiple", factor } : { kind: "custom", cents: savedTopUpCents };
}

/** The amount a choice sends: null for the minimum (the server pulls the minimum), else the amount. */
export function topUpCentsFor(choice: WalletTopUpChoice, minimumCents: number): number | null {
  assertCents(minimumCents, "minimumCents");
  if (choice.kind === "minimum") return null;
  if (choice.kind === "multiple") return minimumCents * choice.factor;
  return choice.cents;
}

// ---------------------------------------------------------------------------
// Adding money: the top-up step's picks again, so the two cards agree
// ---------------------------------------------------------------------------

export interface WalletDepositOption {
  cents: number;
  /** 1 for the minimum, a multiple of it, or null for the vendor's own top-up amount when it is neither. */
  factor: WalletTopUpOption["factor"] | null;
}

/**
 * The amounts offered when adding money: the same picks as the top-up step
 * (the minimum and its multiples) plus the vendor's own top-up amount when it
 * is not one of them, so what autopay would pull is always on offer. Anything
 * outside the manual funding limits is left out; the vendor can still type an
 * amount of their own.
 */
export function depositOptions(input: {
  minimumCents: number;
  topUpCents: number | null;
  limits: Pick<WalletLimits, "autoReloadMinAmountCents" | "manualFundingMinCents" | "manualFundingMaxCents" | "cardFundingMinCents">;
  /** The way to pay: a card deposit has its own minimum (funding design phase 7). */
  rail: WalletSourceRail;
}): WalletDepositOption[] {
  const minCents = input.rail === "stripe_card" ? input.limits.cardFundingMinCents : input.limits.manualFundingMinCents;
  const picks: WalletDepositOption[] = [...topUpOptions(input.minimumCents, input.limits)];
  if (input.topUpCents !== null) {
    assertCents(input.topUpCents, "topUpCents");
    if (!picks.some((pick) => pick.cents === input.topUpCents)) picks.push({ factor: null, cents: input.topUpCents });
  }
  return picks
    .filter((pick) => pick.cents >= minCents && pick.cents <= input.limits.manualFundingMaxCents)
    .sort((left, right) => left.cents - right.cents);
}

/** What each pick is, under its amount. */
export function describeDepositOption(option: WalletDepositOption): string {
  return option.factor === null ? "Your top-up amount" : describeTopUpOption({ factor: option.factor, cents: option.cents });
}

/**
 * The pick the add-money controls open on: what autopay would pull next when
 * it is offered, else the minimum, else the smallest amount offered; null when
 * the limits leave nothing to offer and the vendor must type an amount.
 */
export function depositDefaultCents(options: readonly WalletDepositOption[], nextTopUpCents: number): number | null {
  assertCents(nextTopUpCents, "nextTopUpCents");
  const preferred = options.find((option) => option.cents === nextTopUpCents)
    ?? options.find((option) => option.factor === 1)
    ?? options[0];
  return preferred?.cents ?? null;
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

/**
 * Names a card already saved on the wallet while the picker sits on the
 * recommended bank rail with nothing selected. Without this the card is
 * invisible until the vendor clicks Card, which reads as if it were lost.
 */
export function describeSavedCardAlternative(input: {
  rail: WalletSourceRail;
  selected: WalletFundingMethod | null;
  cards: readonly WalletFundingMethod[];
}): string | null {
  if (input.rail !== RECOMMENDED_SOURCE_RAIL || input.selected !== null) return null;
  const card = input.cards[0];
  if (!card) return null;
  return `${describeFundingMethod(card)} is already saved. Choose Card to use it, or add a bank account and pay no fees.`;
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

/** Continue on the minimum step. */
export function draftAfterFloorChoice(draft: WalletDraft, floorCents: number, topUpCents: number | null): WalletDraft {
  assertCents(floorCents, "floorCents");
  if (topUpCents !== null) assertCents(topUpCents, "topUpCents");
  return { ...draft, stepOverride: null, floorCents, topUpCents };
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
  /** The minimum the vendor keeps. */
  floorCents: number;
  /** What each refill pulls; null is the minimum. */
  topUpCents: number | null;
  /** The single-charge bound on routine top-ups. */
  limitCents: number;
  /** The program's ceiling on any single payment (the policy's manual funding maximum). */
  chargeCeilingCents: number;
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
  return `Your first automatic top-up runs on the first daily check after you activate (about midnight UTC). Until it lands, orders are charged to your backup card${cardFeeAt(terms.cardFundingFeeBps)}. Adding money by card now avoids that.`;
}

/** The activation line for a given balance, in the words of what the code does today. */
export function describeActivationQuote(input: {
  terms: WalletTerms;
  availableCents: number;
  pendingCents: number;
}): string {
  const { terms } = input;
  const result = activationTopUp({
    sourceRail: terms.sourceRail,
    floorCents: terms.floorCents,
    topUpCents: terms.topUpCents,
    availableCents: input.availableCents,
    pendingCents: input.pendingCents,
    bps: terms.cardFundingFeeBps,
  });
  if (result.outcome === "not_needed") {
    return "Your balance already covers your minimum, so the first daily check after you activate starts no top-up.";
  }
  // The bound cut the pull short of the minimum: the next daily check continues.
  const more = result.partial ? " — the most autopay takes in one charge; the next daily check continues" : "";
  return terms.sourceRail === "stripe_card"
    ? `Balance now ${formatWholeDollars(input.availableCents)}, so the first daily check after you activate charges ${formatWholeDollars(result.chargedCents)} to ${terms.sourceLabel} (${terms.cardFundingFeeBps > 0 ? `${formatWholeDollars(result.amountCents)} plus ${formatWholeDollars(result.feeCents)} fee` : "no fee"}${more}), landing at once.`
    : `Balance now ${formatWholeDollars(input.availableCents)}, so the first daily check after you activate starts a ${formatWholeDollars(result.amountCents)} bank transfer from ${terms.sourceLabel}${more} (no fee; ${BANK_SETTLEMENT_PHRASE} to land). Until it lands, any shortfall goes to ${terms.backupLabel}${cardFeeAt(terms.cardFundingFeeBps)}.`;
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
 * "How your wallet works": six topics, each a lead sentence and its detail, in
 * the order a seller meets them — what the wallet is, what it lets you sell,
 * how it stays funded, what each way of paying costs, what covers a gap, and
 * what a failure does. The words are the deposit model's (funding design
 * phase 5): minimum, top-up amount, autopay, backup card.
 *
 * Every number quoted is a served value the server enforces: the card fee,
 * the two tier minimums, the grace period, the advance fee and cap, and the
 * hold time. Nothing the product does not enforce as a rule is quoted.
 *
 * USDC (funding design phase 6): with a deposit address of the vendor's own
 * and a chain watcher, the intro says what the watcher enforces — the
 * confirmations before a transfer shows and settlement at the network's safe
 * head — and nothing more. Without the watcher only the fee is stated, since
 * a staff member credits the transfer by hand.
 */
export function describeIntro(input: {
  cardFundingFeeBps: number;
  usdcOffered: boolean;
  /** The served deposit position; absent or null means only the shared address, if any. */
  usdcDeposit?: WalletUsdcDeposit | null;
  holdTimeoutMinutes: number;
  limits: WalletLimits;
}): WalletIntroCopy {
  const fee = formatFeeRate(input.cardFundingFeeBps);
  const hold = formatDurationMinutes(input.holdTimeoutMinutes);
  const pack = formatWholeDollars(input.limits.autoReloadMinTriggerCents);
  const cases = formatWholeDollars(input.limits.caseTierMinimumCents);
  const grace = `${input.limits.tierChangeGraceDays} day${input.limits.tierChangeGraceDays === 1 ? "" : "s"}`;
  const advanceFee = formatFeeRate(input.limits.advanceFeeBps);
  const advanceCap = formatWholeDollars(input.limits.advanceCapCents);
  const ceiling = formatWholeDollars(input.limits.manualFundingMaxCents);
  const usdc = describeUsdcIntroSentence(input.usdcDeposit ?? null, input.usdcOffered);
  const rewards = describeRewardsRule(input.limits, input.usdcOffered || (input.usdcDeposit?.offered ?? false));
  return {
    lede: "Your wallet is the deposit Card Shellz draws on for the orders you sell. Here is what it holds, what it lets you sell, how it stays funded, and what happens when a payment fails.",
    topics: [
      {
        lead: "What your wallet is.",
        detail: "A prepaid deposit Card Shellz holds for your store. Every order you accept is paid from it: the product cost plus shipping, with nothing added on top. A return fee comes out of it too, and so does a payment your bank takes back after it landed; either can take the balance below zero.",
      },
      {
        lead: "What you can sell, and the minimum it needs.",
        detail: `Singles, packs and inner packs are on sale while you keep at least ${pack} in your wallet. Cases are on sale once your balance, counting money on its way, has reached ${cases}. If Card Shellz raises a minimum you keep selling for ${grace} after the notice, then that tier comes off sale until you are back above it.`,
      },
      {
        lead: "Keeping it funded: your minimum and autopay.",
        detail: `You choose the minimum you keep — at least ${pack}, or ${cases} to sell cases. Whenever an order takes your balance below it, and at a daily check, autopay pulls a top-up from your bank account or card: your top-up amount, which is your minimum unless you set another, or more if that alone would not reach your minimum. Money already on its way counts, so the same gap is never pulled twice. Routine top-ups never take more than the larger of your minimum and your top-up amount in one charge. You can also add money yourself at any time.`,
      },
      {
        lead: "Ways to pay, and what each costs.",
        detail: `A bank account costs nothing and takes ${BANK_SETTLEMENT_DAYS_PHRASE} to land (our estimate). ${input.cardFundingFeeBps > 0 ? `A card lands at once and costs ${fee} on top of the amount, whether autopay charged it, you added money yourself, or it covered an order.` : `A card lands at once and costs nothing either; a card deposit is ${formatWholeDollars(input.limits.cardFundingMinCents)} or more.`}${usdc}${rewards}`,
      },
      {
        lead: "Orders while a transfer lands, and your backup card.",
        detail: `Money that has landed pays for orders first. A bank transfer still on its way can pay too, once the account it comes from qualifies — a business account, a balance we could read when it was linked, and one earlier transfer from it landed — for a ${advanceFee} fee on the amount used, at most ${advanceCap} outstanding at a time. If an order still needs more than your balance, we charge your backup card for the whole difference plus ${fee}, up to ${ceiling} in one payment, and send the order out. An order the card cannot cover waits ${hold} for you to add money, then is cancelled.`,
      },
      {
        lead: "If a payment fails or is taken back.",
        detail: `Selling pauses: your listings show nothing for sale, and orders already waiting are cancelled after your hold time (${hold}). We email you, and we do not retry the charge ourselves. A payment your bank takes back after it landed is taken out of your wallet the same way. Selling starts again on its own once your balance is back at your minimum.`,
      },
    ],
  };
}

export const INTRO_VERIFICATION_NOTE = "We will ask you to confirm it is you when you add your first account or card (a 6-digit code by email), again if setup takes longer than ten minutes, and once more if you add money.";

/** The top-up amount as the mandate names it: the vendor's, or the minimum. */
function topUpForTerms(terms: Pick<WalletTerms, "floorCents" | "topUpCents">): { cents: number; isMinimum: boolean } {
  const cents = terms.topUpCents ?? terms.floorCents;
  return { cents, isMinimum: cents === terms.floorCents };
}

/** The standing authorization, one numbered line per charge it allows. */
export function describeMandate(terms: WalletTerms): string[] {
  assertCents(terms.floorCents, "floorCents");
  assertCents(terms.limitCents, "limitCents");
  if (terms.topUpCents !== null) assertCents(terms.topUpCents, "topUpCents");
  const fee = formatFeeRate(terms.cardFundingFeeBps);
  const minimum = formatWholeDollars(terms.floorCents);
  const bound = formatWholeDollars(terms.limitCents);
  const ceiling = formatWholeDollars(terms.chargeCeilingCents);
  const topUp = topUpForTerms(terms);
  const topUpText = `${formatWholeDollars(topUp.cents)}${topUp.isMinimum ? " (your minimum)" : ""}`;
  const hold = formatDurationMinutes(terms.holdTimeoutMinutes);
  const warning = formatDurationMinutes(terms.holdExpiryWarningMinutes);
  const example = shortfallExample({ orderCents: EXAMPLE_SHORTFALL.orderCents, availableCents: EXAMPLE_SHORTFALL.availableCents, bps: terms.cardFundingFeeBps });
  const exampleText = `a ${formatWholeDollars(EXAMPLE_SHORTFALL.orderCents)} order with ${formatWholeDollars(EXAMPLE_SHORTFALL.availableCents)} available charges ${formatWholeDollars(example.shortfallCents)}${terms.cardFundingFeeBps > 0 ? ` + ${formatWholeDollars(example.feeCents)}` : ""}`;
  const belowZero = "If a return fee has taken your balance below zero, the shortfall includes that amount.";
  const boundLine = `Routine top-ups never take more than ${bound} in one charge — the larger of your minimum and your top-up amount. A held order is different: your backup card is charged its whole shortfall, up to ${ceiling}, the most any single payment may be. An order short by more than ${ceiling} is not charged: it waits for you to add money and is cancelled if still unpaid after ${hold}. We email you ${warning} before that.`;
  const termsLine = `While your account is active, autopay stays on; the source, minimum, top-up amount and backup card can be changed at any time in Wallet. ${terms.cardFundingFeeBps > 0 ? `The ${fee} card fee is the rate you agree to today for automatic top-ups and covers; if Card Shellz ever raises it, we ask you to confirm before charging those at the higher rate.` : "Card charges carry no fee today, and that is the rate you agree to for automatic top-ups and covers; if Card Shellz ever adds a fee, we ask you to confirm before charging one."} Money you add yourself shows the current fee on Stripe's page before you pay.`;

  if (terms.sourceRail === "stripe_card") {
    const fill = firstFillFeeCents(topUp.cents, terms.cardFundingFeeBps);
    return [
      terms.cardFundingFeeBps > 0
        ? `Charge ${terms.sourceLabel}, plus the ${fee} fee, whenever an order takes your balance below your minimum of ${minimum}, and at the daily check: your top-up amount of ${topUpText}, or more if that alone would not bring you back to ${minimum} (${formatWholeDollars(topUp.cents)} + ${formatWholeDollars(fill)} = ${formatWholeDollars(topUp.cents + fill)} for a routine top-up).`
        : `Charge ${terms.sourceLabel}, with no fee, whenever an order takes your balance below your minimum of ${minimum}, and at the daily check: your top-up amount of ${topUpText}, or more if that alone would not bring you back to ${minimum}.`,
      `${terms.sourceLabel} is also your backup card: while your account is active, an order needing more than your available balance is charged the shortfall${cardFeeOnTop(terms.cardFundingFeeBps)}, whatever its size (up to ${ceiling}), and goes out at once; the next routine top-up then brings the balance back to ${minimum}${terms.cardFundingFeeBps > 0 ? ` (also plus ${fee})` : " (no fee)"}. Example: ${exampleText}. ${belowZero}`,
      boundLine,
      `${describeActivationTopUp(terms)} Once it runs, it charges ${terms.sourceLabel} your top-up amount (${formatWholeDollars(topUp.cents)}), or more if that alone would not reach ${minimum} — unless you add money first.`,
      `Pause selling if a charge is declined, or a bank transfer you started is returned before it lands, and resume on its own once your balance is back to ${minimum}. We do not retry the failed charge ourselves; if a top-up fails for any other reason, we email you.`,
      termsLine,
    ];
  }
  return [
    `Debit ${terms.sourceLabel} whenever an order takes your balance below your minimum of ${minimum}, and at the daily check: your top-up amount of ${topUpText}, or more if that alone would not bring you back to ${minimum}. No fee. Money already on its way counts, so the same gap is not debited twice.`,
    `While your account is active, charge ${terms.backupLabel} only when an order needs more than your available balance: the shortfall${terms.cardFundingFeeBps > 0 ? ` plus the ${fee} card fee` : " with no card fee"}, whatever its size (up to ${ceiling}), and accept the order at once — even while a bank top-up is still landing or your autopay source cannot be charged. Example: ${exampleText}. Money still on its way counts only through the pending-transfer advance, when your account qualifies for it. ${belowZero}`,
    boundLine,
    `${describeActivationTopUp(terms)} Once it runs, it debits ${terms.sourceLabel} for your top-up amount (${formatWholeDollars(topUp.cents)}), or more if that alone would not reach ${minimum}, and that transfer takes ${BANK_SETTLEMENT_PHRASE} to land; a bank transfer you start now helps once it lands.`,
    `Pause selling if a top-up is declined or a bank transfer is returned before it lands, and resume on its own once settled money brings your balance back to ${minimum}. We do not retry the failed charge ourselves; if a top-up fails for any other reason, we email you.`,
    termsLine,
  ];
}

export function describePlanSentence(terms: WalletTerms): string {
  const fee = formatFeeRate(terms.cardFundingFeeBps);
  const minimum = formatWholeDollars(terms.floorCents);
  const topUp = formatWholeDollars(topUpForTerms(terms).cents);
  return terms.sourceRail === "stripe_card"
    ? `In one sentence: you keep ${minimum} in your wallet, topped up by ${topUp} from your ${terms.sourceLabel}${cardFeeAt(terms.cardFundingFeeBps)}; the same card covers any shortfall.`
    : `In one sentence: you keep ${minimum} in your wallet; when an order takes it lower, autopay pulls ${topUp} from your bank for free, and your ${terms.backupLabel} covers any shortfall${cardFeeOnTop(terms.cardFundingFeeBps)}.`;
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
  const current = input.cardFundingFeeBps;
  if (recorded === null) {
    return {
      acknowledgedCardFeeBps: current,
      saveLabel: current > 0 ? `Save and accept the ${formatFeeRate(current)} card fee` : "Save and accept the card terms (no fee)",
      feeChangeNote: null,
    };
  }
  if (recorded !== current) {
    // A raise waits for the vendor's word; a cut applies to unattended charges
    // at once (the server holds them to the lower of the two rates).
    return {
      acknowledgedCardFeeBps: recorded,
      saveLabel: "Save",
      feeChangeNote: current > recorded
        ? `Card charges now carry ${cardFeeNoun(current)} (you agreed to ${cardFeeNoun(recorded)}). Automatic top-ups and covers ${recorded > 0 ? `stay at ${formatFeeRate(recorded)}` : "stay free"} until you confirm the new terms above; this save does not change that.`
        : `Card charges now carry ${cardFeeNoun(current)} (you agreed to ${cardFeeNoun(recorded)}); automatic top-ups and covers already use the lower rate. Confirm the new terms above when you like; this save keeps your record as it is.`,
    };
  }
  return { acknowledgedCardFeeBps: recorded, saveLabel: "Save", feeChangeNote: null };
}

export interface WalletPlanInput {
  fundingMethodId: number;
  backupFundingMethodId: number;
  /** The minimum the vendor keeps. */
  floorCents: number;
  /** What each refill pulls; null is the minimum. */
  topUpCents: number | null;
  /** The single-charge bound, for copy only: the server derives and stores its own. */
  limitCents: number;
  holdTimeoutMinutes: number;
}

function assertPlan(plan: WalletPlanInput, limits: WalletLimits): void {
  if (!Number.isSafeInteger(plan.fundingMethodId) || plan.fundingMethodId <= 0) throw new Error("An autopay source is required.");
  if (!Number.isSafeInteger(plan.backupFundingMethodId) || plan.backupFundingMethodId <= 0) throw new Error("A backup card is required.");
  assertCents(plan.floorCents, "floorCents");
  assertCents(plan.limitCents, "limitCents");
  if (plan.floorCents < limits.autoReloadMinTriggerCents) throw new Error(`Your minimum must be at least ${formatWholeDollars(limits.autoReloadMinTriggerCents)}.`);
  if (plan.topUpCents !== null) {
    assertCents(plan.topUpCents, "topUpCents");
    if (plan.topUpCents < limits.autoReloadMinAmountCents) throw new Error(`The top-up amount must be at least ${formatWholeDollars(limits.autoReloadMinAmountCents)}.`);
  }
  if (!Number.isSafeInteger(plan.holdTimeoutMinutes) || plan.holdTimeoutMinutes < 1) throw new Error("The hold time must be at least one minute.");
}

/** Step 5: the one PUT that turns autopay on; always carries the rate in force. The bound is never sent: the server derives it. */
export function buildAuthorizeInput(plan: WalletPlanInput, wallet: Pick<DropshipWalletView, "cardFundingFeeBps" | "limits">): DropshipAutoReloadConfigInput {
  assertPlan(plan, wallet.limits);
  return {
    enabled: true,
    fundingMethodId: plan.fundingMethodId,
    backstopFundingMethodId: plan.backupFundingMethodId,
    minimumBalanceCents: plan.floorCents,
    topUpAmountCents: plan.topUpCents,
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
    topUpAmountCents: plan.topUpCents,
    paymentHoldTimeoutMinutes: plan.holdTimeoutMinutes,
    acknowledgedCardFeeBps: acknowledgementForSave({ autoReload: wallet.autoReload, cardFundingFeeBps: wallet.cardFundingFeeBps }).acknowledgedCardFeeBps,
  };
}

/** Confirm terms: the same values, the rate in force; the only manage-mode write that moves the record. */
export function buildConfirmTermsInput(plan: WalletPlanInput, wallet: Pick<DropshipWalletView, "cardFundingFeeBps" | "limits">): DropshipAutoReloadConfigInput {
  return buildAuthorizeInput(plan, wallet);
}

/** Turn autopay off while keeping the saved amounts; the acknowledgement is withdrawn with it. */
export function buildAutoReloadDisableInput(wallet: Pick<DropshipWalletView, "autoReload" | "limits">): DropshipAutoReloadConfigInput {
  const existing = wallet.autoReload;
  return {
    enabled: false,
    fundingMethodId: existing?.fundingMethodId ?? null,
    backstopFundingMethodId: existing?.backstopFundingMethodId ?? null,
    // No saved amount to keep: the policy's pack minimum, the same the step opens on.
    minimumBalanceCents: existing?.minimumBalanceCents ?? wallet.limits.autoReloadMinTriggerCents,
    topUpAmountCents: existing?.topUpAmountCents ?? null,
    paymentHoldTimeoutMinutes: wallet.limits.defaultPaymentHoldTimeoutMinutes,
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
    topUpCents: autoReload.topUpAmountCents,
    limitCents: autoReload.maxSingleReloadCents ?? chargeBoundCents(autoReload.minimumBalanceCents, autoReload.topUpAmountCents),
    holdTimeoutMinutes: wallet.limits.defaultPaymentHoldTimeoutMinutes,
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
  const suffix = canTurnOffAutoReload ? " — or turn off autopay." : "";
  if (method.roles.isBackupCard) return `This is your backup card — choose another backup card first, then remove this one.${suffix}`;
  if (method.roles.isAutoReloadSource) return `This is your autopay source — choose another source first, then remove this one.${suffix}`;
  return null;
}

/** The instrument a deposit is paid with: the configured source when its rail matches, else the newest active method of that rail. */
export function depositFundingMethodFor(wallet: DropshipWalletView, rail: WalletSourceRail): WalletFundingMethod | null {
  const configuredId = wallet.autoReload?.enabled ? wallet.autoReload.fundingMethodId : null;
  const active = activeMethodsOfRail(wallet, rail);
  return active.find((method) => method.fundingMethodId === configuredId) ?? active[0] ?? null;
}

/**
 * The words for the card fee on a vendor surface (funding design phase 7):
 * every sentence that names the fee goes through these, so the wallet says
 * "no fee" at zero and never "0% fee". `describeCardFee` is the label form
 * ("3% fee" / "no fee"), `cardFeeNoun` the sentence form ("a 3% fee" / "no
 * fee"), `cardFeeOnTop` the clause after an amount (" plus 3%" / nothing) and
 * `cardFeeAt` the clause after a charge (" at 3%" / " with no fee").
 */
export function describeCardFee(bps: number): string {
  return bps > 0 ? `${formatFeeRate(bps)} fee` : "no fee";
}

export function cardFeeNoun(bps: number): string {
  return bps > 0 ? `a ${formatFeeRate(bps)} fee` : "no fee";
}

export function cardFeeOnTop(bps: number): string {
  return bps > 0 ? ` plus ${formatFeeRate(bps)}` : "";
}

export function cardFeeAt(bps: number): string {
  return bps > 0 ? ` at ${formatFeeRate(bps)}` : " with no fee";
}

/** What the add-money step tells the vendor about the way to pay they picked (funding design phase 7). */
export interface DepositRailNotesInput {
  rail: WalletSourceRail;
  cardFundingFeeBps: number;
  /** The card a short order is charged to while a bank transfer is still landing. */
  backupLabel: string;
  /** The smallest card deposit (the policy's card minimum); bank deposits keep the general minimum. */
  cardMinimumCents: number;
  /** The bank account a bank deposit would come from, when one is on file. */
  bankFundingMethodId: number | null;
  /** The server's pending-transfer advance position; null when the server does not serve one. */
  advance: WalletAdvance | null;
  /** The per-rail rewards rates in force (funding design phase 7). */
  rewardsRates: WalletRewardsRates;
}

/**
 * Short bullets, one per fact the vendor needs before paying this way: the
 * fee, when the money can pay orders, and — for a bank transfer — whether
 * money still on its way can pay for orders (the pending-transfer advance)
 * and what happens to an order it cannot pay for. Nothing here is about
 * autopay: the autopay steps before this one cover that.
 */
export function describeDepositRail(input: DepositRailNotesInput): string[] {
  const fee = formatFeeRate(input.cardFundingFeeBps);
  const rewards = describeRewardsEarning(input.rail, input.rewardsRates);
  const rewardsNotes = rewards === null ? [] : [rewards];
  if (input.rail === "stripe_card") {
    return [
      input.cardFundingFeeBps > 0 ? `Card fee: ${fee} on top of the amount.` : "No fee.",
      `Deposits of ${formatWholeDollars(input.cardMinimumCents)} or more.`,
      "Available at once.",
      ...rewardsNotes,
    ];
  }
  const feeClause = input.cardFundingFeeBps > 0 ? ` plus ${fee}` : "";
  return [
    "No fee.",
    `Takes ${BANK_SETTLEMENT_PHRASE} to land, and counts toward your minimum as soon as it shows as on the way.`,
    ...rewardsNotes,
    describeDepositCredit(input),
    `While it is on the way, an order it cannot pay for is charged to ${input.backupLabel} for the shortfall${feeClause}.`,
  ];
}

/**
 * The credit sentence for a bank deposit, from the three facts the server
 * judges per bank account (company holder, balance read when linked, one
 * earlier transfer landed) — never from the eligibility flag, which also
 * turns false when nothing is on the way right now.
 */
function describeDepositCredit(input: DepositRailNotesInput): string {
  const advance = input.advance;
  if (advance === null) {
    return "A business bank account can qualify to pay for orders while a transfer is still on the way; a personal account pays only once the money lands.";
  }
  if (advance.policy.capCents === 0) {
    return "Money on its way cannot pay for orders until it lands.";
  }
  const terms = `for a ${formatFeeRate(advance.policy.feeBps)} fee on the amount used, up to ${formatWholeDollars(advance.policy.capCents)} at a time`;
  const source = input.bankFundingMethodId === null
    ? null
    : advance.sources.find((candidate) => candidate.fundingMethodId === input.bankFundingMethodId) ?? null;
  if (source?.accountHolderType === "individual") {
    return "This is a personal account: money on its way from it pays for orders only once it lands.";
  }
  if (source?.accountHolderType === "company") {
    if (!source.balanceVerified) {
      return "This is a business account, but we could not read its balance when it was linked, so money on its way from it pays for orders only once it lands.";
    }
    if (!source.priorPullSettled) {
      return `This is a business account: once one transfer from it has landed, later transfers can pay for orders while still on the way, ${terms}.`;
    }
    return `This business account qualifies: money still on its way from it can pay for orders, ${terms}.`;
  }
  return `A business account can qualify to pay for orders while a transfer is still on the way — a balance we could read when it was linked, and one earlier transfer from it landed — ${terms}. A personal account pays only once the money lands.`;
}

/** Copy for the Limits editor's hold-time line: the hold is CardShellz's setting, shown so the vendor knows the deadline their held orders get. */
export function describeHoldTimeLine(holdExpiryWarningMinutes: number): string {
  return `How long a waiting order stays open before it is cancelled. Set by CardShellz for every wallet, for orders held from now on — an order already waiting keeps the deadline it was given. We email you ${formatDurationMinutes(holdExpiryWarningMinutes)} before.`;
}

/**
 * Copy for the pending-balance line. With an advance position that has
 * headroom, the line says how much of the money on its way can already pay
 * for orders; otherwise it says plainly that it cannot yet.
 */
export function describePendingBalance(pendingCents: number, advance: WalletAdvance | null = null): string {
  const lead = `${formatWholeDollars(pendingCents)} on the way — a bank transfer takes ${BANK_SETTLEMENT_PHRASE} to land;`;
  if (advance && advance.headroomCents > 0) {
    const usable = Math.min(advance.headroomCents, pendingCents);
    return `${lead} up to ${formatWholeDollars(usable)} of it can pay for orders now, for a ${formatFeeRate(advance.policy.feeBps)} fee on the amount used.`;
  }
  return `${lead} this money cannot pay orders yet.`;
}

/** Why a bank account's transfers cannot be advanced against, in the vendor's words. */
export function describeAdvanceReason(
  reason: WalletAdvanceReason,
  /** False when no bank link reads a balance, so relinking cannot help. */
  bankBalanceReadOffered = true,
): string {
  switch (reason) {
    case "no_bank_account":
      return "Add a bank account: the advance applies to bank transfers only.";
    case "no_pending_credit":
      return "No bank transfer is on its way right now.";
    case "account_holder_not_company":
      return "The bank account has to be a business account.";
    case "bank_balance_not_verified":
      // Telling a vendor to link again is only honest when linking would read
      // a balance at all; otherwise it is a loop with no exit.
      return bankBalanceReadOffered
        ? "We could not read the account's balance when it was linked. Link it again through your bank to enable this."
        : "Card Shellz is not reading bank balances right now, so this is unavailable for every seller. Nothing for you to do.";
    case "first_pull_not_settled":
      return "One earlier transfer from this account has to land first.";
    case "advance_cap_zero":
      return "Card Shellz has set your advance limit to $0.";
  }
}

export interface WalletAdvanceStandingCopy {
  headline: string;
  /** Policy terms, or the reasons nothing can be advanced; one sentence each. */
  details: string[];
}

/** The state of the pending-transfer advance, as the wallet page shows it. */
export function describeAdvanceStanding(
  advance: WalletAdvance,
  /** Passed through to the reasons; see `describeAdvanceReason`. */
  bankBalanceReadOffered = true,
): WalletAdvanceStandingCopy {
  const fee = formatFeeRate(advance.policy.feeBps);
  const cap = formatWholeDollars(advance.policy.capCents);
  const terms = `Fee ${fee} on the amount used; at most ${cap} outstanding at a time.`;
  if (advance.headroomCents > 0) {
    return {
      headline: `Up to ${formatWholeDollars(advance.headroomCents)} of money on its way can pay for orders now.`,
      details: [terms],
    };
  }
  if (advance.exposureCents > 0 && advance.allowanceCents > 0) {
    return {
      headline: `Orders have already used ${formatWholeDollars(Math.min(advance.exposureCents, advance.allowanceCents))} of money on its way; nothing more until it lands.`,
      details: [terms],
    };
  }
  return {
    headline: "No money on its way can pay for orders yet.",
    details: [...advance.reasons.map((reason) => describeAdvanceReason(reason, bankBalanceReadOffered)), terms],
  };
}

/**
 * The line under a negative balance. Money on its way that qualifies for the
 * advance covers the negative until it lands; otherwise the negative is a
 * return fee or a returned transfer, collected by the next top-up.
 */
export function describeNegativeBalance(input: {
  availableCents: number;
  advance: WalletAdvance | null;
  limitCents: number;
  cardFundingFeeBps: number;
}): string {
  const negative = formatWholeDollars(-input.availableCents);
  const covered = input.advance ? Math.min(input.advance.eligiblePendingCents, -input.availableCents) : 0;
  if (covered > 0) {
    return `${negative} below zero — ${formatWholeDollars(covered)} of it was paid from a bank transfer still on its way and clears when that lands. If the transfer is returned instead, the amount is collected by your next top-up.`;
  }
  return `${negative} below zero — a return fee or a returned transfer took the balance below zero. Your next top-up covers it, up to ${formatWholeDollars(input.limitCents)} in one charge; anything beyond that is collected over the following daily checks. Until then, a backup-card charge for an order includes this shortfall (order plus the amount below zero${input.cardFundingFeeBps > 0 ? `, plus ${formatFeeRate(input.cardFundingFeeBps)}` : ""}).`;
}

/** The role-warning texts (spec §2.8); they name no card label, because the view does not identify the archived card. */
export function describeRoleGap(gap: "backupCard" | "source", input: { holdTimeoutMinutes: number; holdExpiryWarningMinutes: number }): string {
  if (gap === "backupCard") {
    return `Backup card needed — your backup card was removed at Stripe or can no longer be charged. Until you choose one, an order your balance cannot cover waits for you to add money and is cancelled after ${formatDurationMinutes(input.holdTimeoutMinutes)} (we email you ${formatDurationMinutes(input.holdExpiryWarningMinutes)} before).`;
  }
  return "Autopay source needed — your autopay source was removed at Stripe or can no longer be charged, so routine top-ups are not running. Held orders are still covered by your backup card. Choose another source.";
}

/** The acknowledgement banner's three faces (spec §2.8). */
export function describeAcknowledgementBanner(input: { feeChange: { recordedBps: number; currentBps: number } | null; onboarding: boolean }): string {
  if (!input.feeChange) {
    return `Please review and confirm your autopay terms. Nothing changes until you confirm.${input.onboarding ? " You cannot activate until you do." : ""}`;
  }
  const { recordedBps, currentBps } = input.feeChange;
  if (currentBps > recordedBps) {
    return `Card Shellz changed the card fee: card charges now carry ${cardFeeNoun(currentBps)} (you agreed to ${cardFeeNoun(recordedBps)}). Until you confirm, automatic top-ups and covers ${recordedBps > 0 ? `stay at ${formatFeeRate(recordedBps)}` : "stay free"}; money you add yourself shows the current fee on Stripe's page before you pay.`;
  }
  return `Card Shellz ${currentBps === 0 ? "removed the card fee" : `lowered the card fee to ${formatFeeRate(currentBps)}`} (you agreed to ${cardFeeNoun(recordedBps)}). Automatic charges already use the lower rate; confirm to keep your record current.`;
}

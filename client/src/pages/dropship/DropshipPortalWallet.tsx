import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronDown, Coins, CreditCard, History, Info, Landmark, Loader2, RefreshCw, Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatFeeRate, quoteWalletFunding } from "@shared/dropship/wallet-funding-fee";
import {
  DropshipApiError,
  buildStripeFundingSetupSessionInput,
  buildUsdcBaseFundingMethodInput,
  deleteJson,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  parseDollarInputToCents,
  postJson,
  putJson,
  queryErrorMessage,
  type DropshipAutoReloadConfigInput,
  type DropshipOnboardingState,
  type DropshipStripeFundingSetupSessionResponse,
  type DropshipStripeWalletFundingSessionResponse,
} from "@/lib/dropship-ops-surface";
import { dropshipPortalPath, isDropshipSensitiveProofActive, useDropshipAuth, type DropshipSensitiveAction } from "@/lib/dropship-auth";
import { isOnboardingVendor } from "@/lib/dropship-onboarding";
import { describeVendorStanding } from "@/lib/dropship-vendor-standing";
import { adaptWalletView, type DropshipWalletView, type WalletFundingMethod, type WalletLimits } from "@/lib/dropship-wallet-view-adapter";
import {
  BANK_SETTLEMENT_PHRASE,
  BANK_SETTLEMENT_PHRASE_WITH_CALENDAR,
  DAILY_COST_PRESETS_CENTS,
  DEFAULT_FLOOR_CENTS_BY_SOURCE,
  DEPOSIT_PRESETS_CENTS,
  EXAMPLE_CARD_TOP_UP_CENTS,
  EXAMPLE_MONTHLY_SPEND_CENTS,
  EXAMPLE_SHORTFALL,
  FIRST_FILL_EXAMPLE_FLOORS_CENTS,
  FLOOR_PRESETS_CENTS,
  FLOOR_STEP_CENTS,
  HOLD_TIMEOUT_PRESETS_MINUTES,
  LIMIT_PRESETS_CENTS,
  activationTopUp,
  capAfterFloorChange,
  cardExpiryState,
  daysOfCover,
  depositAmountDefault,
  derivedLimitCents,
  describeLimitDerivation,
  firstFillFeeCents,
  floorVerdict,
  formatDurationMinutes,
  formatSignedCents,
  formatWholeDollars,
  monthlyCardFeeEstimate,
  presetsIncluding,
  recommendedFloorCents,
  roundUpToStep,
  shortfallExample,
  type WalletSourceRail,
} from "@/lib/dropship-wallet-guidance";
import {
  CARD_CONFIRMATION_POLL_INTERVAL_MS,
  CARD_CONFIRMATION_POLL_TIMEOUT_MS,
  EMPTY_DRAFT,
  INTRO_VERIFICATION_NOTE,
  LEDGER_REASON_LABELS,
  STEP_ORDER,
  acknowledgementForSave,
  activeMethodsOfRail,
  buildAuthorizeInput,
  buildAutoReloadDisableInput,
  buildConfirmTermsInput,
  buildPendingStripe,
  buildPlanSaveInput,
  buildRemoveFundingMethodPath,
  clearWalletDraft,
  depositFundingMethodFor,
  deriveWalletFlow,
  draftAfterBackupChoice,
  draftAfterFloorChoice,
  draftAfterIntro,
  draftAfterSourceChoice,
  draftAtStep,
  describeAcknowledgementBanner,
  describeActivationQuote,
  describeActivationTopUp,
  describeBackupFollow,
  describeFundingMethod,
  describeFundingMethodDetailed,
  describeHoldTimeLine,
  describeIntro,
  describeMandate,
  describePendingBalance,
  describePlanSentence,
  describeRoleGap,
  describeSourcePreselection,
  disabledReasonForRemoval,
  isEligibleBackupCard,
  isPendingStripeLive,
  parseStripeReturn,
  planAfterSourceChange,
  planFromWallet,
  previousWalletStep,
  readWalletDraft,
  resolveStripeReturn,
  stripStripeReturn,
  walletStepNumber,
  walletStepState,
  writeWalletDraft,
  type StripePurpose,
  type StripeReturn,
  type WalletDraft,
  type WalletFlowState,
  type WalletFlowStep,
  type WalletPlanInput,
  type WalletTerms,
} from "@/lib/dropship-wallet-flow";
import { describeWalletError, type WalletErrorSurface } from "@/lib/dropship-wallet-errors";
import { DropshipPortalShell } from "./DropshipPortalShell";

/**
 * Vendor wallet.
 *
 * Six steps, decision first: how the wallet works, the top-up source, the
 * floor, the backup card, one review-and-authorize click, and an optional
 * first deposit; then a manage view where every choice has a Change control.
 * The page renders what the pure models decide (`deriveWalletFlow`, the
 * guidance module, `describeWalletError`) and never decides on its own.
 * Every notice and the emailed-code prompt render inside the section whose
 * button asked for them.
 */

const WALLET_QUERY_KEY = ["/api/dropship/wallet?limit=50"] as const;
const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;
const SETTINGS_QUERY_KEY = ["/api/dropship/settings"] as const;
const BRAND_BUTTON = "h-10 w-full sm:w-auto bg-[#C060E0] hover:bg-[#a94bc9]";
const SECTION = "mt-5 rounded-md border border-zinc-200 bg-white p-5";

type WalletSensitiveAction = Extract<DropshipSensitiveAction, "add_funding_method" | "wallet_funding_high_value" | "remove_funding_method">;
/** Which part of the page an action, its notice and its code prompt belong to. */
type WalletScope = WalletFlowStep | "banner" | "money" | "plan" | "methods";
type ManageEditor = "source" | "floor" | "backup" | "limits" | "review" | null;

interface WalletNotice {
  scope: WalletScope;
  tone: "error" | "success" | "info";
  text: string;
}

interface PendingVerification {
  scope: WalletScope;
  action: WalletSensitiveAction;
  intent: () => Promise<void>;
}

interface Feedback {
  busy: boolean;
  notice: WalletNotice | null;
  verification: { code: string; onCodeChange: (value: string) => void; onSubmit: () => void; onCancel: () => void } | null;
}

const STEP_TITLES: Readonly<Record<WalletFlowStep, string>> = {
  intro: "How your wallet works",
  source: "Choose your top-up source",
  floor: "Set your floor",
  backup: "Your backup card",
  authorize: "Review and turn on auto-reload",
  deposit: "Add money now (recommended)",
};

export default function DropshipPortalWallet() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { principal, sensitiveProofs, startEmailStepUp, verifyEmailStepUp, verifyPasskeyStepUp } = useDropshipAuth();
  const now = useMemo(() => new Date(), []);

  // Stripe returns to this page with a status marker; read it once and clear it
  // from the address bar so a reload does not replay the banner.
  const [stripeReturn, setStripeReturn] = useState<StripeReturn | null>(() => parseStripeReturn(window.location.search));
  useEffect(() => {
    if (!parseStripeReturn(window.location.search)) return;
    window.history.replaceState(null, "", `${window.location.pathname}${stripStripeReturn(window.location.search)}`);
  }, []);

  const [busyScope, setBusyScope] = useState<WalletScope | null>(null);
  const [notice, setNotice] = useState<WalletNotice | null>(null);
  const [verification, setVerification] = useState<PendingVerification | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false);
  const [editor, setEditor] = useState<ManageEditor>(null);
  const [addMoneyOpen, setAddMoneyOpen] = useState(false);
  const [newMethodOffer, setNewMethodOffer] = useState<WalletFundingMethod | null>(null);
  const [returnBanner, setReturnBanner] = useState<{ tone: "success" | "info"; text: string } | null>(null);
  const [pendingStripeNotice, setPendingStripeNotice] = useState<{ scope: WalletScope; purpose: StripePurpose } | null>(null);
  /** The method a Stripe redirect just added: pre-selected on its step, written to the draft only when the vendor clicks Continue. */
  const [autoSelected, setAutoSelected] = useState<{ purpose: StripePurpose; fundingMethodId: number } | null>(null);
  const [feeMisconfigured, setFeeMisconfigured] = useState(false);

  const walletQuery = useQuery<DropshipWalletView>({
    queryKey: WALLET_QUERY_KEY,
    queryFn: async () => adaptWalletView(await fetchJson<unknown>(WALLET_QUERY_KEY[0])),
  });
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: [...ONBOARDING_QUERY_KEY],
    queryFn: () => fetchJson<DropshipOnboardingState>(ONBOARDING_QUERY_KEY[0]),
  });
  const wallet = walletQuery.data ?? null;
  const vendor = onboardingQuery.data?.vendor ?? null;
  const vendorStatus = vendor?.status ?? null;
  const standingNotice = vendor ? describeVendorStanding(vendor) : null;
  const stillOnboarding = vendorStatus !== null && isOnboardingVendor(vendorStatus);

  // The draft of not-yet-authorized choices, vendor-scoped in sessionStorage,
  // in memory when storage is unavailable. Loaded once the vendor id is known.
  const [draft, setDraftState] = useState<WalletDraft>(EMPTY_DRAFT);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const vendorId = vendor?.vendorId ?? null;
  useEffect(() => {
    if (vendorId === null || draftLoaded) return;
    const read = readWalletDraft(storageOrNull(), vendorId);
    setDraftState(read.draft);
    setStorageFailed(read.storageFailed);
    setDraftLoaded(true);
  }, [vendorId, draftLoaded]);
  function setDraft(update: (current: WalletDraft) => WalletDraft) {
    setDraftState((current) => {
      const next = update(current);
      if (vendorId !== null && !writeWalletDraft(storageOrNull(), vendorId, next)) setStorageFailed(true);
      return next;
    });
  }

  const flow = useMemo(
    () => (wallet && vendorStatus !== null && draftLoaded ? deriveWalletFlow({ wallet, vendorStatus, draft, now }) : null),
    [wallet, vendorStatus, draft, draftLoaded, now],
  );

  // A Stripe redirect resolves deterministically from the wallet view (a new
  // or refreshed method of the rail, or a moved ledger mark). After a success
  // return the page polls until it does or the timeout fires; without a
  // marker it checks once and says what it could not see.
  const pending = draft.pendingStripe;
  const pendingLive = isPendingStripeLive(pending, now) ? pending : null;
  const resolution = wallet && pendingLive ? resolveStripeReturn(pendingLive, wallet) : null;
  const awaiting = stripeReturn?.status === "success" && pendingLive !== null && resolution === null && !confirmationTimedOut;
  useEffect(() => {
    if (!awaiting) return;
    const timer = window.setTimeout(() => setConfirmationTimedOut(true), CARD_CONFIRMATION_POLL_TIMEOUT_MS);
    const interval = window.setInterval(() => { void walletQuery.refetch(); }, CARD_CONFIRMATION_POLL_INTERVAL_MS);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
    // walletQuery.refetch is stable for the query key; re-arming on it would restart the timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting]);

  const handledReturn = useRef(false);
  useEffect(() => {
    if (!wallet || !draftLoaded || handledReturn.current) return;
    // A pending redirect past Stripe's own expiry is discarded silently.
    if (pending && !pendingLive) {
      handledReturn.current = true;
      setDraft((current) => ({ ...current, pendingStripe: null }));
      return;
    }
    if (stripeReturn?.status === "cancelled") {
      handledReturn.current = true;
      const purpose = pendingLive?.purpose ?? (stripeReturn.kind === "wallet_funding" ? "deposit" : "manage_add");
      setDraft((current) => ({ ...current, pendingStripe: null }));
      if (stripeReturn.kind === "wallet_funding") {
        if (flow?.mode === "flow") setNotice({ scope: "deposit", tone: "info", text: "Payment cancelled. Nothing was charged." });
        else setReturnBanner({ tone: "info", text: "Payment cancelled. Nothing was charged." });
      } else if (flow?.mode === "flow" && purpose !== "manage_add") {
        const step = scopeForPurpose(purpose);
        setNotice({ scope: step, tone: "info", text: `Nothing was saved. You are back at step ${walletStepNumber(step)}.` });
      } else {
        setReturnBanner({ tone: "info", text: "Nothing was saved." });
      }
      return;
    }
    if (stripeReturn?.status === "success" || !pendingLive) {
      // A success return is resolved by the effect below as the wallet refreshes.
      if (stripeReturn?.status !== "success" || !pendingLive) handledReturn.current = true;
      return;
    }
    // No marker but a live pending redirect: one ordinary read decides.
    handledReturn.current = true;
    if (resolution === null) {
      setDraft((current) => ({ ...current, pendingStripe: null }));
      setPendingStripeNotice({ scope: flow?.mode === "flow" ? scopeForPurpose(pendingLive.purpose) : "banner", purpose: pendingLive.purpose });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, draftLoaded, flow?.mode]);

  useEffect(() => {
    if (!wallet || !pendingLive || !resolution) return;
    const purpose = pendingLive.purpose;
    if (resolution.kind === "method") {
      const method = resolution.method;
      const label = describeFundingMethod(method);
      const added = `${method.rail === "stripe_ach" ? "Bank account" : "Card"} added: ${label}.`;
      if (purpose === "source") {
        setDraft((current) => ({ ...current, pendingStripe: null, sourceRail: method.rail as WalletSourceRail }));
        setAutoSelected({ purpose, fundingMethodId: method.fundingMethodId });
        setNotice({ scope: "source", tone: "success", text: added });
      } else if (purpose === "backup") {
        setDraft((current) => ({ ...current, pendingStripe: null }));
        setAutoSelected({ purpose, fundingMethodId: method.fundingMethodId });
        setNotice({ scope: "backup", tone: "success", text: added });
      } else {
        setDraft((current) => ({ ...current, pendingStripe: null }));
        setReturnBanner({ tone: "success", text: added });
        if (method.rail === "stripe_ach" || method.rail === "stripe_card") setNewMethodOffer(method);
      }
    } else {
      setDraft((current) => ({ ...current, pendingStripe: null, deposit: "done" }));
      setReturnBanner({
        tone: "success",
        text: pendingLive.rail === "stripe_ach"
          ? `Transfer started. It shows as on the way once Stripe confirms it and can take ${BANK_SETTLEMENT_PHRASE} to land.`
          : "Payment received. Your balance updates as soon as Stripe confirms it.",
      });
    }
    setStripeReturn(null);
    setConfirmationTimedOut(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolution?.kind, resolution?.kind === "method" ? resolution.method.fundingMethodId : null]);

  // The draft is deleted when manage renders with nothing pending.
  useEffect(() => {
    if (!flow || flow.mode !== "manage" || vendorId === null) return;
    if (draft.pendingStripe === null && draft.deposit !== "pending" && draft !== EMPTY_DRAFT && (draft.sourceMethodId !== null || draft.floorCents !== null || draft.backupMethodId !== null || draft.seenIntro)) {
      // Keep the daily cost so the floor row can show "≈ N days" until the page is left.
      const kept: WalletDraft = { ...EMPTY_DRAFT, dailyCostCents: draft.dailyCostCents };
      setDraftState(kept);
      clearWalletDraft(storageOrNull(), vendorId);
    }
  }, [flow, draft, vendorId]);

  async function refreshAfterWalletChange() {
    await Promise.all([
      walletQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] }),
      queryClient.invalidateQueries({ queryKey: [...SETTINGS_QUERY_KEY] }),
    ]);
  }

  /** Every server refusal is shown through its §2.10 face; a `{ step }` recovery moves the flow or opens the manage editor. */
  function showError(scope: WalletScope, surface: WalletErrorSurface, caught: unknown) {
    if (!(caught instanceof DropshipApiError)) {
      setNotice({ scope, tone: "error", text: caught instanceof Error && caught.message.trim() ? caught.message : "Wallet request failed." });
      return;
    }
    const limits = wallet?.limits ?? { autoReloadMinTriggerCents: 0, autoReloadMinAmountCents: 0, manualFundingMinCents: 0, manualFundingMaxCents: 0, defaultPaymentHoldTimeoutMinutes: 1, holdExpiryWarningMinutes: 1 };
    const face = describeWalletError(caught.code, caught.message, caught.context, { surface, limits });
    if (caught.code === "DROPSHIP_CARD_FUNDING_FEE_MISCONFIGURED") setFeeMisconfigured(true);
    if (face.recovery === "verify") {
      setNotice({ scope, tone: "error", text: face.text });
      return;
    }
    if (typeof face.recovery === "object") {
      const step = face.recovery.step;
      if (flow?.mode === "flow") {
        // The refused value is cleared, so the recomputed furthest step IS the
        // step to fix; any step the vendor had navigated to is released with it.
        setDraft((current) => step === "source"
          ? { ...current, stepOverride: null, sourceMethodId: null, floorCents: null, backupMethodId: null }
          : step === "floor" ? { ...current, stepOverride: null, floorCents: null, backupMethodId: null } : { ...current, stepOverride: null, backupMethodId: null });
        setNotice({ scope: step, tone: "error", text: face.text });
      } else {
        setEditor(step);
        setNotice({ scope: "plan", tone: "error", text: face.text });
      }
      void refreshAfterWalletChange();
      return;
    }
    setNotice({ scope, tone: "error", text: face.text });
    if (face.recovery === "refetch") void refreshAfterWalletChange();
  }

  async function run(scope: WalletScope, surface: WalletErrorSurface, task: () => Promise<void>): Promise<boolean> {
    setBusyScope(scope);
    setNotice(null);
    try {
      await task();
      return true;
    } catch (caught) {
      showError(scope, surface, caught);
      return false;
    } finally {
      setBusyScope(null);
    }
  }

  /**
   * Run a request that needs a recent verification. A proof from the last ten
   * minutes is reused, a passkey is prompted immediately, and the email path
   * parks the request until the code is entered next to the same button.
   */
  async function withVerification(scope: WalletScope, action: WalletSensitiveAction, surface: WalletErrorSurface, intent: () => Promise<void>) {
    const proofActive = isDropshipSensitiveProofActive({ principal, action, proof: sensitiveProofs[action] });
    if (proofActive) {
      await run(scope, surface, intent);
      return;
    }
    if (principal?.hasPasskey) {
      const verified = await run(scope, surface, () => verifyPasskeyStepUp(action).then(() => undefined));
      if (verified) await run(scope, surface, intent);
      return;
    }
    // The auth provider surfaces only a message; any failure to send the code has one face (spec §2.10).
    setBusyScope(scope);
    setNotice(null);
    try {
      await startEmailStepUp(action);
    } catch {
      setNotice({ scope, tone: "error", text: "We could not send the code. Try again in a moment." });
      return;
    } finally {
      setBusyScope(null);
    }
    setVerification({ scope, action, intent });
    setVerificationCode("");
    setNotice({ scope, tone: "info", text: "We emailed you a 6-digit code. Enter it below to continue. This code lets you change your wallet setup." });
  }

  async function submitVerificationCode() {
    if (!verification || verificationCode.length !== 6) return;
    const { scope, action, intent } = verification;
    const verified = await run(scope, "other", () => verifyEmailStepUp({ action, verificationCode }).then(() => undefined));
    if (!verified) return;
    setVerification(null);
    setVerificationCode("");
    await run(scope, "other", intent);
  }

  function cancelVerification() {
    setVerification(null);
    setVerificationCode("");
    setNotice(null);
  }

  function returnPath(): string {
    return `${window.location.pathname}${stripStripeReturn(window.location.search)}` || dropshipPortalPath("/wallet");
  }

  function startStripeSetup(scope: WalletScope, rail: WalletSourceRail, purpose: StripePurpose) {
    if (!wallet) return Promise.resolve();
    return withVerification(scope, "add_funding_method", "setup", async () => {
      const input = buildStripeFundingSetupSessionInput({ rail, returnTo: returnPath() });
      const response = await postJson<DropshipStripeFundingSetupSessionResponse>("/api/dropship/wallet/funding-methods/stripe/setup-session", input);
      const pendingStripe = buildPendingStripe({ rail, purpose, wallet, startedAt: new Date(), expiresAt: response.setupSession.expiresAt });
      setDraft((current) => ({ ...current, pendingStripe }));
      window.location.assign(response.setupSession.checkoutUrl);
    });
  }

  function putAutoReload(scope: WalletScope, body: DropshipAutoReloadConfigInput, onSuccess: () => void) {
    return withVerification(scope, "add_funding_method", "put", async () => {
      await putJson<{ autoReload: unknown; idempotentReplay?: boolean }>("/api/dropship/wallet/auto-reload", body);
      onSuccess();
      await refreshAfterWalletChange();
    });
  }

  function authorize(plan: WalletPlanInput) {
    if (!wallet) return Promise.resolve();
    const body = buildAuthorizeInput(plan, wallet);
    const bankSource = wallet.fundingMethods.find((method) => method.fundingMethodId === plan.fundingMethodId)?.rail === "stripe_ach";
    return putAutoReload("authorize", body, () => {
      // Step 6 renders only from a pending deposit marker on a bank source.
      setDraft((current) => ({ ...current, deposit: bankSource ? "pending" : null }));
      setNotice({ scope: "plan", tone: "success", text: "Auto-reload is on." });
    });
  }

  function savePlan(plan: WalletPlanInput, successText = "Saved.") {
    if (!wallet) return Promise.resolve();
    return putAutoReload("plan", buildPlanSaveInput(plan, wallet), () => {
      setEditor(null);
      setNewMethodOffer(null);
      setNotice({ scope: "plan", tone: "success", text: successText });
    });
  }

  function confirmTerms(plan: WalletPlanInput) {
    if (!wallet) return Promise.resolve();
    return putAutoReload("banner", buildConfirmTermsInput(plan, wallet), () => {
      setEditor(null);
      setNotice({ scope: "plan", tone: "success", text: "Terms confirmed. Auto-reload is on." });
    });
  }

  function turnOffAutoReload() {
    if (!wallet) return Promise.resolve();
    return putAutoReload("plan", buildAutoReloadDisableInput(wallet), () => {
      setNotice({ scope: "plan", tone: "success", text: "Auto-reload is off. Nothing is charged automatically." });
    });
  }

  function removeMethod(method: WalletFundingMethod) {
    return withVerification("methods", "remove_funding_method", "delete", async () => {
      const response = await deleteJson<{ fundingMethod: unknown; idempotentReplay: boolean; providerDetach: string }>(buildRemoveFundingMethodPath(method.fundingMethodId));
      await refreshAfterWalletChange();
      setNotice({
        scope: "methods",
        tone: "success",
        text: response.providerDetach === "pending" || response.providerDetach === "requires_review"
          ? "Removed from your wallet. Card Shellz will no longer charge it. Stripe has not confirmed the removal yet; if it still shows on Stripe's page later, contact Card Shellz support."
          : "Removed. Card Shellz will no longer charge it.",
      });
    });
  }

  function addFunds(scope: WalletScope, rail: WalletSourceRail, amountCents: number) {
    if (!wallet) return Promise.resolve();
    const method = depositFundingMethodFor(wallet, rail);
    if (!method) return Promise.resolve();
    return withVerification(scope, "wallet_funding_high_value", "checkout", async () => {
      const response = await postJson<DropshipStripeWalletFundingSessionResponse>("/api/dropship/wallet/funding/stripe/checkout-session", {
        fundingMethodId: method.fundingMethodId,
        amountCents,
        returnTo: returnPath(),
      });
      const pendingStripe = buildPendingStripe({ rail, purpose: "deposit", wallet, startedAt: new Date(), expiresAt: response.fundingSession.expiresAt });
      setDraft((current) => ({ ...current, pendingStripe }));
      window.location.assign(response.fundingSession.checkoutUrl);
    });
  }

  function saveUsdcMethod(input: { walletAddress: string; displayLabel: string }) {
    return withVerification("money", "add_funding_method", "usdc", async () => {
      await postJson<unknown>("/api/dropship/wallet/funding-methods/usdc-base", buildUsdcBaseFundingMethodInput({ ...input, isDefault: false }));
      await refreshAfterWalletChange();
      setNotice({ scope: "money", tone: "success", text: "USDC address saved." });
    });
  }

  function checkAgain() {
    setConfirmationTimedOut(false);
    setPendingStripeNotice(null);
    void walletQuery.refetch();
  }

  /** A step screen's Back control: the previous step in STEP_ORDER, or nothing at the first one. */
  function backTo(step: WalletFlowStep): (() => void) | undefined {
    const previous = previousWalletStep(step);
    return previous === null ? undefined : () => setDraft((current) => draftAtStep(current, previous));
  }

  const feedback = (scope: WalletScope): Feedback => ({
    busy: busyScope === scope,
    notice: notice?.scope === scope ? notice : null,
    verification: verification?.scope === scope
      ? { code: verificationCode, onCodeChange: setVerificationCode, onSubmit: submitVerificationCode, onCancel: cancelVerification }
      : null,
  });

  const walletErrorText = walletQuery.error
    ? describeWalletError(walletQuery.error instanceof DropshipApiError ? walletQuery.error.code : null, queryErrorMessage(walletQuery.error, "Unable to load your wallet."), null, {
      surface: "get", limits: { autoReloadMinTriggerCents: 0, autoReloadMinAmountCents: 0, manualFundingMinCents: 0, manualFundingMaxCents: 0, defaultPaymentHoldTimeoutMinutes: 1, holdExpiryWarningMinutes: 1 },
    }).text
    : null;

  const currentPurposeScope = pendingLive ? scopeForPurpose(pendingLive.purpose) : null;
  const confirmation = wallet && pendingLive && stripeReturn?.status === "success" && flow?.mode === "flow" && currentPurposeScope !== null
    ? { scope: currentPurposeScope, rail: pendingLive.rail, timedOut: confirmationTimedOut }
    : null;

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Wallet className="h-6 w-6 text-[#C060E0]" />
            Wallet
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Card Shellz charges this wallet for each order you accept: the product cost plus shipping.
          </p>
        </div>

        {standingNotice && wallet && flow && (
          <Alert variant="destructive" className="mt-5" data-testid="wallet-vendor-standing-notice">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <span className="font-medium">{standingNotice.title}.</span> {standingNotice.reason} {standingNotice.action}
              {standingNotice.needsFunds && (
                <span className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setAddMoneyOpen(true)}>Add money</Button>
                  {flow.source?.rail === "stripe_card" ? (
                    <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditor("source")}>Change top-up source</Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditor("backup")}>Change backup card</Button>
                  )}
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}
        {standingNotice && !(wallet && flow) && (
          <Alert variant="destructive" className="mt-5" data-testid="wallet-vendor-standing-notice">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription><span className="font-medium">{standingNotice.title}.</span> {standingNotice.reason} {standingNotice.action}</AlertDescription>
          </Alert>
        )}

        {walletErrorText && (
          <Alert variant="destructive" className="mt-5" role="alert">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{walletErrorText}</AlertDescription>
          </Alert>
        )}

        {storageFailed && flow?.mode === "flow" && (
          <Alert className="mt-5" role="status">
            <Info className="h-4 w-4" />
            <AlertDescription>We could not remember your choices in this browser; pick them again.</AlertDescription>
          </Alert>
        )}

        {walletQuery.isLoading || !wallet || !flow ? (
          !walletErrorText && (
            <div className="mt-5 space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          )
        ) : flow.mode === "flow" && flow.step ? (
          <>
            <StepIndicator wallet={wallet} flow={flow} draft={draft} onSelect={(step) => setDraft((current) => draftAtStep(current, step))} />
            {flow.step === "intro" && (
              <IntroStep
                wallet={wallet}
                flow={flow}
                revisited={flow.furthestStep !== "intro"}
                onContinue={() => setDraft(draftAfterIntro)}
              />
            )}
            {flow.step === "source" && (
              <SourceStep
                wallet={wallet}
                flow={flow}
                draft={draft}
                feedback={feedback("source")}
                confirmation={confirmation?.scope === "source" ? confirmation : null}
                pendingNotice={pendingStripeNotice?.scope === "source" ? pendingStripeNotice : null}
                onCheckAgain={checkAgain}
                onAdd={(rail) => startStripeSetup("source", rail, "source")}
                onRailChange={(rail) => setDraft((current) => (current.sourceRail === rail ? current : { ...current, sourceRail: rail }))}
                autoSelectedId={autoSelected?.purpose === "source" ? autoSelected.fundingMethodId : null}
                onBack={backTo(flow.step)}
                onContinue={(method) => setDraft((current) => draftAfterSourceChoice(current, method, flow.source?.method ?? null))}
              />
            )}
            {flow.step === "floor" && flow.source && (
              <FloorStep
                wallet={wallet}
                flow={flow}
                sourceRail={flow.source.rail}
                sourceLabel={describeFundingMethod(flow.source.method)}
                initialFloorCents={draft.floorCents ?? recommendedFloorCents(flow.source.rail, draft.dailyCostCents, wallet.limits)}
                initialDailyCostCents={draft.dailyCostCents}
                feedback={feedback("floor")}
                submitLabel="Continue"
                onBack={backTo(flow.step)}
                onSubmit={(floorCents, dailyCostCents) => setDraft((current) => draftAfterFloorChoice(current, floorCents, dailyCostCents))}
              />
            )}
            {flow.step === "backup" && (
              <BackupStep
                wallet={wallet}
                now={now}
                feedback={feedback("backup")}
                confirmation={confirmation?.scope === "backup" ? confirmation : null}
                pendingNotice={pendingStripeNotice?.scope === "backup" ? pendingStripeNotice : null}
                onCheckAgain={checkAgain}
                onAdd={() => startStripeSetup("backup", "stripe_card", "backup")}
                initialCardId={draft.backupMethodId ?? (autoSelected?.purpose === "backup" ? autoSelected.fundingMethodId : null)}
                submitLabel="Continue"
                onBack={backTo(flow.step)}
                onSubmit={(card) => setDraft((current) => draftAfterBackupChoice(current, card))}
              />
            )}
            {flow.step === "authorize" && flow.source && flow.backup && (
              <ReviewStep
                wallet={wallet}
                flow={flow}
                draft={draft}
                feedback={feedback("authorize")}
                disabled={feeMisconfigured}
                onBack={backTo(flow.step)}
                onChange={(step) => setDraft((current) => draftAtStep(current, step))}
                onAuthorize={() => authorize({
                  fundingMethodId: flow.source!.method.fundingMethodId,
                  backupFundingMethodId: flow.backup!.method.fundingMethodId,
                  floorCents: flow.floorCents,
                  limitCents: flow.limitCents,
                  holdTimeoutMinutes: flow.holdTimeoutMinutes,
                })}
              />
            )}
            {flow.step === "deposit" && flow.source && flow.backup && (
              <DepositStep
                wallet={wallet}
                flow={flow}
                feedback={feedback("deposit")}
                pendingNotice={pendingStripeNotice?.scope === "deposit" ? pendingStripeNotice : null}
                onCheckAgain={checkAgain}
                onBack={backTo(flow.step)}
                onContinue={(rail, amountCents) => addFunds("deposit", rail, amountCents)}
                onAddMethod={(rail) => startStripeSetup("deposit", rail, "manage_add")}
                onNotNow={() => setDraft((current) => ({ ...current, deposit: "skipped" }))}
              />
            )}
          </>
        ) : (
          <ManageView
            wallet={wallet}
            flow={flow}
            draft={draft}
            now={now}
            stillOnboarding={stillOnboarding}
            editor={editor}
            setEditor={setEditor}
            addMoneyOpen={addMoneyOpen}
            setAddMoneyOpen={setAddMoneyOpen}
            newMethodOffer={newMethodOffer}
            dismissOffer={() => setNewMethodOffer(null)}
            returnBanner={returnBanner}
            dismissReturnBanner={() => setReturnBanner(null)}
            pendingNotice={pendingStripeNotice?.scope === "banner" ? pendingStripeNotice : null}
            onCheckAgain={checkAgain}
            feedback={feedback}
            feeMisconfigured={feeMisconfigured}
            onSavePlan={savePlan}
            onConfirmTerms={confirmTerms}
            onTurnOff={turnOffAutoReload}
            onRemove={removeMethod}
            onAddMethod={(scope, rail) => startStripeSetup(scope, rail, "manage_add")}
            onAddFunds={(rail, amount) => addFunds("money", rail, amount)}
            onSaveUsdc={saveUsdcMethod}
            onBackToOnboarding={() => setLocation(dropshipPortalPath("/onboarding"))}
          />
        )}
      </div>
    </DropshipPortalShell>
  );
}

function storageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function scopeForPurpose(purpose: StripePurpose): WalletFlowStep {
  switch (purpose) {
    case "source":
      return "source";
    case "backup":
      return "backup";
    case "deposit":
      return "deposit";
    default:
      return "authorize";
  }
}

/** Everything the mandate needs, from the flow state. */
function termsFor(wallet: DropshipWalletView, flow: WalletFlowState): WalletTerms | null {
  if (!flow.source || !flow.backup) return null;
  return {
    sourceRail: flow.source.rail,
    sourceLabel: describeFundingMethod(flow.source.method),
    backupLabel: describeFundingMethod(flow.backup.method),
    floorCents: flow.floorCents,
    limitCents: flow.limitCents,
    holdTimeoutMinutes: flow.holdTimeoutMinutes,
    holdExpiryWarningMinutes: wallet.limits.holdExpiryWarningMinutes,
    cardFundingFeeBps: wallet.cardFundingFeeBps,
  };
}

function termsForPlan(wallet: DropshipWalletView, plan: WalletPlanInput): WalletTerms | null {
  const source = wallet.fundingMethods.find((method) => method.fundingMethodId === plan.fundingMethodId);
  const backup = wallet.fundingMethods.find((method) => method.fundingMethodId === plan.backupFundingMethodId);
  if (!source || !backup || (source.rail !== "stripe_ach" && source.rail !== "stripe_card")) return null;
  return {
    sourceRail: source.rail,
    sourceLabel: describeFundingMethod(source),
    backupLabel: describeFundingMethod(backup),
    floorCents: plan.floorCents,
    limitCents: plan.limitCents,
    holdTimeoutMinutes: plan.holdTimeoutMinutes,
    holdExpiryWarningMinutes: wallet.limits.holdExpiryWarningMinutes,
    cardFundingFeeBps: wallet.cardFundingFeeBps,
  };
}

// ---------------------------------------------------------------------------
// Shared feedback: notices and the emailed-code prompt render inside the section
// whose button asked for them, never at the top of the page.
// ---------------------------------------------------------------------------

function SectionFeedback({ busy, notice, verification }: Feedback) {
  return (
    <>
      {notice && (
        <Alert
          role={notice.tone === "error" ? "alert" : "status"}
          variant={notice.tone === "error" ? "destructive" : "default"}
          className={notice.tone === "success" ? "mt-4 border-emerald-200 bg-emerald-50 text-emerald-900" : "mt-4"}
        >
          {notice.tone === "error" ? <AlertCircle className="h-4 w-4" /> : notice.tone === "success" ? <CheckCircle2 className="h-4 w-4" /> : <Info className="h-4 w-4" />}
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}
      {verification && (
        <div className="mt-4 max-w-sm space-y-3 rounded-md border border-violet-200 bg-violet-50 p-4" data-testid="wallet-verification">
          <Label htmlFor="wallet-verification-code">Verification code</Label>
          <InputOTP id="wallet-verification-code" maxLength={6} value={verification.code} onChange={verification.onCodeChange} containerClassName="justify-between" disabled={busy}>
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <div className="flex gap-2">
            <Button type="button" className="h-9 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={busy || verification.code.length !== 6} onClick={verification.onSubmit}>
              {busy ? "Checking code" : "Continue"}
            </Button>
            <Button type="button" variant="ghost" className="h-9" disabled={busy} onClick={verification.onCancel}>Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}

/** The plain Back control every step screen but the intro carries: one step earlier, nothing saved and nothing cleared. */
function StepBack({ busy, onBack }: { busy: boolean; onBack?: () => void }) {
  if (!onBack) return null;
  return (
    <Button type="button" variant="ghost" className="h-10 w-full sm:w-auto" disabled={busy} onClick={onBack} data-testid="wallet-step-back">Back</Button>
  );
}

function Impact({ children }: { children: ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="mt-4 rounded-md border border-violet-100 bg-violet-50 p-3 text-sm text-zinc-700" data-testid="wallet-impact">
      {children}
    </p>
  );
}

/** The portal's hand-rolled radio: a button with role="radio" inside a role="radiogroup". */
function RadioChip({ label, hint, selected, disabled, onSelect, testId }: { label: string; hint?: string; selected: boolean; disabled?: boolean; onSelect: () => void; testId?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={selected
        ? "min-h-10 rounded-md border border-[#C060E0] bg-[#C060E0]/10 px-3 py-1.5 text-left text-sm font-medium text-[#8c35aa]"
        : "min-h-10 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-left text-sm hover:bg-zinc-50 disabled:opacity-50"}
    >
      <span className="block">{label}</span>
      {hint && <span className="block text-xs font-normal text-zinc-500">{hint}</span>}
    </button>
  );
}

function MethodConfirmation({ rail, timedOut, onCheckAgain }: { rail: WalletSourceRail; timedOut: boolean; onCheckAgain: () => void }) {
  const noun = rail === "stripe_ach" ? "bank account" : "card";
  const testId = `wallet-${rail === "stripe_ach" ? "bank" : "card"}-confirmation`;
  if (timedOut) {
    return (
      <div role="status" className="mt-4" data-testid={testId}>
        <p className="text-sm text-zinc-700">Stripe has not confirmed it to Card Shellz yet. Check again, or come back later — it will be here once confirmed.</p>
        <Button type="button" variant="outline" className="mt-3 h-10 gap-2" onClick={onCheckAgain}><RefreshCw className="h-4 w-4" />Check again</Button>
      </div>
    );
  }
  return (
    <div role="status" className="mt-4 flex items-start gap-3" data-testid={testId}>
      <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-[#C060E0]" aria-hidden="true" />
      <p className="text-sm text-zinc-700">Confirming your {noun} with Stripe. We keep checking — this can take a minute.</p>
    </div>
  );
}

function PendingStripeNotice({ purpose, onCheckAgain }: { purpose: StripePurpose; onCheckAgain: () => void }) {
  return (
    <div role="status" className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3" data-testid="wallet-pending-stripe-notice">
      <p className="text-sm text-zinc-700">
        {purpose === "deposit"
          ? "We did not hear back from Stripe. If you finished paying on Stripe's page, the money shows up here once Stripe confirms it — check again in a minute."
          : "We did not hear back from Stripe. If you finished on Stripe's page, the account or card shows up here once Stripe confirms it — check again in a minute."}
      </p>
      <Button type="button" variant="outline" className="mt-3 h-10 gap-2" onClick={onCheckAgain}><RefreshCw className="h-4 w-4" />Check again</Button>
    </div>
  );
}

const STRIPE_HANDOFF_NOTE = "You finish on Stripe's page. Card Shellz never sees your account or card number.";

// ---------------------------------------------------------------------------
// Step list: done rows show their result, derived rows their explanation, the
// current row the "Now" badge. Collapsed to one line on phones. Every step the
// flow has already reached is a button that goes back to it; the rest are plain
// text and are not focusable, so nothing offers a step the vendor cannot open.
// ---------------------------------------------------------------------------

function StepIndicator({ wallet, flow, draft, onSelect }: { wallet: DropshipWalletView; flow: WalletFlowState; draft: WalletDraft; onSelect: (step: WalletFlowStep) => void }) {
  const [open, setOpen] = useState(false);
  const current = flow.step ?? "authorize";
  const currentIndex = STEP_ORDER.indexOf(current);
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const rows = STEP_ORDER.map((step) => {
    const state = walletStepState(step, { current, furthestStep: flow.furthestStep ?? current, seenIntro: draft.seenIntro });
    let detail: string | null = null;
    if (step === "source" && state === "done" && flow.source) {
      detail = `${flow.source.rail === "stripe_ach" ? "Bank account" : "Card"} · ${describeFundingMethod(flow.source.method)}`;
    } else if (step === "floor" && state === "done") {
      const days = daysOfCover(flow.floorCents, draft.dailyCostCents);
      detail = `${formatWholeDollars(flow.floorCents)}${days === null ? "" : ` · ≈ ${days} days`}`;
    } else if (step === "backup" && flow.source?.rail === "stripe_card" && state !== "later") {
      detail = `Backup card · ${describeFundingMethod(flow.source.method)} — the card you top up with is also your backup card. If an order needs more than your balance, the same card pays the shortfall plus ${fee}, up to your single top-up limit.`;
    } else if (step === "backup" && state === "done" && flow.backup) {
      detail = describeFundingMethodDetailed(flow.backup.method);
    } else if (step === "deposit" && flow.source?.rail === "stripe_card" && flow.backup) {
      const quote = activationTopUp({ sourceRail: "stripe_card", floorCents: flow.floorCents, limitCents: flow.limitCents, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents, bps: wallet.cardFundingFeeBps });
      detail = quote.outcome === "top_up"
        ? `First top-up · On the first daily check after you activate we charge ${describeFundingMethod(flow.source.method)} ${formatWholeDollars(quote.chargedCents)} (${formatWholeDollars(quote.amountCents)} + ${formatWholeDollars(quote.feeCents)} fee) to bring your balance to your floor. You can add money any time from Wallet.`
        : "First top-up · Your balance already covers your floor. You can add money any time from Wallet.";
    }
    return { step, state, detail, reachable: flow.reachableSteps.includes(step) };
  });
  const list = (
    <ol className="space-y-2" data-testid="wallet-step-indicator">
      {rows.map(({ step, state, detail, reachable }, index) => {
        const body = (
          <>
            <span
              className={state === "done"
                ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
                : state === "current"
                  ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#C060E0] text-white"
                  : "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-zinc-500"}
              aria-hidden="true"
            >
              {state === "done" ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span className={state === "later" ? "text-zinc-500" : "font-medium"}>{STEP_TITLES[step]}</span>
              {state === "current" && <Badge variant="outline" className="ml-2">Now</Badge>}
              {detail && <span className="block text-zinc-500">{detail}</span>}
            </span>
          </>
        );
        return (
          <li key={step} className="text-sm">
            {reachable ? (
              <button
                type="button"
                className="flex w-full items-start gap-3 rounded-md text-left hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C060E0]"
                aria-current={state === "current" ? "step" : undefined}
                data-testid={`wallet-step-link-${step}`}
                onClick={() => onSelect(step)}
              >
                {body}
              </button>
            ) : (
              <span className="flex items-start gap-3">{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
  return (
    <section className={SECTION}>
      <div className="hidden sm:block">{list}</div>
      <Collapsible open={open} onOpenChange={setOpen} className="sm:hidden">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium">Step {currentIndex + 1} of {STEP_ORDER.length} · {STEP_TITLES[current]}</span>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex shrink-0 items-center gap-1 text-xs text-zinc-600">
              {open ? "Hide steps" : "Show all steps"}
              <ChevronDown className={open ? "h-4 w-4 rotate-180" : "h-4 w-4"} aria-hidden="true" />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="mt-3">{list}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — How your wallet works
// ---------------------------------------------------------------------------

/** The charge rules, worded once: step 1 during setup and the manage view's "How your wallet works" render this. */
function WalletHowItWorks({ wallet, flow }: { wallet: DropshipWalletView; flow: WalletFlowState }) {
  const lines = describeIntro({ cardFundingFeeBps: wallet.cardFundingFeeBps, usdcOffered: wallet.usdcBaseDepositAddress !== null, holdTimeoutMinutes: flow.holdTimeoutMinutes });
  return (
    <>
      <ol className="list-decimal space-y-3 pl-5 text-sm text-zinc-700" data-testid="wallet-how-it-works-rules">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ol>
      <p className="mt-4 text-sm text-zinc-500" data-testid="wallet-intro-verification-note">{INTRO_VERIFICATION_NOTE}</p>
    </>
  );
}

function IntroStep({ wallet, flow, revisited, onContinue }: { wallet: DropshipWalletView; flow: WalletFlowState; revisited: boolean; onContinue: () => void }) {
  return (
    <section className={SECTION} data-testid="wallet-step-intro">
      <h2 className="text-lg font-semibold">How your wallet works</h2>
      <p className="mt-1 text-sm text-zinc-500">
        {revisited ? "The charge rules, unchanged. Nothing you have chosen is affected by reading them again." : "Before you choose anything, here is exactly when we charge you and why."}
      </p>
      <div className="mt-4"><WalletHowItWorks wallet={wallet} flow={flow} /></div>
      <Button type="button" className={`mt-5 ${BRAND_BUTTON}`} onClick={onContinue}>{revisited ? "Back to setup" : "Set up my wallet"}</Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Choose your top-up source (also the manage-mode source editor)
// ---------------------------------------------------------------------------

function SourcePicker({
  wallet, selectedId, initialRail, onSelect, busy, onAdd, confirmation, onCheckAgain, editing,
}: {
  wallet: DropshipWalletView;
  selectedId: number | null;
  initialRail: WalletSourceRail | null;
  onSelect: (method: WalletFundingMethod | null, rail: WalletSourceRail) => void;
  busy: boolean;
  onAdd: (rail: WalletSourceRail) => void;
  confirmation: { rail: WalletSourceRail; timedOut: boolean } | null;
  onCheckAgain: () => void;
  editing: boolean;
}) {
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const selected = wallet.fundingMethods.find((method) => method.fundingMethodId === selectedId) ?? null;
  const [railChoice, setRailChoice] = useState<WalletSourceRail | null>(null);
  const rail = selected ? (selected.rail as WalletSourceRail) : (railChoice ?? initialRail);
  const rows = (kind: WalletSourceRail) => kind === "stripe_ach"
    ? [
      ["Fee", "None"],
      ["Speed", `Up to 5 business days to land (our assumption — Stripe gives us no date)`],
      ["Money parked", "Higher floor recommended, so more of your money sits in the wallet"],
      ["When an order needs more than your balance", `Your backup card pays the shortfall plus ${fee}, up to your single top-up limit`],
      ["Best for", "Most sellers: fees stay near zero when the floor keeps up"],
    ]
    : [
      ["Fee", `${fee} on every top-up, on top of the amount`],
      ["Speed", "Lands at once"],
      ["Money parked", `A lower floor is fine, so less of your money sits in the wallet — the first fill to the floor is charged ${fee} once`],
      ["When an order needs more than your balance", `The same card pays the shortfall plus ${fee}, up to your single top-up limit`],
      ["Best for", "Sellers who would rather park less money and pay the fee"],
    ];

  function choose(kind: WalletSourceRail) {
    setRailChoice(kind);
    const active = activeMethodsOfRail(wallet, kind).filter((method) => kind === "stripe_ach" || isEligibleBackupCard(method, new Date()));
    onSelect(active[0] ?? null, kind);
  }

  const option = (kind: WalletSourceRail) => {
    const active = activeMethodsOfRail(wallet, kind);
    const pendingRows = wallet.fundingMethods.filter((method) => method.rail === kind && method.status !== "active" && method.status !== "archived");
    const isSelected = rail === kind;
    const title = kind === "stripe_ach" ? "Bank account" : "Card";
    return (
      <div className={isSelected ? "rounded-md border border-[#C060E0] bg-[#C060E0]/5 p-4" : "rounded-md border border-zinc-200 p-4"} data-testid={`wallet-source-option-${kind === "stripe_ach" ? "bank" : "card"}`}>
        <button type="button" role="radio" aria-checked={isSelected} aria-label={title} disabled={busy} onClick={() => choose(kind)} className="flex w-full items-start gap-3 text-left">
          <span className={isSelected ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#C060E0] text-white" : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700"}>
            {kind === "stripe_ach" ? <Landmark className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
          </span>
          <span>
            <span className="block font-medium">{title}</span>
            {kind === "stripe_ach" && <Badge variant="outline" className="mt-1 border-emerald-300 text-emerald-700">Recommended: no fees</Badge>}
          </span>
        </button>
        <dl className="mt-3 space-y-2 text-sm">
          {rows(kind).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
              <dd className="text-zinc-700">{value}</dd>
            </div>
          ))}
        </dl>
        {isSelected && (
          <div className="mt-3 space-y-2">
            {confirmation?.rail === kind ? (
              <MethodConfirmation rail={kind} timedOut={confirmation.timedOut} onCheckAgain={onCheckAgain} />
            ) : active.length === 0 ? (
              <>
                <Button type="button" variant="outline" className="h-10 w-full gap-2 sm:w-auto" disabled={busy} onClick={() => onAdd(kind)}>
                  {kind === "stripe_ach" ? <Landmark className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
                  {kind === "stripe_ach" ? "Add a bank account" : "Add a card"}
                </Button>
                <p className="text-xs text-zinc-500">{STRIPE_HANDOFF_NOTE}</p>
              </>
            ) : active.length === 1 ? (
              <p className="text-sm text-zinc-700">{describeFundingMethodDetailed(active[0])}</p>
            ) : (
              <select
                aria-label="Which one"
                className="h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm"
                value={selected?.fundingMethodId ?? active[0].fundingMethodId}
                disabled={busy}
                onChange={(event) => onSelect(active.find((method) => method.fundingMethodId === Number(event.target.value)) ?? null, kind)}
              >
                {active.map((method) => (
                  <option key={method.fundingMethodId} value={method.fundingMethodId}>{describeFundingMethodDetailed(method)}</option>
                ))}
              </select>
            )}
            {active.length > 0 && !editing && (
              <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => onAdd(kind)}>
                {kind === "stripe_ach" ? "Add another bank account" : "Add another card"}
              </Button>
            )}
            {pendingRows.map((method) => (
              <p key={method.fundingMethodId} className="text-sm text-zinc-500">
                {method.status === "failed" ? "This account could not be set up." : "Your bank is still verifying this account."}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div role="radiogroup" aria-label="Top up from" className="grid gap-3 sm:grid-cols-2">
      {option("stripe_ach")}
      {option("stripe_card")}
    </div>
  );
}

function SourceStep({
  wallet, flow, draft, feedback, confirmation, pendingNotice, onCheckAgain, onAdd, onRailChange, autoSelectedId, onBack, onContinue,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  draft: WalletDraft;
  feedback: Feedback;
  confirmation: { rail: WalletSourceRail; timedOut: boolean } | null;
  pendingNotice: { purpose: StripePurpose } | null;
  onCheckAgain: () => void;
  onAdd: (rail: WalletSourceRail) => void;
  onRailChange: (rail: WalletSourceRail) => void;
  autoSelectedId: number | null;
  onBack?: () => void;
  onContinue: (method: WalletFundingMethod) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(draft.sourceMethodId ?? flow.suggestedSourceMethodId);
  const [rail, setRail] = useState<WalletSourceRail | null>(() => {
    const method = wallet.fundingMethods.find((entry) => entry.fundingMethodId === (draft.sourceMethodId ?? flow.suggestedSourceMethodId));
    return method ? (method.rail as WalletSourceRail) : draft.sourceRail;
  });
  // A method Stripe just added is pre-selected while this step is open; Continue is still required.
  useEffect(() => {
    if (autoSelectedId === null) return;
    const method = wallet.fundingMethods.find((entry) => entry.fundingMethodId === autoSelectedId);
    if (!method) return;
    setSelectedId(method.fundingMethodId);
    setRail(method.rail as WalletSourceRail);
  }, [autoSelectedId, wallet.fundingMethods]);
  const selected = wallet.fundingMethods.find((method) => method.fundingMethodId === selectedId && method.status === "active") ?? null;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const preselection = describeSourcePreselection({
    selected,
    draftSourceMethodId: draft.sourceMethodId,
    suggestedSourceMethodId: flow.suggestedSourceMethodId,
    justAdded: autoSelectedId !== null,
  });
  const monthly = draft.dailyCostCents ? monthlyCardFeeEstimate("stripe_card", DEFAULT_FLOOR_CENTS_BY_SOURCE.stripe_card, draft.dailyCostCents, wallet.cardFundingFeeBps) : null;
  const exampleFee = quoteWalletFunding({ rail: "stripe_card", creditCents: EXAMPLE_MONTHLY_SPEND_CENTS, cardFeeBps: wallet.cardFundingFeeBps }).feeCents;
  const canContinue = selected !== null && (selected.rail === "stripe_ach" || selected.roles.chargeable);

  return (
    <section className={SECTION} data-testid="wallet-step-source">
      <h2 className="text-lg font-semibold">Choose your top-up source</h2>
      <p className="mt-1 text-sm text-zinc-500">This is where your routine top-ups come from — the money that pays your orders day to day. You can change it later.</p>
      <div className="mt-4">
        <SourcePicker
          wallet={wallet}
          selectedId={selectedId}
          initialRail={rail ?? confirmation?.rail ?? null}
          onSelect={(method, kind) => { setSelectedId(method?.fundingMethodId ?? null); setRail(kind); onRailChange(kind); }}
          busy={feedback.busy}
          onAdd={onAdd}
          confirmation={confirmation}
          onCheckAgain={onCheckAgain}
          editing={false}
        />
      </div>
      {preselection && <p className="mt-3 text-sm text-zinc-600" data-testid="wallet-source-preselection">{preselection}</p>}
      {wallet.usdcBaseDepositAddress && (
        <p className="mt-3 text-sm text-zinc-500" data-testid="wallet-usdc-note">
          Prefer USDC? It is free too, but manual: you send USDC on Base to Card Shellz's deposit address and a member of our team credits your wallet after confirming the transfer. Because it cannot be pulled automatically, it can never be your top-up source. Use it any time under Add money.
        </p>
      )}
      {rail === "stripe_ach" && (
        <Impact>Routine top-ups are free. While a transfer is landing, orders draw on what has already settled; if an order needs more, your backup card covers the shortfall plus {fee} (up to your single top-up limit). A higher floor in the next step makes that rare.</Impact>
      )}
      {rail === "stripe_card" && (
        <Impact>
          Every top-up costs {fee}: {monthly
            ? `at ${formatWholeDollars(monthly.monthlySpendCents)} of orders a month that is about ${formatWholeDollars(monthly.estimateCents)} in fees`
            : `for example, at ${formatWholeDollars(EXAMPLE_MONTHLY_SPEND_CENTS)} of orders a month that is about ${formatWholeDollars(exampleFee)} in fees`}. Your card is also your backup card, so there is nothing more to add.
        </Impact>
      )}
      {pendingNotice && <PendingStripeNotice purpose={pendingNotice.purpose} onCheckAgain={onCheckAgain} />}
      <SectionFeedback {...feedback} />
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || !canContinue} onClick={() => selected && onContinue(selected)}>Continue</Button>
        <StepBack busy={feedback.busy} onBack={onBack} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Set your floor (also the manage-mode floor editor)
// ---------------------------------------------------------------------------

/** The typed amount as cents, or null while it is not a valid dollar amount yet. */
function tryParseDollarInputToCents(value: string): number | null {
  try {
    return parseDollarInputToCents(value, "Amount");
  } catch {
    return null;
  }
}

function FloorStep({
  wallet, flow, sourceRail, sourceLabel, initialFloorCents, initialDailyCostCents, feedback, submitLabel, onSubmit, onBack, onCancel, currentLimitCents, saveNote,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  sourceRail: WalletSourceRail;
  sourceLabel: string;
  initialFloorCents: number;
  initialDailyCostCents: number | null;
  feedback: Feedback;
  submitLabel: string;
  onSubmit: (floorCents: number, dailyCostCents: number | null) => void;
  /** The flow's Back control; the manage editor passes `onCancel` instead. */
  onBack?: () => void;
  onCancel?: () => void;
  /** Manage mode: the saved cap, so the editor can say where the limit moves. */
  currentLimitCents?: number;
  saveNote?: ReactNode;
}) {
  const limits = wallet.limits;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const [dailyText, setDailyText] = useState(initialDailyCostCents === null ? "" : centsToDollarText(initialDailyCostCents));
  const [floorCents, setFloorCents] = useState(initialFloorCents);
  const [chipClicked, setChipClicked] = useState(false);
  const [customText, setCustomText] = useState("");
  const [customError, setCustomError] = useState("");
  const dailyCents = dailyText.trim() ? tryParseDollarInputToCents(dailyText) : null;
  const dailyInvalid = dailyText.trim() !== "" && dailyCents === null;
  const recommended = dailyCents ? recommendedFloorCents(sourceRail, dailyCents, limits) : null;
  const chips = presetsIncluding(FLOOR_PRESETS_CENTS, recommended, initialFloorCents).filter((cents) => cents >= limits.autoReloadMinTriggerCents);
  const days = daysOfCover(floorCents, dailyCents);
  const verdict = floorVerdict(sourceRail, days);
  const limitCents = currentLimitCents === undefined
    ? derivedLimitCents(floorCents, limits)
    : capAfterFloorChange(initialFloorCents, floorCents, currentLimitCents, limits);
  const holdMinutes = flow.holdTimeoutMinutes;
  const estimate = dailyCents ? monthlyCardFeeEstimate(sourceRail, floorCents, dailyCents, wallet.cardFundingFeeBps) : null;
  const example = shortfallExample({ orderCents: EXAMPLE_SHORTFALL.orderCents, availableCents: EXAMPLE_SHORTFALL.availableCents, bps: wallet.cardFundingFeeBps });
  const exampleCardTopUp = quoteWalletFunding({ rail: "stripe_card", creditCents: EXAMPLE_CARD_TOP_UP_CENTS, cardFeeBps: wallet.cardFundingFeeBps });
  const activation = activationTopUp({ sourceRail, floorCents, limitCents, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents, bps: wallet.cardFundingFeeBps });

  function applyDaily(next: string) {
    setDailyText(next);
    const cents = next.trim() ? tryParseDollarInputToCents(next) : null;
    if (cents && !chipClicked) setFloorCents(recommendedFloorCents(sourceRail, cents, limits));
  }

  function chooseChip(cents: number) {
    setChipClicked(true);
    setFloorCents(cents);
    setCustomText("");
    setCustomError("");
  }

  function applyCustom(text: string) {
    setCustomText(text);
    setCustomError("");
    if (!text.trim()) return;
    const cents = tryParseDollarInputToCents(text);
    if (cents === null) { setCustomError("Enter a whole dollar amount like 250."); return; }
    const rounded = roundUpToStep(cents, FLOOR_STEP_CENTS);
    if (rounded < limits.autoReloadMinTriggerCents) { setCustomError(`The floor must be at least ${formatWholeDollars(limits.autoReloadMinTriggerCents)}.`); return; }
    setChipClicked(true);
    setFloorCents(rounded);
  }

  const valid = floorCents >= limits.autoReloadMinTriggerCents && !customError;
  const limitMoved = currentLimitCents !== undefined && limitCents !== currentLimitCents;

  return (
    <section className={SECTION} data-testid="wallet-step-floor">
      <h2 className="text-lg font-semibold">Set your floor</h2>
      <p className="mt-1 text-sm text-zinc-600">
        {sourceRail === "stripe_ach"
          ? "The floor is the balance we keep your wallet at. With a bank account, a higher floor means orders rarely outrun your settled money, so the backup card is rarely charged. The trade-off: more of your money sits in the wallet."
          : `With a card, top-ups land at once, so a low floor is fine. The fee is ${fee} of everything you spend whatever floor you choose — a higher floor parks more of your money and costs ${fee} once on the first fill (${formatWholeDollars(firstFillFeeCents(FIRST_FILL_EXAMPLE_FLOORS_CENTS[0], wallet.cardFundingFeeBps))} at ${formatWholeDollars(FIRST_FILL_EXAMPLE_FLOORS_CENTS[0])}, ${formatWholeDollars(firstFillFeeCents(FIRST_FILL_EXAMPLE_FLOORS_CENTS[1], wallet.cardFundingFeeBps))} at ${formatWholeDollars(FIRST_FILL_EXAMPLE_FLOORS_CENTS[1])}).`}
      </p>

      <div className="mt-4 space-y-2">
        <Label htmlFor="wallet-daily-cost">Typical daily order cost (optional)</Label>
        <Input id="wallet-daily-cost" data-testid="wallet-daily-cost" inputMode="decimal" placeholder="e.g. 40.00" value={dailyText} disabled={feedback.busy} onChange={(event) => applyDaily(event.target.value)} className="h-10 max-w-xs" />
        <div role="radiogroup" aria-label="Typical daily order cost" className="flex flex-wrap gap-2">
          {DAILY_COST_PRESETS_CENTS.map((cents) => (
            <RadioChip key={cents} label={formatWholeDollars(cents)} selected={dailyCents === cents} disabled={feedback.busy} onSelect={() => applyDaily(centsToDollarText(cents))} />
          ))}
        </div>
        <p className="text-xs text-zinc-500">Product cost plus shipping, all orders added up. A guess is fine — you can change the floor any time. This number stays on your device and is never sent to Card Shellz.</p>
        {dailyInvalid && <p role="alert" className="text-sm text-red-700">Enter a dollar amount like 40.00</p>}
      </div>

      {recommended !== null && dailyCents !== null && (
        <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm" data-testid="wallet-floor-recommendation">
          {sourceRail === "stripe_ach"
            ? `Based on ${formatWholeDollars(dailyCents)} a day, we suggest a floor of ${formatWholeDollars(recommended)}: about ${daysOfCover(recommended, dailyCents)} days of orders — enough for a bank top-up to land, ${BANK_SETTLEMENT_PHRASE_WITH_CALENDAR}, plus a busy weekend.`
            : `Based on ${formatWholeDollars(dailyCents)} a day, we suggest ${formatWholeDollars(recommended)}: about ${daysOfCover(recommended, dailyCents) === 1 ? "a day" : `${daysOfCover(recommended, dailyCents)} days`} of orders; top-ups land at once.`}
          {floorCents !== recommended && (
            <Button type="button" variant="outline" size="sm" className="ml-2 h-8" disabled={feedback.busy} onClick={() => chooseChip(recommended)}>Use {formatWholeDollars(recommended)}</Button>
          )}
        </div>
      )}

      <div role="radiogroup" aria-label="Keep my balance at" className="mt-4 space-y-2">
        <div className="text-sm font-medium">Keep my balance at</div>
        <div className="flex flex-wrap gap-2">
          {chips.map((cents) => {
            const isDefault = dailyCents === null && cents === DEFAULT_FLOOR_CENTS_BY_SOURCE[sourceRail];
            const isRecommended = recommended === cents;
            const chipDays = daysOfCover(cents, dailyCents);
            return (
              <RadioChip
                key={cents}
                label={isRecommended && !FLOOR_PRESETS_CENTS.includes(cents) ? `Recommended ${formatWholeDollars(cents)}` : formatWholeDollars(cents)}
                hint={chipDays !== null ? `≈ ${chipDays} days` : isDefault ? "Default" : undefined}
                selected={floorCents === cents && !customText.trim()}
                disabled={feedback.busy}
                onSelect={() => chooseChip(cents)}
              />
            );
          })}
        </div>
        <div className="max-w-xs space-y-1">
          <Label htmlFor="wallet-floor-custom">Another amount</Label>
          <Input id="wallet-floor-custom" data-testid="wallet-floor-custom" inputMode="numeric" placeholder="Whole dollars" value={customText} disabled={feedback.busy} onChange={(event) => applyCustom(event.target.value)} className="h-10" />
          {customError && <p role="alert" className="text-sm text-red-700">{customError}</p>}
        </div>
      </div>

      <div className="mt-4 space-y-2 rounded-md border border-violet-100 bg-violet-50 p-3 text-sm text-zinc-700" data-testid="wallet-floor-guidance">
        <p role="status" aria-live="polite" data-testid="wallet-impact">
          {sourceRail === "stripe_ach"
            ? `Keeping ${formatWholeDollars(floorCents)} means routine top-ups are free and the backup card is charged only when orders outrun your settled money.`
            : `Keeping ${formatWholeDollars(floorCents)} means every top-up, whatever its size, costs ${fee}; the floor changes how much of your money sits in the wallet, not the fee.`}
        </p>
        {days !== null && dailyCents !== null && (
          <p data-testid="wallet-guidance-days">
            About {days} days of typical orders at {formatWholeDollars(dailyCents)} a day.{" "}
            <span data-testid="wallet-floor-verdict">
              {verdict === "keeps_up" && `Keeps up: a bank transfer — ${BANK_SETTLEMENT_PHRASE_WITH_CALENDAR} — lands before the floor runs out, with time to spare.`}
              {verdict === "tight" && `Tight: a transfer lands about when the floor runs out — no margin for a busy weekend, so some orders may hit your backup card at ${fee}.`}
              {verdict === "may_fall_short" && `May fall short: shorter than a transfer can take, so expect some orders to hit your backup card at ${fee}.`}
              {verdict === "instant" && "Fine with a card: top-ups land at once."}
            </span>
          </p>
        )}
        <p data-testid="wallet-guidance-parked">
          Routine top-ups keep up to {formatWholeDollars(floorCents)} in the wallet.
          {sourceRail === "stripe_ach" ? " — plus transfers on the way." : ` The first fill to ${formatWholeDollars(floorCents)} is charged ${fee} once: ${formatWholeDollars(firstFillFeeCents(floorCents, wallet.cardFundingFeeBps))}.`}
        </p>
        <p data-testid="wallet-guidance-fee">
          {sourceRail === "stripe_ach"
            ? estimate && dailyCents
              ? `Estimated card fees: about ${formatWholeDollars(estimate.estimateCents)} a month at ${formatWholeDollars(estimate.monthlySpendCents)} of orders — at most ${fee} of what actually goes on the card, ${formatWholeDollars(estimate.maxCents)} if all ${formatWholeDollars(estimate.monthlySpendCents)} did. The estimate assumes even daily orders and transfers landing in ${BANK_SETTLEMENT_PHRASE_WITH_CALENDAR}.`
              : `Card fees: $0 on routine top-ups. Only a shortfall is charged ${fee} — for example a ${formatWholeDollars(EXAMPLE_SHORTFALL.orderCents)} order with ${formatWholeDollars(EXAMPLE_SHORTFALL.availableCents)} available charges your backup card ${formatWholeDollars(example.shortfallCents)} + ${formatWholeDollars(example.feeCents)}.`
            : estimate
              ? `Card fees: about ${formatWholeDollars(estimate.estimateCents)} a month at ${formatWholeDollars(estimate.monthlySpendCents)} of orders (${fee} of every top-up) — the same at any floor, plus ${fee} once on the first fill.`
              : `Card fees: ${fee} of every top-up, whatever floor you choose. For example a ${formatWholeDollars(exampleCardTopUp.creditCents)} top-up charges ${formatWholeDollars(exampleCardTopUp.chargedCents)}.`}
        </p>
        <p data-testid="wallet-guidance-activation">
          {activation.outcome === "top_up" && sourceRail === "stripe_ach" && `On the first daily check after you activate (about midnight UTC): we start a top-up of ${formatWholeDollars(activation.amountCents)} from ${sourceLabel} — free, ${BANK_SETTLEMENT_PHRASE} to land. Until it lands, orders are charged to your backup card at ${fee}. Adding money by card now avoids that.`}
          {activation.outcome === "top_up" && sourceRail === "stripe_card" && `On the first daily check after you activate (about midnight UTC): we charge ${sourceLabel} ${formatWholeDollars(activation.chargedCents)} (${formatWholeDollars(activation.amountCents)} + ${formatWholeDollars(activation.feeCents)} fee) at once.`}
          {activation.outcome === "not_needed" && "On the first daily check after you activate: no top-up — your balance already covers your floor."}
          {activation.outcome === "skipped_over_limit" && `On the first daily check after you activate: the top-up needed (${formatWholeDollars(activation.amountCents)}) is more than your single top-up limit (${formatWholeDollars(activation.limitCents)}), so we do not charge it and email you instead. Add money or raise the limit under Limits.`}
        </p>
        <p className="text-xs text-zinc-600" data-testid="wallet-floor-limit-note">
          Single top-up limit: {formatWholeDollars(limitCents)} ({describeLimitDerivation(floorCents, limitCents)}). We never charge more than this in one top-up. An order needing more than your available balance plus this limit waits for you to add money and is cancelled after {formatDurationMinutes(holdMinutes)}; we email you {formatDurationMinutes(limits.holdExpiryWarningMinutes)} before that. Change it later under Limits.
        </p>
      </div>
      {limitMoved && (
        <p className="mt-3 text-sm text-zinc-600">Single top-up limit lifted to {formatWholeDollars(limitCents)} ({describeLimitDerivation(floorCents, limitCents)}).</p>
      )}
      {saveNote}
      <SectionFeedback {...feedback} />
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || !valid || dailyInvalid} onClick={() => onSubmit(floorCents, dailyCents)}>{submitLabel}</Button>
        <StepBack busy={feedback.busy} onBack={onBack} />
        {onCancel && <Button type="button" variant="ghost" className="h-10" disabled={feedback.busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </section>
  );
}

function centsToDollarText(centsValue: number): string {
  return centsValue % 100 === 0 ? String(centsValue / 100) : `${Math.trunc(centsValue / 100)}.${String(centsValue % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Step 4 — Your backup card (also the manage-mode backup editor)
// ---------------------------------------------------------------------------

function BackupPicker({
  wallet, now, selectedId, onSelect, busy, onAdd, confirmation, onCheckAgain,
}: {
  wallet: DropshipWalletView;
  now: Date;
  selectedId: number | null;
  onSelect: (id: number) => void;
  busy: boolean;
  onAdd: () => void;
  confirmation: { timedOut: boolean } | null;
  onCheckAgain: () => void;
}) {
  const cards = activeMethodsOfRail(wallet, "stripe_card").filter((method) => method.roles.chargeable);
  const eligible = cards.filter((method) => isEligibleBackupCard(method, now));
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  return (
    <div className="mt-4 space-y-3">
      {confirmation ? (
        <MethodConfirmation rail="stripe_card" timedOut={confirmation.timedOut} onCheckAgain={onCheckAgain} />
      ) : eligible.length === 0 ? (
        <>
          <Button type="button" variant="outline" className="h-10 w-full gap-2 sm:w-auto" disabled={busy} onClick={onAdd}><CreditCard className="h-4 w-4" />Add a card</Button>
          <p className="text-xs text-zinc-500">You finish on Stripe's page. Card Shellz never sees your card number.</p>
        </>
      ) : cards.length === 1 ? (
        <>
          <p className="text-sm text-zinc-700">{describeFundingMethodDetailed(eligible[0])} will be your backup card.</p>
          <ExpiryLine method={eligible[0]} now={now} />
          <Button type="button" variant="outline" className="h-10 w-full sm:w-auto" disabled={busy} onClick={onAdd}>Use a different card</Button>
        </>
      ) : (
        <>
          <div role="radiogroup" aria-label="Which card" className="flex flex-wrap gap-2">
            {cards.map((method) => {
              const expired = method.card !== null && cardExpiryState(method.card, now) === "expired";
              return (
                <RadioChip
                  key={method.fundingMethodId}
                  label={describeFundingMethodDetailed(method)}
                  hint={expired ? "Expired — add a current card" : undefined}
                  selected={selectedId === method.fundingMethodId}
                  disabled={busy || expired}
                  onSelect={() => onSelect(method.fundingMethodId)}
                />
              );
            })}
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy} onClick={onAdd}>Add a card</Button>
        </>
      )}
      <p className="text-sm text-zinc-500" data-testid="wallet-card-fee-note">Card charges carry a {fee} fee on top of the amount added. Bank accounts and USDC carry no fee.</p>
    </div>
  );
}

function ExpiryLine({ method, now }: { method: WalletFundingMethod; now: Date }) {
  if (!method.card) return null;
  const state = cardExpiryState(method.card, now);
  if (state === "expired") return <p className="text-sm text-red-700">Expired — add a current card. An expired card is declined at charge time and selling pauses.</p>;
  if (state === "expiring") return <p className="text-sm text-amber-700">Expires soon. Add a new backup card before it is needed.</p>;
  return null;
}

function BackupStep({
  wallet, now, feedback, confirmation, pendingNotice, onCheckAgain, onAdd, initialCardId, submitLabel, onSubmit, onBack, onCancel, saveNote,
}: {
  wallet: DropshipWalletView;
  now: Date;
  feedback: Feedback;
  confirmation: { timedOut: boolean } | null;
  pendingNotice: { purpose: StripePurpose } | null;
  onCheckAgain: () => void;
  onAdd: () => void;
  initialCardId: number | null;
  submitLabel: string;
  onSubmit: (card: WalletFundingMethod) => void;
  /** The flow's Back control; the manage editor passes `onCancel` instead. */
  onBack?: () => void;
  onCancel?: () => void;
  saveNote?: ReactNode;
}) {
  const eligible = wallet.fundingMethods.filter((method) => isEligibleBackupCard(method, now));
  const [selectedId, setSelectedId] = useState<number | null>(initialCardId ?? (eligible.length === 1 ? eligible[0].fundingMethodId : null));
  // A card Stripe just added is pre-selected while this step is open; Continue is still required.
  useEffect(() => {
    if (initialCardId !== null) setSelectedId(initialCardId);
  }, [initialCardId]);
  const selected = eligible.find((method) => method.fundingMethodId === (selectedId ?? (eligible.length === 1 ? eligible[0].fundingMethodId : null))) ?? null;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  return (
    <section className={SECTION} data-testid="wallet-step-backup">
      <h2 className="text-lg font-semibold">Your backup card</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Bank transfers take days to land. A card lets an order go out when your balance is short: we charge it the shortfall plus the {fee} fee — never to refill the wallet — and accept the order right away, even while a bank top-up is still landing. It is never used for routine top-ups. Keep your floor high and it may never be used.
      </p>
      <BackupPicker wallet={wallet} now={now} selectedId={selected?.fundingMethodId ?? null} onSelect={setSelectedId} busy={feedback.busy} onAdd={onAdd} confirmation={confirmation} onCheckAgain={onCheckAgain} />
      <Impact>While your account is active, we only ever charge this card when an order needs more than your available balance, and only for the shortfall plus the {fee} fee — up to your single top-up limit. If a return fee has taken your balance below zero, the shortfall includes that amount. Your bank top-ups stay free.</Impact>
      {pendingNotice && <PendingStripeNotice purpose={pendingNotice.purpose} onCheckAgain={onCheckAgain} />}
      {saveNote}
      <SectionFeedback {...feedback} />
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || !selected} onClick={() => selected && onSubmit(selected)}>{submitLabel}</Button>
        <StepBack busy={feedback.busy} onBack={onBack} />
        {onCancel && <Button type="button" variant="ghost" className="h-10" disabled={feedback.busy} onClick={onCancel}>Cancel</Button>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Review and turn on auto-reload (also Confirm terms / Turn on in manage)
// ---------------------------------------------------------------------------

function buildReviewRows({ wallet, terms, dailyCostCents }: { wallet: DropshipWalletView; terms: WalletTerms; dailyCostCents: number | null }) {
  const days = daysOfCover(terms.floorCents, dailyCostCents);
  const rows: Array<[string, string, ("source" | "floor" | "backup") | null]> = [
    ["Top-ups from", terms.sourceRail === "stripe_ach" ? `${terms.sourceLabel} (bank account, no fee)` : `${terms.sourceLabel} (card, ${formatFeeRate(terms.cardFundingFeeBps)} fee)`, "source"],
    ["Floor", `${formatWholeDollars(terms.floorCents)}${days !== null && dailyCostCents !== null ? ` — about ${days} days at ${formatWholeDollars(dailyCostCents)} a day` : ""}`, "floor"],
    ["Backup card", terms.sourceRail === "stripe_card" ? `${terms.backupLabel} — also your top-up source` : terms.backupLabel, terms.sourceRail === "stripe_card" ? null : "backup"],
    ["Single top-up limit", `${formatWholeDollars(terms.limitCents)} — ${describeLimitDerivation(terms.floorCents, terms.limitCents)}. Change it later under Limits.`, null],
    ["Hold time", `${formatDurationMinutes(terms.holdTimeoutMinutes)}${terms.holdTimeoutMinutes === wallet.limits.defaultPaymentHoldTimeoutMinutes ? " — the default" : ""}. Change it later under Limits.`, null],
  ];
  return { rows, mandate: describeMandate(terms) };
}

function ReviewStep({
  wallet, flow, draft, feedback, disabled, onBack, onChange, onAuthorize,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  draft: WalletDraft;
  feedback: Feedback;
  disabled: boolean;
  onBack?: () => void;
  /** Each Change opens that step with its saved value; nothing is cleared until the vendor picks something else. */
  onChange: (step: "source" | "floor" | "backup") => void;
  onAuthorize: () => void;
}) {
  const terms = termsFor(wallet, flow);
  if (!terms) return null;
  const { rows, mandate } = buildReviewRows({ wallet, terms, dailyCostCents: draft.dailyCostCents });
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const busy = feedback.busy;
  return (
    <section className={SECTION} data-testid="wallet-step-review">
      <h2 className="text-lg font-semibold">Review and turn on auto-reload</h2>
      <p className="mt-1 text-sm text-zinc-600">This is everything Card Shellz may charge without you present. Read it once; you can change any of it later.</p>
      <dl className="mt-4 divide-y divide-zinc-200 rounded-md border border-zinc-200" data-testid="wallet-review-summary">
        {rows.map(([label, value, step]) => (
          <div key={label} className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
              <dd className="text-zinc-800">{value}</dd>
            </div>
            {/* Once the plan is authorized those steps are no longer open, so the control is not offered rather than offered and dead. */}
            {step && flow.reachableSteps.includes(step) && (
              <Button type="button" variant="outline" size="sm" className="h-8 w-fit" disabled={busy} onClick={() => onChange(step)}>Change</Button>
            )}
          </div>
        ))}
      </dl>
      <h3 className="mt-5 font-medium">What you authorize Card Shellz to do</h3>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-zinc-700" data-testid="wallet-mandate">
        {mandate.map((line) => <li key={line}>{line}</li>)}
      </ol>
      <p className="mt-4 text-sm font-medium text-zinc-800" data-testid="wallet-plan-sentence">{describePlanSentence(terms)}</p>
      <p className="mt-2 text-sm text-zinc-600" data-testid="wallet-activation-quote">
        {describeActivationQuote({ terms, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents })}
      </p>
      <p className="mt-2 text-sm text-zinc-500" data-testid="wallet-fee-acknowledgement-line">
        Clicking the button records that you agree to the {fee} fee on card charges, with today's date and the team member who agreed. You can change any of this later in Wallet.
      </p>
      <Impact>From now on we top up on our own as described above. Nothing is charged until you activate your account.</Impact>
      <SectionFeedback {...feedback} />
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={busy || disabled} onClick={onAuthorize}>Agree and turn on auto-reload</Button>
        <StepBack busy={busy} onBack={onBack} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Adding money: step 6 and the manage-mode panel share these controls
// ---------------------------------------------------------------------------

function FundingControls({
  wallet, floorCents, busy, quoteTestId, usdcOffered, onContinue, onAddMethod, onSaveUsdc, extraBelowButton,
}: {
  wallet: DropshipWalletView;
  floorCents: number;
  busy: boolean;
  quoteTestId: string;
  usdcOffered: boolean;
  onContinue: (rail: WalletSourceRail, amountCents: number) => void;
  onAddMethod: (rail: WalletSourceRail) => void;
  onSaveUsdc?: (input: { walletAddress: string; displayLabel: string }) => void;
  extraBelowButton?: ReactNode;
}) {
  const limits = wallet.limits;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const [rail, setRail] = useState<WalletSourceRail | "usdc">("stripe_ach");
  const defaultAmount = depositAmountDefault(floorCents, limits);
  const [presetCents, setPresetCents] = useState(defaultAmount);
  const [customText, setCustomText] = useState("");
  const [customError, setCustomError] = useState("");
  const chips = presetsIncluding(DEPOSIT_PRESETS_CENTS, floorCents).filter((cents) => cents >= limits.manualFundingMinCents && cents <= limits.manualFundingMaxCents);
  const chosen = customText.trim() ? tryParseDollarInputToCents(customText) : presetCents;
  const method = rail === "usdc" ? null : depositFundingMethodFor(wallet, rail);
  const quote = rail !== "usdc" && chosen !== null && chosen > 0 ? quoteWalletFunding({ rail, creditCents: chosen, cardFeeBps: wallet.cardFundingFeeBps }) : null;

  function submit() {
    if (rail === "usdc") return;
    let amountCents = presetCents;
    if (customText.trim()) {
      const parsed = tryParseDollarInputToCents(customText);
      if (parsed === null) { setCustomError("Enter a dollar amount like 75.00"); return; }
      amountCents = parsed;
    }
    if (amountCents < limits.manualFundingMinCents || amountCents > limits.manualFundingMaxCents) {
      setCustomError(`Amounts must be between ${formatWholeDollars(limits.manualFundingMinCents)} and ${formatWholeDollars(limits.manualFundingMaxCents)}.`);
      return;
    }
    setCustomError("");
    onContinue(rail, amountCents);
  }

  return (
    <div className="mt-4 space-y-4">
      <div role="radiogroup" aria-label="Pay with" className="flex flex-wrap gap-2">
        <RadioChip label="Bank account (no fee)" selected={rail === "stripe_ach"} disabled={busy} onSelect={() => setRail("stripe_ach")} />
        <RadioChip label={`Card (${fee} fee)`} selected={rail === "stripe_card"} disabled={busy} onSelect={() => setRail("stripe_card")} />
        {usdcOffered && <RadioChip label="USDC on Base" hint="No fee · manual" selected={rail === "usdc"} disabled={busy} onSelect={() => setRail("usdc")} />}
      </div>
      {rail === "usdc" && wallet.usdcBaseDepositAddress && onSaveUsdc ? (
        <UsdcFundingPanel wallet={wallet} busy={busy} onSave={onSaveUsdc} />
      ) : rail !== "usdc" ? (
        <>
          <p className="text-xs text-zinc-500">You finish on Stripe's page. The account or card you use there is saved to your wallet.</p>
          <div role="radiogroup" aria-label="Amount" className="flex flex-wrap gap-2">
            {chips.map((cents) => (
              <RadioChip key={cents} label={formatWholeDollars(cents)} selected={!customText.trim() && presetCents === cents} disabled={busy} onSelect={() => { setPresetCents(cents); setCustomText(""); setCustomError(""); }} />
            ))}
          </div>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="wallet-custom-amount">Or another amount</Label>
            <Input id="wallet-custom-amount" inputMode="decimal" placeholder="75.00" value={customText} disabled={busy} onChange={(event) => { setCustomText(event.target.value); setCustomError(""); }} className="h-10" />
            {customError && <p role="alert" className="text-sm text-red-700">{customError}</p>}
          </div>
          {quote && (
            <p className="text-sm text-zinc-600" data-testid={quoteTestId}>
              {rail === "stripe_ach"
                ? `No fee. ${formatCents(quote.creditCents)} goes into your wallet once the bank transfer settles — ${BANK_SETTLEMENT_PHRASE}. It cannot pay orders until then.`
                : `Card fee (${fee}): ${formatCents(quote.feeCents)}. Your card is charged ${formatCents(quote.chargedCents)} and ${formatCents(quote.creditCents)} goes into your wallet, available at once.`}
            </p>
          )}
          {method ? (
            <Button type="button" className={BRAND_BUTTON} disabled={busy} onClick={submit}>{busy ? "One moment" : "Continue on Stripe"}</Button>
          ) : (
            <Button type="button" variant="outline" className="h-10 w-full gap-2 sm:w-auto" disabled={busy} onClick={() => onAddMethod(rail)}>
              {rail === "stripe_ach" ? <Landmark className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
              {rail === "stripe_ach" ? "Add a bank account" : "Add a card"}
            </Button>
          )}
          {extraBelowButton}
        </>
      ) : null}
    </div>
  );
}

function UsdcFundingPanel({ wallet, busy, onSave }: { wallet: DropshipWalletView; busy: boolean; onSave: (input: { walletAddress: string; displayLabel: string }) => void }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [displayLabel, setDisplayLabel] = useState("USDC on Base");
  const registered = wallet.fundingMethods.filter((method) => method.rail === "usdc_base" && method.status === "active");
  return (
    <div className="space-y-3" data-testid="wallet-usdc-funding">
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
        <div className="text-xs uppercase text-zinc-500">Deposit address (Base)</div>
        <code className="mt-1 block break-all font-mono text-zinc-900" data-testid="wallet-usdc-deposit-address">{wallet.usdcBaseDepositAddress}</code>
      </div>
      <p className="text-sm text-zinc-600">No fee. A member of the Card Shellz team credits your wallet after confirming the transfer — this is not instant.</p>
      {registered.length > 0 && (
        <ul className="space-y-1 text-sm">
          {registered.map((method) => <li key={method.fundingMethodId}>Sending from {describeFundingMethod(method)}</li>)}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <Label htmlFor="wallet-usdc-address">Wallet address you send from</Label>
          <Input id="wallet-usdc-address" placeholder="0x..." value={walletAddress} disabled={busy} onChange={(event) => setWalletAddress(event.target.value)} className="h-10 font-mono text-sm" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="wallet-usdc-label">Label</Label>
          <Input id="wallet-usdc-label" value={displayLabel} disabled={busy} onChange={(event) => setDisplayLabel(event.target.value)} className="h-10" />
        </div>
      </div>
      <p className="text-xs text-zinc-500">Optional. Card Shellz keeps the address on file for our team; nothing is matched automatically.</p>
      <Button type="button" variant="outline" className="h-10 w-full gap-2 sm:w-auto" disabled={busy || !walletAddress.trim()} onClick={() => onSave({ walletAddress, displayLabel })}>
        <Coins className="h-4 w-4" />Save USDC address
      </Button>
    </div>
  );
}

function DepositStep({
  wallet, flow, feedback, pendingNotice, onCheckAgain, onBack, onContinue, onAddMethod, onNotNow,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  feedback: Feedback;
  pendingNotice: { purpose: StripePurpose } | null;
  onCheckAgain: () => void;
  onBack?: () => void;
  onContinue: (rail: WalletSourceRail, amountCents: number) => void;
  onAddMethod: (rail: WalletSourceRail) => void;
  onNotNow: () => void;
}) {
  const terms = termsFor(wallet, flow);
  if (!terms) return null;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  return (
    <section className={SECTION} data-testid="wallet-step-deposit">
      <h2 className="text-lg font-semibold">Add money now (recommended)</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Your balance is {formatWholeDollars(wallet.account.availableBalanceCents)}. {describeActivationTopUp(terms)} That first top-up is {formatWholeDollars(terms.floorCents)} from {terms.sourceLabel}, no fee, and it takes {BANK_SETTLEMENT_PHRASE} to land. Until then any order is charged to your backup card {terms.backupLabel} for the shortfall plus {fee}. Money you add by card is available at once; a bank transfer you start now helps once it lands.
      </p>
      <FundingControls
        wallet={wallet}
        floorCents={terms.floorCents}
        busy={feedback.busy}
        quoteTestId="wallet-deposit-quote"
        usdcOffered={false}
        onContinue={onContinue}
        onAddMethod={onAddMethod}
        extraBelowButton={<p className="text-xs text-zinc-500">Adding money is a separate payment, so we may ask you to confirm it is you again.</p>}
      />
      <Impact>The transfer shows as on the way until your bank settles it and counts toward your floor, so we will not start a second one for the same money. Until it lands, money on its way cannot pay an order.</Impact>
      {pendingNotice && <PendingStripeNotice purpose={pendingNotice.purpose} onCheckAgain={onCheckAgain} />}
      <SectionFeedback {...feedback} />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="ghost" className="h-10 w-full sm:w-auto" disabled={feedback.busy} onClick={onNotNow}>Not now</Button>
        <StepBack busy={feedback.busy} onBack={onBack} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Done state — manage: every choice has a Change control
// ---------------------------------------------------------------------------

function ManageView({
  wallet, flow, draft, now, stillOnboarding, editor, setEditor, addMoneyOpen, setAddMoneyOpen, newMethodOffer, dismissOffer, returnBanner, dismissReturnBanner,
  pendingNotice, onCheckAgain, feedback, feeMisconfigured, onSavePlan, onConfirmTerms, onTurnOff, onRemove, onAddMethod, onAddFunds, onSaveUsdc, onBackToOnboarding,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  draft: WalletDraft;
  now: Date;
  stillOnboarding: boolean;
  editor: ManageEditor;
  setEditor: (editor: ManageEditor) => void;
  addMoneyOpen: boolean;
  setAddMoneyOpen: (open: boolean) => void;
  newMethodOffer: WalletFundingMethod | null;
  dismissOffer: () => void;
  returnBanner: { tone: "success" | "info"; text: string } | null;
  dismissReturnBanner: () => void;
  pendingNotice: { purpose: StripePurpose } | null;
  onCheckAgain: () => void;
  feedback: (scope: WalletScope) => Feedback;
  feeMisconfigured: boolean;
  onSavePlan: (plan: WalletPlanInput, successText?: string) => Promise<void>;
  onConfirmTerms: (plan: WalletPlanInput) => Promise<void>;
  onTurnOff: () => Promise<void>;
  onRemove: (method: WalletFundingMethod) => Promise<void>;
  onAddMethod: (scope: WalletScope, rail: WalletSourceRail) => Promise<void>;
  onAddFunds: (rail: WalletSourceRail, amountCents: number) => Promise<void>;
  onSaveUsdc: (input: { walletAddress: string; displayLabel: string }) => Promise<void>;
  onBackToOnboarding: () => void;
}) {
  const plan = planFromWallet(wallet);
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const source = flow.source?.method ?? null;
  const backup = flow.backup?.method ?? null;
  const ack = acknowledgementForSave({ autoReload: wallet.autoReload, cardFundingFeeBps: wallet.cardFundingFeeBps });
  const bannerFeedback = feedback("banner");
  const planFeedback = feedback("plan");
  const floorCents = wallet.autoReload?.minimumBalanceCents ?? flow.floorCents;
  const belowFloor = stillOnboarding && wallet.account.availableBalanceCents + wallet.account.pendingBalanceCents < floorCents;

  const saveNote = (
    <div className="mt-4 space-y-2 text-sm text-zinc-600">
      {plan && termsForPlan(wallet, plan) && <p>{describePlanSentence(termsForPlan(wallet, plan)!)}</p>}
      {ack.feeChangeNote && <p>{ack.feeChangeNote}</p>}
    </div>
  );

  /** A plan with one part replaced, saved as a whole row. */
  function savePart(update: (current: WalletPlanInput) => WalletPlanInput, successText?: string) {
    const base = plan ?? { fundingMethodId: source?.fundingMethodId ?? 0, backupFundingMethodId: backup?.fundingMethodId ?? 0, floorCents: flow.floorCents, limitCents: flow.limitCents, holdTimeoutMinutes: flow.holdTimeoutMinutes };
    return onSavePlan(update(base), successText);
  }

  return (
    <div data-testid="wallet-manage">
      {flow.needsAcknowledgement && (
        <Alert className="mt-5 border-amber-200 bg-amber-50 text-amber-900" data-testid="wallet-acknowledgement-needed">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {describeAcknowledgementBanner({ feeChange: flow.feeChange, onboarding: stillOnboarding })}
            <span className="mt-3 block">
              <Button type="button" variant="outline" size="sm" className="h-9 bg-white" disabled={bannerFeedback.busy || feeMisconfigured} onClick={() => setEditor("review")}>Confirm terms</Button>
            </span>
          </AlertDescription>
        </Alert>
      )}
      {(flow.roleGaps.backupCard || flow.roleGaps.source) && (
        <Alert variant="destructive" className="mt-5" data-testid="wallet-role-warning">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {flow.roleGaps.backupCard && (
              <span className="block">
                {describeRoleGap("backupCard", { holdTimeoutMinutes: flow.holdTimeoutMinutes, holdExpiryWarningMinutes: wallet.limits.holdExpiryWarningMinutes })}
                <span className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditor("backup")}>Choose a backup card</Button>
                  <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void onAddMethod("plan", "stripe_card")}>Add a card</Button>
                </span>
              </span>
            )}
            {flow.roleGaps.source && (
              <span className="mt-2 block">
                {describeRoleGap("source", { holdTimeoutMinutes: flow.holdTimeoutMinutes, holdExpiryWarningMinutes: wallet.limits.holdExpiryWarningMinutes })}
                <span className="mt-2 block"><Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditor("source")}>Change top-up source</Button></span>
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {newMethodOffer && plan && (
        <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" data-testid="wallet-new-method-offer">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            {describeFundingMethod(newMethodOffer)} added.{newMethodOffer.rail === "stripe_ach" ? " Use it for top-ups?" : ""}
            {source?.rail === "stripe_card" && newMethodOffer.rail === "stripe_card" && <span className="block text-xs">Using it for top-ups also makes it your backup card.</span>}
            {ack.feeChangeNote && <span className="block text-xs">{ack.feeChangeNote}</span>}
            <span className="mt-3 flex flex-wrap gap-2">
              {newMethodOffer.rail === "stripe_card" && (
                <Button type="button" variant="outline" size="sm" className="h-9 bg-white" disabled={planFeedback.busy}
                  onClick={() => savePart((current) => ({ ...current, backupFundingMethodId: newMethodOffer.fundingMethodId }), "Backup card updated.")}>Use as backup card</Button>
              )}
              <Button type="button" variant="outline" size="sm" className="h-9 bg-white" disabled={planFeedback.busy}
                onClick={() => savePart((current) => planAfterSourceChange(current, newMethodOffer, current.backupFundingMethodId), "Top-up source updated.")}>Use for top-ups</Button>
              <Button type="button" variant="ghost" size="sm" className="h-9" disabled={planFeedback.busy} onClick={dismissOffer}>Keep current</Button>
            </span>
          </AlertDescription>
        </Alert>
      )}
      {returnBanner && (
        <Alert className={returnBanner.tone === "success" ? "mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" : "mt-5"} data-testid="wallet-funding-return">
          {returnBanner.tone === "success" ? <CheckCircle2 className="h-4 w-4" /> : <Info className="h-4 w-4" />}
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{returnBanner.text}</span>
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={dismissReturnBanner}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}
      {pendingNotice && <PendingStripeNotice purpose={pendingNotice.purpose} onCheckAgain={onCheckAgain} />}

      <section className={SECTION} data-testid="wallet-balance">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-sm text-zinc-500">Available balance</div>
            <div className="mt-1 text-4xl font-semibold" data-testid="wallet-available">{formatSignedCents(wallet.account.availableBalanceCents)}</div>
            {wallet.account.pendingBalanceCents > 0 && (
              <p className="mt-1 text-sm text-zinc-500" data-testid="wallet-pending">{describePendingBalance(wallet.account.pendingBalanceCents)}</p>
            )}
            {wallet.account.availableBalanceCents < 0 && (
              <p className="mt-1 text-sm text-red-700" data-testid="wallet-negative-note">
                {formatSignedCents(wallet.account.availableBalanceCents)} — a return fee took the balance below zero. Your next top-up covers it, unless the top-up needed exceeds your single top-up limit ({formatWholeDollars(flow.limitCents)}) — then we email you instead of charging. Until then, a backup-card charge for an order includes this shortfall (order plus the amount below zero, plus {fee}).
              </p>
            )}
            {flow.authorized && <Badge variant="outline" className="mt-2">Floor {formatWholeDollars(floorCents)}</Badge>}
          </div>
          <Button type="button" variant={addMoneyOpen ? "outline" : "default"} className={addMoneyOpen ? "h-10 w-full sm:w-auto" : BRAND_BUTTON} onClick={() => setAddMoneyOpen(!addMoneyOpen)}>
            {addMoneyOpen ? "Close" : "Add money"}
          </Button>
        </div>
        {belowFloor && (
          <p className="mt-3 text-sm text-zinc-600" data-testid="wallet-deposit-callout">
            Add money by card before you activate, or start a bank transfer early enough to land, so your first orders do not run on the backup card.
          </p>
        )}
        {addMoneyOpen && (
          <div className="mt-5 border-t border-zinc-200 pt-1" data-testid="wallet-add-money">
            <FundingControls
              wallet={wallet}
              floorCents={floorCents}
              busy={feedback("money").busy}
              quoteTestId="wallet-funding-quote"
              usdcOffered={wallet.usdcBaseDepositAddress !== null}
              onContinue={(rail, amount) => void onAddFunds(rail, amount)}
              onAddMethod={(rail) => void onAddMethod("money", rail)}
              onSaveUsdc={(input) => void onSaveUsdc(input)}
            />
          </div>
        )}
        <SectionFeedback {...feedback("money")} />
      </section>

      <section className={SECTION} data-testid="wallet-plan">
        <h2 className="text-lg font-semibold">Your plan</h2>
        {!flow.authorized ? (
          <div className="mt-2">
            <p className="text-sm text-zinc-600">Auto-reload is off. Nothing is charged automatically; you cannot activate or sell until it is on.</p>
            {editor !== "review" && (
              <Button type="button" className={`mt-4 ${BRAND_BUTTON}`} disabled={planFeedback.busy || feeMisconfigured} onClick={() => setEditor("review")}>Turn on auto-reload</Button>
            )}
          </div>
        ) : (
          <dl className="mt-3 divide-y divide-zinc-200 rounded-md border border-zinc-200">
            <PlanRow testId="wallet-plan-source" label="Top-ups from" busy={planFeedback.busy} onChange={editor === "source" ? null : () => setEditor("source")}>
              {source ? `${describeFundingMethod(source)} · ${source.rail === "stripe_ach" ? "bank account · no fee" : `card · ${fee} fee`}` : "Not set"}
            </PlanRow>
            <PlanRow testId="wallet-plan-floor" label="Floor" busy={planFeedback.busy} onChange={editor === "floor" ? null : () => setEditor("floor")}>
              {formatWholeDollars(floorCents)} — topped up once a day and after any order that takes it lower.
              {draft.dailyCostCents !== null && daysOfCover(floorCents, draft.dailyCostCents) !== null && ` ≈ ${daysOfCover(floorCents, draft.dailyCostCents)} days at ${formatWholeDollars(draft.dailyCostCents)} a day.`}
            </PlanRow>
            <PlanRow testId="wallet-plan-backup-card" label="Backup card" busy={planFeedback.busy} onChange={source?.rail === "stripe_card" || editor === "backup" ? null : () => setEditor("backup")}>
              {backup ? describeFundingMethodDetailed(backup) : "Not set"}
              {backup?.card && cardExpiryState(backup.card, now) !== "ok" && cardExpiryState(backup.card, now) !== "unknown" && (
                <Badge variant={cardExpiryState(backup.card, now) === "expired" ? "destructive" : "outline"} className="ml-2" data-testid="wallet-backup-card-expiry">
                  {cardExpiryState(backup.card, now) === "expired" ? "Expired" : "Expires soon"}
                </Badge>
              )}
              <span className="block text-xs text-zinc-500">
                {source?.rail === "stripe_card"
                  ? "The same card you top up with."
                  : `Charged only for the shortfall on an order, plus ${fee}, up to your single top-up limit — even while a bank top-up is still landing.`}
                {backup?.card && cardExpiryState(backup.card, now) === "expired" && " Add a new backup card before it is needed — an expired card is declined at charge time and selling pauses."}
              </span>
            </PlanRow>
            <PlanRow testId="wallet-plan-limits" label="Limits" busy={planFeedback.busy} onChange={editor === "limits" ? null : () => setEditor("limits")}>
              Single top-up limit {formatWholeDollars(plan?.limitCents ?? flow.limitCents)} · hold time {formatDurationMinutes(flow.holdTimeoutMinutes)}
            </PlanRow>
            <PlanRow testId="wallet-plan-authorization" label="Authorization" busy={planFeedback.busy} onChange={null}>
              {wallet.autoReload?.acknowledgedAt === null || wallet.autoReload?.acknowledgedCardFeeBps === null
                ? "Not on record — confirm your terms above."
                : flow.feeChange
                  ? `Recorded ${formatDateTime(wallet.autoReload?.acknowledgedAt)} at a ${formatFeeRate(flow.feeChange.recordedBps)} card fee; the card fee is now ${formatFeeRate(flow.feeChange.currentBps)} — confirm the new terms above.`
                  : `Recorded ${formatDateTime(wallet.autoReload?.acknowledgedAt)} at a ${fee} card fee. The terms above are the current terms.`}
            </PlanRow>
            <PlanRow testId="wallet-plan-auto-reload" label="Auto-reload" busy={planFeedback.busy} onChange={null}>
              On
              {flow.canTurnOffAutoReload && <TurnOffDialog busy={planFeedback.busy} onConfirm={() => void onTurnOff()} />}
            </PlanRow>
          </dl>
        )}

        {editor === "source" && (
          <div className="mt-4 border-t border-zinc-200 pt-4" data-testid="wallet-source-editor">
            <SourceEditor wallet={wallet} now={now} plan={plan} currentBackup={backup} feedback={planFeedback} saveLabel={ack.saveLabel} saveNote={saveNote}
              onAdd={(rail) => void onAddMethod("plan", rail)} onCancel={() => setEditor(null)}
              onSave={(next) => savePart(() => next, "Top-up source updated.")} />
          </div>
        )}
        {editor === "floor" && flow.source && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <FloorStep wallet={wallet} flow={flow} sourceRail={flow.source.rail} sourceLabel={describeFundingMethod(flow.source.method)}
              initialFloorCents={floorCents} initialDailyCostCents={draft.dailyCostCents} feedback={planFeedback} submitLabel={ack.saveLabel}
              currentLimitCents={plan?.limitCents ?? flow.limitCents} saveNote={saveNote} onCancel={() => setEditor(null)}
              onSubmit={(newFloor) => savePart((current) => ({ ...current, floorCents: newFloor, limitCents: capAfterFloorChange(current.floorCents, newFloor, current.limitCents, wallet.limits) }), "Floor updated.")} />
          </div>
        )}
        {editor === "backup" && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <BackupStep wallet={wallet} now={now} feedback={planFeedback} confirmation={null} pendingNotice={null} onCheckAgain={onCheckAgain}
              onAdd={() => void onAddMethod("plan", "stripe_card")} initialCardId={backup?.fundingMethodId ?? null} submitLabel={ack.saveLabel} saveNote={saveNote}
              onCancel={() => setEditor(null)} onSubmit={(card) => savePart((current) => ({ ...current, backupFundingMethodId: card.fundingMethodId }), "Backup card updated.")} />
          </div>
        )}
        {editor === "limits" && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <LimitsEditor wallet={wallet} flow={flow} floorCents={floorCents} initialLimitCents={plan?.limitCents ?? flow.limitCents} initialHoldMinutes={flow.holdTimeoutMinutes}
              feedback={planFeedback} saveLabel={ack.saveLabel} saveNote={saveNote} onCancel={() => setEditor(null)}
              onSave={(limitCents, holdTimeoutMinutes) => savePart((current) => ({ ...current, limitCents, holdTimeoutMinutes }), "Limits updated.")} />
          </div>
        )}
        {editor === "review" && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <ConfirmTermsEditor wallet={wallet} flow={flow} draft={draft} plan={plan} feedback={flow.authorized ? bannerFeedback : planFeedback} disabled={feeMisconfigured}
              onCancel={() => setEditor(null)} onConfirm={(next) => void onConfirmTerms(next)} />
          </div>
        )}
        {editor !== "review" && <SectionFeedback {...planFeedback} />}
        {editor !== "review" && editor === null && flow.authorized && <SectionFeedback {...bannerFeedback} />}
      </section>

      <HowItWorksSection wallet={wallet} flow={flow} />
      <SavedMethods wallet={wallet} flow={flow} now={now} feedback={feedback("methods")} onRemove={onRemove} onAdd={(rail) => void onAddMethod("methods", rail)} />
      <ActivitySection wallet={wallet} />

      {stillOnboarding && (
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="outline" className="gap-2" onClick={onBackToOnboarding}>Back to onboarding<ArrowRight className="h-4 w-4" /></Button>
        </div>
      )}
    </div>
  );
}

/** The step-1 rules, collapsed, for a vendor past setup: the same copy, never a second wording of it. */
function HowItWorksSection({ wallet, flow }: { wallet: DropshipWalletView; flow: WalletFlowState }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={SECTION} data-testid="wallet-how-it-works">
      <Collapsible open={open} onOpenChange={setOpen}>
        <h2 className="text-lg font-semibold">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center justify-between gap-3 text-left">
              How your wallet works
              <ChevronDown className={open ? "h-5 w-5 shrink-0 rotate-180 text-zinc-500" : "h-5 w-5 shrink-0 text-zinc-500"} aria-hidden="true" />
            </button>
          </CollapsibleTrigger>
        </h2>
        <p className="mt-1 text-sm text-zinc-500">When we charge you, and why — the same rules you were shown at setup.</p>
        <CollapsibleContent className="mt-4">
          <WalletHowItWorks wallet={wallet} flow={flow} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function PlanRow({ testId, label, children, busy, onChange }: { testId: string; label: string; children: ReactNode; busy: boolean; onChange: (() => void) | null }) {
  return (
    <div className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between" data-testid={testId}>
      <div className="min-w-0">
        <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
        <dd className="text-zinc-800">{children}</dd>
      </div>
      {onChange && <Button type="button" variant="outline" size="sm" className="h-8 w-fit shrink-0" disabled={busy} onClick={onChange}>Change</Button>}
    </div>
  );
}

function TurnOffDialog({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="ml-3 h-8" disabled={busy} onClick={() => setOpen(true)} data-testid="wallet-auto-reload-off">Turn off auto-reload</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off auto-reload?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing will be charged automatically and your saved methods stay. You cannot activate or sell until it is on again; turning it back on asks you to review and agree to the terms.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>Turn off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SourceEditor({
  wallet, now, plan, currentBackup, feedback, saveLabel, saveNote, onAdd, onCancel, onSave,
}: {
  wallet: DropshipWalletView;
  now: Date;
  plan: WalletPlanInput | null;
  currentBackup: WalletFundingMethod | null;
  feedback: Feedback;
  saveLabel: string;
  saveNote: ReactNode;
  onAdd: (rail: WalletSourceRail) => void;
  onCancel: () => void;
  onSave: (plan: WalletPlanInput) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(plan?.fundingMethodId ?? null);
  const [backupId, setBackupId] = useState<number | null>(currentBackup?.fundingMethodId ?? null);
  const selected = wallet.fundingMethods.find((method) => method.fundingMethodId === selectedId && method.status === "active") ?? null;
  const follow = selected && plan ? describeBackupFollow(currentBackup, selected) : null;
  const needsBackupPick = selected?.rail === "stripe_ach";
  const backupValid = !needsBackupPick || wallet.fundingMethods.some((method) => method.fundingMethodId === backupId && isEligibleBackupCard(method, now));
  const next = selected && plan ? planAfterSourceChange(plan, selected, backupId) : null;
  return (
    <div>
      <h3 className="font-medium">Change your top-up source</h3>
      <div className="mt-3">
        <SourcePicker wallet={wallet} selectedId={selectedId} initialRail={null} onSelect={(method) => setSelectedId(method?.fundingMethodId ?? null)} busy={feedback.busy} onAdd={onAdd} confirmation={null} onCheckAgain={() => {}} editing />
      </div>
      {follow && <p className="mt-3 text-sm text-zinc-700" data-testid="wallet-source-backup-follow-note">{follow}</p>}
      {needsBackupPick && (
        <BackupPicker wallet={wallet} now={now} selectedId={backupId} onSelect={setBackupId} busy={feedback.busy} onAdd={() => onAdd("stripe_card")} confirmation={null} onCheckAgain={() => {}} />
      )}
      {saveNote}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || !next || !backupValid} onClick={() => next && onSave(next)}>{saveLabel}</Button>
        <Button type="button" variant="ghost" className="h-10" disabled={feedback.busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function LimitsEditor({
  wallet, flow, floorCents, initialLimitCents, initialHoldMinutes, feedback, saveLabel, saveNote, onCancel, onSave,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  floorCents: number;
  initialLimitCents: number;
  initialHoldMinutes: number;
  feedback: Feedback;
  saveLabel: string;
  saveNote: ReactNode;
  onCancel: () => void;
  onSave: (limitCents: number, holdTimeoutMinutes: number) => void;
}) {
  const limits: WalletLimits = wallet.limits;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const derived = derivedLimitCents(floorCents, limits);
  const [limitCents, setLimitCents] = useState(initialLimitCents);
  const [holdMinutes, setHoldMinutes] = useState(initialHoldMinutes);
  const floorOfChips = Math.max(floorCents, limits.autoReloadMinAmountCents);
  const chips = presetsIncluding(LIMIT_PRESETS_CENTS, initialLimitCents, derived).filter((cents) => cents >= floorOfChips);
  const holdChips = presetsIncluding(HOLD_TIMEOUT_PRESETS_MINUTES, initialHoldMinutes);
  return (
    <div data-testid="wallet-limits-editor">
      <h3 className="font-medium">Limits</h3>
      <div role="radiogroup" aria-label="Single top-up limit" className="mt-3 space-y-2">
        <div className="text-sm font-medium">Single top-up limit</div>
        <div className="flex flex-wrap gap-2">
          {chips.map((cents) => (
            <RadioChip key={cents} label={formatWholeDollars(cents)} hint={cents === derived ? "Use recommended" : undefined} selected={limitCents === cents} disabled={feedback.busy} onSelect={() => setLimitCents(cents)} />
          ))}
        </div>
        <p className="text-sm text-zinc-600">
          We never charge more than this in one top-up. Nothing is ever charged because of this limit. If an order needs more than your available balance plus this limit, we do not charge the card: the order waits for you to add money and is cancelled after the hold time if still short. A routine top-up is normally at most your floor, so this limit matters mostly for the backup card. If a return fee ever takes your balance below zero, the next backup-card charge includes that shortfall (so it can be more than {fee} of the order), and if the top-up needed exceeds the limit we email you instead of charging.
        </p>
      </div>
      <div role="radiogroup" aria-label="Hold time" className="mt-4 space-y-2">
        <div className="text-sm font-medium">Hold time</div>
        <div className="flex flex-wrap gap-2">
          {holdChips.map((minutes) => (
            <RadioChip key={minutes} label={formatDurationMinutes(minutes)} selected={holdMinutes === minutes} disabled={feedback.busy} onSelect={() => setHoldMinutes(minutes)} />
          ))}
        </div>
        <p className="text-sm text-zinc-600">{describeHoldTimeLine(limits.holdExpiryWarningMinutes)}</p>
      </div>
      {saveNote}
      <SectionFeedback {...feedback} />
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || limitCents < flow.floorCents} onClick={() => onSave(limitCents, holdMinutes)}>{saveLabel}</Button>
        <Button type="button" variant="ghost" className="h-10" disabled={feedback.busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** The §2.5 review inline: Confirm terms for an authorized row, Turn on auto-reload for a disabled one. */
function ConfirmTermsEditor({
  wallet, flow, draft, plan, feedback, disabled, onCancel, onConfirm,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  draft: WalletDraft;
  plan: WalletPlanInput | null;
  feedback: Feedback;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (plan: WalletPlanInput) => void;
}) {
  const fallbackPlan: WalletPlanInput | null = plan ?? (flow.source && flow.backup
    ? { fundingMethodId: flow.source.method.fundingMethodId, backupFundingMethodId: flow.backup.method.fundingMethodId, floorCents: flow.floorCents, limitCents: flow.limitCents, holdTimeoutMinutes: flow.holdTimeoutMinutes }
    : null);
  const terms = fallbackPlan ? termsForPlan(wallet, fallbackPlan) : null;
  if (!fallbackPlan || !terms) {
    return (
      <div>
        <p className="text-sm text-zinc-600">Choose a top-up source and a backup card before turning auto-reload on.</p>
        <Button type="button" variant="ghost" className="mt-3 h-10" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }
  const { rows, mandate } = buildReviewRows({ wallet, terms, dailyCostCents: draft.dailyCostCents });
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  return (
    <div data-testid="wallet-step-review">
      <h3 className="font-medium">{flow.authorized ? "Confirm your auto-reload terms" : "Review and turn on auto-reload"}</h3>
      <dl className="mt-3 divide-y divide-zinc-200 rounded-md border border-zinc-200" data-testid="wallet-review-summary">
        {rows.map(([label, value]) => (
          <div key={label} className="p-3 text-sm">
            <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
            <dd className="text-zinc-800">{value}</dd>
          </div>
        ))}
      </dl>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-700" data-testid="wallet-mandate">
        {mandate.map((line) => <li key={line}>{line}</li>)}
      </ol>
      <p className="mt-3 text-sm text-zinc-500" data-testid="wallet-fee-acknowledgement-line">
        Clicking the button records that you agree to the {fee} fee on card charges, with today's date and the team member who agreed.
      </p>
      <Impact>This applies from the next top-up.</Impact>
      <SectionFeedback {...feedback} />
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || disabled} onClick={() => onConfirm(fallbackPlan)}>
          {flow.authorized ? "Confirm terms" : "Agree and turn on auto-reload"}
        </Button>
        <Button type="button" variant="ghost" className="h-10" disabled={feedback.busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function SavedMethods({
  wallet, flow, now, feedback, onRemove, onAdd,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  now: Date;
  feedback: Feedback;
  onRemove: (method: WalletFundingMethod) => Promise<void>;
  onAdd: (rail: WalletSourceRail) => void;
}) {
  const [showRemoved, setShowRemoved] = useState(false);
  const [removing, setRemoving] = useState<WalletFundingMethod | null>(null);
  const live = wallet.fundingMethods.filter((method) => method.status !== "archived");
  const removed = wallet.fundingMethods.filter((method) => method.status === "archived");
  return (
    <section className={SECTION} data-testid="wallet-methods">
      <h2 className="text-lg font-semibold">Saved methods</h2>
      {live.length ? (
        <ul className="mt-3 space-y-2">
          {live.map((method) => {
            const reason = disabledReasonForRemoval(method, flow.canTurnOffAutoReload);
            const expiry = method.card ? cardExpiryState(method.card, now) : "unknown";
            return (
              <li key={method.fundingMethodId} className="rounded-md border border-zinc-200 p-3 text-sm" data-testid={`wallet-method-${method.fundingMethodId}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <span className="font-medium">{describeFundingMethodDetailed(method)}</span>
                    <span className="ml-2 flex-wrap gap-1 inline-flex">
                      {method.roles.isAutoReloadSource && <Badge variant="outline">Top-up source</Badge>}
                      {method.roles.isBackupCard && <Badge variant="outline">Backup card</Badge>}
                      {method.status === "setup_pending" && <Badge variant="outline">Verifying</Badge>}
                      {method.status === "failed" && <Badge variant="destructive">Failed</Badge>}
                      {expiry === "expired" && <Badge variant="destructive">Expired</Badge>}
                      {expiry === "expiring" && <Badge variant="outline" className="border-amber-300 text-amber-700">Expires soon</Badge>}
                    </span>
                    {reason && <span className="mt-1 block text-xs text-zinc-500">{reason}</span>}
                  </div>
                  <Button type="button" variant="outline" size="sm" className="h-8 w-fit shrink-0" disabled={feedback.busy || reason !== null} title={reason ?? undefined} onClick={() => setRemoving(method)} data-testid="wallet-method-remove">
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">None yet.</p>
      )}
      {removed.length > 0 && (
        <Collapsible open={showRemoved} onOpenChange={setShowRemoved} className="mt-3">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex items-center gap-1 text-sm text-zinc-600">{showRemoved ? "Hide removed" : "Show removed"}<ChevronDown className={showRemoved ? "h-4 w-4 rotate-180" : "h-4 w-4"} aria-hidden="true" /></button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-1 text-sm text-zinc-500">
              {removed.map((method) => <li key={method.fundingMethodId}>{describeFundingMethod(method)} · Removed</li>)}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" className="h-9 gap-2" disabled={feedback.busy} onClick={() => onAdd("stripe_card")}><CreditCard className="h-4 w-4" />Add a card</Button>
        <Button type="button" variant="outline" size="sm" className="h-9 gap-2" disabled={feedback.busy} onClick={() => onAdd("stripe_ach")}><Landmark className="h-4 w-4" />Add a bank account</Button>
      </div>
      <p className="mt-3 text-xs text-zinc-500">To replace a card: add the new one, make it the backup card (and your top-up source, if that card was it), then remove the old one.</p>
      <SectionFeedback {...feedback} />
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing ? describeFundingMethod(removing) : "this method"}?</AlertDialogTitle>
            <AlertDialogDescription>We also ask Stripe to remove it. Card Shellz will no longer charge it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const target = removing; setRemoving(null); if (target) void onRemove(target); }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ActivitySection({ wallet }: { wallet: DropshipWalletView }) {
  const labelFor = (id: number | null) => {
    if (id === null) return null;
    const method = wallet.fundingMethods.find((entry) => entry.fundingMethodId === id);
    return method ? describeFundingMethod(method) : "removed method";
  };
  return (
    <section className={SECTION} data-testid="wallet-activity">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Activity</h2>
        <History className="h-5 w-5 text-zinc-400" aria-hidden="true" />
      </div>
      {wallet.recentLedger.length ? (
        <div className="mt-4 overflow-x-auto rounded-md border border-zinc-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>What</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance after</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wallet.recentLedger.map((entry) => (
                <TableRow key={entry.ledgerEntryId}>
                  <TableCell>
                    <span className="block">{LEDGER_REASON_LABELS[entry.reason]}</span>
                    {entry.cardFee && (
                      <span className="block text-xs text-zinc-500">
                        {labelFor(entry.fundingMethodId) ? `from ${labelFor(entry.fundingMethodId)} · ` : ""}charged {formatCents(entry.cardFee.chargedCents)} incl. {formatCents(entry.cardFee.feeCents)} fee ({formatFeeRate(entry.cardFee.feeBps)})
                      </span>
                    )}
                    {entry.failure && <span className="block text-xs text-red-700">Failed: {entry.failure.code ?? entry.failure.message ?? "unknown"}</span>}
                  </TableCell>
                  <TableCell><Badge variant="outline">{formatStatus(entry.status)}</Badge></TableCell>
                  <TableCell className="text-right font-mono">{formatSignedCents(entry.amountCents)}</TableCell>
                  <TableCell className="text-right font-mono">{entry.availableBalanceAfterCents === null ? "—" : formatSignedCents(entry.availableBalanceAfterCents)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(entry.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">No activity yet. Charges and top-ups will show here.</p>
      )}
    </section>
  );
}

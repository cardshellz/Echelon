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
import {
  adaptWalletView,
  type DropshipWalletView,
  type WalletFundingMethod,
  type WalletLimits,
  type WalletAdvance,
  type WalletListingTierStatus,
  type WalletListingTiers,
} from "@/lib/dropship-wallet-view-adapter";
import {
  BANK_SETTLEMENT_PHRASE,
  EXAMPLE_CARD_TOP_UP_CENTS,
  EXAMPLE_MONTHLY_SPEND_CENTS,
  EXAMPLE_SHORTFALL,
  FIRST_FILL_EXAMPLE_FLOORS_CENTS,
  activationTopUp,
  cardExpiryState,
  chargeBoundCents,
  firstFillFeeCents,
  formatDurationMinutes,
  formatSignedCents,
  formatWholeDollars,
  nextTopUpCents,
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
  defaultMinimumCents,
  depositFundingMethodFor,
  deriveWalletFlow,
  draftAfterBackupChoice,
  draftAfterFloorChoice,
  draftAfterIntro,
  draftAfterSourceChoice,
  draftAtStep,
  describeAcknowledgementBanner,
  describeActivationQuote,
  describeAdvanceReason,
  describeAdvanceStanding,
  describeBackupFollow,
  describeFundingMethod,
  describeFundingMethodDetailed,
  describeHoldTimeLine,
  describeIntro,
  describeUsdcDeposit,
  describeUsdcSourceNote,
  usdcOfferedFor,
  describeMandate,
  describeMinimumOption,
  describeNegativeBalance,
  depositDefaultCents,
  depositOptions,
  describeDepositOption,
  describeDepositRail,
  describePendingBalance,
  describePlanSentence,
  describeRoleGap,
  describeSavedCardAlternative,
  describeSourcePreselection,
  describeTopUpOption,
  disabledReasonForRemoval,
  isEligibleBackupCard,
  isPendingStripeLive,
  minimumOptionFor,
  minimumOptions,
  parseStripeReturn,
  planAfterSourceChange,
  planFromWallet,
  previousWalletStep,
  readWalletDraft,
  RECOMMENDED_SOURCE_RAIL,
  resolveStripeReturn,
  stripStripeReturn,
  topUpCentsFor,
  topUpChoiceFor,
  topUpOptions,
  walletStepNumber,
  walletStepState,
  writeWalletDraft,
  type StripePurpose,
  type StripeReturn,
  type WalletDraft,
  type WalletFlowState,
  type WalletTopUpChoice,
  type WalletTopUpOption,
  type WalletFlowStep,
  type WalletPlanInput,
  type WalletTerms,
} from "@/lib/dropship-wallet-flow";
import { describeWalletError, type WalletErrorSurface } from "@/lib/dropship-wallet-errors";
import { DropshipPortalShell } from "./DropshipPortalShell";

/**
 * Vendor wallet.
 *
 * Six steps, decision first: how the wallet works, the autopay source, the
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
type ManageEditor = "source" | "floor" | "backup" | "review" | null;

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
  source: "Choose your autopay source",
  floor: "Set your minimum",
  backup: "Your backup card",
  authorize: "Review and turn on autopay",
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
  const draftRef = useRef<WalletDraft>(EMPTY_DRAFT);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const vendorId = vendor?.vendorId ?? null;
  useEffect(() => {
    if (vendorId === null || draftLoaded) return;
    const read = readWalletDraft(storageOrNull(), vendorId);
    draftRef.current = read.draft;
    setDraftState(read.draft);
    setStorageFailed(read.storageFailed);
    setDraftLoaded(true);
  }, [vendorId, draftLoaded]);
  function setDraft(update: (current: WalletDraft) => WalletDraft) {
    setDraftState((current) => {
      const next = update(current);
      draftRef.current = next;
      if (vendorId !== null && !writeWalletDraft(storageOrNull(), vendorId, next)) setStorageFailed(true);
      return next;
    });
  }

  /**
   * A Stripe redirect leaves the page. React runs a state updater during its
   * next render, which is after `window.location.assign` has been called, so a
   * draft written only through `setDraft` races the navigation: lose the race
   * and the vendor comes back with no record of the setup they started. The
   * redirect paths write synchronously through here before they navigate.
   */
  function commitDraftBeforeRedirect(next: WalletDraft) {
    draftRef.current = next;
    if (vendorId !== null && !writeWalletDraft(storageOrNull(), vendorId, next)) setStorageFailed(true);
    setDraftState(next);
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
      setDraftState(EMPTY_DRAFT);
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
    const limits = wallet?.limits ?? { bankBalanceReadOffered: false, autoReloadMinTriggerCents: 0, caseTierMinimumCents: 0, autoReloadMinAmountCents: 0, manualFundingMinCents: 0, manualFundingMaxCents: 0, defaultPaymentHoldTimeoutMinutes: 1, holdExpiryWarningMinutes: 1, advanceFeeBps: 0, advanceCapCents: 0, tierChangeGraceDays: 0 };
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
      commitDraftBeforeRedirect({ ...draftRef.current, pendingStripe });
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
      setNotice({ scope: "plan", tone: "success", text: "Autopay is on." });
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
      setNotice({ scope: "plan", tone: "success", text: "Terms confirmed. Autopay is on." });
    });
  }

  function turnOffAutoReload() {
    if (!wallet) return Promise.resolve();
    return putAutoReload("plan", buildAutoReloadDisableInput(wallet), () => {
      setNotice({ scope: "plan", tone: "success", text: "Autopay is off. Nothing is charged automatically." });
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
      commitDraftBeforeRedirect({ ...draftRef.current, pendingStripe });
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

  /** Asks for the vendor's own deposit address (funding design phase 6): receiving money needs no step-up. */
  async function requestUsdcAddress() {
    await run("money", "usdc", async () => {
      await postJson<unknown>("/api/dropship/wallet/usdc/deposit-address", {});
      await refreshAfterWalletChange();
      setNotice({ scope: "money", tone: "success", text: "Your USDC deposit address is ready." });
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
      surface: "get", limits: { bankBalanceReadOffered: false, autoReloadMinTriggerCents: 0, caseTierMinimumCents: 0, autoReloadMinAmountCents: 0, manualFundingMinCents: 0, manualFundingMaxCents: 0, defaultPaymentHoldTimeoutMinutes: 1, holdExpiryWarningMinutes: 1, advanceFeeBps: 0, advanceCapCents: 0, tierChangeGraceDays: 0 },
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
                    <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditor("source")}>Change autopay source</Button>
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
                initialFloorCents={draft.floorCents ?? defaultMinimumCents(wallet)}
                initialTopUpCents={draft.topUpCents}
                feedback={feedback("floor")}
                submitLabel="Continue"
                onBack={backTo(flow.step)}
                onSubmit={(floorCents, topUpCents) => setDraft((current) => draftAfterFloorChoice(current, floorCents, topUpCents))}
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
                  topUpCents: flow.topUpCents,
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
                onContinue={(rail, amountCents) => addFunds("deposit", rail, amountCents)}
                onAddMethod={(rail) => startStripeSetup("deposit", rail, "manage_add")}
                onSkip={() => setDraft((current) => ({ ...current, deposit: "skipped" }))}
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
            onRequestUsdcAddress={requestUsdcAddress}
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
    topUpCents: flow.topUpCents,
    limitCents: flow.limitCents,
    chargeCeilingCents: wallet.limits.manualFundingMaxCents,
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
    topUpCents: plan.topUpCents,
    limitCents: plan.limitCents,
    chargeCeilingCents: wallet.limits.manualFundingMaxCents,
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
      detail = formatWholeDollars(flow.floorCents);
    } else if (step === "backup" && flow.source?.rail === "stripe_card" && state !== "later") {
      detail = `Backup card · ${describeFundingMethod(flow.source.method)} — the card you top up with is also your backup card. If an order needs more than your balance, the same card pays the shortfall plus ${fee}, up to ${formatWholeDollars(wallet.limits.manualFundingMaxCents)} in one payment.`;
    } else if (step === "backup" && state === "done" && flow.backup) {
      detail = describeFundingMethodDetailed(flow.backup.method);
    } else if (step === "deposit" && flow.source?.rail === "stripe_card" && flow.backup) {
      const quote = activationTopUp({ sourceRail: "stripe_card", floorCents: flow.floorCents, topUpCents: flow.topUpCents, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents, bps: wallet.cardFundingFeeBps });
      detail = quote.outcome === "top_up"
        ? `First top-up · On the first daily check after you activate we charge ${describeFundingMethod(flow.source.method)} ${formatWholeDollars(quote.chargedCents)} (${formatWholeDollars(quote.amountCents)} + ${formatWholeDollars(quote.feeCents)} fee) to bring your balance back to your minimum. You can add money any time from Wallet.`
        : "First top-up · Your balance already covers your minimum. You can add money any time from Wallet.";
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

/**
 * The charge rules, worded once: step 1 during setup and the manage view's
 * "How your wallet works" render this. Each topic leads with its bold sentence
 * so they can be scanned without reading the detail.
 */
function WalletHowItWorks({ wallet, flow }: { wallet: DropshipWalletView; flow: WalletFlowState }) {
  const intro = describeIntro({ cardFundingFeeBps: wallet.cardFundingFeeBps, usdcOffered: usdcOfferedFor(wallet), usdcDeposit: wallet.usdcDeposit, holdTimeoutMinutes: flow.holdTimeoutMinutes, limits: wallet.limits });
  return (
    <>
      <p className="text-sm text-zinc-600" data-testid="wallet-how-it-works-lede">{intro.lede}</p>
      <ol className="mt-3 list-decimal space-y-4 pl-5 text-sm text-zinc-700" data-testid="wallet-how-it-works-rules">
        {intro.topics.map((topic) => (
          <li key={topic.lead}><strong className="font-semibold text-zinc-900">{topic.lead}</strong> {topic.detail}</li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-zinc-500" data-testid="wallet-intro-verification-note">{INTRO_VERIFICATION_NOTE}</p>
    </>
  );
}

function IntroStep({ wallet, flow, revisited, onContinue }: { wallet: DropshipWalletView; flow: WalletFlowState; revisited: boolean; onContinue: () => void }) {
  return (
    <section className={SECTION} data-testid="wallet-step-intro">
      <h2 className="text-lg font-semibold">How your wallet works</h2>
      {revisited && <p className="mt-1 text-sm text-zinc-500">The charge rules, unchanged. Nothing you have chosen is affected by reading them again.</p>}
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
  const ceiling = formatWholeDollars(wallet.limits.manualFundingMaxCents);
  const selected = wallet.fundingMethods.find((method) => method.fundingMethodId === selectedId) ?? null;
  const [railChoice, setRailChoice] = useState<WalletSourceRail | null>(null);
  const rail = selected ? (selected.rail as WalletSourceRail) : (railChoice ?? initialRail ?? RECOMMENDED_SOURCE_RAIL);
  const rows = (kind: WalletSourceRail) => kind === "stripe_ach"
    ? [
      ["Fee", "None"],
      ["Speed", `Up to 5 business days to land (our assumption — Stripe gives us no date)`],
      ["Money parked", "Higher minimum recommended, so more of your money sits in the wallet"],
      ["When an order needs more than your balance", `Your backup card pays the shortfall plus ${fee}, up to ${ceiling} in one payment`],
      ["Best for", "Most sellers: fees stay near zero when the minimum keeps up"],
    ]
    : [
      ["Fee", `${fee} on every top-up, on top of the amount`],
      ["Speed", "Lands at once"],
      ["Money parked", `A lower minimum is fine, so less of your money sits in the wallet — the first fill to the minimum is charged ${fee} once`],
      ["When an order needs more than your balance", `The same card pays the shortfall plus ${fee}, up to ${ceiling} in one payment`],
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
    // The whole card is the radio: a vendor reading the comparison rows expects
    // to click the row they just read, not hunt for the icon. The controls that
    // appear inside the selected card stop the click from reaching it, so using
    // them never re-picks the rail and discards a chosen method.
    return (
      <div
        role="radio"
        aria-checked={isSelected}
        aria-label={title}
        aria-disabled={busy}
        tabIndex={busy ? -1 : 0}
        onClick={() => { if (!busy) choose(kind); }}
        onKeyDown={(event) => {
          if (busy || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          choose(kind);
        }}
        className={`${isSelected ? "rounded-md border border-[#C060E0] bg-[#C060E0]/5 p-4" : "rounded-md border border-zinc-200 p-4"} ${busy ? "cursor-default" : "cursor-pointer"} focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0] focus-visible:ring-offset-2`}
        data-testid={`wallet-source-option-${kind === "stripe_ach" ? "bank" : "card"}`}
      >
        <div className="flex w-full items-start gap-3 text-left">
          <span className={isSelected ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#C060E0] text-white" : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700"}>
            {kind === "stripe_ach" ? <Landmark className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
          </span>
          <span>
            <span className="block font-medium">{title}</span>
            {kind === "stripe_ach" && <Badge variant="outline" className="mt-1 border-emerald-300 text-emerald-700">Recommended: no fees</Badge>}
          </span>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          {rows(kind).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
              <dd className="text-zinc-700">{value}</dd>
            </div>
          ))}
        </dl>
        {isSelected && (
          <div className="mt-3 space-y-2" onClick={(event) => event.stopPropagation()}>
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
  // The rail actually on screen: what the vendor chose, else the rail a Stripe
  // return points at, else the recommended one. The picker applies the same
  // fallback, so what is highlighted and what is explained below always agree.
  const shownRail = rail ?? confirmation?.rail ?? RECOMMENDED_SOURCE_RAIL;
  const savedCardAlternative = describeSavedCardAlternative({
    rail: shownRail,
    selected,
    cards: wallet.fundingMethods.filter((method) => isEligibleBackupCard(method, new Date())),
  });
  const exampleFee = quoteWalletFunding({ rail: "stripe_card", creditCents: EXAMPLE_MONTHLY_SPEND_CENTS, cardFeeBps: wallet.cardFundingFeeBps }).feeCents;
  const canContinue = selected !== null && (selected.rail === "stripe_ach" || selected.roles.chargeable);

  return (
    <section className={SECTION} data-testid="wallet-step-source">
      <h2 className="text-lg font-semibold">Choose your autopay source</h2>
      <p className="mt-1 text-sm text-zinc-500">This is where your routine top-ups come from — the money that pays your orders day to day. You can change it later.</p>
      <div className="mt-4">
        <SourcePicker
          wallet={wallet}
          selectedId={selectedId}
          initialRail={shownRail}
          onSelect={(method, kind) => { setSelectedId(method?.fundingMethodId ?? null); setRail(kind); onRailChange(kind); }}
          busy={feedback.busy}
          onAdd={onAdd}
          confirmation={confirmation}
          onCheckAgain={onCheckAgain}
          editing={false}
        />
      </div>
      {preselection && <p className="mt-3 text-sm text-zinc-600" data-testid="wallet-source-preselection">{preselection}</p>}
      {savedCardAlternative && <p className="mt-3 text-sm text-zinc-600" data-testid="wallet-source-saved-card">{savedCardAlternative}</p>}
      {usdcOfferedFor(wallet) && (
        <p className="mt-3 text-sm text-zinc-500" data-testid="wallet-usdc-note">{describeUsdcSourceNote(wallet.usdcDeposit)}</p>
      )}
      {shownRail === "stripe_ach" && (
        <Impact>Routine top-ups are free. While a transfer is landing, orders draw on what has already settled; if an order needs more, your backup card covers the shortfall plus {fee}, up to {formatWholeDollars(wallet.limits.manualFundingMaxCents)} in one payment. A higher minimum in the next step makes that rare.</Impact>
      )}
      {shownRail === "stripe_card" && (
        <Impact>
          Every top-up costs {fee}: for example, at {formatWholeDollars(EXAMPLE_MONTHLY_SPEND_CENTS)} of orders a month that is about {formatWholeDollars(exampleFee)} in fees. Your card is also your backup card, so there is nothing more to add.
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
  wallet, flow, sourceRail, sourceLabel, initialFloorCents, initialTopUpCents, feedback, submitLabel, onSubmit, onBack, onCancel, saveNote,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  sourceRail: WalletSourceRail;
  sourceLabel: string;
  initialFloorCents: number;
  /** The saved top-up amount; null is "the minimum". */
  initialTopUpCents: number | null;
  feedback: Feedback;
  submitLabel: string;
  onSubmit: (floorCents: number, topUpCents: number | null) => void;
  /** The flow's Back control; the manage editor passes `onCancel` instead. */
  onBack?: () => void;
  onCancel?: () => void;
  saveNote?: ReactNode;
}) {
  const limits = wallet.limits;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  // The two tier minimums are the only choices: the minimum exists to decide what the vendor can sell.
  const options = minimumOptions(limits);
  // A minimum saved before the step offered only the two tiers opens on the tier it falls in.
  const [floorCents, setFloorCents] = useState(minimumOptionFor(initialFloorCents, limits));
  // The top-up amount: the minimum itself, a multiple of it that follows the minimum, or an amount of the vendor's own.
  const [topUpChoice, setTopUpChoice] = useState<WalletTopUpChoice>(() => topUpChoiceFor(initialTopUpCents, minimumOptionFor(initialFloorCents, limits)));
  const [customText, setCustomText] = useState(() => {
    const initial = topUpChoiceFor(initialTopUpCents, minimumOptionFor(initialFloorCents, limits));
    return initial.kind === "custom" ? centsToDollarText(initial.cents) : "";
  });
  const [topUpError, setTopUpError] = useState("");
  const topUpChoices = topUpOptions(floorCents, limits);
  // A multiple the policy does not offer at this minimum (below its smallest top-up) reads as the minimum.
  const effectiveTopUp: WalletTopUpChoice = topUpChoice.kind === "multiple" && !topUpChoices.some((option) => option.factor === topUpChoice.factor)
    ? { kind: "minimum" }
    : topUpChoice;
  const topUpCents = topUpError ? null : topUpCentsFor(effectiveTopUp, floorCents);
  const boundCents = chargeBoundCents(floorCents, topUpCents);
  const holdMinutes = flow.holdTimeoutMinutes;
  const example = shortfallExample({ orderCents: EXAMPLE_SHORTFALL.orderCents, availableCents: EXAMPLE_SHORTFALL.availableCents, bps: wallet.cardFundingFeeBps });
  const exampleCardTopUp = quoteWalletFunding({ rail: "stripe_card", creditCents: EXAMPLE_CARD_TOP_UP_CENTS, cardFeeBps: wallet.cardFundingFeeBps });
  const activation = activationTopUp({ sourceRail, floorCents, topUpCents, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents, bps: wallet.cardFundingFeeBps });

  function chooseTopUp(factor: WalletTopUpOption["factor"]) {
    setCustomText("");
    setTopUpError("");
    setTopUpChoice(factor === 1 ? { kind: "minimum" } : { kind: "multiple", factor });
  }

  // Typing an amount of the vendor's own: it has to parse and clear the policy's smallest top-up; cleared, the minimum is back.
  function applyCustomTopUp(text: string) {
    setCustomText(text);
    setTopUpError("");
    if (!text.trim()) { setTopUpChoice({ kind: "minimum" }); return; }
    const cents = tryParseDollarInputToCents(text);
    if (cents === null) { setTopUpError("Enter a whole dollar amount like 250, or leave it blank."); return; }
    if (cents < limits.autoReloadMinAmountCents) { setTopUpError(`The top-up amount must be at least ${formatWholeDollars(limits.autoReloadMinAmountCents)}.`); return; }
    setTopUpChoice({ kind: "custom", cents });
  }

  const valid = options.some((option) => option.cents === floorCents) && !topUpError;

  return (
    <section className={SECTION} data-testid="wallet-step-floor">
      <h2 className="text-lg font-semibold">Set your minimum</h2>
      <p className="mt-1 text-sm text-zinc-600">
        {sourceRail === "stripe_ach"
          ? "Your minimum is the balance autopay keeps your wallet at, and it decides what you can sell. With a bank account, a higher minimum means orders rarely outrun your settled money, so the backup card is rarely charged. The trade-off: more of your money sits in the wallet."
          : `Your minimum is the balance autopay keeps your wallet at, and it decides what you can sell. With a card, top-ups land at once. The fee is ${fee} of everything you spend whatever minimum you choose — a higher minimum parks more of your money and costs ${fee} once on the first fill (${formatWholeDollars(firstFillFeeCents(FIRST_FILL_EXAMPLE_FLOORS_CENTS[0], wallet.cardFundingFeeBps))} at ${formatWholeDollars(FIRST_FILL_EXAMPLE_FLOORS_CENTS[0])}, ${formatWholeDollars(firstFillFeeCents(FIRST_FILL_EXAMPLE_FLOORS_CENTS[1], wallet.cardFundingFeeBps))} at ${formatWholeDollars(FIRST_FILL_EXAMPLE_FLOORS_CENTS[1])}).`}
      </p>

      <div role="radiogroup" aria-label="Minimum" className="mt-4 space-y-2">
        <div className="text-sm font-medium">Minimum</div>
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <RadioChip
              key={option.tier}
              label={formatWholeDollars(option.cents)}
              hint={describeMinimumOption(option.tier)}
              selected={floorCents === option.cents}
              disabled={feedback.busy}
              onSelect={() => setFloorCents(option.cents)}
              testId={`wallet-minimum-${option.tier}`}
            />
          ))}
        </div>
        <p className="text-xs text-zinc-500" data-testid="wallet-tier-hint">Keep at least the tier you sell. You can change it any time.</p>
      </div>

      <div role="radiogroup" aria-label="Top-up amount" className="mt-4 space-y-2" data-testid="wallet-top-up-amount">
        <div className="text-sm font-medium">Top-up amount</div>
        <div className="flex flex-wrap gap-2">
          {topUpChoices.map((option) => (
            <RadioChip
              key={option.factor}
              label={formatWholeDollars(option.cents)}
              hint={describeTopUpOption(option)}
              selected={effectiveTopUp.kind === "minimum" ? option.factor === 1 : effectiveTopUp.kind === "multiple" && option.factor === effectiveTopUp.factor}
              disabled={feedback.busy}
              onSelect={() => chooseTopUp(option.factor)}
              testId={`wallet-top-up-${option.factor}x`}
            />
          ))}
        </div>
        <div className="max-w-xs space-y-1">
          <Label htmlFor="wallet-top-up-custom">Another amount</Label>
          <Input id="wallet-top-up-custom" data-testid="wallet-top-up-custom" inputMode="numeric" placeholder="Whole dollars" value={customText} disabled={feedback.busy} onChange={(event) => applyCustomTopUp(event.target.value)} className="h-10" />
          {topUpError && <p role="alert" className="text-sm text-red-700">{topUpError}</p>}
        </div>
        <p className="text-xs text-zinc-500">What autopay pulls when an order takes your balance below your minimum. A larger amount means fewer, bigger top-ups.</p>
      </div>

      <div className="mt-4 space-y-2 rounded-md border border-violet-100 bg-violet-50 p-3 text-sm text-zinc-700" data-testid="wallet-floor-guidance">
        <p role="status" aria-live="polite" data-testid="wallet-impact">
          {sourceRail === "stripe_ach"
            ? `Keeping ${formatWholeDollars(floorCents)} means routine top-ups are free and the backup card is charged only when orders outrun your settled money.`
            : `Keeping ${formatWholeDollars(floorCents)} means every top-up, whatever its size, costs ${fee}; the minimum changes how much of your money sits in the wallet, not the fee.`}
        </p>
        <p data-testid="wallet-guidance-parked">
          Autopay keeps at least {formatWholeDollars(floorCents)} in the wallet, topping up by {formatWholeDollars(topUpCents ?? floorCents)} at a time.
          {sourceRail === "stripe_ach" ? " Transfers on the way count." : ` The first fill to ${formatWholeDollars(floorCents)} is charged ${fee} once: ${formatWholeDollars(firstFillFeeCents(floorCents, wallet.cardFundingFeeBps))}.`}
        </p>
        <p data-testid="wallet-guidance-fee">
          {sourceRail === "stripe_ach"
            ? `Card fees: $0 on routine top-ups. Only a shortfall is charged ${fee} — for example a ${formatWholeDollars(EXAMPLE_SHORTFALL.orderCents)} order with ${formatWholeDollars(EXAMPLE_SHORTFALL.availableCents)} available charges your backup card ${formatWholeDollars(example.shortfallCents)} + ${formatWholeDollars(example.feeCents)}.`
            : `Card fees: ${fee} of every top-up, whatever minimum you choose. For example a ${formatWholeDollars(exampleCardTopUp.creditCents)} top-up charges ${formatWholeDollars(exampleCardTopUp.chargedCents)}.`}
        </p>
        <p data-testid="wallet-guidance-activation">
          {activation.outcome === "top_up" && sourceRail === "stripe_ach" && `On the first daily check after you activate (about midnight UTC): we start a top-up of ${formatWholeDollars(activation.amountCents)} from ${sourceLabel} — free, ${BANK_SETTLEMENT_PHRASE} to land${activation.partial ? "; the most autopay takes in one charge, so the next daily check continues" : ""}. Until it lands, orders are charged to your backup card at ${fee}. Adding money by card now avoids that.`}
          {activation.outcome === "top_up" && sourceRail === "stripe_card" && `On the first daily check after you activate (about midnight UTC): we charge ${sourceLabel} ${formatWholeDollars(activation.chargedCents)} (${formatWholeDollars(activation.amountCents)} + ${formatWholeDollars(activation.feeCents)} fee) at once${activation.partial ? "; the most autopay takes in one charge, so the next daily check continues" : ""}.`}
          {activation.outcome === "not_needed" && "On the first daily check after you activate: no top-up — your balance already covers your minimum."}
        </p>
        <p className="text-xs text-zinc-600" data-testid="wallet-floor-limit-note">
          Routine top-ups never take more than {formatWholeDollars(boundCents)} in one charge ({boundCents === floorCents ? "your minimum" : "your top-up amount"}). An order your balance cannot cover is charged to your backup card for its whole shortfall, up to {formatWholeDollars(limits.manualFundingMaxCents)} in one payment; only an order short by more than that waits for you to add money and is cancelled after {formatDurationMinutes(holdMinutes)}. We email you {formatDurationMinutes(limits.holdExpiryWarningMinutes)} before that.
        </p>
      </div>
      {saveNote}
      <SectionFeedback {...feedback} />
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button type="button" className={BRAND_BUTTON} disabled={feedback.busy || !valid} onClick={() => onSubmit(floorCents, topUpCents)}>{submitLabel}</Button>
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
        Bank transfers take days to land. A card lets an order go out when your balance is short: we charge it the shortfall plus the {fee} fee — never to refill the wallet — and accept the order right away, even while a bank top-up is still landing. It is never used for routine top-ups. Keep your minimum high and it may never be used.
      </p>
      <BackupPicker wallet={wallet} now={now} selectedId={selected?.fundingMethodId ?? null} onSelect={setSelectedId} busy={feedback.busy} onAdd={onAdd} confirmation={confirmation} onCheckAgain={onCheckAgain} />
      <Impact>While your account is active, we only ever charge this card when an order needs more than your available balance, and only for the shortfall plus the {fee} fee, whatever its size (up to {formatWholeDollars(wallet.limits.manualFundingMaxCents)} in one payment). If a return fee has taken your balance below zero, the shortfall includes that amount. Your bank top-ups stay free.</Impact>
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

function buildReviewRows({ wallet, terms }: { wallet: DropshipWalletView; terms: WalletTerms }) {
  const topUp = terms.topUpCents ?? terms.floorCents;
  const rows: Array<[string, string, ("source" | "floor" | "backup") | null]> = [
    ["Autopay from", terms.sourceRail === "stripe_ach" ? `${terms.sourceLabel} (bank account, no fee)` : `${terms.sourceLabel} (card, ${formatFeeRate(terms.cardFundingFeeBps)} fee)`, "source"],
    ["Minimum", formatWholeDollars(terms.floorCents), "floor"],
    ["Backup card", terms.sourceRail === "stripe_card" ? `${terms.backupLabel} — also your autopay source` : terms.backupLabel, terms.sourceRail === "stripe_card" ? null : "backup"],
    ["Top-up amount", `${formatWholeDollars(topUp)}${topUp === terms.floorCents ? " — your minimum" : ""}. Routine top-ups never take more than ${formatWholeDollars(terms.limitCents)} in one charge.`, "floor"],
    ["Hold time", `${formatDurationMinutes(terms.holdTimeoutMinutes)} — set by CardShellz for every wallet.`, null],
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
  const { rows, mandate } = buildReviewRows({ wallet, terms });
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const busy = feedback.busy;
  return (
    <section className={SECTION} data-testid="wallet-step-review">
      <h2 className="text-lg font-semibold">Review and turn on autopay</h2>
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
        <Button type="button" className={BRAND_BUTTON} disabled={busy || disabled} onClick={onAuthorize}>Agree and turn on autopay</Button>
        <StepBack busy={busy} onBack={onBack} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Adding money: step 6 and the manage-mode panel share these controls
// ---------------------------------------------------------------------------

function FundingControls({
  wallet, floorCents, topUpCents, busy, quoteTestId, usdcOffered, railNotes, onContinue, onAddMethod, onSaveUsdc, onRequestUsdcAddress, extraBelowButton,
}: {
  wallet: DropshipWalletView;
  floorCents: number;
  /** The autopay top-up amount, null for the minimum: always one of the picks, and what the controls open on. */
  topUpCents: number | null;
  busy: boolean;
  quoteTestId: string;
  usdcOffered: boolean;
  /** The terms of the way to pay currently picked, as short bullets; the add-money step supplies them. */
  railNotes?: (rail: WalletSourceRail, method: WalletFundingMethod | null) => string[];
  onContinue: (rail: WalletSourceRail, amountCents: number) => void;
  onAddMethod: (rail: WalletSourceRail) => void;
  onSaveUsdc?: (input: { walletAddress: string; displayLabel: string }) => void;
  onRequestUsdcAddress?: () => void;
  extraBelowButton?: ReactNode;
}) {
  const limits = wallet.limits;
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  const [rail, setRail] = useState<WalletSourceRail | "usdc">("stripe_ach");
  // The top-up step's picks again, so the two cards agree; they open on what autopay would pull next.
  const options = depositOptions({ minimumCents: floorCents, topUpCents, limits });
  const [presetCents, setPresetCents] = useState<number | null>(() => depositDefaultCents(options, nextTopUpCents({ floorCents, topUpCents, availableCents: wallet.account.availableBalanceCents, pendingCents: wallet.account.pendingBalanceCents })));
  const [customText, setCustomText] = useState("");
  const [customError, setCustomError] = useState("");
  // A pick the picks no longer offer (the plan changed underneath) counts as none.
  const preset = options.some((option) => option.cents === presetCents) ? presetCents : null;
  const chosen = customText.trim() ? tryParseDollarInputToCents(customText) : preset;
  const method = rail === "usdc" ? null : depositFundingMethodFor(wallet, rail);
  const quote = rail !== "usdc" && chosen !== null && chosen > 0 ? quoteWalletFunding({ rail, creditCents: chosen, cardFeeBps: wallet.cardFundingFeeBps }) : null;

  function submit() {
    if (rail === "usdc") return;
    let amountCents = preset;
    if (customText.trim()) {
      const parsed = tryParseDollarInputToCents(customText);
      if (parsed === null) { setCustomError("Enter an amount in dollars and cents, like 250.00"); return; }
      amountCents = parsed;
    }
    if (amountCents === null) { setCustomError("Pick an amount or enter one."); return; }
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
      {rail === "usdc" && usdcOffered && onSaveUsdc ? (
        <UsdcFundingPanel wallet={wallet} busy={busy} onSave={onSaveUsdc} onRequestAddress={onRequestUsdcAddress} />
      ) : rail !== "usdc" ? (
        <>
          <p className="text-xs text-zinc-500">You finish on Stripe's page. The account or card you use there is saved to your wallet.</p>
          {railNotes && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600" data-testid="wallet-rail-notes">
              {railNotes(rail, method).map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
          <div role="radiogroup" aria-label="Amount" className="flex flex-wrap gap-2">
            {options.map((option) => (
              <RadioChip
                key={option.cents}
                label={formatWholeDollars(option.cents)}
                hint={describeDepositOption(option)}
                selected={!customText.trim() && preset === option.cents}
                disabled={busy}
                onSelect={() => { setPresetCents(option.cents); setCustomText(""); setCustomError(""); }}
                testId={`wallet-deposit-${option.factor === null ? "top-up" : `${option.factor}x`}`}
              />
            ))}
          </div>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="wallet-custom-amount">Or another amount</Label>
            <Input id="wallet-custom-amount" inputMode="decimal" placeholder="Dollars and cents" value={customText} disabled={busy} onChange={(event) => { setCustomText(event.target.value); setCustomError(""); }} className="h-10" />
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

function UsdcFundingPanel({ wallet, busy, onSave, onRequestAddress }: {
  wallet: DropshipWalletView;
  busy: boolean;
  onSave: (input: { walletAddress: string; displayLabel: string }) => void;
  onRequestAddress?: () => void;
}) {
  const [walletAddress, setWalletAddress] = useState("");
  const [displayLabel, setDisplayLabel] = useState("USDC on Base");
  const registered = wallet.fundingMethods.filter((method) => method.rail === "usdc_base" && method.status === "active");
  const deposit = wallet.usdcDeposit;
  if (deposit?.offered) {
    // The vendor's own address (funding design phase 6): nothing to register,
    // nothing for staff to match. The words are the model's.
    const copy = describeUsdcDeposit(deposit);
    return (
      <div className="space-y-3" data-testid="wallet-usdc-funding">
        {deposit.address ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
            <div className="text-xs uppercase text-zinc-500">Your deposit address (Base)</div>
            <code className="mt-1 block break-all font-mono text-zinc-900" data-testid="wallet-usdc-deposit-address">{deposit.address.checksumAddress}</code>
          </div>
        ) : (
          <Button type="button" variant="outline" className="h-10 w-full gap-2 sm:w-auto" disabled={busy || !onRequestAddress} onClick={onRequestAddress} data-testid="wallet-usdc-request-address">
            <Coins className="h-4 w-4" />Get my deposit address
          </Button>
        )}
        <p className="text-sm text-zinc-600" data-testid="wallet-usdc-timing">{copy.timing}</p>
        <p className="text-xs text-zinc-500" data-testid="wallet-usdc-warning">{copy.warning}</p>
      </div>
    );
  }
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
  wallet, flow, feedback, pendingNotice, onCheckAgain, onContinue, onAddMethod, onSkip,
}: {
  wallet: DropshipWalletView;
  flow: WalletFlowState;
  feedback: Feedback;
  pendingNotice: { purpose: StripePurpose } | null;
  onCheckAgain: () => void;
  onContinue: (rail: WalletSourceRail, amountCents: number) => void;
  onAddMethod: (rail: WalletSourceRail) => void;
  onSkip: () => void;
}) {
  const terms = termsFor(wallet, flow);
  if (!terms) return null;
  // The step is about adding money only: the balance stands on its own, and the
  // way to pay the vendor picks lists its own terms (funding design phase 7).
  return (
    <section className={SECTION} data-testid="wallet-step-deposit">
      <h2 className="text-lg font-semibold">Add money now (recommended)</h2>
      <p className="mt-1 text-sm text-zinc-600">Each way to pay has its own terms; they are listed under the one you pick.</p>
      <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3" data-testid="wallet-deposit-balance">
        <div className="text-sm text-zinc-500">Available balance</div>
        <div className="mt-1 text-2xl font-semibold" data-testid="wallet-deposit-available">{formatSignedCents(wallet.account.availableBalanceCents)}</div>
        {wallet.account.pendingBalanceCents > 0 && (
          <p className="mt-1 text-sm text-zinc-500" data-testid="wallet-deposit-pending">{describePendingBalance(wallet.account.pendingBalanceCents, wallet.advance)}</p>
        )}
      </div>
      <FundingControls
        wallet={wallet}
        floorCents={terms.floorCents}
        topUpCents={terms.topUpCents}
        busy={feedback.busy}
        quoteTestId="wallet-deposit-quote"
        usdcOffered={false}
        railNotes={(rail, method) => describeDepositRail({
          rail,
          cardFundingFeeBps: wallet.cardFundingFeeBps,
          backupLabel: terms.backupLabel,
          bankFundingMethodId: rail === "stripe_ach" && method ? method.fundingMethodId : null,
          advance: wallet.advance,
        })}
        onContinue={onContinue}
        onAddMethod={onAddMethod}
        extraBelowButton={<p className="text-xs text-zinc-500">Adding money is a separate payment, so we may ask you to confirm it is you again.</p>}
      />
      {pendingNotice && <PendingStripeNotice purpose={pendingNotice.purpose} onCheckAgain={onCheckAgain} />}
      <SectionFeedback {...feedback} />
      <div className="mt-3">
        <Button type="button" variant="ghost" className="h-10 w-full sm:w-auto" disabled={feedback.busy} onClick={onSkip}>Skip for now</Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Done state — manage: every choice has a Change control
// ---------------------------------------------------------------------------

function ManageView({
  wallet, flow, draft, now, stillOnboarding, editor, setEditor, addMoneyOpen, setAddMoneyOpen, newMethodOffer, dismissOffer, returnBanner, dismissReturnBanner,
  pendingNotice, onCheckAgain, feedback, feeMisconfigured, onSavePlan, onConfirmTerms, onTurnOff, onRemove, onAddMethod, onAddFunds, onSaveUsdc, onRequestUsdcAddress, onBackToOnboarding,
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
  onRequestUsdcAddress: () => Promise<void>;
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
  // The saved plan's top-up amount (null is the minimum), the draft's while none is saved. Not `??`: a saved null must not fall through.
  const topUpCents = wallet.autoReload ? wallet.autoReload.topUpAmountCents : flow.topUpCents;
  const topUpShown = plan?.topUpCents ?? flow.topUpCents;
  const boundShown = plan?.limitCents ?? flow.limitCents;
  const belowFloor = stillOnboarding && wallet.account.availableBalanceCents + wallet.account.pendingBalanceCents < floorCents;

  const saveNote = (
    <div className="mt-4 space-y-2 text-sm text-zinc-600">
      {plan && termsForPlan(wallet, plan) && <p>{describePlanSentence(termsForPlan(wallet, plan)!)}</p>}
      {ack.feeChangeNote && <p>{ack.feeChangeNote}</p>}
    </div>
  );

  /** A plan with one part replaced, saved as a whole row. */
  function savePart(update: (current: WalletPlanInput) => WalletPlanInput, successText?: string) {
    const base = plan ?? { fundingMethodId: source?.fundingMethodId ?? 0, backupFundingMethodId: backup?.fundingMethodId ?? 0, floorCents: flow.floorCents, topUpCents: flow.topUpCents, limitCents: flow.limitCents, holdTimeoutMinutes: flow.holdTimeoutMinutes };
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
                <span className="mt-2 block"><Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditor("source")}>Change autopay source</Button></span>
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {newMethodOffer && plan && (
        <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" data-testid="wallet-new-method-offer">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            {describeFundingMethod(newMethodOffer)} added.{newMethodOffer.rail === "stripe_ach" ? " Use it for autopay?" : ""}
            {source?.rail === "stripe_card" && newMethodOffer.rail === "stripe_card" && <span className="block text-xs">Using it for autopay also makes it your backup card.</span>}
            {ack.feeChangeNote && <span className="block text-xs">{ack.feeChangeNote}</span>}
            <span className="mt-3 flex flex-wrap gap-2">
              {newMethodOffer.rail === "stripe_card" && (
                <Button type="button" variant="outline" size="sm" className="h-9 bg-white" disabled={planFeedback.busy}
                  onClick={() => savePart((current) => ({ ...current, backupFundingMethodId: newMethodOffer.fundingMethodId }), "Backup card updated.")}>Use as backup card</Button>
              )}
              <Button type="button" variant="outline" size="sm" className="h-9 bg-white" disabled={planFeedback.busy}
                onClick={() => savePart((current) => planAfterSourceChange(current, newMethodOffer, current.backupFundingMethodId), "Autopay source updated.")}>Use for autopay</Button>
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
              <p className="mt-1 text-sm text-zinc-500" data-testid="wallet-pending">{describePendingBalance(wallet.account.pendingBalanceCents, wallet.advance)}</p>
            )}
            {wallet.account.availableBalanceCents < 0 && (
              <p className="mt-1 text-sm text-red-700" data-testid="wallet-negative-note">
                {describeNegativeBalance({ availableCents: wallet.account.availableBalanceCents, advance: wallet.advance, limitCents: flow.limitCents, cardFundingFeeBps: wallet.cardFundingFeeBps })}
              </p>
            )}
            {flow.authorized && <Badge variant="outline" className="mt-2">Minimum {formatWholeDollars(floorCents)}</Badge>}
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
              topUpCents={topUpCents}
              busy={feedback("money").busy}
              quoteTestId="wallet-funding-quote"
              usdcOffered={usdcOfferedFor(wallet)}
              onContinue={(rail, amount) => void onAddFunds(rail, amount)}
              onAddMethod={(rail) => void onAddMethod("money", rail)}
              onSaveUsdc={(input) => void onSaveUsdc(input)}
              onRequestUsdcAddress={() => void onRequestUsdcAddress()}
            />
          </div>
        )}
        <SectionFeedback {...feedback("money")} />
      </section>

      {wallet.listingTiers && <ListingTiersSection tiers={wallet.listingTiers} />}
      {wallet.advance && <AdvanceSection advance={wallet.advance} wallet={wallet} />}

      <section className={SECTION} data-testid="wallet-plan">
        <h2 className="text-lg font-semibold">Your plan</h2>
        {!flow.authorized ? (
          <div className="mt-2">
            <p className="text-sm text-zinc-600">Autopay is off. Nothing is charged automatically; you cannot activate or sell until it is on.</p>
            {editor !== "review" && (
              <Button type="button" className={`mt-4 ${BRAND_BUTTON}`} disabled={planFeedback.busy || feeMisconfigured} onClick={() => setEditor("review")}>Turn on autopay</Button>
            )}
          </div>
        ) : (
          <dl className="mt-3 divide-y divide-zinc-200 rounded-md border border-zinc-200">
            <PlanRow testId="wallet-plan-source" label="Autopay from" busy={planFeedback.busy} onChange={editor === "source" ? null : () => setEditor("source")}>
              {source ? `${describeFundingMethod(source)} · ${source.rail === "stripe_ach" ? "bank account · no fee" : `card · ${fee} fee`}` : "Not set"}
            </PlanRow>
            <PlanRow testId="wallet-plan-floor" label="Minimum" busy={planFeedback.busy} onChange={editor === "floor" ? null : () => setEditor("floor")}>
              {formatWholeDollars(floorCents)} — autopay tops it up after any order that takes it lower, and at the daily check.
              <span className="block text-xs text-zinc-500" data-testid="wallet-plan-top-up">
                Top-up amount {formatWholeDollars(topUpShown ?? floorCents)}{topUpShown === null || topUpShown === floorCents ? " (your minimum)" : ""} · routine top-ups never more than {formatWholeDollars(boundShown)} in one charge.
              </span>
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
                  : `Charged only for the shortfall on an order, plus ${fee}, up to ${formatWholeDollars(wallet.limits.manualFundingMaxCents)} in one payment — even while a bank top-up is still landing.`}
                {backup?.card && cardExpiryState(backup.card, now) === "expired" && " Add a new backup card before it is needed — an expired card is declined at charge time and selling pauses."}
              </span>
            </PlanRow>
            <PlanRow testId="wallet-plan-limits" label="Hold time" busy={planFeedback.busy} onChange={null}>
              {formatDurationMinutes(flow.holdTimeoutMinutes)} — set by CardShellz for every wallet. {describeHoldTimeLine(wallet.limits.holdExpiryWarningMinutes)}
            </PlanRow>
            <PlanRow testId="wallet-plan-authorization" label="Authorization" busy={planFeedback.busy} onChange={null}>
              {wallet.autoReload?.acknowledgedAt === null || wallet.autoReload?.acknowledgedCardFeeBps === null
                ? "Not on record — confirm your terms above."
                : flow.feeChange
                  ? `Recorded ${formatDateTime(wallet.autoReload?.acknowledgedAt)} at a ${formatFeeRate(flow.feeChange.recordedBps)} card fee; the card fee is now ${formatFeeRate(flow.feeChange.currentBps)} — confirm the new terms above.`
                  : `Recorded ${formatDateTime(wallet.autoReload?.acknowledgedAt)} at a ${fee} card fee. The terms above are the current terms.`}
            </PlanRow>
            <PlanRow testId="wallet-plan-auto-reload" label="Autopay" busy={planFeedback.busy} onChange={null}>
              On
              {flow.canTurnOffAutoReload && <TurnOffDialog busy={planFeedback.busy} onConfirm={() => void onTurnOff()} />}
            </PlanRow>
          </dl>
        )}

        {editor === "source" && (
          <div className="mt-4 border-t border-zinc-200 pt-4" data-testid="wallet-source-editor">
            <SourceEditor wallet={wallet} now={now} plan={plan} currentBackup={backup} feedback={planFeedback} saveLabel={ack.saveLabel} saveNote={saveNote}
              onAdd={(rail) => void onAddMethod("plan", rail)} onCancel={() => setEditor(null)}
              onSave={(next) => savePart(() => next, "Autopay source updated.")} />
          </div>
        )}
        {editor === "floor" && flow.source && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <FloorStep wallet={wallet} flow={flow} sourceRail={flow.source.rail} sourceLabel={describeFundingMethod(flow.source.method)}
              initialFloorCents={floorCents} initialTopUpCents={topUpShown} feedback={planFeedback} submitLabel={ack.saveLabel}
              saveNote={saveNote} onCancel={() => setEditor(null)}
              onSubmit={(newFloor, newTopUp) => savePart((current) => ({ ...current, floorCents: newFloor, topUpCents: newTopUp, limitCents: chargeBoundCents(newFloor, newTopUp) }), "Minimum updated.")} />
          </div>
        )}
        {editor === "backup" && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <BackupStep wallet={wallet} now={now} feedback={planFeedback} confirmation={null} pendingNotice={null} onCheckAgain={onCheckAgain}
              onAdd={() => void onAddMethod("plan", "stripe_card")} initialCardId={backup?.fundingMethodId ?? null} submitLabel={ack.saveLabel} saveNote={saveNote}
              onCancel={() => setEditor(null)} onSubmit={(card) => savePart((current) => ({ ...current, backupFundingMethodId: card.fundingMethodId }), "Backup card updated.")} />
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
/**
 * What is on sale, per listing tier, as the server decided it: the minimum
 * each tier needs, whether this wallet meets it, and a raise still in its
 * grace period. Packs and inner packs share one minimum; cases have their own.
 */
function ListingTiersSection({ tiers }: { tiers: WalletListingTiers }) {
  return (
    <section className={SECTION} data-testid="wallet-listing-tiers">
      <h2 className="text-lg font-semibold">What is on sale</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Each kind of listing needs a minimum wallet balance, set by CardShellz. Packs and inner packs share one minimum; cases have their own. Money still settling counts.
      </p>
      <ul className="mt-3 space-y-3">
        {[tiers.pack, tiers.case].map((tier) => (
          <li key={tier.tier} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between" data-testid={`wallet-listing-tier-${tier.tier}`}>
            <div>
              <div className="font-medium">{tier.tier === "case" ? "Cases" : "Packs and inner packs"} · minimum {formatWholeDollars(tier.minimumCents)}</div>
              <p className="text-sm text-zinc-600">{describeListingTier(tier)}</p>
              {tier.upcoming && (
                <p className="text-sm text-amber-800" data-testid={`wallet-listing-tier-${tier.tier}-upcoming`}>
                  {describeUpcomingListingTier(tier)}
                </p>
              )}
            </div>
            <Badge
              variant="outline"
              className={tier.eligible ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}
            >
              {tier.eligible ? "On sale" : "Off sale"}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Orders while a transfer lands: the pending-transfer advance as the server
 * assessed it — what it costs, how much could pay for orders now, and per bank
 * account which of the three facts is still missing. Nothing here is decided
 * by the page.
 */
function AdvanceSection({ advance, wallet }: { advance: WalletAdvance; wallet: DropshipWalletView }) {
  const copy = describeAdvanceStanding(advance, wallet.limits.bankBalanceReadOffered);
  const labelFor = (fundingMethodId: number) =>
    wallet.fundingMethods.find((method) => method.fundingMethodId === fundingMethodId)?.displayLabel ?? `Bank account #${fundingMethodId}`;
  return (
    <section className={SECTION} data-testid="wallet-advance">
      <h2 className="text-lg font-semibold">Orders while a transfer lands</h2>
      <p className="mt-1 text-sm text-zinc-600">
        A bank transfer still on its way can pay for an order once the account it comes from qualifies: a business account, a balance we could read when you linked it, and one earlier transfer from it that landed.
      </p>
      <p className="mt-3 font-medium" data-testid="wallet-advance-status">{copy.headline}</p>
      <ul className="mt-1 space-y-1 text-sm text-zinc-600" data-testid="wallet-advance-details">
        {copy.details.map((detail) => <li key={detail}>{detail}</li>)}
      </ul>
      {advance.sources.length > 0 && (
        <ul className="mt-3 space-y-2">
          {advance.sources.map((source) => (
            <li key={source.fundingMethodId} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between" data-testid={`wallet-advance-source-${source.fundingMethodId}`}>
              <div>
                <div className="font-medium">
                  {labelFor(source.fundingMethodId)}{source.pendingCents > 0 ? ` · ${formatWholeDollars(source.pendingCents)} on the way` : ""}
                </div>
                {source.reasons.length > 0 && (
                  <ul className="text-sm text-zinc-600">
                    {source.reasons.map((reason) => <li key={reason}>{describeAdvanceReason(reason, wallet.limits.bankBalanceReadOffered)}</li>)}
                  </ul>
                )}
              </div>
              <Badge
                variant="outline"
                className={source.eligible ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}
              >
                {source.eligible ? "Qualifies" : "Not yet"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function describeListingTier(tier: WalletListingTierStatus): string {
  if (tier.eligible) {
    return tier.tier === "case"
      ? "Your balance is at or above the case minimum, so your case listings are on sale."
      : "Your wallet keeps this minimum, so these listings are on sale.";
  }
  const shortfall = formatWholeDollars(tier.shortfallCents);
  return tier.tier === "case"
    ? `Case listings go on sale on their own once your balance reaches the minimum. You are ${shortfall} short.`
    : `These listings are off sale until your wallet keeps the minimum: raise your minimum to it, or add ${shortfall}.`;
}

function describeUpcomingListingTier(tier: WalletListingTierStatus): string {
  const upcoming = tier.upcoming!;
  const date = new Date(upcoming.enforcesAt).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
  const rises = `The minimum rises to ${formatWholeDollars(upcoming.minimumCents)} on ${date}.`;
  return upcoming.affectsVendor
    ? `${rises} As things stand you would fall below it; bring your wallet up before then to keep these listings on sale.`
    : `${rises} Your wallet already meets it.`;
}

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
        <p className="mt-1 text-sm text-zinc-500">The same rules you were shown at setup.</p>
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
      <Button type="button" variant="outline" size="sm" className="ml-3 h-8" disabled={busy} onClick={() => setOpen(true)} data-testid="wallet-auto-reload-off">Turn off autopay</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off autopay?</AlertDialogTitle>
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
      <h3 className="font-medium">Change your autopay source</h3>
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

/** The §2.5 review inline: Confirm terms for an authorized row, Turn on autopay for a disabled one. */
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
    ? { fundingMethodId: flow.source.method.fundingMethodId, backupFundingMethodId: flow.backup.method.fundingMethodId, floorCents: flow.floorCents, topUpCents: flow.topUpCents, limitCents: flow.limitCents, holdTimeoutMinutes: flow.holdTimeoutMinutes }
    : null);
  const terms = fallbackPlan ? termsForPlan(wallet, fallbackPlan) : null;
  if (!fallbackPlan || !terms) {
    return (
      <div>
        <p className="text-sm text-zinc-600">Choose an autopay source and a backup card before turning autopay on.</p>
        <Button type="button" variant="ghost" className="mt-3 h-10" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }
  const { rows, mandate } = buildReviewRows({ wallet, terms });
  const fee = formatFeeRate(wallet.cardFundingFeeBps);
  return (
    <div data-testid="wallet-step-review">
      <h3 className="font-medium">{flow.authorized ? "Confirm your autopay terms" : "Review and turn on autopay"}</h3>
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
          {flow.authorized ? "Confirm terms" : "Agree and turn on autopay"}
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
                      {method.roles.isAutoReloadSource && <Badge variant="outline">Autopay source</Badge>}
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
      <p className="mt-3 text-xs text-zinc-500">To replace a card: add the new one, make it the backup card (and your autopay source, if that card was it), then remove the old one.</p>
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

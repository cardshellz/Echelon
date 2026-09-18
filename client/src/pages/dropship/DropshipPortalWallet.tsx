import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronDown, Coins, CreditCard, History, Info, Landmark, Loader2, RefreshCw, Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatFeeRate } from "@shared/dropship/wallet-funding-fee";
import {
  buildAutoReloadConfigInput,
  buildStripeFundingSetupSessionInput,
  buildStripeWalletFundingSessionInput,
  buildUsdcBaseFundingMethodInput,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  parseDollarInputToCents,
  postJson,
  putJson,
  queryErrorMessage,
  type DropshipAutoReloadConfigResponse,
  type DropshipOnboardingState,
  type DropshipStripeFundingRail,
  type DropshipStripeFundingSetupSessionResponse,
  type DropshipStripeWalletFundingSessionResponse,
  type DropshipUsdcBaseFundingMethodResponse,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";
import {
  dropshipPortalPath,
  isDropshipSensitiveProofActive,
  useDropshipAuth,
  type DropshipSensitiveAction,
} from "@/lib/dropship-auth";
import { isOnboardingVendor } from "@/lib/dropship-onboarding";
import { describeVendorStanding } from "@/lib/dropship-vendor-standing";
import {
  AUTO_RELOAD_CAP_PRESETS_CENTS,
  AUTO_RELOAD_DEFAULTS,
  AUTO_RELOAD_MINIMUM_PRESETS_CENTS,
  CARD_CONFIRMATION_POLL_INTERVAL_MS,
  CARD_CONFIRMATION_POLL_TIMEOUT_MS,
  FUND_WALLET_PRESETS_CENTS,
  PAUSE_ON_DECLINE_NOTE,
  buildAutoReloadDisableInput,
  buildAutoReloadSetupInput,
  centsToDollarInput,
  deriveWalletSetupState,
  describeAutoReloadMandate,
  describeAutoReloadPolicy,
  describeFundingMethod,
  describeFundingQuote,
  describeTopUpFee,
  describeTopUpRule,
  describeUsdcFunding,
  isBankFundingMethod,
  isCardFundingMethod,
  parseStripeReturn,
  presetsIncluding,
  quoteFundingForMethod,
  smallestCapFor,
  stripStripeReturn,
  type AutoReloadTerms,
  type DropshipWalletFundingMethod,
  type DropshipWalletOverview,
  type StripeReturn,
  type UsdcFundingView,
  type WalletSetupState,
} from "@/lib/dropship-wallet-setup";
import { DropshipPortalShell } from "./DropshipPortalShell";

/**
 * Vendor wallet.
 *
 * Setup is three steps, one at a time: add the backup card every vendor keeps
 * on file, choose what tops the wallet up (a bank account for free, or the
 * card with its fee) and the balance it is kept at, then start selling. Once
 * set up the page leads with the balance and lets the vendor add money by
 * bank account, card or USDC. Only the payment-hold timeout and the raw method
 * list live under "Advanced". Every message and verification prompt renders
 * next to the button that caused it.
 */

const WALLET_QUERY_KEY = ["/api/dropship/wallet?limit=50"] as const;
const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;
const SETTINGS_QUERY_KEY = ["/api/dropship/settings"] as const;
/** Which rail was sent to Stripe, so the return knows what to wait for. Browser-local convenience only. */
const SETUP_RAIL_STORAGE_KEY = "dropship-wallet-setup-rail";

type WalletSensitiveAction = Extract<DropshipSensitiveAction, "add_funding_method" | "wallet_funding_high_value">;
/** Which part of the page an action, its notice and its code prompt belong to. */
type WalletScope = "setup" | "funds" | "auto_reload" | "advanced";

interface WalletNotice {
  scope: WalletScope;
  tone: "error" | "success" | "info";
  text: string;
}

interface PendingVerification {
  scope: WalletScope;
  action: WalletSensitiveAction;
  /** The request to run once the emailed code is accepted. */
  intent: () => Promise<void>;
}

interface TopUpChoice {
  fundingMethodId: number;
  minimumBalanceCents: number;
  maxSingleReloadCents: number;
}

export default function DropshipPortalWallet() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { principal, sensitiveProofs, startEmailStepUp, verifyEmailStepUp, verifyPasskeyStepUp } = useDropshipAuth();

  // Stripe returns to this page with a status marker; read it once and clear it
  // from the address bar so a reload does not replay the banner.
  const [stripeReturn, setStripeReturn] = useState<StripeReturn | null>(() => parseStripeReturn(window.location.search));
  const [setupRail] = useState<DropshipStripeFundingRail>(() => takeSetupRail());
  useEffect(() => {
    if (!parseStripeReturn(window.location.search)) return;
    window.history.replaceState(null, "", `${window.location.pathname}${stripStripeReturn(window.location.search)}`);
  }, []);

  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false);
  const [busyScope, setBusyScope] = useState<WalletScope | null>(null);
  const [notice, setNotice] = useState<WalletNotice | null>(null);
  const [verification, setVerification] = useState<PendingVerification | null>(null);
  const [verificationCode, setVerificationCode] = useState("");

  const walletQuery = useQuery<DropshipWalletResponse>({
    queryKey: WALLET_QUERY_KEY,
    queryFn: () => fetchJson<DropshipWalletResponse>(WALLET_QUERY_KEY[0]),
  });
  // Standing comes from the onboarding state the shell already invalidates
  // after every wallet change, so a resume shows up as soon as funds settle.
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: [...ONBOARDING_QUERY_KEY],
    queryFn: () => fetchJson<DropshipOnboardingState>(ONBOARDING_QUERY_KEY[0]),
  });
  const standingNotice = onboardingQuery.data ? describeVendorStanding(onboardingQuery.data.vendor) : null;
  const stillOnboarding = onboardingQuery.data ? isOnboardingVendor(onboardingQuery.data.vendor.status) : false;
  const wallet = walletQuery.data?.wallet ?? null;
  const setup = useMemo(() => (wallet ? deriveWalletSetupState(wallet) : null), [wallet]);
  const usdcFunding = useMemo(
    () => (wallet && setup ? describeUsdcFunding({ depositAddress: wallet.usdcBaseDepositAddress, usdcMethods: setup.usdcMethods }) : null),
    [wallet, setup],
  );

  // After a successful Stripe setup, keep asking the server until the webhook
  // activates the card or bank account, bounded so a broken webhook cannot
  // poll forever. A card is awaited while no card is active; a bank account
  // while none is active or one is still pending.
  const returnedFromSetup = stripeReturn?.kind === "funding_setup" && stripeReturn.status === "success";
  const awaitingCard = returnedFromSetup && setupRail === "stripe_card" && setup !== null
    && (setup.stage === "add_card" || setup.stage === "confirm_card") && !confirmationTimedOut;
  const awaitingBank = returnedFromSetup && setupRail === "stripe_ach" && setup !== null
    && (setup.bankMethods.length === 0 || setup.hasPendingBankMethod) && !confirmationTimedOut;
  const awaitingMethod = awaitingCard || awaitingBank;
  useEffect(() => {
    if (!awaitingMethod) return;
    const timer = window.setTimeout(() => setConfirmationTimedOut(true), CARD_CONFIRMATION_POLL_TIMEOUT_MS);
    const interval = window.setInterval(() => { void walletQuery.refetch(); }, CARD_CONFIRMATION_POLL_INTERVAL_MS);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
    // walletQuery.refetch is stable for the query key; re-arming on it would restart the timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingMethod]);

  async function refreshAfterWalletChange() {
    await Promise.all([
      walletQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] }),
      queryClient.invalidateQueries({ queryKey: [...SETTINGS_QUERY_KEY] }),
    ]);
  }

  async function run(scope: WalletScope, task: () => Promise<void>): Promise<boolean> {
    setBusyScope(scope);
    setNotice(null);
    try {
      await task();
      return true;
    } catch (caught) {
      setNotice({ scope, tone: "error", text: caught instanceof Error ? caught.message : "Wallet request failed." });
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
  async function withVerification(scope: WalletScope, action: WalletSensitiveAction, intent: () => Promise<void>) {
    const proofActive = isDropshipSensitiveProofActive({ principal, action, proof: sensitiveProofs[action] });
    if (proofActive) {
      await run(scope, intent);
      return;
    }
    if (principal?.hasPasskey) {
      const verified = await run(scope, () => verifyPasskeyStepUp(action).then(() => undefined));
      if (verified) await run(scope, intent);
      return;
    }
    const sent = await run(scope, () => startEmailStepUp(action));
    if (!sent) return;
    setVerification({ scope, action, intent });
    setVerificationCode("");
    setNotice({ scope, tone: "info", text: "We emailed you a 6-digit code. Enter it below to continue." });
  }

  async function submitVerificationCode() {
    if (!verification || verificationCode.length !== 6) return;
    const { scope, action, intent } = verification;
    const verified = await run(scope, () => verifyEmailStepUp({ action, verificationCode }).then(() => undefined));
    if (!verified) return;
    setVerification(null);
    setVerificationCode("");
    await run(scope, intent);
  }

  function cancelVerification() {
    setVerification(null);
    setVerificationCode("");
    setNotice(null);
  }

  function returnPath(): string {
    return `${window.location.pathname}${stripStripeReturn(window.location.search)}` || dropshipPortalPath("/wallet");
  }

  function startStripeSetup(scope: WalletScope, rail: DropshipStripeFundingRail) {
    return withVerification(scope, "add_funding_method", async () => {
      const input = buildStripeFundingSetupSessionInput({ rail, returnTo: returnPath() });
      const response = await postJson<DropshipStripeFundingSetupSessionResponse>(
        "/api/dropship/wallet/funding-methods/stripe/setup-session",
        input,
      );
      rememberSetupRail(rail);
      window.location.assign(response.setupSession.checkoutUrl);
    });
  }

  function turnOnAutoReload(scope: WalletScope, input: TopUpChoice) {
    if (!wallet) return Promise.resolve();
    return withVerification(scope, "add_funding_method", async () => {
      await putJson<DropshipAutoReloadConfigResponse>(
        "/api/dropship/wallet/auto-reload",
        buildAutoReloadSetupInput({ ...input, cardFundingFeeBps: wallet.cardFundingFeeBps, existing: wallet.autoReload }),
      );
      await refreshAfterWalletChange();
      setStripeReturn(null);
      setNotice({ scope, tone: "success", text: "Auto-reload is on." });
    });
  }

  function turnOffAutoReload(scope: WalletScope) {
    if (!wallet) return Promise.resolve();
    return withVerification(scope, "add_funding_method", async () => {
      await putJson<DropshipAutoReloadConfigResponse>("/api/dropship/wallet/auto-reload", buildAutoReloadDisableInput(wallet.autoReload));
      await refreshAfterWalletChange();
      setNotice({ scope, tone: "success", text: "Auto-reload is off. Orders will wait for a manual payment until it is turned back on." });
    });
  }

  function saveHoldTimeout(minutes: string) {
    if (!wallet) return Promise.resolve();
    return withVerification("advanced", "add_funding_method", async () => {
      const existing = wallet.autoReload;
      await putJson<DropshipAutoReloadConfigResponse>(
        "/api/dropship/wallet/auto-reload",
        buildAutoReloadConfigInput({
          enabled: existing?.enabled ?? false,
          fundingMethodId: existing?.fundingMethodId ? String(existing.fundingMethodId) : "",
          minimumBalance: centsToDollarInput(existing?.minimumBalanceCents ?? AUTO_RELOAD_DEFAULTS.minimumBalanceCents),
          maxSingleReload: existing?.maxSingleReloadCents === null || existing?.maxSingleReloadCents === undefined
            ? "" : centsToDollarInput(existing.maxSingleReloadCents),
          paymentHoldTimeoutMinutes: minutes,
        }),
      );
      await refreshAfterWalletChange();
      setNotice({ scope: "advanced", tone: "success", text: "Payment hold timeout saved." });
    });
  }

  function addFunds(input: { fundingMethodId: number; amountCents: number }) {
    return withVerification("funds", "wallet_funding_high_value", async () => {
      const request = buildStripeWalletFundingSessionInput({
        fundingMethodId: String(input.fundingMethodId),
        amount: centsToDollarInput(input.amountCents),
        returnTo: returnPath(),
      });
      const response = await postJson<DropshipStripeWalletFundingSessionResponse>(
        "/api/dropship/wallet/funding/stripe/checkout-session",
        request,
      );
      window.location.assign(response.fundingSession.checkoutUrl);
    });
  }

  function saveUsdcMethod(input: { walletAddress: string; displayLabel: string }) {
    return withVerification("funds", "add_funding_method", async () => {
      await postJson<DropshipUsdcBaseFundingMethodResponse>(
        "/api/dropship/wallet/funding-methods/usdc-base",
        buildUsdcBaseFundingMethodInput({ ...input, isDefault: false }),
      );
      await refreshAfterWalletChange();
      setNotice({ scope: "funds", tone: "success", text: "USDC address saved." });
    });
  }

  const sectionProps = (scope: WalletScope): SectionFeedbackProps => ({
    busy: busyScope === scope,
    notice: notice?.scope === scope ? notice : null,
    verification: verification?.scope === scope
      ? { code: verificationCode, onCodeChange: setVerificationCode, onSubmit: submitVerificationCode, onCancel: cancelVerification }
      : null,
  });

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

        {standingNotice && (
          <Alert variant="destructive" className="mt-5" data-testid="wallet-vendor-standing-notice">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <span className="font-medium">{standingNotice.title}.</span> {standingNotice.reason} {standingNotice.action}
            </AlertDescription>
          </Alert>
        )}

        {walletQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{queryErrorMessage(walletQuery.error, "Unable to load your wallet.")}</AlertDescription>
          </Alert>
        )}

        {walletQuery.isLoading || !wallet || !setup ? (
          <div className="mt-5 space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <>
            {stripeReturn?.kind === "wallet_funding" && (
              <WalletFundingReturnBanner status={stripeReturn.status} onDismiss={() => setStripeReturn(null)} />
            )}
            {stripeReturn?.kind === "funding_setup" && stripeReturn.status === "cancelled" && (
              <Alert className="mt-5">
                <Info className="h-4 w-4" />
                <AlertDescription>{setupRail === "stripe_ach" ? "Bank account setup was cancelled. Nothing was saved." : "Card setup was cancelled. Nothing was saved."}</AlertDescription>
              </Alert>
            )}

            {setup.stage === "ready" ? (
              <>
                <BalanceSection
                  setup={setup}
                  cardFundingFeeBps={wallet.cardFundingFeeBps}
                  usdcFunding={usdcFunding}
                  {...sectionProps("funds")}
                  onAddFunds={addFunds}
                  onSaveUsdc={saveUsdcMethod}
                />
                <AutoReloadSection
                  wallet={wallet}
                  setup={setup}
                  cardFundingFeeBps={wallet.cardFundingFeeBps}
                  awaitingBank={awaitingBank}
                  confirmationTimedOut={confirmationTimedOut}
                  {...sectionProps("auto_reload")}
                  onTurnOn={(input) => turnOnAutoReload("auto_reload", input)}
                  onTurnOff={() => turnOffAutoReload("auto_reload")}
                  onAddBankAccount={() => startStripeSetup("auto_reload", "stripe_ach")}
                  onCheckAgain={() => { setConfirmationTimedOut(false); void walletQuery.refetch(); }}
                />
              </>
            ) : (
              <SetupSection
                setup={setup}
                cardFundingFeeBps={wallet.cardFundingFeeBps}
                awaitingCard={awaitingCard}
                awaitingBank={awaitingBank}
                confirmationTimedOut={confirmationTimedOut}
                {...sectionProps("setup")}
                onAddCard={() => startStripeSetup("setup", "stripe_card")}
                onAddBankAccount={() => startStripeSetup("setup", "stripe_ach")}
                onCheckAgain={() => { setConfirmationTimedOut(false); void walletQuery.refetch(); }}
                onTurnOn={(input) => turnOnAutoReload("setup", input)}
              />
            )}

            {setup.stage === "ready" && returnedFromSetup && !awaitingBank && (
              <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>{setupRail === "stripe_ach" ? "Your bank account was added." : "Your card was added."}</AlertDescription>
              </Alert>
            )}

            {setup.stage === "ready" && stillOnboarding && (
              <div className="mt-5 flex justify-end">
                <Button type="button" variant="outline" className="gap-2" onClick={() => setLocation(dropshipPortalPath("/onboarding"))}>
                  Back to onboarding
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            <AdvancedSection
              wallet={wallet}
              setup={setup}
              {...sectionProps("advanced")}
              onAddCard={() => startStripeSetup("advanced", "stripe_card")}
              onAddBankAccount={() => startStripeSetup("advanced", "stripe_ach")}
              onSaveHoldTimeout={saveHoldTimeout}
            />

            <ActivitySection wallet={wallet} />
          </>
        )}
      </div>
    </DropshipPortalShell>
  );
}

function rememberSetupRail(rail: DropshipStripeFundingRail): void {
  try {
    window.sessionStorage.setItem(SETUP_RAIL_STORAGE_KEY, rail);
  } catch {
    // Storage can be unavailable (private mode, blocked site data). The return
    // then assumes a card, which only affects which confirmation text shows.
  }
}

function takeSetupRail(): DropshipStripeFundingRail {
  try {
    const stored = window.sessionStorage.getItem(SETUP_RAIL_STORAGE_KEY);
    window.sessionStorage.removeItem(SETUP_RAIL_STORAGE_KEY);
    return stored === "stripe_ach" ? "stripe_ach" : "stripe_card";
  } catch {
    return "stripe_card";
  }
}

// ---------------------------------------------------------------------------
// Shared feedback: notices and the emailed-code prompt render inside the section
// whose button asked for them, never at the top of the page.
// ---------------------------------------------------------------------------

interface SectionFeedbackProps {
  busy: boolean;
  notice: WalletNotice | null;
  verification: {
    code: string;
    onCodeChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
  } | null;
}

function SectionFeedback({ busy, notice, verification }: SectionFeedbackProps) {
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
          <InputOTP
            id="wallet-verification-code"
            maxLength={6}
            value={verification.code}
            onChange={verification.onCodeChange}
            containerClassName="justify-between"
            disabled={busy}
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <div className="flex gap-2">
            <Button
              type="button"
              className="h-9 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={busy || verification.code.length !== 6}
              onClick={verification.onSubmit}
            >
              {busy ? "Checking code" : "Continue"}
            </Button>
            <Button type="button" variant="ghost" className="h-9" disabled={busy} onClick={verification.onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Setup: one step at a time until the launch gate is satisfied.
// ---------------------------------------------------------------------------

const SETUP_STEPS = [
  { key: "card", title: "Add your backup card" },
  { key: "top_up", title: "Choose how to top up" },
  { key: "done", title: "Start selling" },
] as const;

function SetupSection({
  setup, cardFundingFeeBps, awaitingCard, awaitingBank, confirmationTimedOut, busy, notice, verification,
  onAddCard, onAddBankAccount, onCheckAgain, onTurnOn,
}: SectionFeedbackProps & {
  setup: WalletSetupState;
  cardFundingFeeBps: number;
  awaitingCard: boolean;
  awaitingBank: boolean;
  confirmationTimedOut: boolean;
  onAddCard: () => void;
  onAddBankAccount: () => void;
  onCheckAgain: () => void;
  onTurnOn: (input: TopUpChoice) => void;
}) {
  const cardDone = setup.cardMethods.length > 0;
  const currentIndex = cardDone ? 1 : 0;
  const feeRate = formatFeeRate(cardFundingFeeBps);

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5" data-testid="wallet-setup">
      <h2 className="text-lg font-semibold">Set up your wallet</h2>
      <p className="mt-1 text-sm text-zinc-500">Two short steps. Nothing is charged until you accept an order.</p>

      <ol className="mt-4 space-y-2">
        {SETUP_STEPS.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "later";
          return (
            <li key={step.key} className="flex items-center gap-3 text-sm">
              <span
                className={state === "done"
                  ? "flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white"
                  : state === "current"
                    ? "flex h-6 w-6 items-center justify-center rounded-full bg-[#C060E0] text-white"
                    : "flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-zinc-500"}
                aria-hidden="true"
              >
                {state === "done" ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
              </span>
              <span className={state === "later" ? "text-zinc-500" : "font-medium"}>{step.title}</span>
              {state === "current" && <Badge variant="outline">Now</Badge>}
            </li>
          );
        })}
      </ol>

      <div className="mt-5 border-t border-zinc-200 pt-5">
        {!cardDone && (setup.stage === "confirm_card" || awaitingCard) ? (
          <MethodConfirmation rail="stripe_card" timedOut={confirmationTimedOut && !awaitingCard} onCheckAgain={onCheckAgain} />
        ) : !cardDone ? (
          <div>
            <h3 className="font-medium">Add your backup card</h3>
            <p className="mt-1 text-sm text-zinc-600">
              Every seller keeps a card on file. You will be sent to Stripe to enter it; Card Shellz never sees your card number.
            </p>
            <p className="mt-2 text-sm text-zinc-500" data-testid="wallet-backup-card-role">
              The card is the backup, not your main way to pay. It is charged only when an order needs more than your
              balance, or if you choose it for top-ups in the next step. Fund by bank account or USDC and it may never be used.
            </p>
            <p className="mt-2 text-sm text-zinc-500" data-testid="wallet-card-fee-note">
              Card charges carry a {feeRate} fee on top of the amount added. Bank accounts and USDC carry no fee.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button type="button" className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={busy} onClick={onAddCard}>
                <CreditCard className="h-4 w-4" />
                {busy ? "One moment" : "Add a card"}
              </Button>
            </div>
          </div>
        ) : (
          <TopUpChooser
            setup={setup}
            cardFundingFeeBps={cardFundingFeeBps}
            initialMinimumCents={AUTO_RELOAD_DEFAULTS.minimumBalanceCents}
            initialCapCents={AUTO_RELOAD_DEFAULTS.maxSingleReloadCents}
            awaitingBank={awaitingBank}
            bankTimedOut={confirmationTimedOut && !awaitingBank}
            busy={busy}
            submitLabel="Turn on auto-reload"
            onSubmit={onTurnOn}
            onAddBankAccount={onAddBankAccount}
            onCheckAgain={onCheckAgain}
          />
        )}
        <SectionFeedback busy={busy} notice={notice} verification={verification} />
      </div>
    </section>
  );
}

function MethodConfirmation({ rail, timedOut, onCheckAgain }: { rail: DropshipStripeFundingRail; timedOut: boolean; onCheckAgain: () => void }) {
  const noun = rail === "stripe_ach" ? "bank account" : "card";
  if (timedOut) {
    return (
      <div role="status" data-testid={`wallet-${rail === "stripe_ach" ? "bank" : "card"}-confirmation`}>
        <h3 className="font-medium">Still confirming your {noun}</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Stripe accepted the {noun} but has not confirmed it to Card Shellz yet. This is taking longer than usual.
          Refresh in a minute. If the {noun} still is not here, contact Card Shellz support.
        </p>
        <Button type="button" variant="outline" className="mt-4 h-10 gap-2" onClick={onCheckAgain}>
          <RefreshCw className="h-4 w-4" />
          Check again
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-3" data-testid={`wallet-${rail === "stripe_ach" ? "bank" : "card"}-confirmation`}>
      <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-[#C060E0]" aria-hidden="true" />
      <div>
        <h3 className="font-medium">Confirming your {noun}</h3>
        <p className="mt-1 text-sm text-zinc-600">Stripe is confirming the {noun}. This usually takes a few seconds.</p>
      </div>
    </div>
  );
}

/**
 * The top-up choice: what pays (a bank account for free, or the card with its
 * fee), the balance the wallet is kept at, and the cap on one top-up. Every
 * amount is a whole-dollar preset the server accepts; the copy under the
 * choices states exactly what the vendor is authorizing.
 */
function TopUpChooser({
  setup, cardFundingFeeBps, initialMinimumCents, initialCapCents, initialMethodId, awaitingBank, bankTimedOut, busy, submitLabel,
  onSubmit, onAddBankAccount, onCheckAgain,
}: {
  setup: WalletSetupState;
  cardFundingFeeBps: number;
  initialMinimumCents: number;
  initialCapCents: number;
  initialMethodId?: number;
  awaitingBank: boolean;
  bankTimedOut: boolean;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: TopUpChoice) => void;
  onAddBankAccount: () => void;
  onCheckAgain: () => void;
}) {
  const minimumOptions = useMemo(() => presetsIncluding(AUTO_RELOAD_MINIMUM_PRESETS_CENTS, initialMinimumCents), [initialMinimumCents]);
  const capOptions = useMemo(() => presetsIncluding(AUTO_RELOAD_CAP_PRESETS_CENTS, initialCapCents), [initialCapCents]);
  const [minimumCents, setMinimumCents] = useState(initialMinimumCents);
  const [capCents, setCapCents] = useState(initialCapCents);
  const [methodId, setMethodId] = useState<number | null>(initialMethodId ?? setup.primaryMethod?.fundingMethodId ?? null);
  const [railChosen, setRailChosen] = useState(initialMethodId !== undefined);
  const defaultBank = setup.bankMethods.find((method) => method.isDefault) ?? setup.bankMethods[0] ?? null;
  // A bank account that lands while this step is open (the vendor just added
  // it) becomes the selection, unless they had already picked a rail by hand.
  useEffect(() => {
    if (!railChosen && defaultBank) setMethodId(defaultBank.fundingMethodId);
  }, [railChosen, defaultBank]);
  const selected = setup.reloadMethods.find((method) => method.fundingMethodId === methodId) ?? setup.reloadMethods[0] ?? null;
  const selectedIsBank = selected !== null && isBankFundingMethod(selected);
  const backupCard = setup.cardMethods.find((method) => method.isDefault) ?? setup.cardMethods[0] ?? null;
  const feeRate = formatFeeRate(cardFundingFeeBps);
  const invalid = capCents < minimumCents;
  const terms: AutoReloadTerms | null = selected
    ? { method: selected, backupCard, minimumBalanceCents: minimumCents, maxSingleReloadCents: capCents, cardFundingFeeBps }
    : null;

  function chooseMinimum(cents: number) {
    setMinimumCents(cents);
    // The cap can never sit below the balance it protects; lift it to the
    // nearest option instead of surfacing an error the vendor did not cause.
    if (capCents < cents) setCapCents(smallestCapFor(cents, capOptions));
  }

  function chooseRail(rail: DropshipStripeFundingRail) {
    const candidates = rail === "stripe_ach" ? setup.bankMethods : setup.cardMethods;
    const preferred = candidates.find((method) => method.isDefault) ?? candidates[0] ?? null;
    if (!preferred) return;
    setRailChosen(true);
    setMethodId(preferred.fundingMethodId);
  }

  return (
    <div>
      <h3 className="font-medium">Choose how to top up</h3>
      <p className="mt-1 text-sm text-zinc-600">
        Your wallet pays for each order you accept. Auto-reload keeps it topped up so orders never wait.
      </p>

      <div className="mt-4 space-y-4">
        <div role="radiogroup" aria-label="Top up from" className="grid gap-3 sm:grid-cols-2" data-testid="wallet-top-up-method">
          <RailOption
            title="Bank account"
            subtitle="No fee. Takes a few days to land."
            icon={<Landmark className="h-4 w-4" />}
            selected={selectedIsBank}
            selectable={setup.bankMethods.length > 0}
            disabled={busy}
            onSelect={() => chooseRail("stripe_ach")}
          >
            {awaitingBank || bankTimedOut ? (
              <MethodConfirmation rail="stripe_ach" timedOut={bankTimedOut} onCheckAgain={onCheckAgain} />
            ) : setup.bankMethods.length === 0 ? (
              <Button type="button" variant="outline" className="h-9 gap-2" disabled={busy} onClick={onAddBankAccount}>
                <Landmark className="h-4 w-4" />
                {busy ? "One moment" : "Add a bank account"}
              </Button>
            ) : (
              <MethodPicker
                id="wallet-top-up-bank"
                methods={setup.bankMethods}
                selectedId={selectedIsBank && selected ? selected.fundingMethodId : null}
                disabled={busy || !selectedIsBank}
                onChange={setMethodId}
              />
            )}
          </RailOption>
          <RailOption
            title="Card"
            subtitle={`${feeRate} fee on each top-up.`}
            icon={<CreditCard className="h-4 w-4" />}
            selected={selected !== null && !selectedIsBank}
            selectable={setup.cardMethods.length > 0}
            disabled={busy}
            onSelect={() => chooseRail("stripe_card")}
          >
            <MethodPicker
              id="wallet-top-up-card"
              methods={setup.cardMethods}
              selectedId={selected !== null && !selectedIsBank ? selected.fundingMethodId : null}
              disabled={busy || selectedIsBank}
              onChange={setMethodId}
            />
          </RailOption>
        </div>

        <PresetPicker
          label="Keep my balance at"
          options={minimumOptions}
          value={minimumCents}
          onChange={chooseMinimum}
          disabled={busy}
        />
        <PresetPicker
          label="Largest single top-up"
          options={capOptions}
          value={capCents}
          onChange={setCapCents}
          disabled={busy}
          isOptionDisabled={(cents) => cents < minimumCents}
        />
        {invalid && (
          <p role="alert" className="text-sm text-red-700">The largest single top-up must be at least the balance you keep.</p>
        )}
        {terms && (
          <>
            <p className="text-sm text-zinc-600" data-testid="wallet-top-up-rule">{describeTopUpRule(terms)}</p>
            <p className="text-sm text-zinc-600" data-testid="wallet-auto-reload-fee">{describeTopUpFee(terms)}</p>
            <p className="text-sm text-zinc-500" data-testid="wallet-auto-reload-mandate">{describeAutoReloadMandate(terms)}</p>
            <p className="text-sm text-zinc-500" data-testid="wallet-pause-note">{PAUSE_ON_DECLINE_NOTE}</p>
          </>
        )}
      </div>
      <Button
        type="button"
        className="mt-5 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
        disabled={busy || invalid || selected === null}
        onClick={() => selected && onSubmit({ fundingMethodId: selected.fundingMethodId, minimumBalanceCents: minimumCents, maxSingleReloadCents: capCents })}
      >
        {busy ? "Saving" : submitLabel}
      </Button>
    </div>
  );
}

/** One rail as a selectable card; its body holds the method picker or the button that adds one. */
function RailOption({
  title, subtitle, icon, selected, selectable, disabled, onSelect, children,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  selected: boolean;
  selectable: boolean;
  disabled: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <div className={selected ? "rounded-md border border-[#C060E0] bg-[#C060E0]/5 p-4" : "rounded-md border border-zinc-200 p-4"}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={title}
        disabled={disabled || !selectable}
        onClick={onSelect}
        className="flex w-full items-start gap-3 text-left disabled:cursor-default"
      >
        <span className={selected ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#C060E0] text-white" : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700"}>
          {icon}
        </span>
        <span>
          <span className="block font-medium">{title}</span>
          <span className="block text-sm text-zinc-500">{subtitle}</span>
        </span>
      </button>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** The saved methods of one rail: a label when there is one, a select when there are several. */
function MethodPicker({
  id, methods, selectedId, disabled, onChange,
}: {
  id: string;
  methods: readonly DropshipWalletFundingMethod[];
  selectedId: number | null;
  disabled: boolean;
  onChange: (fundingMethodId: number) => void;
}) {
  if (methods.length === 0) return null;
  if (methods.length === 1) {
    return <p className="text-sm text-zinc-700">{describeFundingMethod(methods[0])}</p>;
  }
  return (
    <select
      id={id}
      aria-label="Which one"
      className="h-9 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm"
      value={selectedId ?? methods[0].fundingMethodId}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {methods.map((method) => (
        <option key={method.fundingMethodId} value={method.fundingMethodId}>{describeFundingMethod(method)}</option>
      ))}
    </select>
  );
}

function PresetPicker({
  label, options, value, onChange, disabled, isOptionDisabled,
}: {
  label: string;
  options: readonly number[];
  value: number;
  onChange: (cents: number) => void;
  disabled: boolean;
  isOptionDisabled?: (cents: number) => boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((cents) => {
          const selected = cents === value;
          return (
            <button
              key={cents}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || (isOptionDisabled?.(cents) ?? false)}
              onClick={() => onChange(cents)}
              className={selected
                ? "h-10 rounded-md border border-[#C060E0] bg-[#C060E0]/10 px-4 text-sm font-medium text-[#8c35aa]"
                : "h-10 rounded-md border border-zinc-300 bg-white px-4 text-sm hover:bg-zinc-50 disabled:opacity-50"}
            >
              {formatWholeDollars(cents)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// After setup: the balance, adding money, and the auto-reload summary.
// ---------------------------------------------------------------------------

type PayWith = { kind: "method"; method: DropshipWalletFundingMethod } | { kind: "usdc" };

function BalanceSection({
  setup, cardFundingFeeBps, usdcFunding, busy, notice, verification, onAddFunds, onSaveUsdc,
}: SectionFeedbackProps & {
  setup: WalletSetupState;
  cardFundingFeeBps: number;
  usdcFunding: UsdcFundingView | null;
  onAddFunds: (input: { fundingMethodId: number; amountCents: number }) => void;
  onSaveUsdc: (input: { walletAddress: string; displayLabel: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [presetCents, setPresetCents] = useState<number>(FUND_WALLET_PRESETS_CENTS[1]);
  const [customAmount, setCustomAmount] = useState("");
  const [customError, setCustomError] = useState("");
  // Free rails first: a bank account, then cards, then USDC when offered.
  const stripeMethods = [...setup.bankMethods, ...setup.cardMethods];
  const [payWithKey, setPayWithKey] = useState<string>(() => stripeMethods[0] ? `method:${stripeMethods[0].fundingMethodId}` : "usdc");
  const payWith = resolvePayWith(payWithKey, stripeMethods, usdcFunding !== null);
  // The quote follows whatever amount is currently chosen, so the fee and the
  // total are on screen before the vendor is sent to pay. An unparsable custom
  // amount simply shows no quote; submit reports the parse error.
  const chosenCents = customAmount.trim() ? tryParseDollarInputToCents(customAmount) : presetCents;
  const quote = payWith?.kind === "method" && chosenCents !== null && chosenCents > 0
    ? quoteFundingForMethod(payWith.method, chosenCents, cardFundingFeeBps)
    : null;

  function submit() {
    if (payWith?.kind !== "method") return;
    let amountCents = presetCents;
    if (customAmount.trim()) {
      try {
        amountCents = parseDollarInputToCents(customAmount, "Amount");
      } catch (caught) {
        setCustomError(caught instanceof Error ? caught.message : "Enter a dollar amount.");
        return;
      }
    }
    setCustomError("");
    onAddFunds({ fundingMethodId: payWith.method.fundingMethodId, amountCents });
  }

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5" data-testid="wallet-balance">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm text-zinc-500">Available balance</div>
          <div className="mt-1 text-4xl font-semibold" data-testid="wallet-available">{formatCents(setup.availableBalanceCents)}</div>
          {setup.pendingBalanceCents > 0 && (
            <div className="mt-1 text-sm text-zinc-500">{formatCents(setup.pendingBalanceCents)} on the way</div>
          )}
        </div>
        <Button type="button" variant={open ? "outline" : "default"} className={open ? "h-10" : "h-10 bg-[#C060E0] hover:bg-[#a94bc9]"} onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Add funds"}
        </Button>
      </div>

      {open && (
        <div className="mt-5 border-t border-zinc-200 pt-5">
          <p className="text-sm text-zinc-600">
            Optional. Adding money now means your first orders do not wait for a top-up.
          </p>
          <div className="mt-4 space-y-4">
            <div role="radiogroup" aria-label="Pay with" className="flex flex-wrap gap-2" data-testid="wallet-funding-method">
              {stripeMethods.map((method) => (
                <PayWithOption
                  key={method.fundingMethodId}
                  label={describeFundingMethod(method)}
                  hint={isCardFundingMethod(method) ? `${formatFeeRate(cardFundingFeeBps)} fee` : "No fee"}
                  selected={payWithKey === `method:${method.fundingMethodId}`}
                  disabled={busy}
                  onSelect={() => setPayWithKey(`method:${method.fundingMethodId}`)}
                />
              ))}
              {usdcFunding && (
                <PayWithOption
                  label="USDC on Base"
                  hint="No fee"
                  selected={payWithKey === "usdc"}
                  disabled={busy}
                  onSelect={() => setPayWithKey("usdc")}
                />
              )}
            </div>

            {payWith?.kind === "usdc" && usdcFunding ? (
              <UsdcFundingPanel funding={usdcFunding} busy={busy} onSave={onSaveUsdc} />
            ) : payWith?.kind === "method" ? (
              <>
                <PresetPicker label="Amount" options={FUND_WALLET_PRESETS_CENTS} value={customAmount.trim() ? -1 : presetCents} onChange={(cents) => { setPresetCents(cents); setCustomAmount(""); setCustomError(""); }} disabled={busy} />
                <div className="max-w-xs space-y-2">
                  <Label htmlFor="wallet-custom-amount">Or another amount</Label>
                  <Input
                    id="wallet-custom-amount"
                    inputMode="decimal"
                    placeholder="75.00"
                    value={customAmount}
                    disabled={busy}
                    onChange={(event) => { setCustomAmount(event.target.value); setCustomError(""); }}
                    className="h-10"
                  />
                  {customError && <p role="alert" className="text-sm text-red-700">{customError}</p>}
                </div>
                {quote && (
                  <p className="text-sm text-zinc-600" data-testid="wallet-funding-quote">{describeFundingQuote(payWith.method, quote)}</p>
                )}
                <Button type="button" className="h-10 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={busy} onClick={submit}>
                  {busy ? "One moment" : "Continue to payment"}
                </Button>
              </>
            ) : (
              <p className="text-sm text-zinc-500">Add a bank account or card under Advanced to add funds.</p>
            )}
          </div>
        </div>
      )}
      <SectionFeedback busy={busy} notice={notice} verification={verification} />
    </section>
  );
}

function resolvePayWith(key: string, stripeMethods: readonly DropshipWalletFundingMethod[], usdcOffered: boolean): PayWith | null {
  if (key === "usdc") return usdcOffered ? { kind: "usdc" } : null;
  const method = stripeMethods.find((entry) => `method:${entry.fundingMethodId}` === key) ?? stripeMethods[0] ?? null;
  return method ? { kind: "method", method } : null;
}

function PayWithOption({ label, hint, selected, disabled, onSelect }: { label: string; hint: string; selected: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
      className={selected
        ? "h-10 rounded-md border border-[#C060E0] bg-[#C060E0]/10 px-3 text-sm font-medium text-[#8c35aa]"
        : "h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm hover:bg-zinc-50 disabled:opacity-50"}
    >
      {label}
      <span className="ml-2 text-xs font-normal text-zinc-500">{hint}</span>
    </button>
  );
}

/** USDC funding: where to send it, and the sending address to register so the transfer is matched. */
function UsdcFundingPanel({ funding, busy, onSave }: { funding: UsdcFundingView; busy: boolean; onSave: (input: { walletAddress: string; displayLabel: string }) => void }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [displayLabel, setDisplayLabel] = useState("USDC on Base");
  return (
    <div className="space-y-3" data-testid="wallet-usdc-funding">
      {funding.lines.map((line) => (
        <p key={line} className="text-sm text-zinc-600">{line}</p>
      ))}
      {funding.registeredAddress ? (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <div className="text-xs uppercase text-zinc-500">Deposit address (Base)</div>
          <code className="mt-1 block break-all font-mono text-zinc-900" data-testid="wallet-usdc-deposit-address">{funding.depositAddress}</code>
          <div className="mt-2 text-xs text-zinc-500">Sending from {funding.registeredAddress}</div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <div className="space-y-2">
            <Label htmlFor="wallet-usdc-address">Wallet address you send from</Label>
            <Input id="wallet-usdc-address" placeholder="0x..." value={walletAddress} disabled={busy} onChange={(event) => setWalletAddress(event.target.value)} className="h-10 font-mono text-sm" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wallet-usdc-label">Label</Label>
            <Input id="wallet-usdc-label" value={displayLabel} disabled={busy} onChange={(event) => setDisplayLabel(event.target.value)} className="h-10" />
          </div>
          <Button type="button" variant="outline" className="h-10 w-fit gap-2" disabled={busy || !walletAddress.trim()} onClick={() => onSave({ walletAddress, displayLabel })}>
            <Coins className="h-4 w-4" />
            Save USDC address
          </Button>
        </div>
      )}
    </div>
  );
}

function AutoReloadSection({
  wallet, setup, cardFundingFeeBps, awaitingBank, confirmationTimedOut, busy, notice, verification,
  onTurnOn, onTurnOff, onAddBankAccount, onCheckAgain,
}: SectionFeedbackProps & {
  wallet: DropshipWalletOverview;
  setup: WalletSetupState;
  cardFundingFeeBps: number;
  awaitingBank: boolean;
  confirmationTimedOut: boolean;
  onTurnOn: (input: TopUpChoice) => void;
  onTurnOff: () => void;
  onAddBankAccount: () => void;
  onCheckAgain: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const autoReload = wallet.autoReload;
  const method = setup.primaryMethod;
  const backupCard = setup.cardMethods.find((entry) => entry.isDefault) ?? setup.cardMethods[0] ?? null;
  const showChooser = editing || awaitingBank;

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5" data-testid="wallet-auto-reload">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Auto-reload</h2>
          {autoReload && setup.autoReloadReady && method ? (
            <p className="mt-1 text-sm text-zinc-600" data-testid="wallet-auto-reload-summary">
              {describeAutoReloadPolicy({ autoReload, method, backupCard, cardFundingFeeBps })}
            </p>
          ) : (
            <p className="mt-1 text-sm text-zinc-600">Off. Orders wait for a manual payment.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="wallet-auto-reload-switch" className="text-sm">{setup.autoReloadReady ? "On" : "Off"}</Label>
          <Switch
            id="wallet-auto-reload-switch"
            checked={setup.autoReloadReady}
            disabled={busy}
            onCheckedChange={(checked) => {
              if (checked) setEditing(true);
              else onTurnOff();
            }}
          />
        </div>
      </div>
      {setup.autoReloadReady && method && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel" : "Change"}
          </Button>
        </div>
      )}
      {showChooser && method && (
        <div className="mt-5 border-t border-zinc-200 pt-5">
          <TopUpChooser
            setup={setup}
            cardFundingFeeBps={cardFundingFeeBps}
            initialMinimumCents={autoReload?.minimumBalanceCents ?? AUTO_RELOAD_DEFAULTS.minimumBalanceCents}
            initialCapCents={autoReload?.maxSingleReloadCents ?? AUTO_RELOAD_DEFAULTS.maxSingleReloadCents}
            initialMethodId={method.fundingMethodId}
            awaitingBank={awaitingBank}
            bankTimedOut={confirmationTimedOut && !awaitingBank}
            busy={busy}
            submitLabel="Save"
            onSubmit={(input) => { setEditing(false); onTurnOn(input); }}
            onAddBankAccount={onAddBankAccount}
            onCheckAgain={onCheckAgain}
          />
        </div>
      )}
      <SectionFeedback busy={busy} notice={notice} verification={verification} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Advanced: what a vendor does not need day to day, collapsed by default.
// ---------------------------------------------------------------------------

function AdvancedSection({
  wallet, setup, busy, notice, verification, onAddCard, onAddBankAccount, onSaveHoldTimeout,
}: SectionFeedbackProps & {
  wallet: DropshipWalletOverview;
  setup: WalletSetupState;
  onAddCard: () => void;
  onAddBankAccount: () => void;
  onSaveHoldTimeout: (minutes: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [holdMinutes, setHoldMinutes] = useState(String(wallet.autoReload?.paymentHoldTimeoutMinutes ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes));

  useEffect(() => {
    setHoldMinutes(String(wallet.autoReload?.paymentHoldTimeoutMinutes ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes));
  }, [wallet.autoReload?.paymentHoldTimeoutMinutes]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-5 rounded-md border border-zinc-200 bg-white" data-testid="wallet-advanced">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center justify-between p-5 text-left">
          <span>
            <span className="block text-lg font-semibold">Advanced</span>
            <span className="block text-sm text-zinc-500">Payment hold timeout and every saved method.</span>
          </span>
          <ChevronDown className={open ? "h-5 w-5 rotate-180 transition-transform" : "h-5 w-5 transition-transform"} aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-6 border-t border-zinc-200 p-5">
          <div>
            <h3 className="font-medium">Payment hold timeout</h3>
            <p className="mt-1 text-sm text-zinc-600">
              If a top-up fails, an order waits this long for a manual payment before it is cancelled.
            </p>
            <div className="mt-3 flex max-w-sm items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="wallet-hold-minutes">Minutes</Label>
                <Input id="wallet-hold-minutes" inputMode="numeric" value={holdMinutes} disabled={busy} onChange={(event) => setHoldMinutes(event.target.value)} className="h-10" />
              </div>
              <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => onSaveHoldTimeout(holdMinutes)}>
                Save
              </Button>
            </div>
          </div>

          <div>
            <h3 className="font-medium">Saved methods</h3>
            {wallet.fundingMethods.length ? (
              <ul className="mt-3 space-y-2">
                {wallet.fundingMethods.map((method) => (
                  <li key={method.fundingMethodId} className="flex items-center justify-between rounded-md border border-zinc-200 p-3 text-sm">
                    <span>
                      <span className="font-medium">{describeFundingMethod(method)}</span>
                      <span className="ml-2 text-zinc-500">{method.rail === "stripe_card" ? "Card" : method.rail === "stripe_ach" ? "Bank account" : method.rail === "usdc_base" ? "USDC" : formatStatus(method.rail)}</span>
                    </span>
                    <Badge variant="outline">{method.isDefault ? "Default" : formatStatus(method.status)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-zinc-500">None yet.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" className="h-9 gap-2" disabled={busy} onClick={onAddCard}>
                <CreditCard className="h-4 w-4" />
                {setup.cardMethods.length ? "Add another card" : "Add a card"}
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-9 gap-2" disabled={busy} onClick={onAddBankAccount}>
                <Landmark className="h-4 w-4" />
                {setup.bankMethods.length ? "Add another bank account" : "Add a bank account"}
              </Button>
            </div>
          </div>

          <SectionFeedback busy={busy} notice={notice} verification={verification} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActivitySection({ wallet }: { wallet: DropshipWalletOverview }) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5">
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
                <TableHead>Amount</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wallet.recentLedger.map((entry) => (
                <TableRow key={entry.ledgerEntryId}>
                  <TableCell>{formatStatus(entry.type)}</TableCell>
                  <TableCell><Badge variant="outline">{formatStatus(entry.status)}</Badge></TableCell>
                  <TableCell className="font-mono">{formatCents(entry.amountCents)}</TableCell>
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

function WalletFundingReturnBanner({ status, onDismiss }: { status: "success" | "cancelled"; onDismiss: () => void }) {
  const success = status === "success";
  return (
    <Alert className={success ? "mt-5 border-emerald-200 bg-emerald-50 text-emerald-900" : "mt-5"}>
      {success ? <CheckCircle2 className="h-4 w-4" /> : <Info className="h-4 w-4" />}
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>
          {success
            ? "Payment received. Your balance updates as soon as Stripe confirms it."
            : "Payment cancelled. Nothing was charged."}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onDismiss}>Dismiss</Button>
      </AlertDescription>
    </Alert>
  );
}

/** The typed amount as cents, or null while it is not a valid dollar amount yet. */
function tryParseDollarInputToCents(value: string): number | null {
  try {
    return parseDollarInputToCents(value, "Amount");
  } catch {
    return null;
  }
}

function formatWholeDollars(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : formatCents(cents);
}

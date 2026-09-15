import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronDown, CreditCard, History, Info, Landmark, Loader2, RefreshCw, Wallet,
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
import {
  AUTO_RELOAD_AMOUNT_PRESETS_CENTS,
  AUTO_RELOAD_DEFAULTS,
  AUTO_RELOAD_MINIMUM_PRESETS_CENTS,
  CARD_CONFIRMATION_POLL_INTERVAL_MS,
  CARD_CONFIRMATION_POLL_TIMEOUT_MS,
  FUND_WALLET_PRESETS_CENTS,
  buildAutoReloadDisableInput,
  buildAutoReloadSetupInput,
  centsToDollarInput,
  deriveWalletSetupState,
  describeFundingMethod,
  isStripeFundingMethod,
  parseStripeReturn,
  stripStripeReturn,
  type DropshipWalletFundingMethod,
  type DropshipWalletOverview,
  type StripeReturn,
  type WalletSetupState,
} from "@/lib/dropship-wallet-setup";
import { DropshipPortalShell } from "./DropshipPortalShell";

/**
 * Vendor wallet.
 *
 * One question at a time: add a card, confirm it, turn on auto-reload, done.
 * Everything a vendor does not need for launch (bank accounts, USDC, the
 * payment-hold timeout, the raw method list) lives under "Advanced". Every
 * message and verification prompt renders next to the button that caused it.
 */

const WALLET_QUERY_KEY = ["/api/dropship/wallet?limit=50"] as const;
const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;
const SETTINGS_QUERY_KEY = ["/api/dropship/settings"] as const;

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

export default function DropshipPortalWallet() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { principal, sensitiveProofs, startEmailStepUp, verifyEmailStepUp, verifyPasskeyStepUp } = useDropshipAuth();

  // Stripe returns to this page with a status marker; read it once and clear it
  // from the address bar so a reload does not replay the banner.
  const [stripeReturn, setStripeReturn] = useState<StripeReturn | null>(() => parseStripeReturn(window.location.search));
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
  const wallet = walletQuery.data?.wallet ?? null;
  const setup = useMemo(() => (wallet ? deriveWalletSetupState(wallet) : null), [wallet]);

  // After a successful card setup, keep asking the server until Stripe's
  // webhook activates the card, bounded so a broken webhook cannot poll forever.
  const awaitingCard = stripeReturn?.kind === "funding_setup" && stripeReturn.status === "success"
    && setup !== null && (setup.stage === "add_card" || setup.stage === "confirm_card") && !confirmationTimedOut;
  useEffect(() => {
    if (!awaitingCard) return;
    const timer = window.setTimeout(() => setConfirmationTimedOut(true), CARD_CONFIRMATION_POLL_TIMEOUT_MS);
    const interval = window.setInterval(() => { void walletQuery.refetch(); }, CARD_CONFIRMATION_POLL_INTERVAL_MS);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
    // walletQuery.refetch is stable for the query key; re-arming on it would restart the timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingCard]);

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
      window.location.assign(response.setupSession.checkoutUrl);
    });
  }

  function turnOnAutoReload(scope: WalletScope, input: { fundingMethodId: number; minimumBalanceCents: number; maxSingleReloadCents: number }) {
    if (!wallet) return Promise.resolve();
    return withVerification(scope, "add_funding_method", async () => {
      await putJson<DropshipAutoReloadConfigResponse>(
        "/api/dropship/wallet/auto-reload",
        buildAutoReloadSetupInput({ ...input, existing: wallet.autoReload }),
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
    return withVerification("advanced", "add_funding_method", async () => {
      await postJson<DropshipUsdcBaseFundingMethodResponse>(
        "/api/dropship/wallet/funding-methods/usdc-base",
        buildUsdcBaseFundingMethodInput({ ...input, isDefault: false }),
      );
      await refreshAfterWalletChange();
      setNotice({ scope: "advanced", tone: "success", text: "USDC address saved." });
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
                <AlertDescription>Card setup was cancelled. Nothing was saved.</AlertDescription>
              </Alert>
            )}

            {setup.stage === "ready" ? (
              <>
                <BalanceSection
                  setup={setup}
                  {...sectionProps("funds")}
                  onAddFunds={addFunds}
                />
                <AutoReloadSection
                  wallet={wallet}
                  setup={setup}
                  {...sectionProps("auto_reload")}
                  onTurnOn={(input) => turnOnAutoReload("auto_reload", input)}
                  onTurnOff={() => turnOffAutoReload("auto_reload")}
                  onAddCard={() => startStripeSetup("auto_reload", "stripe_card")}
                />
              </>
            ) : (
              <SetupSection
                setup={setup}
                awaitingCard={awaitingCard}
                confirmationTimedOut={confirmationTimedOut}
                {...sectionProps("setup")}
                onAddCard={() => startStripeSetup("setup", "stripe_card")}
                onAddBankAccount={() => startStripeSetup("setup", "stripe_ach")}
                onCheckAgain={() => { setConfirmationTimedOut(false); void walletQuery.refetch(); }}
                onTurnOn={(input) => turnOnAutoReload("setup", input)}
              />
            )}

            {setup.stage === "ready" && stripeReturn?.kind === "funding_setup" && stripeReturn.status === "success" && (
              <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>Your card was added.</AlertDescription>
              </Alert>
            )}

            {setup.stage === "ready" && (
              <div className="mt-5 flex justify-end">
                <Button type="button" variant="outline" className="gap-2" onClick={() => setLocation(dropshipPortalPath("/onboarding"))}>
                  Back to onboarding
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            <AdvancedSection
              wallet={wallet}
              {...sectionProps("advanced")}
              onAddBankAccount={() => startStripeSetup("advanced", "stripe_ach")}
              onSaveHoldTimeout={saveHoldTimeout}
              onSaveUsdc={saveUsdcMethod}
            />

            <ActivitySection wallet={wallet} />
          </>
        )}
      </div>
    </DropshipPortalShell>
  );
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
  { key: "card", title: "Add a card" },
  { key: "reload", title: "Keep it funded automatically" },
  { key: "done", title: "Start selling" },
] as const;

function SetupSection({
  setup, awaitingCard, confirmationTimedOut, busy, notice, verification, onAddCard, onAddBankAccount, onCheckAgain, onTurnOn,
}: SectionFeedbackProps & {
  setup: WalletSetupState;
  awaitingCard: boolean;
  confirmationTimedOut: boolean;
  onAddCard: () => void;
  onAddBankAccount: () => void;
  onCheckAgain: () => void;
  onTurnOn: (input: { fundingMethodId: number; minimumBalanceCents: number; maxSingleReloadCents: number }) => void;
}) {
  const cardDone = setup.primaryMethod !== null;
  const currentIndex = cardDone ? 1 : 0;

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
          <CardConfirmation timedOut={confirmationTimedOut && !awaitingCard} onCheckAgain={onCheckAgain} />
        ) : !cardDone ? (
          <div>
            <h3 className="font-medium">Add a card</h3>
            <p className="mt-1 text-sm text-zinc-600">
              You will be sent to Stripe to enter it. Card Shellz never sees your card number.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button type="button" className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={busy} onClick={onAddCard}>
                <CreditCard className="h-4 w-4" />
                {busy ? "One moment" : "Add a card"}
              </Button>
              <Button type="button" variant="link" className="h-10 px-0 text-zinc-600" disabled={busy} onClick={onAddBankAccount}>
                Use a bank account instead
              </Button>
            </div>
          </div>
        ) : (
          <AutoReloadChooser
            methods={setup.stripeMethods}
            primaryMethod={setup.primaryMethod!}
            initialMinimumCents={AUTO_RELOAD_DEFAULTS.minimumBalanceCents}
            initialAmountCents={AUTO_RELOAD_DEFAULTS.maxSingleReloadCents}
            busy={busy}
            submitLabel="Turn on auto-reload"
            onSubmit={onTurnOn}
          />
        )}
        <SectionFeedback busy={busy} notice={notice} verification={verification} />
      </div>
    </section>
  );
}

function CardConfirmation({ timedOut, onCheckAgain }: { timedOut: boolean; onCheckAgain: () => void }) {
  if (timedOut) {
    return (
      <div role="status">
        <h3 className="font-medium">Still confirming your card</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Stripe accepted the card but has not confirmed it to Card Shellz yet. This is taking longer than usual.
          Refresh in a minute. If the card still is not here, contact Card Shellz support.
        </p>
        <Button type="button" variant="outline" className="mt-4 h-10 gap-2" onClick={onCheckAgain}>
          <RefreshCw className="h-4 w-4" />
          Check again
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-3">
      <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-[#C060E0]" aria-hidden="true" />
      <div>
        <h3 className="font-medium">Confirming your card</h3>
        <p className="mt-1 text-sm text-zinc-600">Stripe is confirming the card. This usually takes a few seconds.</p>
      </div>
    </div>
  );
}

/**
 * The auto-reload choice as one sentence with preset amounts. Free-text money
 * fields are gone: every choice is a whole-dollar preset the server accepts.
 */
function AutoReloadChooser({
  methods, primaryMethod, initialMinimumCents, initialAmountCents, busy, submitLabel, onSubmit,
}: {
  methods: readonly DropshipWalletFundingMethod[];
  primaryMethod: DropshipWalletFundingMethod;
  initialMinimumCents: number;
  initialAmountCents: number;
  busy: boolean;
  submitLabel: string;
  onSubmit: (input: { fundingMethodId: number; minimumBalanceCents: number; maxSingleReloadCents: number }) => void;
}) {
  const [minimumCents, setMinimumCents] = useState(initialMinimumCents);
  const [amountCents, setAmountCents] = useState(initialAmountCents);
  const [methodId, setMethodId] = useState(primaryMethod.fundingMethodId);
  const invalid = amountCents < minimumCents;

  return (
    <div>
      <h3 className="font-medium">Keep it funded automatically</h3>
      <p className="mt-1 text-sm text-zinc-600">
        When an order needs more than your balance, we top the wallet up from your card. Nothing is charged until then.
      </p>
      <div className="mt-4 space-y-4">
        <PresetPicker
          label="Reload when my balance drops below"
          options={AUTO_RELOAD_MINIMUM_PRESETS_CENTS}
          value={minimumCents}
          onChange={setMinimumCents}
          disabled={busy}
        />
        <PresetPicker
          label="Add this much each time"
          options={AUTO_RELOAD_AMOUNT_PRESETS_CENTS}
          value={amountCents}
          onChange={setAmountCents}
          disabled={busy}
        />
        {methods.length > 1 ? (
          <div className="space-y-2">
            <Label htmlFor="auto-reload-method">Charge</Label>
            <select
              id="auto-reload-method"
              className="h-10 w-full max-w-sm rounded-md border border-zinc-300 bg-white px-3 text-sm"
              value={methodId}
              disabled={busy}
              onChange={(event) => setMethodId(Number(event.target.value))}
            >
              {methods.map((method) => (
                <option key={method.fundingMethodId} value={method.fundingMethodId}>{describeFundingMethod(method)}</option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-sm text-zinc-600">Charged to <span className="font-medium text-zinc-900">{describeFundingMethod(primaryMethod)}</span>.</p>
        )}
        {invalid && (
          <p role="alert" className="text-sm text-red-700">The reload amount must be at least the minimum balance.</p>
        )}
      </div>
      <Button
        type="button"
        className="mt-5 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
        disabled={busy || invalid}
        onClick={() => onSubmit({ fundingMethodId: methodId, minimumBalanceCents: minimumCents, maxSingleReloadCents: amountCents })}
      >
        {busy ? "Saving" : submitLabel}
      </Button>
    </div>
  );
}

function PresetPicker({
  label, options, value, onChange, disabled,
}: {
  label: string;
  options: readonly number[];
  value: number;
  onChange: (cents: number) => void;
  disabled: boolean;
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
              disabled={disabled}
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

function BalanceSection({
  setup, busy, notice, verification, onAddFunds,
}: SectionFeedbackProps & {
  setup: WalletSetupState;
  onAddFunds: (input: { fundingMethodId: number; amountCents: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [presetCents, setPresetCents] = useState<number>(FUND_WALLET_PRESETS_CENTS[1]);
  const [customAmount, setCustomAmount] = useState("");
  const [customError, setCustomError] = useState("");
  const method = setup.primaryMethod;

  function submit() {
    if (!method) return;
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
    onAddFunds({ fundingMethodId: method.fundingMethodId, amountCents });
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

      {open && method && (
        <div className="mt-5 border-t border-zinc-200 pt-5">
          <p className="text-sm text-zinc-600">
            Optional. Adding money now means your first orders do not wait for a reload. Charged to {describeFundingMethod(method)}.
          </p>
          <div className="mt-4 space-y-4">
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
          </div>
          <Button type="button" className="mt-5 h-10 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={busy} onClick={submit}>
            {busy ? "One moment" : "Continue to payment"}
          </Button>
        </div>
      )}
      <SectionFeedback busy={busy} notice={notice} verification={verification} />
    </section>
  );
}

function AutoReloadSection({
  wallet, setup, busy, notice, verification, onTurnOn, onTurnOff, onAddCard,
}: SectionFeedbackProps & {
  wallet: DropshipWalletOverview;
  setup: WalletSetupState;
  onTurnOn: (input: { fundingMethodId: number; minimumBalanceCents: number; maxSingleReloadCents: number }) => void;
  onTurnOff: () => void;
  onAddCard: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const autoReload = wallet.autoReload;
  const method = setup.primaryMethod;

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-5" data-testid="wallet-auto-reload">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Auto-reload</h2>
          {autoReload && setup.autoReloadReady && method ? (
            <p className="mt-1 text-sm text-zinc-600" data-testid="wallet-auto-reload-summary">
              Below {formatCents(autoReload.minimumBalanceCents)}, add {formatCents(autoReload.maxSingleReloadCents ?? autoReload.minimumBalanceCents)} from {describeFundingMethod(method)}.
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
      <div className="mt-3 flex flex-wrap gap-2">
        {setup.autoReloadReady && method && (
          <Button type="button" variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel" : "Change amounts"}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" className="h-9 gap-2" disabled={busy} onClick={onAddCard}>
          <CreditCard className="h-4 w-4" />
          {method ? "Add another card" : "Add a card"}
        </Button>
      </div>
      {editing && method && (
        <div className="mt-5 border-t border-zinc-200 pt-5">
          <AutoReloadChooser
            methods={setup.stripeMethods}
            primaryMethod={method}
            initialMinimumCents={autoReload?.minimumBalanceCents ?? AUTO_RELOAD_DEFAULTS.minimumBalanceCents}
            initialAmountCents={autoReload?.maxSingleReloadCents ?? AUTO_RELOAD_DEFAULTS.maxSingleReloadCents}
            busy={busy}
            submitLabel="Save"
            onSubmit={(input) => { setEditing(false); onTurnOn(input); }}
          />
        </div>
      )}
      <SectionFeedback busy={busy} notice={notice} verification={verification} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Advanced: everything a vendor does not need for launch, collapsed by default.
// ---------------------------------------------------------------------------

function AdvancedSection({
  wallet, busy, notice, verification, onAddBankAccount, onSaveHoldTimeout, onSaveUsdc,
}: SectionFeedbackProps & {
  wallet: DropshipWalletOverview;
  onAddBankAccount: () => void;
  onSaveHoldTimeout: (minutes: string) => void;
  onSaveUsdc: (input: { walletAddress: string; displayLabel: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [holdMinutes, setHoldMinutes] = useState(String(wallet.autoReload?.paymentHoldTimeoutMinutes ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes));
  const [usdcAddress, setUsdcAddress] = useState("");
  const [usdcLabel, setUsdcLabel] = useState("USDC on Base");

  useEffect(() => {
    setHoldMinutes(String(wallet.autoReload?.paymentHoldTimeoutMinutes ?? AUTO_RELOAD_DEFAULTS.paymentHoldTimeoutMinutes));
  }, [wallet.autoReload?.paymentHoldTimeoutMinutes]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-5 rounded-md border border-zinc-200 bg-white" data-testid="wallet-advanced">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center justify-between p-5 text-left">
          <span>
            <span className="block text-lg font-semibold">Advanced</span>
            <span className="block text-sm text-zinc-500">Bank accounts, USDC, payment hold timeout, and every saved method.</span>
          </span>
          <ChevronDown className={open ? "h-5 w-5 rotate-180 transition-transform" : "h-5 w-5 transition-transform"} aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-6 border-t border-zinc-200 p-5">
          <div>
            <h3 className="font-medium">Bank account (ACH)</h3>
            <p className="mt-1 text-sm text-zinc-600">Lower fees than a card, but reloads take a few days to settle.</p>
            <Button type="button" variant="outline" className="mt-3 h-10 gap-2" disabled={busy} onClick={onAddBankAccount}>
              <Landmark className="h-4 w-4" />
              Add a bank account
            </Button>
          </div>

          <div>
            <h3 className="font-medium">Payment hold timeout</h3>
            <p className="mt-1 text-sm text-zinc-600">
              If a reload fails, an order waits this long for a manual payment before it is cancelled.
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
            <h3 className="font-medium">USDC on Base</h3>
            <p className="mt-1 text-sm text-zinc-600">Optional. Register a wallet address to fund by confirmed transfer. Not used for auto-reload.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr]">
              <div className="space-y-2">
                <Label htmlFor="wallet-usdc-address">Wallet address</Label>
                <Input id="wallet-usdc-address" placeholder="0x..." value={usdcAddress} disabled={busy} onChange={(event) => setUsdcAddress(event.target.value)} className="h-10 font-mono text-sm" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wallet-usdc-label">Label</Label>
                <Input id="wallet-usdc-label" value={usdcLabel} disabled={busy} onChange={(event) => setUsdcLabel(event.target.value)} className="h-10" />
              </div>
            </div>
            <Button type="button" variant="outline" className="mt-3 h-10" disabled={busy || !usdcAddress.trim()} onClick={() => onSaveUsdc({ walletAddress: usdcAddress, displayLabel: usdcLabel })}>
              Save USDC address
            </Button>
          </div>

          <div>
            <h3 className="font-medium">Saved methods</h3>
            {wallet.fundingMethods.length ? (
              <ul className="mt-3 space-y-2">
                {wallet.fundingMethods.map((method) => (
                  <li key={method.fundingMethodId} className="flex items-center justify-between rounded-md border border-zinc-200 p-3 text-sm">
                    <span>
                      <span className="font-medium">{describeFundingMethod(method)}</span>
                      <span className="ml-2 text-zinc-500">{isStripeFundingMethod(method) ? (method.rail === "stripe_card" ? "Card" : "Bank account") : formatStatus(method.rail)}</span>
                    </span>
                    <Badge variant="outline">{method.isDefault ? "Default" : formatStatus(method.status)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-zinc-500">None yet.</p>
            )}
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
        <p className="mt-2 text-sm text-zinc-500">No activity yet. Charges and reloads will show here.</p>
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

function formatWholeDollars(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : formatCents(cents);
}

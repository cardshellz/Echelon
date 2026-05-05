import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, CircleDollarSign, CreditCard, Fingerprint, History, Landmark, Mail, Save, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildAutoReloadConfigInput,
  buildStripeFundingSetupSessionInput,
  buildStripeWalletFundingSessionInput,
  buildUsdcBaseFundingMethodInput,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
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
import { dropshipPortalPath, useDropshipAuth, type DropshipSensitiveAction } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingWalletAction = "send-code" | "verify-code" | "passkey-proof" | "save" | "stripe-card" | "stripe-ach" | "usdc-base" | "fund-wallet" | null;
type WalletSensitiveAction = Extract<DropshipSensitiveAction, "add_funding_method" | "wallet_funding_high_value">;

export default function DropshipPortalWallet() {
  const queryClient = useQueryClient();
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [autoReloadEnabled, setAutoReloadEnabled] = useState(true);
  const [fundingMethodId, setFundingMethodId] = useState("");
  const [minimumBalance, setMinimumBalance] = useState("50.00");
  const [maxSingleReload, setMaxSingleReload] = useState("250.00");
  const [paymentHoldTimeoutMinutes, setPaymentHoldTimeoutMinutes] = useState("2880");
  const [fundingLoadMethodId, setFundingLoadMethodId] = useState("");
  const [fundingAmount, setFundingAmount] = useState("250.00");
  const [usdcWalletAddress, setUsdcWalletAddress] = useState("");
  const [usdcDisplayLabel, setUsdcDisplayLabel] = useState("USDC on Base");
  const [emailStepUpAction, setEmailStepUpAction] = useState<WalletSensitiveAction | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingWalletAction, setPendingWalletAction] = useState<PendingWalletAction>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const walletQuery = useQuery<DropshipWalletResponse>({
    queryKey: ["/api/dropship/wallet?limit=50"],
    queryFn: () => fetchJson<DropshipWalletResponse>("/api/dropship/wallet?limit=50"),
  });
  const wallet = walletQuery.data?.wallet;
  const activeFundingMethods = wallet?.fundingMethods.filter((method) => method.status === "active") ?? [];
  const stripeFundingMethods = activeFundingMethods.filter((method) =>
    method.rail === "stripe_card" || method.rail === "stripe_ach"
  );
  const hasActiveProof = (action: DropshipSensitiveAction) => {
    const proof = sensitiveProofs[action];
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  };

  useEffect(() => {
    if (!wallet) return;
    const configuredAutoReloadMethodId = wallet.autoReload?.fundingMethodId ?? null;
    const usableAutoReloadMethodId = configuredAutoReloadMethodId && stripeFundingMethods.some((method) =>
      method.fundingMethodId === configuredAutoReloadMethodId
    )
      ? configuredAutoReloadMethodId
      : null;
    const defaultFundingMethodId = usableAutoReloadMethodId
      ?? stripeFundingMethods.find((method) => method.isDefault)?.fundingMethodId
      ?? stripeFundingMethods[0]?.fundingMethodId
      ?? null;
    setAutoReloadEnabled(wallet.autoReload?.enabled ?? true);
    setFundingMethodId(defaultFundingMethodId ? String(defaultFundingMethodId) : "");
    setFundingLoadMethodId(defaultFundingMethodId ? String(defaultFundingMethodId) : "");
    setMinimumBalance(centsToDollarInput(wallet.autoReload?.minimumBalanceCents ?? 5000));
    setMaxSingleReload(wallet.autoReload?.maxSingleReloadCents === null || wallet.autoReload?.maxSingleReloadCents === undefined
      ? "250.00"
      : centsToDollarInput(wallet.autoReload.maxSingleReloadCents));
    setPaymentHoldTimeoutMinutes(String(wallet.autoReload?.paymentHoldTimeoutMinutes ?? 2880));
  }, [wallet?.autoReload, wallet?.fundingMethods]);

  async function saveAutoReload() {
    if (!await ensureWalletSensitiveProof("add_funding_method")) return;

    await runWalletAction("save", async () => {
      const input = buildAutoReloadConfigInput({
        enabled: autoReloadEnabled,
        fundingMethodId,
        minimumBalance,
        maxSingleReload,
        paymentHoldTimeoutMinutes,
      });
      await putJson<DropshipAutoReloadConfigResponse>("/api/dropship/wallet/auto-reload", input);
      await Promise.all([
        walletQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
      ]);
      setEmailStepUpAction(null);
      setVerificationCode("");
      setMessage("Auto-reload settings saved.");
    });
  }

  async function startStripeFundingSetup(rail: DropshipStripeFundingRail) {
    if (!await ensureWalletSensitiveProof("add_funding_method")) return;

    await runWalletAction(rail === "stripe_card" ? "stripe-card" : "stripe-ach", async () => {
      const returnTo = `${window.location.pathname}${window.location.search}` || dropshipPortalPath("/wallet");
      const input = buildStripeFundingSetupSessionInput({ rail, returnTo });
      const response = await postJson<DropshipStripeFundingSetupSessionResponse>(
        "/api/dropship/wallet/funding-methods/stripe/setup-session",
        input,
      );
      window.location.assign(response.setupSession.checkoutUrl);
    });
  }

  async function saveUsdcFundingMethod() {
    if (!await ensureWalletSensitiveProof("add_funding_method")) return;

    await runWalletAction("usdc-base", async () => {
      const input = buildUsdcBaseFundingMethodInput({
        walletAddress: usdcWalletAddress,
        displayLabel: usdcDisplayLabel,
        isDefault: activeFundingMethods.length === 0,
      });
      await postJson<DropshipUsdcBaseFundingMethodResponse>(
        "/api/dropship/wallet/funding-methods/usdc-base",
        input,
      );
      await Promise.all([
        walletQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
      ]);
      setUsdcWalletAddress("");
      setUsdcDisplayLabel("USDC on Base");
      setEmailStepUpAction(null);
      setVerificationCode("");
      setMessage("USDC funding method saved.");
    });
  }

  async function startWalletFunding() {
    if (!await ensureWalletSensitiveProof("wallet_funding_high_value")) return;

    await runWalletAction("fund-wallet", async () => {
      const returnTo = `${window.location.pathname}${window.location.search}` || dropshipPortalPath("/wallet");
      const input = buildStripeWalletFundingSessionInput({
        fundingMethodId: fundingLoadMethodId,
        amount: fundingAmount,
        returnTo,
      });
      const response = await postJson<DropshipStripeWalletFundingSessionResponse>(
        "/api/dropship/wallet/funding/stripe/checkout-session",
        input,
      );
      window.location.assign(response.fundingSession.checkoutUrl);
    });
  }

  async function ensureWalletSensitiveProof(action: WalletSensitiveAction): Promise<boolean> {
    if (hasActiveProof(action)) return true;
    if (principal?.hasPasskey) {
      return runWalletAction("passkey-proof", async () => {
        await verifyPasskeyStepUp(action);
      });
    }
    if (emailStepUpAction !== action) {
      await runWalletAction("send-code", async () => {
        await startEmailStepUp(action);
        setEmailStepUpAction(action);
        setVerificationCode("");
        setMessage("Verification code sent. Enter it below, then retry the wallet action.");
      });
      return false;
    }
    if (verificationCode.length !== 6) {
      setError("Enter the 6-digit verification code before continuing.");
      return false;
    }

    const verified = await runWalletAction("verify-code", async () => {
      await verifyEmailStepUp({
        action,
        verificationCode,
      });
    });
    if (verified) {
      setEmailStepUpAction(null);
      setVerificationCode("");
    }
    return verified;
  }

  async function runWalletAction(action: PendingWalletAction, task: () => Promise<void>): Promise<boolean> {
    setPendingWalletAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wallet request failed.");
      return false;
    } finally {
      setPendingWalletAction(null);
    }
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Wallet className="h-6 w-6 text-[#C060E0]" />
            Wallet
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Balance, auto-reload configuration, funding methods, and ledger history.</p>
        </div>

        {walletQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(walletQuery.error, "Unable to load dropship wallet.")}
            </AlertDescription>
          </Alert>
        )}

        {walletQuery.isLoading ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : wallet ? (
          <>
            <section className="mt-5 grid gap-4 lg:grid-cols-3">
              <Metric title="Available" value={formatCents(wallet.account.availableBalanceCents)} />
              <Metric title="Pending" value={formatCents(wallet.account.pendingBalanceCents)} />
              <Metric
                title="Auto-reload"
                value={wallet.autoReload?.enabled ? "Enabled" : "Needs setup"}
                detail={wallet.autoReload ? `Minimum ${formatCents(wallet.autoReload.minimumBalanceCents)}` : "No configuration"}
              />
            </section>

            {error && (
              <Alert variant="destructive" className="mt-5">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {message && (
              <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            )}

            {emailStepUpAction && (
              <SensitiveActionVerificationPanel
                emailStepUpAction={emailStepUpAction}
                pendingWalletAction={pendingWalletAction}
                verificationCode={verificationCode}
                onVerificationCodeChange={setVerificationCode}
              />
            )}

            <AutoReloadPanel
              activeFundingMethods={stripeFundingMethods}
              autoReloadEnabled={autoReloadEnabled}
              emailStepUpAction={emailStepUpAction}
              fundingMethodId={fundingMethodId}
              maxSingleReload={maxSingleReload}
              minimumBalance={minimumBalance}
              paymentHoldTimeoutMinutes={paymentHoldTimeoutMinutes}
              pendingWalletAction={pendingWalletAction}
              verificationCode={verificationCode}
              onAutoReloadEnabledChange={setAutoReloadEnabled}
              onFundingMethodIdChange={setFundingMethodId}
              onMaxSingleReloadChange={setMaxSingleReload}
              onMinimumBalanceChange={setMinimumBalance}
              onPaymentHoldTimeoutMinutesChange={setPaymentHoldTimeoutMinutes}
              onSave={saveAutoReload}
            />

            <FundWalletPanel
              activeFundingMethods={stripeFundingMethods}
              emailStepUpAction={emailStepUpAction}
              fundingAmount={fundingAmount}
              fundingLoadMethodId={fundingLoadMethodId}
              pendingWalletAction={pendingWalletAction}
              verificationCode={verificationCode}
              onFundingAmountChange={setFundingAmount}
              onFundingLoadMethodIdChange={setFundingLoadMethodId}
              onFund={startWalletFunding}
            />

            <UsdcFundingMethodPanel
              emailStepUpAction={emailStepUpAction}
              pendingWalletAction={pendingWalletAction}
              usdcDisplayLabel={usdcDisplayLabel}
              usdcWalletAddress={usdcWalletAddress}
              verificationCode={verificationCode}
              onDisplayLabelChange={setUsdcDisplayLabel}
              onSave={saveUsdcFundingMethod}
              onWalletAddressChange={setUsdcWalletAddress}
            />

            <section className="mt-5 grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
              <div className="rounded-md border border-zinc-200 bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Funding methods</h2>
                    <p className="text-sm text-zinc-500">Configured rails</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2"
                      disabled={pendingWalletAction !== null || walletEmailStepUpRequiresCode(emailStepUpAction, "add_funding_method", verificationCode)}
                      onClick={() => startStripeFundingSetup("stripe_card")}
                    >
                      <CreditCard className="h-4 w-4" />
                      {fundingMethodButtonLabel({
                        pendingWalletAction,
                        emailStepUpAction,
                        action: "add_funding_method",
                        activeLabel: "Starting card",
                        defaultLabel: "Add card",
                        verifyLabel: "Verify and add card",
                        pendingAction: "stripe-card",
                      })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2"
                      disabled={pendingWalletAction !== null || walletEmailStepUpRequiresCode(emailStepUpAction, "add_funding_method", verificationCode)}
                      onClick={() => startStripeFundingSetup("stripe_ach")}
                    >
                      <Landmark className="h-4 w-4" />
                      {fundingMethodButtonLabel({
                        pendingWalletAction,
                        emailStepUpAction,
                        action: "add_funding_method",
                        activeLabel: "Starting ACH",
                        defaultLabel: "Add ACH",
                        verifyLabel: "Verify and add ACH",
                        pendingAction: "stripe-ach",
                      })}
                    </Button>
                  </div>
                </div>
                {wallet.fundingMethods.length ? (
                  <div className="mt-4 space-y-3">
                    {wallet.fundingMethods.map((method) => (
                      <div key={method.fundingMethodId} className="rounded-md border border-zinc-200 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium">{method.displayLabel || formatStatus(method.rail)}</div>
                            <div className="text-sm text-zinc-500">
                              {method.rail === "usdc_base" && method.usdcWalletAddress
                                ? maskAddress(method.usdcWalletAddress)
                                : formatStatus(method.rail)}
                            </div>
                          </div>
                          <Badge variant="outline">{method.isDefault ? "Default" : formatStatus(method.status)}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty className="mt-4 rounded-md border border-dashed p-6">
                    <EmptyMedia variant="icon"><CreditCard /></EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>No funding methods</EmptyTitle>
                      <EmptyDescription>Funding methods are not configured yet.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>

              <div className="rounded-md border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Ledger</h2>
                    <p className="text-sm text-zinc-500">Recent wallet transactions</p>
                  </div>
                  <History className="h-5 w-5 text-zinc-400" />
                </div>
                {wallet.recentLedger.length ? (
                  <div className="mt-4 rounded-md border border-zinc-200">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Type</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Amount</TableHead>
                          <TableHead>Created</TableHead>
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
                  <Empty className="mt-4 rounded-md border border-dashed p-6">
                    <EmptyMedia variant="icon"><History /></EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>No ledger entries</EmptyTitle>
                      <EmptyDescription>No wallet ledger activity has been recorded.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
            </section>
          </>
        ) : (
          <Empty className="mt-5 rounded-md border border-dashed p-8">
            <EmptyMedia variant="icon"><Wallet /></EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{walletQuery.error ? "Wallet unavailable" : "No wallet"}</EmptyTitle>
              <EmptyDescription>
                {walletQuery.error ? "The wallet API request failed." : "Dropship wallet state could not be loaded."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </DropshipPortalShell>
  );
}

function AutoReloadPanel({
  activeFundingMethods,
  autoReloadEnabled,
  emailStepUpAction,
  fundingMethodId,
  maxSingleReload,
  minimumBalance,
  onAutoReloadEnabledChange,
  onFundingMethodIdChange,
  onMaxSingleReloadChange,
  onMinimumBalanceChange,
  onPaymentHoldTimeoutMinutesChange,
  onSave,
  paymentHoldTimeoutMinutes,
  pendingWalletAction,
  verificationCode,
}: {
  activeFundingMethods: DropshipWalletResponse["wallet"]["fundingMethods"];
  autoReloadEnabled: boolean;
  emailStepUpAction: WalletSensitiveAction | null;
  fundingMethodId: string;
  maxSingleReload: string;
  minimumBalance: string;
  onAutoReloadEnabledChange: (value: boolean) => void;
  onFundingMethodIdChange: (value: string) => void;
  onMaxSingleReloadChange: (value: string) => void;
  onMinimumBalanceChange: (value: string) => void;
  onPaymentHoldTimeoutMinutesChange: (value: string) => void;
  onSave: () => void;
  paymentHoldTimeoutMinutes: string;
  pendingWalletAction: PendingWalletAction;
  verificationCode: string;
}) {
  const saveDisabled = pendingWalletAction !== null
    || (autoReloadEnabled && activeFundingMethods.length === 0)
    || walletEmailStepUpRequiresCode(emailStepUpAction, "add_funding_method", verificationCode);

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Auto-reload</h2>
          <p className="mt-1 text-sm text-zinc-500">Required before order processing can run without manual payment holds.</p>
        </div>
        <Select value={autoReloadEnabled ? "enabled" : "disabled"} onValueChange={(value) => onAutoReloadEnabledChange(value === "enabled")}>
          <SelectTrigger className="h-10 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        <div className="space-y-2 lg:col-span-2">
          <Label>Funding method</Label>
          <Select
            value={fundingMethodId}
            onValueChange={onFundingMethodIdChange}
            disabled={activeFundingMethods.length === 0}
          >
            <SelectTrigger className="h-10">
              <SelectValue placeholder="Select active funding method" />
            </SelectTrigger>
            <SelectContent>
              {activeFundingMethods.map((method) => (
                <SelectItem key={method.fundingMethodId} value={String(method.fundingMethodId)}>
                  {method.displayLabel || formatStatus(method.rail)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="auto-reload-minimum">Minimum balance</Label>
          <Input id="auto-reload-minimum" value={minimumBalance} onChange={(event) => onMinimumBalanceChange(event.target.value)} className="h-10" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="auto-reload-max">Max reload</Label>
          <Input id="auto-reload-max" value={maxSingleReload} onChange={(event) => onMaxSingleReloadChange(event.target.value)} className="h-10" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="payment-hold-timeout">Payment hold minutes</Label>
          <Input
            id="payment-hold-timeout"
            value={paymentHoldTimeoutMinutes}
            onChange={(event) => onPaymentHoldTimeoutMinutesChange(event.target.value)}
            className="h-10"
          />
        </div>
      </div>

      {activeFundingMethods.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Add an active card or ACH funding method before enabling auto-reload.
        </div>
      )}

      <Button
        type="button"
        className="mt-4 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
        disabled={saveDisabled}
        onClick={onSave}
      >
        {walletButtonIcon(pendingWalletAction, emailStepUpAction, "add_funding_method")}
        {walletButtonLabel(pendingWalletAction, emailStepUpAction, "add_funding_method")}
      </Button>
    </section>
  );
}

function SensitiveActionVerificationPanel({
  emailStepUpAction,
  onVerificationCodeChange,
  pendingWalletAction,
  verificationCode,
}: {
  emailStepUpAction: WalletSensitiveAction;
  onVerificationCodeChange: (value: string) => void;
  pendingWalletAction: PendingWalletAction;
  verificationCode: string;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="max-w-sm space-y-2">
        <Label>{walletSensitiveActionLabel(emailStepUpAction)}</Label>
        <InputOTP
          maxLength={6}
          value={verificationCode}
          onChange={onVerificationCodeChange}
          containerClassName="justify-between"
          disabled={pendingWalletAction !== null}
        >
          <InputOTPGroup>
            {Array.from({ length: 6 }).map((_, index) => (
              <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
    </section>
  );
}

function FundWalletPanel({
  activeFundingMethods,
  emailStepUpAction,
  fundingAmount,
  fundingLoadMethodId,
  onFund,
  onFundingAmountChange,
  onFundingLoadMethodIdChange,
  pendingWalletAction,
  verificationCode,
}: {
  activeFundingMethods: DropshipWalletResponse["wallet"]["fundingMethods"];
  emailStepUpAction: WalletSensitiveAction | null;
  fundingAmount: string;
  fundingLoadMethodId: string;
  onFund: () => void;
  onFundingAmountChange: (value: string) => void;
  onFundingLoadMethodIdChange: (value: string) => void;
  pendingWalletAction: PendingWalletAction;
  verificationCode: string;
}) {
  const fundDisabled = pendingWalletAction !== null
    || activeFundingMethods.length === 0
    || walletEmailStepUpRequiresCode(emailStepUpAction, "wallet_funding_high_value", verificationCode);

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Load wallet</h2>
          <p className="mt-1 text-sm text-zinc-500">Add funds from an active card or ACH funding method.</p>
        </div>
        <Button
          type="button"
          className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          disabled={fundDisabled}
          onClick={onFund}
        >
          {fundWalletButtonIcon(pendingWalletAction, emailStepUpAction)}
          {fundWalletButtonLabel(pendingWalletAction, emailStepUpAction)}
        </Button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <Label>Funding method</Label>
          <Select
            value={fundingLoadMethodId}
            onValueChange={onFundingLoadMethodIdChange}
            disabled={activeFundingMethods.length === 0}
          >
            <SelectTrigger className="h-10">
              <SelectValue placeholder="Select active funding method" />
            </SelectTrigger>
            <SelectContent>
              {activeFundingMethods.map((method) => (
                <SelectItem key={method.fundingMethodId} value={String(method.fundingMethodId)}>
                  {method.displayLabel || formatStatus(method.rail)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="wallet-funding-amount">Amount</Label>
          <Input
            id="wallet-funding-amount"
            value={fundingAmount}
            onChange={(event) => onFundingAmountChange(event.target.value)}
            className="h-10"
          />
        </div>
      </div>

      {activeFundingMethods.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Add an active card or ACH funding method before loading the wallet.
        </div>
      )}
    </section>
  );
}

function UsdcFundingMethodPanel({
  emailStepUpAction,
  onDisplayLabelChange,
  onSave,
  onWalletAddressChange,
  pendingWalletAction,
  usdcDisplayLabel,
  usdcWalletAddress,
  verificationCode,
}: {
  emailStepUpAction: WalletSensitiveAction | null;
  onDisplayLabelChange: (value: string) => void;
  onSave: () => void;
  onWalletAddressChange: (value: string) => void;
  pendingWalletAction: PendingWalletAction;
  usdcDisplayLabel: string;
  usdcWalletAddress: string;
  verificationCode: string;
}) {
  const saveDisabled = pendingWalletAction !== null
    || !usdcWalletAddress.trim()
    || walletEmailStepUpRequiresCode(emailStepUpAction, "add_funding_method", verificationCode);

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">USDC on Base</h2>
          <p className="mt-1 text-sm text-zinc-500">Register the wallet address used for confirmed-transfer funding.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-10 gap-2"
          disabled={saveDisabled}
          onClick={onSave}
        >
          <CircleDollarSign className="h-4 w-4" />
          {pendingWalletAction === "usdc-base"
            ? "Saving USDC"
            : emailStepUpAction === "add_funding_method"
              ? "Verify and save USDC"
              : "Save USDC"}
        </Button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <Label htmlFor="usdc-wallet-address">Wallet address</Label>
          <Input
            id="usdc-wallet-address"
            value={usdcWalletAddress}
            onChange={(event) => onWalletAddressChange(event.target.value)}
            placeholder="0x..."
            className="h-10 font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="usdc-display-label">Label</Label>
          <Input
            id="usdc-display-label"
            value={usdcDisplayLabel}
            onChange={(event) => onDisplayLabelChange(event.target.value)}
            className="h-10"
          />
        </div>
      </div>
    </section>
  );
}

function Metric({ detail, title, value }: { detail?: string; title: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {detail && <div className="mt-1 text-sm text-zinc-500">{detail}</div>}
    </div>
  );
}

function centsToDollarInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "0.00";
  const dollars = Math.trunc(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${String(remainder).padStart(2, "0")}`;
}

function maskAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function walletButtonLabel(
  pendingWalletAction: PendingWalletAction,
  emailStepUpAction: WalletSensitiveAction | null,
  action: WalletSensitiveAction,
): string {
  if (pendingWalletAction === "send-code") return "Sending code";
  if (pendingWalletAction === "verify-code") return "Verifying code";
  if (pendingWalletAction === "passkey-proof") return "Waiting for passkey";
  if (pendingWalletAction === "stripe-card") return "Starting card setup";
  if (pendingWalletAction === "stripe-ach") return "Starting ACH setup";
  if (pendingWalletAction === "usdc-base") return "Saving USDC";
  if (pendingWalletAction === "fund-wallet") return "Starting wallet funding";
  if (pendingWalletAction === "save") return "Saving";
  if (emailStepUpAction === action) return "Verify and save";
  return "Save auto-reload";
}

function walletButtonIcon(
  pendingWalletAction: PendingWalletAction,
  emailStepUpAction: WalletSensitiveAction | null,
  action: WalletSensitiveAction,
) {
  if (pendingWalletAction === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (pendingWalletAction === "stripe-ach") return <Landmark className="h-4 w-4" />;
  if (pendingWalletAction === "stripe-card") return <CreditCard className="h-4 w-4" />;
  if (pendingWalletAction === "usdc-base") return <CircleDollarSign className="h-4 w-4" />;
  if (pendingWalletAction === "fund-wallet") return <Wallet className="h-4 w-4" />;
  if (pendingWalletAction === "send-code" || (emailStepUpAction === action && pendingWalletAction !== "save")) return <Mail className="h-4 w-4" />;
  return <Save className="h-4 w-4" />;
}

function fundWalletButtonLabel(
  pendingWalletAction: PendingWalletAction,
  emailStepUpAction: WalletSensitiveAction | null,
): string {
  if (pendingWalletAction === "send-code") return "Sending code";
  if (pendingWalletAction === "verify-code") return "Verifying code";
  if (pendingWalletAction === "passkey-proof") return "Waiting for passkey";
  if (pendingWalletAction === "fund-wallet") return "Starting funding";
  if (emailStepUpAction === "wallet_funding_high_value") return "Verify and fund";
  return "Fund wallet";
}

function fundWalletButtonIcon(
  pendingWalletAction: PendingWalletAction,
  emailStepUpAction: WalletSensitiveAction | null,
) {
  if (pendingWalletAction === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (pendingWalletAction === "send-code" || pendingWalletAction === "verify-code" || emailStepUpAction === "wallet_funding_high_value") return <Mail className="h-4 w-4" />;
  return <Wallet className="h-4 w-4" />;
}

function walletEmailStepUpRequiresCode(
  currentAction: WalletSensitiveAction | null,
  targetAction: WalletSensitiveAction,
  verificationCode: string,
): boolean {
  return currentAction === targetAction && verificationCode.length !== 6;
}

function walletSensitiveActionLabel(action: WalletSensitiveAction): string {
  if (action === "wallet_funding_high_value") return "Wallet funding verification code";
  return "Funding method verification code";
}

function fundingMethodButtonLabel(input: {
  pendingWalletAction: PendingWalletAction;
  emailStepUpAction: WalletSensitiveAction | null;
  action: WalletSensitiveAction;
  activeLabel: string;
  defaultLabel: string;
  verifyLabel: string;
  pendingAction: PendingWalletAction;
}): string {
  if (input.pendingWalletAction === input.pendingAction) return input.activeLabel;
  if (input.emailStepUpAction === input.action) return input.verifyLabel;
  return input.defaultLabel;
}

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, CreditCard, Fingerprint, History, Landmark, Mail, Save, Wallet } from "lucide-react";
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
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  putJson,
  type DropshipAutoReloadConfigResponse,
  type DropshipStripeFundingRail,
  type DropshipStripeFundingSetupSessionResponse,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";
import { dropshipPortalPath, useDropshipAuth } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingWalletAction = "send-code" | "verify-code" | "passkey-proof" | "save" | "stripe-card" | "stripe-ach" | null;

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
  const [emailCodeSent, setEmailCodeSent] = useState(false);
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
  const activeProof = (() => {
    const proof = sensitiveProofs.add_funding_method;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  })();

  useEffect(() => {
    if (!wallet) return;
    const defaultFundingMethodId = wallet.autoReload?.fundingMethodId
      ?? activeFundingMethods.find((method) => method.isDefault)?.fundingMethodId
      ?? activeFundingMethods[0]?.fundingMethodId
      ?? null;
    setAutoReloadEnabled(wallet.autoReload?.enabled ?? true);
    setFundingMethodId(defaultFundingMethodId ? String(defaultFundingMethodId) : "");
    setMinimumBalance(centsToDollarInput(wallet.autoReload?.minimumBalanceCents ?? 5000));
    setMaxSingleReload(wallet.autoReload?.maxSingleReloadCents === null || wallet.autoReload?.maxSingleReloadCents === undefined
      ? "250.00"
      : centsToDollarInput(wallet.autoReload.maxSingleReloadCents));
    setPaymentHoldTimeoutMinutes(String(wallet.autoReload?.paymentHoldTimeoutMinutes ?? 2880));
  }, [wallet?.autoReload, wallet?.fundingMethods]);

  async function saveAutoReload() {
    if (!await ensureWalletSensitiveProof()) return;

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
      setEmailCodeSent(false);
      setVerificationCode("");
      setMessage("Auto-reload settings saved.");
    });
  }

  async function startStripeFundingSetup(rail: DropshipStripeFundingRail) {
    if (!await ensureWalletSensitiveProof()) return;

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

  async function ensureWalletSensitiveProof(): Promise<boolean> {
    if (activeProof) return true;
    if (principal?.hasPasskey) {
      return runWalletAction("passkey-proof", async () => {
        await verifyPasskeyStepUp("add_funding_method");
      });
    }
    if (!emailCodeSent) {
      await runWalletAction("send-code", async () => {
        await startEmailStepUp("add_funding_method");
        setEmailCodeSent(true);
        setMessage("Verification code sent. Enter it below, then retry the wallet action.");
      });
      return false;
    }
    return runWalletAction("verify-code", async () => {
      await verifyEmailStepUp({
        action: "add_funding_method",
        verificationCode,
      });
    });
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

            <AutoReloadPanel
              activeFundingMethods={activeFundingMethods}
              autoReloadEnabled={autoReloadEnabled}
              emailCodeSent={emailCodeSent}
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
              onVerificationCodeChange={setVerificationCode}
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
                      disabled={pendingWalletAction !== null || (emailCodeSent && verificationCode.length !== 6)}
                      onClick={() => startStripeFundingSetup("stripe_card")}
                    >
                      <CreditCard className="h-4 w-4" />
                      {pendingWalletAction === "stripe-card" ? "Starting card" : "Add card"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2"
                      disabled={pendingWalletAction !== null || (emailCodeSent && verificationCode.length !== 6)}
                      onClick={() => startStripeFundingSetup("stripe_ach")}
                    >
                      <Landmark className="h-4 w-4" />
                      {pendingWalletAction === "stripe-ach" ? "Starting ACH" : "Add ACH"}
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
                            <div className="text-sm text-zinc-500">{formatStatus(method.rail)}</div>
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
        ) : null}
      </div>
    </DropshipPortalShell>
  );
}

function AutoReloadPanel({
  activeFundingMethods,
  autoReloadEnabled,
  emailCodeSent,
  fundingMethodId,
  maxSingleReload,
  minimumBalance,
  onAutoReloadEnabledChange,
  onFundingMethodIdChange,
  onMaxSingleReloadChange,
  onMinimumBalanceChange,
  onPaymentHoldTimeoutMinutesChange,
  onSave,
  onVerificationCodeChange,
  paymentHoldTimeoutMinutes,
  pendingWalletAction,
  verificationCode,
}: {
  activeFundingMethods: DropshipWalletResponse["wallet"]["fundingMethods"];
  autoReloadEnabled: boolean;
  emailCodeSent: boolean;
  fundingMethodId: string;
  maxSingleReload: string;
  minimumBalance: string;
  onAutoReloadEnabledChange: (value: boolean) => void;
  onFundingMethodIdChange: (value: string) => void;
  onMaxSingleReloadChange: (value: string) => void;
  onMinimumBalanceChange: (value: string) => void;
  onPaymentHoldTimeoutMinutesChange: (value: string) => void;
  onSave: () => void;
  onVerificationCodeChange: (value: string) => void;
  paymentHoldTimeoutMinutes: string;
  pendingWalletAction: PendingWalletAction;
  verificationCode: string;
}) {
  const saveDisabled = pendingWalletAction !== null
    || (autoReloadEnabled && activeFundingMethods.length === 0)
    || (emailCodeSent && verificationCode.length !== 6);

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
          No active V2 funding method is available yet. Stripe ACH/card and USDC funding method onboarding is the next funding-rail slice.
        </div>
      )}

      {emailCodeSent && (
        <div className="mt-4 max-w-sm space-y-2">
          <Label>Verification code</Label>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={onVerificationCodeChange}
            containerClassName="justify-between"
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}

      <Button
        type="button"
        className="mt-4 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
        disabled={saveDisabled}
        onClick={onSave}
      >
        {walletButtonIcon(pendingWalletAction, emailCodeSent)}
        {walletButtonLabel(pendingWalletAction, emailCodeSent)}
      </Button>
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

function walletButtonLabel(pendingWalletAction: PendingWalletAction, emailCodeSent: boolean): string {
  if (pendingWalletAction === "send-code") return "Sending code";
  if (pendingWalletAction === "verify-code") return "Verifying code";
  if (pendingWalletAction === "passkey-proof") return "Waiting for passkey";
  if (pendingWalletAction === "stripe-card") return "Starting card setup";
  if (pendingWalletAction === "stripe-ach") return "Starting ACH setup";
  if (pendingWalletAction === "save") return "Saving";
  if (emailCodeSent) return "Verify and save";
  return "Save auto-reload";
}

function walletButtonIcon(pendingWalletAction: PendingWalletAction, emailCodeSent: boolean) {
  if (pendingWalletAction === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (pendingWalletAction === "stripe-ach") return <Landmark className="h-4 w-4" />;
  if (pendingWalletAction === "stripe-card") return <CreditCard className="h-4 w-4" />;
  if (pendingWalletAction === "send-code" || (emailCodeSent && pendingWalletAction !== "save")) return <Mail className="h-4 w-4" />;
  return <Save className="h-4 w-4" />;
}

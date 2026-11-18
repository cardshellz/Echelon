import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  buildAdminDogfoodReadinessUrl,
  buildAdminWalletConfirmedUsdcCreditInput,
  buildAdminWalletManualCreditInput,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatStatus,
  postJson,
  queryErrorMessage,
  type DropshipAdminWalletConfirmedUsdcCreditResponse,
  type DropshipAdminWalletManualCreditResponse,
  type DropshipDogfoodReadinessResponse,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";
import {
  buildVendorSelectOptions,
  NO_DEFAULT_WAREHOUSE_VALUE,
  SearchableOptionPicker,
  truncateMiddle,
} from "./dropship-admin-shared";

function WalletOpsTab() {
  const queryClient = useQueryClient();
  const [vendorId, setVendorId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [usdcVendorId, setUsdcVendorId] = useState("");
  const [usdcFundingMethodId, setUsdcFundingMethodId] = useState("");
  const [usdcDollarAmount, setUsdcDollarAmount] = useState("");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [usdcTransactionHash, setUsdcTransactionHash] = useState("");
  const [usdcFromAddress, setUsdcFromAddress] = useState("");
  const [usdcToAddress, setUsdcToAddress] = useState("");
  const [usdcConfirmations, setUsdcConfirmations] = useState("12");
  const [manualCreditIdempotencyKey, setManualCreditIdempotencyKey] = useState(
    () => createDropshipIdempotencyKey("admin-wallet-credit"),
  );
  const [usdcCreditIdempotencyKey, setUsdcCreditIdempotencyKey] = useState(() =>
    createDropshipIdempotencyKey("admin-usdc-credit"),
  );
  const [pendingAction, setPendingAction] = useState<"manual" | "usdc" | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pending = pendingAction !== null;
  const walletVendorOptionsUrl = useMemo(
    () =>
      buildAdminDogfoodReadinessUrl({
        search: "",
        status: "all",
        platform: "all",
        limit: 100,
      }),
    [],
  );
  const walletVendorOptionsQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [walletVendorOptionsUrl, "wallet-vendors"],
    queryFn: () =>
      fetchJson<DropshipDogfoodReadinessResponse>(walletVendorOptionsUrl),
  });
  const selectedUsdcVendorId = usdcVendorId.trim();
  const usdcWalletQuery = useQuery<DropshipWalletResponse>({
    queryKey: ["/api/dropship/admin/wallet/vendors", selectedUsdcVendorId],
    queryFn: () =>
      fetchJson<DropshipWalletResponse>(
        `/api/dropship/admin/wallet/vendors/${selectedUsdcVendorId}`,
      ),
    enabled: /^[1-9]\d*$/.test(selectedUsdcVendorId),
  });
  const vendorSelectOptions = useMemo(
    () => buildVendorSelectOptions(walletVendorOptionsQuery.data?.items ?? []),
    [walletVendorOptionsQuery.data?.items],
  );
  const usdcFundingMethodOptions = useMemo(
    () =>
      (usdcWalletQuery.data?.wallet.fundingMethods ?? [])
        .filter((method) => method.rail === "usdc_base")
        .sort((first, second) => {
          if (first.isDefault !== second.isDefault)
            return Number(second.isDefault) - Number(first.isDefault);
          if (first.status !== second.status)
            return first.status.localeCompare(second.status);
          return first.fundingMethodId - second.fundingMethodId;
        })
        .map((method) => ({
          value: String(method.fundingMethodId),
          label: method.displayLabel || formatStatus(method.rail),
          detail: [
            `ID ${method.fundingMethodId}`,
            formatStatus(method.status),
            method.isDefault ? "default" : "",
            method.usdcWalletAddress
              ? truncateMiddle(method.usdcWalletAddress, 16)
              : "",
          ]
            .filter(Boolean)
            .join(" / "),
        })),
    [usdcWalletQuery.data?.wallet.fundingMethods],
  );

  function resetManualCreditIdempotencyKey() {
    setManualCreditIdempotencyKey(
      createDropshipIdempotencyKey("admin-wallet-credit"),
    );
  }

  function resetUsdcCreditIdempotencyKey() {
    setUsdcCreditIdempotencyKey(
      createDropshipIdempotencyKey("admin-usdc-credit"),
    );
  }

  async function creditWallet() {
    setPendingAction("manual");
    setError("");
    setMessage("");
    try {
      const input = buildAdminWalletManualCreditInput({
        vendorId,
        amount,
        reason,
        idempotencyKey: manualCreditIdempotencyKey,
      });
      const response = await postJson<DropshipAdminWalletManualCreditResponse>(
        "/api/dropship/admin/wallet/manual-credit",
        input,
      );
      setMessage(
        response.idempotentReplay
          ? `Vendor ${response.account.vendorId} wallet credit already recorded for ${formatCents(response.ledgerEntry.amountCents)}.`
          : `Vendor ${response.account.vendorId} wallet credited ${formatCents(response.ledgerEntry.amountCents)}.`,
      );
      setAmount("");
      setReason("");
      resetManualCreditIdempotencyKey();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Manual wallet credit failed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function creditConfirmedUsdc() {
    setPendingAction("usdc");
    setError("");
    setMessage("");
    try {
      const input = buildAdminWalletConfirmedUsdcCreditInput({
        vendorId: usdcVendorId,
        fundingMethodId: usdcFundingMethodId,
        amount: usdcDollarAmount,
        usdcAmount,
        transactionHash: usdcTransactionHash,
        fromAddress: usdcFromAddress,
        toAddress: usdcToAddress,
        confirmations: usdcConfirmations,
        idempotencyKey: usdcCreditIdempotencyKey,
      });
      const response =
        await postJson<DropshipAdminWalletConfirmedUsdcCreditResponse>(
          "/api/dropship/admin/wallet/usdc/confirmed-credit",
          input,
        );
      setMessage(
        response.idempotentReplay
          ? `Vendor ${response.account.vendorId} USDC transfer already credited for ${formatCents(response.ledgerEntry.amountCents)}.`
          : `Vendor ${response.account.vendorId} USDC transfer credited ${formatCents(response.ledgerEntry.amountCents)}.`,
      );
      setUsdcDollarAmount("");
      setUsdcAmount("");
      setUsdcTransactionHash("");
      setUsdcFromAddress("");
      setUsdcToAddress("");
      setUsdcConfirmations("12");
      resetUsdcCreditIdempotencyKey();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "USDC wallet credit failed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-5">
      {(walletVendorOptionsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                walletVendorOptionsQuery.error,
                "Unable to load dropship vendors.",
              )}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Manual wallet credit</h2>
            <p className="text-sm text-muted-foreground">
              Admin-only settled funding credit for dogfood and operational
              correction.
            </p>
          </div>
          <Wallet className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[0.45fr_0.45fr_1.1fr_auto] lg:items-end">
          <SearchableOptionPicker
            label="Vendor"
            value={vendorId}
            onChange={(value) => {
              setVendorId(value);
              resetManualCreditIdempotencyKey();
            }}
            options={vendorSelectOptions}
            isLoading={
              walletVendorOptionsQuery.isLoading ||
              walletVendorOptionsQuery.isFetching
            }
            placeholder="Select vendor"
            searchPlaceholder="Search vendor, email, or member..."
            emptyText="No dropship vendors found."
          />
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-wallet-credit-amount"
            >
              Amount
            </label>
            <Input
              id="dropship-wallet-credit-amount"
              className="mt-2"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                resetManualCreditIdempotencyKey();
              }}
              inputMode="decimal"
              placeholder="250.00"
            />
          </div>
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-wallet-credit-reason"
            >
              Reason
            </label>
            <Textarea
              id="dropship-wallet-credit-reason"
              className="mt-2 min-h-10"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                resetManualCreditIdempotencyKey();
              }}
              maxLength={1000}
              placeholder="Dogfood wallet seed"
            />
          </div>
          <Button
            className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={pending}
            onClick={creditWallet}
          >
            <Wallet
              className={
                pendingAction === "manual" ? "h-4 w-4 animate-pulse" : "h-4 w-4"
              }
            />
            Credit
          </Button>
        </div>
      </section>

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Confirmed USDC transfer</h2>
            <p className="text-sm text-muted-foreground">
              Optional admin-assisted rail. Independently verify the Base
              transfer before recording it; this flow does not query Base.
              Wallet and USDC ledgers are recorded atomically.
            </p>
          </div>
          <CircleDollarSign className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-4">
          <SearchableOptionPicker
            label="Vendor"
            value={usdcVendorId}
            onChange={(value) => {
              setUsdcVendorId(value);
              setUsdcFundingMethodId("");
              resetUsdcCreditIdempotencyKey();
            }}
            options={vendorSelectOptions}
            isLoading={
              walletVendorOptionsQuery.isLoading ||
              walletVendorOptionsQuery.isFetching
            }
            placeholder="Select vendor"
            searchPlaceholder="Search vendor, email, or member..."
            emptyText="No dropship vendors found."
          />
          <div>
            <label className="text-sm font-medium">Funding method</label>
            <Select
              value={usdcFundingMethodId || NO_DEFAULT_WAREHOUSE_VALUE}
              onValueChange={(value) => {
                setUsdcFundingMethodId(
                  value === NO_DEFAULT_WAREHOUSE_VALUE ? "" : value,
                );
                resetUsdcCreditIdempotencyKey();
              }}
              disabled={
                !selectedUsdcVendorId ||
                usdcWalletQuery.isLoading ||
                usdcWalletQuery.isFetching
              }
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select funding method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEFAULT_WAREHOUSE_VALUE}>
                  No funding method
                </SelectItem>
                {usdcFundingMethodOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label} - {option.detail}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {usdcWalletQuery.error && (
              <p className="mt-1 text-xs text-rose-700">
                {queryErrorMessage(
                  usdcWalletQuery.error,
                  "Unable to load vendor wallet.",
                )}
              </p>
            )}
          </div>
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-usdc-dollar-amount"
            >
              Wallet credit
            </label>
            <Input
              id="dropship-usdc-dollar-amount"
              className="mt-2"
              value={usdcDollarAmount}
              onChange={(event) => {
                setUsdcDollarAmount(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              inputMode="decimal"
              placeholder="125.50"
            />
          </div>
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-usdc-amount"
            >
              USDC amount
            </label>
            <Input
              id="dropship-usdc-amount"
              className="mt-2"
              value={usdcAmount}
              onChange={(event) => {
                setUsdcAmount(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              inputMode="decimal"
              placeholder="125.50"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr_1fr_0.4fr]">
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-usdc-transaction"
            >
              Transaction hash
            </label>
            <Input
              id="dropship-usdc-transaction"
              className="mt-2 font-mono text-xs"
              value={usdcTransactionHash}
              onChange={(event) => {
                setUsdcTransactionHash(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              placeholder="0x..."
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-from">
              From address
            </label>
            <Input
              id="dropship-usdc-from"
              className="mt-2 font-mono text-xs"
              value={usdcFromAddress}
              onChange={(event) => {
                setUsdcFromAddress(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-to">
              To address
            </label>
            <Input
              id="dropship-usdc-to"
              className="mt-2 font-mono text-xs"
              value={usdcToAddress}
              onChange={(event) => {
                setUsdcToAddress(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              placeholder="0x..."
            />
          </div>
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-usdc-confirmations"
            >
              Confirmations
            </label>
            <Input
              id="dropship-usdc-confirmations"
              className="mt-2"
              value={usdcConfirmations}
              onChange={(event) => {
                setUsdcConfirmations(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              inputMode="numeric"
              placeholder="12"
            />
          </div>
        </div>

        <Button
          className="mt-4 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          disabled={pending}
          onClick={creditConfirmedUsdc}
        >
          <CircleDollarSign
            className={
              pendingAction === "usdc" ? "h-4 w-4 animate-pulse" : "h-4 w-4"
            }
          />
          Record verified transfer
        </Button>
      </section>
    </div>
  );
}

export {
  WalletOpsTab,
};
export default WalletOpsTab;

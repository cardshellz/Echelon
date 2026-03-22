import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Wallet,
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowDownCircle,
  ArrowUpCircle,
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useVendorAuth } from "@/lib/vendor-auth";
import {
  fetchVendorWallet,
  fetchVendorLedger,
  createWalletDeposit,
  updateAutoReload,
} from "@/lib/vendor-api";
import { useToast } from "@/hooks/use-toast";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function txIcon(type: string) {
  if (type.includes("deposit") || type.includes("credit") || type === "auto_reload") {
    return <ArrowDownCircle className="h-5 w-5 text-green-500" />;
  }
  if (type.includes("debit") || type === "order_debit" || type === "withdrawal") {
    return <ArrowUpCircle className="h-5 w-5 text-red-500" />;
  }
  return <RefreshCw className="h-5 w-5 text-blue-500" />;
}

function txLabel(type: string): string {
  switch (type) {
    case "deposit":
      return "Deposit";
    case "order_debit":
      return "Order Charge";
    case "refund_credit":
      return "Refund";
    case "return_credit":
      return "Return Credit";
    case "auto_reload":
      return "Auto-Reload";
    case "adjustment":
      return "Adjustment";
    case "withdrawal":
      return "Withdrawal";
    default:
      return type;
  }
}

const DEPOSIT_PRESETS = [2500, 5000, 10000, 25000, 50000]; // in cents

export default function VendorWallet() {
  const { vendor, refetch: refetchAuth } = useVendorAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [ledgerPage, setLedgerPage] = useState(1);
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [autoReloadEnabled, setAutoReloadEnabled] = useState(vendor?.auto_reload_enabled ?? false);
  const [autoReloadThreshold, setAutoReloadThreshold] = useState(
    String((vendor?.auto_reload_threshold_cents ?? 5000) / 100)
  );
  const [autoReloadAmount, setAutoReloadAmount] = useState(
    String((vendor?.auto_reload_amount_cents ?? 20000) / 100)
  );

  // Check URL for deposit success
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("deposit") === "success") {
      toast({ title: "Deposit successful", description: "Your wallet balance will update shortly." });
      refetchAuth();
      queryClient.invalidateQueries({ queryKey: ["vendor-wallet"] });
      queryClient.invalidateQueries({ queryKey: ["vendor-ledger"] });
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const { data: walletData, isLoading: walletLoading } = useQuery({
    queryKey: ["vendor-wallet"],
    queryFn: fetchVendorWallet,
    staleTime: 15_000,
  });

  const { data: ledgerData, isLoading: ledgerLoading } = useQuery({
    queryKey: ["vendor-ledger", ledgerPage],
    queryFn: () => fetchVendorLedger({ page: ledgerPage, limit: 20 }),
    staleTime: 15_000,
  });

  const depositMutation = useMutation({
    mutationFn: (amountCents: number) => createWalletDeposit(amountCents),
    onSuccess: (data) => {
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
    onError: (err: Error) => {
      toast({ title: "Deposit failed", description: err.message, variant: "destructive" });
    },
  });

  const autoReloadMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; threshold_cents?: number; amount_cents?: number }) =>
      updateAutoReload(body),
    onSuccess: () => {
      toast({ title: "Auto-reload settings saved" });
      refetchAuth();
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const balance = vendor?.wallet_balance_cents ?? 0;
  const transactions = ledgerData?.transactions ?? [];
  const ledgerPagination = ledgerData?.pagination ?? { page: 1, total: 0, total_pages: 1 };

  const handleDeposit = () => {
    const dollars = parseFloat(depositAmount);
    if (isNaN(dollars) || dollars < 10) {
      toast({ title: "Minimum deposit is $10.00", variant: "destructive" });
      return;
    }
    if (dollars > 5000) {
      toast({ title: "Maximum deposit is $5,000.00", variant: "destructive" });
      return;
    }
    depositMutation.mutate(Math.round(dollars * 100));
  };

  const handleAutoReloadSave = () => {
    const thresholdCents = Math.round(parseFloat(autoReloadThreshold) * 100);
    const amountCents = Math.round(parseFloat(autoReloadAmount) * 100);
    if (isNaN(thresholdCents) || isNaN(amountCents)) return;
    autoReloadMutation.mutate({
      enabled: autoReloadEnabled,
      threshold_cents: thresholdCents,
      amount_cents: Math.max(amountCents, 1000),
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Wallet</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage your wallet balance and deposits
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Balance Card */}
        <Card className="lg:col-span-1">
          <CardContent className="p-6 flex flex-col items-center text-center space-y-4">
            <div className="h-16 w-16 rounded-full bg-green-600/10 flex items-center justify-center">
              <Wallet className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Current Balance</p>
              <p className="text-4xl font-bold text-green-600 dark:text-green-400">
                {formatCents(balance)}
              </p>
            </div>
            <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
              <DialogTrigger asChild>
                <Button className="w-full bg-red-600 hover:bg-red-700 min-h-[44px]">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Funds
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Funds to Wallet</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="grid grid-cols-3 gap-2">
                    {DEPOSIT_PRESETS.map((cents) => (
                      <Button
                        key={cents}
                        variant={
                          depositAmount === String(cents / 100) ? "default" : "outline"
                        }
                        className="min-h-[44px]"
                        onClick={() => setDepositAmount(String(cents / 100))}
                      >
                        {formatCents(cents)}
                      </Button>
                    ))}
                  </div>
                  <div>
                    <label className="text-sm text-muted-foreground">
                      Custom amount ($10 - $5,000)
                    </label>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        $
                      </span>
                      <Input
                        type="number"
                        className="pl-7 min-h-[44px]"
                        placeholder="100.00"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        min={10}
                        max={5000}
                        step={0.01}
                      />
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    className="min-h-[44px]"
                    onClick={() => setDepositOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="bg-red-600 hover:bg-red-700 min-h-[44px]"
                    disabled={depositMutation.isPending || !depositAmount}
                    onClick={handleDeposit}
                  >
                    {depositMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Continue to Payment
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>

        {/* Auto-Reload Settings */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Auto-Reload Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between min-h-[44px]">
              <div>
                <p className="text-sm font-medium">Enable Auto-Reload</p>
                <p className="text-xs text-muted-foreground">
                  Automatically add funds when balance drops below threshold
                </p>
              </div>
              <input
                type="checkbox"
                checked={autoReloadEnabled}
                onChange={(e) => setAutoReloadEnabled(e.target.checked)}
                className="h-5 w-5 rounded border-input accent-red-600"
              />
            </div>

            {autoReloadEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm text-muted-foreground">
                    Threshold (reload when below)
                  </label>
                  <div className="relative mt-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      $
                    </span>
                    <Input
                      type="number"
                      className="pl-7 min-h-[44px]"
                      value={autoReloadThreshold}
                      onChange={(e) => setAutoReloadThreshold(e.target.value)}
                      min={0}
                      step={1}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">
                    Reload Amount (min $10)
                  </label>
                  <div className="relative mt-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      $
                    </span>
                    <Input
                      type="number"
                      className="pl-7 min-h-[44px]"
                      value={autoReloadAmount}
                      onChange={(e) => setAutoReloadAmount(e.target.value)}
                      min={10}
                      step={1}
                    />
                  </div>
                </div>
              </div>
            )}

            <Button
              variant="outline"
              className="min-h-[44px]"
              disabled={autoReloadMutation.isPending}
              onClick={handleAutoReloadSave}
            >
              {autoReloadMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Save Settings
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Transaction Ledger */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          {ledgerLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : transactions.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Wallet className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No transactions yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {transactions.map((tx: any) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {txIcon(tx.type)}
                    <div>
                      <p className="text-sm font-medium">{txLabel(tx.type)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(tx.created_at)}
                        {tx.notes && ` · ${tx.notes}`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-sm font-semibold ${
                        tx.amount_cents >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {tx.amount_cents >= 0 ? "+" : ""}
                      {formatCents(tx.amount_cents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      bal: {formatCents(tx.balance_after_cents)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Ledger Pagination */}
          {ledgerPagination.total_pages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-sm text-muted-foreground">
                Page {ledgerPagination.page} of {ledgerPagination.total_pages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-[44px]"
                  disabled={ledgerPage <= 1}
                  onClick={() => setLedgerPage(ledgerPage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-[44px]"
                  disabled={ledgerPage >= ledgerPagination.total_pages}
                  onClick={() => setLedgerPage(ledgerPage + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

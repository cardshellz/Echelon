import { useQuery } from "@tanstack/react-query";
import { CreditCard, History, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
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
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

export default function DropshipPortalWallet() {
  const walletQuery = useQuery<DropshipWalletResponse>({
    queryKey: ["/api/dropship/wallet?limit=50"],
    queryFn: () => fetchJson<DropshipWalletResponse>("/api/dropship/wallet?limit=50"),
  });
  const wallet = walletQuery.data?.wallet;

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

            <section className="mt-5 grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
              <div className="rounded-md border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Funding methods</h2>
                    <p className="text-sm text-zinc-500">Configured rails</p>
                  </div>
                  <CreditCard className="h-5 w-5 text-zinc-400" />
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

function Metric({ detail, title, value }: { detail?: string; title: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {detail && <div className="mt-1 text-sm text-zinc-500">{detail}</div>}
    </div>
  );
}

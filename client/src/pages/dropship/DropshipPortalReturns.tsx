import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Eye, History, Package, ReceiptText, RotateCcw, Search, Truck, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  allDropshipRmaStatuses,
  buildQueryUrl,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  queryErrorMessage,
  type DropshipReturnDetail,
  type DropshipReturnDetailResponse,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

const statuses = ["all", ...allDropshipRmaStatuses];

export default function DropshipPortalReturns() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [applied, setApplied] = useState({ search: "", status: "all" });
  const [selectedRmaId, setSelectedRmaId] = useState<number | null>(null);
  const returnsUrl = useMemo(() => buildQueryUrl("/api/dropship/returns", {
    search: applied.search,
    statuses: applied.status === "all" ? undefined : applied.status,
    page: 1,
    limit: 50,
  }), [applied]);
  const returnsQuery = useQuery<DropshipReturnListResponse>({
    queryKey: [returnsUrl],
    queryFn: () => fetchJson<DropshipReturnListResponse>(returnsUrl),
  });
  const returnDetailQuery = useQuery<DropshipReturnDetailResponse>({
    queryKey: ["dropship-return-detail", selectedRmaId],
    queryFn: () => {
      if (selectedRmaId === null) throw new Error("Missing selected RMA.");
      return fetchJson<DropshipReturnDetailResponse>(`/api/dropship/returns/${selectedRmaId}`);
    },
    enabled: selectedRmaId !== null,
  });

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <RotateCcw className="h-6 w-6 text-[#C060E0]" />
              Returns
            </h1>
            <p className="mt-1 text-sm text-zinc-500">RMA status, inspection progress, and final credit outcomes.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search RMAs" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((option) => (
                  <SelectItem key={option} value={option}>{option === "all" ? "All statuses" : formatStatus(option)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, status })}>
              Apply
            </Button>
          </div>
        </div>

        {returnsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(returnsQuery.error, "Unable to load dropship returns.")}
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {returnsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : returnsQuery.error ? (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Returns unavailable</EmptyTitle>
                <EmptyDescription>The returns API request failed.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : returnsQuery.data?.items.length ? (
            <ReturnsTable
              returns={returnsQuery.data.items}
              total={returnsQuery.data.total}
              onView={(rma) => setSelectedRmaId(rma.rmaId)}
            />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><RotateCcw /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No returns</EmptyTitle>
                <EmptyDescription>No dropship RMAs match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <ReturnDetailSheet
          error={returnDetailQuery.error}
          isLoading={returnDetailQuery.isLoading}
          open={selectedRmaId !== null}
          rma={returnDetailQuery.data?.rma ?? null}
          onOpenChange={(open) => {
            if (!open) setSelectedRmaId(null);
          }}
        />
      </div>
    </DropshipPortalShell>
  );
}

function ReturnDetailSheet({
  error,
  isLoading,
  onOpenChange,
  open,
  rma,
}: {
  error: unknown;
  isLoading: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  rma: DropshipReturnDetail | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{rma ? rma.rmaNumber : "Return details"}</SheetTitle>
          <SheetDescription>
            {rma ? `${formatStatus(rma.status)} RMA ${rma.rmaId}` : "Dropship return detail"}
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : error ? (
          <Alert variant="destructive" className="mt-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{queryErrorMessage(error, "Unable to load return detail.")}</AlertDescription>
          </Alert>
        ) : rma ? (
          <div className="mt-6 space-y-6">
            <section className="grid gap-3 text-sm sm:grid-cols-2">
              <DetailField label="Status" value={formatStatus(rma.status)} />
              <DetailField label="Fault" value={rma.faultCategory ? formatStatus(rma.faultCategory) : "Pending"} />
              <DetailField label="Reason" value={rma.reasonCode ? formatStatus(rma.reasonCode) : "Not recorded"} />
              <DetailField label="Return window" value={`${rma.returnWindowDays} days`} />
              <DetailField label="Platform" value={rma.platform ? formatStatus(rma.platform) : "Not recorded"} />
              <DetailField label="Label source" value={rma.labelSource ? formatStatus(rma.labelSource) : "Not recorded"} />
              <DetailField label="Intake" value={rma.intakeId ? String(rma.intakeId) : "Not linked"} />
              <DetailField label="OMS order" value={rma.omsOrderId ? String(rma.omsOrderId) : "Not linked"} />
              <DetailField label="Requested" value={formatDateTime(rma.requestedAt)} />
              <DetailField label="Received" value={formatDateTime(rma.receivedAt)} />
              <DetailField label="Inspected" value={formatDateTime(rma.inspectedAt)} />
              <DetailField label="Credited" value={formatDateTime(rma.creditedAt)} />
            </section>

            {rma.vendorNotes && (
              <>
                <Separator />
                <ReturnDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Vendor Notes">
                  <p className="whitespace-pre-wrap text-sm text-zinc-700">{rma.vendorNotes}</p>
                </ReturnDetailSection>
              </>
            )}

            <Separator />

            <ReturnDetailSection icon={<Package className="h-4 w-4" />} title="Items">
              {rma.items.length ? (
                <div className="rounded-md border border-zinc-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Requested</TableHead>
                        <TableHead className="text-right">Final</TableHead>
                        <TableHead className="text-right">Fee</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rma.items.map((item) => (
                        <TableRow key={item.rmaItemId}>
                          <TableCell>
                            <div className="font-medium">RMA item {item.rmaItemId}</div>
                            <div className="text-xs text-zinc-500">
                              {item.productVariantId ? `Variant ${item.productVariantId}` : "Variant not linked"}
                            </div>
                          </TableCell>
                          <TableCell><Badge variant="outline" className={statusTone(item.status)}>{formatStatus(item.status)}</Badge></TableCell>
                          <TableCell className="text-right font-mono">{item.quantity}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(item.requestedCreditCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(item.finalCreditCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(item.feeCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No return items recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<Truck className="h-4 w-4" />} title="Return Tracking">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <DetailField label="Tracking number" value={rma.returnTrackingNumber || "None"} />
                <DetailField label="Updated" value={formatDateTime(rma.updatedAt)} />
              </div>
            </ReturnDetailSection>

            <ReturnDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Inspections">
              {rma.inspections.length ? (
                <div className="space-y-3">
                  {rma.inspections.map((inspection) => (
                    <div key={inspection.rmaInspectionId} className="rounded-md border border-zinc-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">Inspection {inspection.rmaInspectionId}</span>
                          <Badge variant="outline" className={statusTone(inspection.outcome)}>{formatStatus(inspection.outcome)}</Badge>
                        </div>
                        <span className="text-xs text-zinc-500">{formatDateTime(inspection.createdAt)}</span>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                        <DetailField label="Fault" value={inspection.faultCategory ? formatStatus(inspection.faultCategory) : "Not recorded"} />
                        <DetailField label="Inspected by" value={inspection.inspectedBy || "Not recorded"} />
                        <DetailField label="Credit" value={formatCents(inspection.creditCents)} />
                        <DetailField label="Fee" value={formatCents(inspection.feeCents)} />
                        <DetailField label="Photos" value={String(inspection.photos.length)} />
                      </div>
                      {inspection.notes && (
                        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700">{inspection.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No inspections recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<Wallet className="h-4 w-4" />} title="Wallet Ledger">
              {rma.walletLedger.length ? (
                <div className="rounded-md border border-zinc-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Entry</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Balance After</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rma.walletLedger.map((entry) => (
                        <TableRow key={entry.ledgerEntryId}>
                          <TableCell>
                            <div className="font-medium">{formatStatus(entry.type)}</div>
                            <div className="text-xs text-zinc-500">Ledger {entry.ledgerEntryId}</div>
                            <div className="text-xs text-zinc-500">{formatDateTime(entry.createdAt)}</div>
                          </TableCell>
                          <TableCell><Badge variant="outline" className={statusTone(entry.status)}>{formatStatus(entry.status)}</Badge></TableCell>
                          <TableCell className="text-right">{formatCents(entry.amountCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(entry.availableBalanceAfterCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No wallet return adjustments recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<History className="h-4 w-4" />} title="Audit References">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <DetailField label="Idempotency key" value={rma.idempotencyKey || "Not recorded"} />
                <DetailField label="Request hash" value={rma.requestHash || "Not recorded"} />
              </div>
            </ReturnDetailSection>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ReturnsTable({
  onView,
  returns,
  total,
}: {
  onView: (rma: DropshipReturnListItem) => void;
  returns: DropshipReturnListItem[];
  total: number;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500">
        <span>{total} return{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>RMA</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fault</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {returns.map((rma) => (
            <TableRow key={rma.rmaId}>
              <TableCell>
                <div className="font-medium">{rma.rmaNumber}</div>
                <div className="text-xs text-zinc-500">{rma.reasonCode ? formatStatus(rma.reasonCode) : "No reason"}</div>
              </TableCell>
              <TableCell><Badge variant="outline">{formatStatus(rma.status)}</Badge></TableCell>
              <TableCell>{rma.faultCategory ? formatStatus(rma.faultCategory) : "Pending"}</TableCell>
              <TableCell className="font-mono">{rma.itemCount} / {rma.totalQuantity}</TableCell>
              <TableCell className="font-mono text-xs">{rma.returnTrackingNumber || "None"}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(rma.updatedAt)}</TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 gap-2"
                  onClick={() => onView(rma)}
                >
                  <Eye className="h-4 w-4" />
                  Details
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function ReturnDetailSection({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="mt-1 break-words text-zinc-900">{value}</div>
    </div>
  );
}

function formatNullableCents(value: number | null | undefined): string {
  return typeof value === "number" ? formatCents(value) : "Not recorded";
}

function statusTone(status: string): string {
  if (
    status === "approved"
    || status === "credited"
    || status === "closed"
    || status === "settled"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "requested"
    || status === "in_transit"
    || status === "received"
    || status === "inspecting"
    || status === "pending"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "rejected" || status === "failed" || status === "voided") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

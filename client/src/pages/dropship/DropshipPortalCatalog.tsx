import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Fingerprint,
  Mail,
  MinusCircle,
  PlusCircle,
  Search,
  Send,
} from "lucide-react";
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
  buildListingPreviewRequest,
  buildListingPushRequest,
  buildVariantSelectionReplacement,
  buildQueryUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatStatus,
  formatCents,
  listingPreviewPushableCount,
  postJson,
  putJson,
  queryErrorMessage,
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
  type DropshipListingPreviewResponse,
  type DropshipListingPreviewResult,
  type DropshipListingPushResponse,
  type DropshipSelectionRulesReplaceResponse,
  type DropshipSelectionRulesResponse,
  type DropshipSettingsResponse,
  type DropshipVendorSelectionAction,
} from "@/lib/dropship-ops-surface";
import { useDropshipAuth } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingSelectionAction = string | null;
type PendingListingAction = "preview" | "send-code" | "verify-code" | "passkey-proof" | "push" | null;

export default function DropshipPortalCatalog() {
  const queryClient = useQueryClient();
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState("false");
  const [applied, setApplied] = useState({ search: "", selectedOnly: "false" });
  const [pendingSelectionAction, setPendingSelectionAction] = useState<PendingSelectionAction>(null);
  const [pendingListingAction, setPendingListingAction] = useState<PendingListingAction>(null);
  const [selectedStoreConnectionId, setSelectedStoreConnectionId] = useState("");
  const [listingPreview, setListingPreview] = useState<DropshipListingPreviewResult | null>(null);
  const [listingPushResult, setListingPushResult] = useState<DropshipListingPushResponse | null>(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const catalogUrl = useMemo(() => buildQueryUrl("/api/dropship/catalog", {
    search: applied.search,
    selectedOnly: applied.selectedOnly,
    page: 1,
    limit: 50,
  }), [applied]);
  const catalogQuery = useQuery<DropshipCatalogResponse>({
    queryKey: [catalogUrl],
    queryFn: () => fetchJson<DropshipCatalogResponse>(catalogUrl),
  });
  const selectionRulesQuery = useQuery<DropshipSelectionRulesResponse>({
    queryKey: ["/api/dropship/catalog/selection-rules"],
    queryFn: () => fetchJson<DropshipSelectionRulesResponse>("/api/dropship/catalog/selection-rules"),
  });
  const settingsQuery = useQuery<DropshipSettingsResponse>({
    queryKey: ["/api/dropship/settings"],
    queryFn: () => fetchJson<DropshipSettingsResponse>("/api/dropship/settings"),
  });
  const visibleRows = catalogQuery.data?.rows ?? [];
  const visibleSelectableRows = visibleRows.filter(canSelectRow);
  const visibleSelectedRows = visibleRows.filter((row) => row.selectionDecision.selected);
  const connectedStoreConnections = (settingsQuery.data?.settings.storeConnections ?? [])
    .filter((connection) => connection.status === "connected");
  const selectedStoreConnectionIdNumber = Number(selectedStoreConnectionId);
  const activeBulkPushProof = useMemo(() => {
    const proof = sensitiveProofs.bulk_listing_push;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  }, [sensitiveProofs.bulk_listing_push]);
  const pushablePreviewCount = listingPreviewPushableCount(listingPreview);

  useEffect(() => {
    if (selectedStoreConnectionId || connectedStoreConnections.length === 0) {
      return;
    }
    setSelectedStoreConnectionId(String(connectedStoreConnections[0].storeConnectionId));
  }, [connectedStoreConnections, selectedStoreConnectionId]);

  async function replaceSelection(action: DropshipVendorSelectionAction, rows: readonly DropshipCatalogRow[], actionKey: string) {
    if (!selectionRulesQuery.data) {
      setError("Selection rules are still loading.");
      return;
    }
    if (rows.length === 0) {
      return;
    }

    setPendingSelectionAction(actionKey);
    setError("");
    setMessage("");
    try {
      await putJson<DropshipSelectionRulesReplaceResponse>("/api/dropship/catalog/selection-rules", {
        idempotencyKey: createDropshipIdempotencyKey(`catalog-${action}`),
        rules: buildVariantSelectionReplacement({
          existingRules: selectionRulesQuery.data.rules,
          rows,
          action,
        }),
      });
      await Promise.all([
        catalogQuery.refetch(),
        selectionRulesQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
      ]);
      setMessage(action === "include" ? "Catalog selection added." : "Catalog selection removed.");
      setListingPreview(null);
      setListingPushResult(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Catalog selection update failed.");
    } finally {
      setPendingSelectionAction(null);
    }
  }

  async function previewListings() {
    setPendingListingAction("preview");
    setError("");
    setMessage("");
    setListingPreview(null);
    setListingPushResult(null);
    try {
      const request = buildListingPreviewRequest({
        storeConnectionId: selectedStoreConnectionIdNumber,
        rows: visibleSelectedRows,
      });
      if (request.productVariantIds.length === 0) {
        setError("Select at least one visible catalog row before previewing listings.");
        return;
      }
      const response = await postJson<DropshipListingPreviewResponse>("/api/dropship/listings/preview", request);
      setListingPreview(response.preview);
      setMessage("Listing preview generated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Listing preview failed.");
    } finally {
      setPendingListingAction(null);
    }
  }

  async function pushListings() {
    if (!listingPreview) {
      setError("Generate a listing preview before queueing a push.");
      return;
    }

    if (!activeBulkPushProof) {
      if (principal?.hasPasskey) {
        const verified = await runListingAction("passkey-proof", async () => {
          await verifyPasskeyStepUp("bulk_listing_push");
        });
        if (!verified) return;
      } else if (!emailCodeSent) {
        await runListingAction("send-code", async () => {
          await startEmailStepUp("bulk_listing_push");
          setEmailCodeSent(true);
          setMessage("Verification code sent.");
        });
        return;
      } else {
        const verified = await runListingAction("verify-code", async () => {
          await verifyEmailStepUp({
            action: "bulk_listing_push",
            verificationCode,
          });
        });
        if (!verified) return;
      }
    }

    await runListingAction("push", async () => {
      const request = buildListingPushRequest({
        storeConnectionId: selectedStoreConnectionIdNumber,
        preview: listingPreview,
        idempotencyKey: createDropshipIdempotencyKey("listing-push"),
      });
      if (request.productVariantIds.length === 0) {
        setError("No preview rows are ready to push.");
        return;
      }
      const response = await postJson<DropshipListingPushResponse>("/api/dropship/listing-push-jobs", request);
      setListingPushResult(response);
      setMessage(`Listing push job ${response.job.jobId} queued with ${response.items.length} item(s).`);
      await Promise.all([
        catalogQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
      ]);
    });
  }

  async function runListingAction(action: PendingListingAction, task: () => Promise<void>): Promise<boolean> {
    setPendingListingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Listing request failed.");
      return false;
    } finally {
      setPendingListingAction(null);
    }
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Boxes className="h-6 w-6 text-[#C060E0]" />
              Catalog
            </h1>
            <p className="mt-1 text-sm text-zinc-500">Exposed Card Shellz dropship products and your selection state.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search catalog" />
            </div>
            <Select value={selectedOnly} onValueChange={setSelectedOnly}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="false">All exposed</SelectItem>
                <SelectItem value="true">Selected only</SelectItem>
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, selectedOnly })}>
              Apply
            </Button>
          </div>
        </div>

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
        {selectionRulesQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(selectionRulesQuery.error, "Unable to load catalog selection rules.")}
            </AlertDescription>
          </Alert>
        )}
        {settingsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(settingsQuery.error, "Unable to load store connections.")}
            </AlertDescription>
          </Alert>
        )}
        {catalogQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(catalogQuery.error, "Unable to load dropship catalog.")}
            </AlertDescription>
          </Alert>
        )}

        <ListingPreviewPanel
          connectedStoreConnections={connectedStoreConnections}
          emailCodeSent={emailCodeSent}
          listingPreview={listingPreview}
          listingPushResult={listingPushResult}
          pendingListingAction={pendingListingAction}
          pushablePreviewCount={pushablePreviewCount}
          selectedRowCount={visibleSelectedRows.length}
          selectedStoreConnectionId={selectedStoreConnectionId}
          verificationCode={verificationCode}
          onPreview={previewListings}
          onPush={pushListings}
          onSelectedStoreConnectionIdChange={(value) => {
            setSelectedStoreConnectionId(value);
            setListingPreview(null);
            setListingPushResult(null);
          }}
          onVerificationCodeChange={setVerificationCode}
        />

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {catalogQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : catalogQuery.error ? (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Catalog unavailable</EmptyTitle>
                <EmptyDescription>The catalog API request failed.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : catalogQuery.data?.rows.length ? (
            <CatalogTable
              bulkSelectionDisabled={selectionRulesQuery.isLoading || pendingSelectionAction !== null}
              pendingSelectionAction={pendingSelectionAction}
              rows={catalogQuery.data.rows}
              selectableRowCount={visibleSelectableRows.length}
              selectedRowCount={visibleSelectedRows.length}
              total={catalogQuery.data.total}
              onBulkDeselect={() => replaceSelection("exclude", visibleSelectedRows, "bulk:exclude")}
              onBulkSelect={() => replaceSelection("include", visibleSelectableRows, "bulk:include")}
              onDeselectRow={(row) => replaceSelection("exclude", [row], `variant:${row.productVariantId}:exclude`)}
              onSelectRow={(row) => replaceSelection("include", [row], `variant:${row.productVariantId}:include`)}
            />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><Boxes /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No catalog rows</EmptyTitle>
                <EmptyDescription>No exposed catalog rows match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </DropshipPortalShell>
  );
}

function ListingPreviewPanel({
  connectedStoreConnections,
  emailCodeSent,
  listingPreview,
  listingPushResult,
  onPreview,
  onPush,
  onSelectedStoreConnectionIdChange,
  onVerificationCodeChange,
  pendingListingAction,
  pushablePreviewCount,
  selectedRowCount,
  selectedStoreConnectionId,
  verificationCode,
}: {
  connectedStoreConnections: DropshipSettingsResponse["settings"]["storeConnections"];
  emailCodeSent: boolean;
  listingPreview: DropshipListingPreviewResult | null;
  listingPushResult: DropshipListingPushResponse | null;
  onPreview: () => void;
  onPush: () => void;
  onSelectedStoreConnectionIdChange: (value: string) => void;
  onVerificationCodeChange: (value: string) => void;
  pendingListingAction: PendingListingAction;
  pushablePreviewCount: number;
  selectedRowCount: number;
  selectedStoreConnectionId: string;
  verificationCode: string;
}) {
  const previewDisabled = connectedStoreConnections.length === 0
    || !selectedStoreConnectionId
    || selectedRowCount === 0
    || pendingListingAction !== null;
  const pushDisabled = !listingPreview
    || pushablePreviewCount === 0
    || pendingListingAction !== null
    || (emailCodeSent && verificationCode.length !== 6);

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Listing preview and push</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Preview selected visible catalog rows before queueing a marketplace listing push.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={selectedStoreConnectionId}
            onValueChange={onSelectedStoreConnectionIdChange}
            disabled={connectedStoreConnections.length === 0}
          >
            <SelectTrigger className="h-10 sm:w-64">
              <SelectValue placeholder="Select connected store" />
            </SelectTrigger>
            <SelectContent>
              {connectedStoreConnections.map((connection) => (
                <SelectItem key={connection.storeConnectionId} value={String(connection.storeConnectionId)}>
                  {connection.externalDisplayName || connection.shopDomain || formatStatus(connection.platform)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="h-10 gap-2"
            disabled={previewDisabled}
            onClick={onPreview}
          >
            <Search className="h-4 w-4" />
            {pendingListingAction === "preview" ? "Previewing" : "Preview selected"}
          </Button>
          <Button
            type="button"
            className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={pushDisabled}
            onClick={onPush}
          >
            {pushButtonIcon(pendingListingAction, emailCodeSent)}
            {pushButtonLabel(pendingListingAction, emailCodeSent)}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <PreviewMetric label="Selected visible" value={String(selectedRowCount)} />
        <PreviewMetric label="Ready" value={String(listingPreview?.summary.ready ?? 0)} />
        <PreviewMetric label="Warnings" value={String(listingPreview?.summary.warning ?? 0)} />
        <PreviewMetric label="Blocked" value={String(listingPreview?.summary.blocked ?? 0)} />
      </div>

      {connectedStoreConnections.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          A connected store is required before listing preview or push.
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

      {listingPreview && (
        <div className="mt-4 overflow-hidden rounded-md border border-zinc-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Listing</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Blockers / Warnings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listingPreview.rows.map((row) => (
                <TableRow key={row.productVariantId}>
                  <TableCell>
                    <div className="font-medium">{row.title}</div>
                    <div className="text-xs text-zinc-500">{row.sku || `Variant ${row.productVariantId}`}</div>
                  </TableCell>
                  <TableCell>{formatStatus(row.listingMode || row.platform)}</TableCell>
                  <TableCell className="font-mono">{row.marketplaceQuantity}</TableCell>
                  <TableCell>{row.priceCents === null ? "Missing" : formatCents(row.priceCents)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={previewStatusTone(row.previewStatus)}>
                      {formatStatus(row.previewStatus)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <PreviewIssues blockers={row.blockers} warnings={row.warnings} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {listingPushResult && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          Push job {listingPushResult.job.jobId} is {formatStatus(listingPushResult.job.status)} with {listingPushResult.items.length} item(s).
        </div>
      )}
    </section>
  );
}

function CatalogTable({
  bulkSelectionDisabled,
  onBulkDeselect,
  onBulkSelect,
  onDeselectRow,
  onSelectRow,
  pendingSelectionAction,
  rows,
  selectableRowCount,
  selectedRowCount,
  total,
}: {
  bulkSelectionDisabled: boolean;
  onBulkDeselect: () => void;
  onBulkSelect: () => void;
  onDeselectRow: (row: DropshipCatalogRow) => void;
  onSelectRow: (row: DropshipCatalogRow) => void;
  pendingSelectionAction: PendingSelectionAction;
  rows: DropshipCatalogRow[];
  selectableRowCount: number;
  selectedRowCount: number;
  total: number;
}) {
  return (
    <>
      <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <span>{total} row{total === 1 ? "" : "s"}</span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            disabled={bulkSelectionDisabled || selectableRowCount === 0}
            onClick={onBulkSelect}
          >
            <PlusCircle className="h-4 w-4" />
            Select visible
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            disabled={bulkSelectionDisabled || selectedRowCount === 0}
            onClick={onBulkDeselect}
          >
            <MinusCircle className="h-4 w-4" />
            Remove visible
          </Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Variant</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Quantity</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.productVariantId}>
              <TableCell>
                <div className="font-medium">{row.productName}</div>
                <div className="text-xs text-zinc-500">{row.productSku || "No product SKU"}</div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{row.variantName}</div>
                <div className="text-xs text-zinc-500">{row.variantSku || `Variant ${row.productVariantId}`}</div>
              </TableCell>
              <TableCell>
                <div>{row.category ? formatStatus(row.category) : "Uncategorized"}</div>
                {row.productLineNames.length > 0 && (
                  <div className="text-xs text-zinc-500">{row.productLineNames.join(", ")}</div>
                )}
              </TableCell>
              <TableCell className="font-mono">{row.selectionDecision.marketplaceQuantity}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={row.selectionDecision.selected
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-zinc-200 bg-zinc-50 text-zinc-600"}
                >
                  {row.selectionDecision.selected ? "Selected" : formatStatus(row.selectionDecision.reason)}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {row.selectionDecision.selected ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 gap-2"
                    disabled={pendingSelectionAction !== null}
                    onClick={() => onDeselectRow(row)}
                  >
                    <MinusCircle className="h-4 w-4" />
                    Remove
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 gap-2"
                    disabled={pendingSelectionAction !== null || !canSelectRow(row)}
                    onClick={() => onSelectRow(row)}
                  >
                    <PlusCircle className="h-4 w-4" />
                    Select
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function PreviewIssues({ blockers, warnings }: { blockers: string[]; warnings: string[] }) {
  const issues = [
    ...blockers.map((issue) => ({ issue, tone: "border-rose-200 bg-rose-50 text-rose-800" })),
    ...warnings.map((issue) => ({ issue, tone: "border-amber-200 bg-amber-50 text-amber-900" })),
  ];

  if (issues.length === 0) {
    return <span className="text-sm text-zinc-500">None</span>;
  }

  return (
    <div className="flex max-w-xl flex-wrap gap-1.5">
      {issues.map((item) => (
        <Badge key={item.issue} variant="outline" className={item.tone}>
          {formatIssue(item.issue)}
        </Badge>
      ))}
    </div>
  );
}

function formatIssue(value: string): string {
  return value.split(":").map((part) => formatStatus(part)).join(": ");
}

function previewStatusTone(status: DropshipListingPreviewResult["rows"][number]["previewStatus"]): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function pushButtonLabel(pendingListingAction: PendingListingAction, emailCodeSent: boolean): string {
  if (pendingListingAction === "send-code") return "Sending code";
  if (pendingListingAction === "verify-code") return "Verifying code";
  if (pendingListingAction === "passkey-proof") return "Waiting for passkey";
  if (pendingListingAction === "push") return "Queueing push";
  if (emailCodeSent) return "Verify and queue push";
  return "Queue ready listings";
}

function pushButtonIcon(pendingListingAction: PendingListingAction, emailCodeSent: boolean) {
  if (pendingListingAction === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (pendingListingAction === "send-code" || (emailCodeSent && pendingListingAction !== "push")) return <Mail className="h-4 w-4" />;
  if (pendingListingAction === "push") return <Send className="h-4 w-4" />;
  return <ArrowRight className="h-4 w-4" />;
}

function canSelectRow(row: DropshipCatalogRow): boolean {
  return !row.selectionDecision.selected && row.selectionDecision.reason !== "not_exposed_by_admin";
}

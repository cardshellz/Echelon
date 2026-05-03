import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Boxes, CheckCircle2, MinusCircle, PlusCircle, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
  buildVariantSelectionReplacement,
  buildQueryUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatStatus,
  putJson,
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
  type DropshipSelectionRulesReplaceResponse,
  type DropshipSelectionRulesResponse,
  type DropshipVendorSelectionAction,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingSelectionAction = string | null;

export default function DropshipPortalCatalog() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState("false");
  const [applied, setApplied] = useState({ search: "", selectedOnly: "false" });
  const [pendingSelectionAction, setPendingSelectionAction] = useState<PendingSelectionAction>(null);
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
  const visibleRows = catalogQuery.data?.rows ?? [];
  const visibleSelectableRows = visibleRows.filter(canSelectRow);
  const visibleSelectedRows = visibleRows.filter((row) => row.selectionDecision.selected);

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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Catalog selection update failed.");
    } finally {
      setPendingSelectionAction(null);
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
              {selectionRulesQuery.error instanceof Error
                ? selectionRulesQuery.error.message
                : "Unable to load catalog selection rules."}
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {catalogQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
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

function canSelectRow(row: DropshipCatalogRow): boolean {
  return !row.selectionDecision.selected && row.selectionDecision.reason !== "not_exposed_by_admin";
}

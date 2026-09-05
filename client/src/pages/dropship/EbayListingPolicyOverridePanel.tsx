import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EBAY_POLICY_FIELDS, effectiveEbayPolicies } from "@/lib/dropship-ebay-policy-assignment";
import { ebayListingPolicyQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import { EBAY_POLICY_PAGE_SIZE, paginateEbayPolicyRows, summarizeEbayListingPolicy } from "@/lib/dropship-ebay-policy-view";
import { MAX_EBAY_POLICY_BULK_ASSIGNMENTS } from "@shared/dropship-ebay-policy-limits";
import { EbayListingPolicyBulkDialog } from "./EbayListingPolicyBulkDialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  fetchJson,
  queryErrorMessage,
  type DropshipCatalogRow,
  type DropshipEbayListingPolicyOverrideResponse,
} from "@/lib/dropship-ops-surface";
import { ListingSetupCombobox } from "./EbayListingSetupPanel";

type PolicyEditor = { productVariantIds: number[]; listingLabel?: string };

export function EbayListingPolicyOverridePanel({ onConfigurationChange, rows, storeConnectionId }: {
  onConfigurationChange: () => void;
  rows: readonly DropshipCatalogRow[];
  storeConnectionId: number;
}) {
  const queryClient = useQueryClient();
  const queryKey = ebayListingPolicyQueryKey(storeConnectionId);
  const policyQuery = useQuery<DropshipEbayListingPolicyOverrideResponse>({
    queryKey,
    queryFn: () => fetchJson<DropshipEbayListingPolicyOverrideResponse>(
      `/api/dropship/ebay/listing-policy-overrides/${storeConnectionId}`,
    ),
    enabled: Number.isInteger(storeConnectionId) && storeConnectionId > 0,
    staleTime: 60_000,
  });
  const [search, setSearch] = useState("");
  const [fulfillmentFilter, setFulfillmentFilter] = useState("__all__");
  const [page, setPage] = useState(1);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [editor, setEditor] = useState<PolicyEditor | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const assignmentsByVariantId = useMemo(
    () => new Map((policyQuery.data?.assignments ?? []).map((assignment) => [assignment.productVariantId, assignment])),
    [policyQuery.data?.assignments],
  );
  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = `${row.productName} ${row.variantName} ${row.variantSku}`.toLowerCase().includes(normalizedSearch);
      const effective = policyQuery.data
        ? effectiveEbayPolicies(assignmentsByVariantId.get(row.productVariantId), policyQuery.data.defaults).fulfillmentPolicyId
        : null;
      return matchesSearch && (fulfillmentFilter === "__all__"
        || (fulfillmentFilter === "__missing__" ? !effective : effective === fulfillmentFilter));
    });
  }, [rows, search, fulfillmentFilter, policyQuery.data, assignmentsByVariantId]);
  const currentPage = paginateEbayPolicyRows(filteredRows, page);
  const checkedRows = rows.filter((row) => checkedIds.has(row.productVariantId));
  const allPageChecked = currentPage.rows.length > 0 && currentPage.rows.every((row) => checkedIds.has(row.productVariantId));
  const somePageChecked = currentPage.rows.some((row) => checkedIds.has(row.productVariantId));

  async function refreshAssignments(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
    setRefreshError("");
  }

  async function refreshPolicies(): Promise<void> {
    if (refreshPending || editor) return;
    setRefreshPending(true);
    setRefreshError("");
    setSaveMessage("");
    try {
      await refreshAssignments();
      onConfigurationChange();
      setSaveMessage("Policies refreshed. Preview listings to use the current policies.");
    } catch (caught) {
      setRefreshError(queryErrorMessage(caught, "Policies could not be refreshed. Try Refresh policies again."));
    } finally {
      setRefreshPending(false);
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Listing policies</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Listings inherit your store defaults. Use Edit policies for exceptions, or check listings to assign policies together. Changes apply when you save.
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Fulfillment policies must fit Card Shellz capabilities. Shipping charges remain yours.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{rows.length} selected for listing</Badge>
            <Button size="sm" variant="outline" disabled={refreshPending || policyQuery.isFetching || editor !== null}
              onClick={() => void refreshPolicies()}>{refreshPending || policyQuery.isFetching ? "Refreshing policies…" : "Refresh policies"}</Button>
          </div>
        </div>
      </div>
      {(refreshError || policyQuery.error) && (
        <div role="alert" className="m-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          {refreshError || queryErrorMessage(policyQuery.error, "Listing policies could not be loaded. Try Refresh policies again.")}
          {policyQuery.data && <p className="mt-1">The values below are from the last successful load.</p>}
        </div>
      )}
      {saveMessage && <div role="status" className="m-3 text-sm text-emerald-800">{saveMessage}</div>}
      {policyQuery.isLoading ? (
        <div className="grid gap-3 p-4 md:grid-cols-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-zinc-500">Select catalog items to configure listing-level policies.</div>
      ) : policyQuery.data ? (
        <>
          <div className="space-y-3 border-b border-zinc-200 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Search listing policies" placeholder="Search product, variant, or SKU"
                value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
              <ListingSetupCombobox ariaLabel="Filter by effective fulfillment policy" emptyMessage="No matching policies."
                searchPlaceholder="Search fulfillment policies..." placeholder="All fulfillment policies" value={fulfillmentFilter}
                onValueChange={(value) => { setFulfillmentFilter(value); setPage(1); }} options={[
                  { id: "__all__", name: "All fulfillment policies" },
                  { id: "__missing__", name: "Missing fulfillment policy" },
                  ...policyQuery.data.options.fulfillmentPolicies,
                ]} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-500">{currentPage.start}–{currentPage.end} of {currentPage.total} matching · {checkedRows.length} checked across pages and filters</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={checkedRows.length === 0 || editor !== null}
                  onClick={() => setCheckedIds(new Set())}>Clear checks</Button>
                <Button size="sm" disabled={checkedRows.length === 0 || checkedRows.length > MAX_EBAY_POLICY_BULK_ASSIGNMENTS || editor !== null || refreshPending}
                  onClick={() => { setSaveMessage(""); setEditor({ productVariantIds: checkedRows.map((row) => row.productVariantId) }); }}>
                  Assign policies ({checkedRows.length})
                </Button>
              </div>
            </div>
            {checkedRows.length > MAX_EBAY_POLICY_BULK_ASSIGNMENTS && (
              <p role="alert" className="text-xs text-amber-800">Choose at most {MAX_EBAY_POLICY_BULK_ASSIGNMENTS} listings per policy update.</p>
            )}
          </div>
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[900px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox aria-label="Check listings on this page" disabled={currentPage.rows.length === 0 || editor !== null}
                      checked={allPageChecked ? true : somePageChecked ? "indeterminate" : false}
                      onCheckedChange={(checked) => setCheckedIds((current) => {
                        const next = new Set(current);
                        for (const row of currentPage.rows) {
                          if (checked === true) next.add(row.productVariantId);
                          else next.delete(row.productVariantId);
                        }
                        return next;
                      })} />
                  </TableHead>
                  <TableHead className="w-[24%]">Selected listing</TableHead>
                  <TableHead>Fulfillment policy</TableHead>
                  <TableHead>Return policy</TableHead>
                  <TableHead>Payment policy</TableHead>
                  <TableHead className="w-36 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currentPage.rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-zinc-500">No listings match these filters.</TableCell></TableRow>}
                {currentPage.rows.map((row) => {
                  const assignment = assignmentsByVariantId.get(row.productVariantId);
                  return (
                    <TableRow key={row.productVariantId}>
                      <TableCell>
                        <Checkbox aria-label={`Check ${row.variantSku} for policy assignment`} checked={checkedIds.has(row.productVariantId)}
                          disabled={editor !== null} onCheckedChange={(checked) => setCheckedIds((current) => {
                            const next = new Set(current);
                            if (checked === true) next.add(row.productVariantId); else next.delete(row.productVariantId);
                            return next;
                          })} />
                      </TableCell>
                      <TableCell>
                        <div className="truncate font-medium" title={row.productName}>{row.productName}</div>
                        <div className="truncate text-xs text-zinc-500" title={`${row.variantName} · ${row.variantSku}`}>{row.variantName} · {row.variantSku}</div>
                      </TableCell>
                      {EBAY_POLICY_FIELDS.map((field) => {
                        const summary = summarizeEbayListingPolicy(policyQuery.data, assignment, field);
                        return <TableCell key={field}>
                          <div className={`truncate text-sm ${summary.needsAttention ? "text-amber-800" : ""}`} title={summary.name}>{summary.name}</div>
                          <div className={`text-xs ${summary.source === "Override" ? "text-violet-700" : "text-zinc-500"}`}>{summary.source}</div>
                        </TableCell>;
                      })}
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" aria-label={`Edit policies for ${row.variantSku}`} disabled={editor !== null || refreshPending}
                          onClick={() => { setSaveMessage(""); setEditor({ productVariantIds: [row.productVariantId], listingLabel: `${row.productName} · ${row.variantSku}` }); }}>
                          Edit policies
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-3 py-2">
            <span className="text-xs text-zinc-500">Page {currentPage.page} of {currentPage.pageCount} · {EBAY_POLICY_PAGE_SIZE} listings per page</span>
            <nav aria-label="Listing policy pages" className="flex gap-2">
              <Button size="sm" variant="outline" disabled={currentPage.page === 1 || editor !== null} onClick={() => setPage(currentPage.page - 1)}>Previous</Button>
              <Button size="sm" variant="outline" disabled={currentPage.page === currentPage.pageCount || editor !== null} onClick={() => setPage(currentPage.page + 1)}>Next</Button>
            </nav>
          </div>
          {editor && <EbayListingPolicyBulkDialog data={policyQuery.data} productVariantIds={editor.productVariantIds} listingLabel={editor.listingLabel}
            onClose={() => setEditor(null)} onConflict={refreshAssignments} onSaved={async (count) => {
              onConfigurationChange();
              await refreshAssignments();
              if (!editor.listingLabel) setCheckedIds(new Set());
              setSaveMessage(`Policies saved for ${count} listing${count === 1 ? "" : "s"}. Preview before pushing to eBay.`);
            }} />}
        </>
      ) : null}
    </section>
  );
}

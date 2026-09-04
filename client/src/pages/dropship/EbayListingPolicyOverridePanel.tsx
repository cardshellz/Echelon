import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  effectiveEbayPolicies,
  ebayPolicyDisplayOptions,
  INHERIT_POLICY_VALUE as INHERIT_VALUE,
  type EbayPolicyField as PolicyField,
} from "@/lib/dropship-ebay-policy-assignment";
import { MAX_EBAY_POLICY_BULK_ASSIGNMENTS } from "@shared/dropship-ebay-policy-limits";
import { EbayListingPolicyBulkDialog } from "./EbayListingPolicyBulkDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createDropshipIdempotencyKey,
  fetchJson,
  putJson,
  queryErrorCode,
  queryErrorMessage,
  type DropshipCatalogRow,
  type DropshipEbayListingPolicyOverride,
  type DropshipEbayListingPolicyOverrideResponse,
  type ReplaceDropshipEbayListingPolicyOverrideResponse,
} from "@/lib/dropship-ops-surface";
import {
  ListingSetupCombobox,
  type ListingSetupDisplayOption,
} from "./EbayListingSetupPanel";

const EMPTY_OVERRIDE: Omit<
  DropshipEbayListingPolicyOverride,
  "productVariantId" | "revisionId" | "updatedAt"
> = {
  fulfillmentPolicyId: null,
  returnPolicyId: null,
  paymentPolicyId: null,
};

export function EbayListingPolicyOverridePanel({
  onConfigurationChange,
  rows,
  storeConnectionId,
}: {
  onConfigurationChange: () => void;
  rows: readonly DropshipCatalogRow[];
  storeConnectionId: number;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["/api/dropship/ebay/listing-policy-overrides", storeConnectionId] as const;
  const policyQuery = useQuery<DropshipEbayListingPolicyOverrideResponse>({
    queryKey,
    queryFn: () => fetchJson<DropshipEbayListingPolicyOverrideResponse>(
      `/api/dropship/ebay/listing-policy-overrides/${storeConnectionId}`,
    ),
    enabled: Number.isInteger(storeConnectionId) && storeConnectionId > 0,
    staleTime: 60_000,
  });
  const [pendingFields, setPendingFields] = useState<Set<string>>(() => new Set());
  const [saveError, setSaveError] = useState("");
  const pendingRows = useRef(new Set<number>());
  const [search, setSearch] = useState("");
  const [fulfillmentFilter, setFulfillmentFilter] = useState("__all__");
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const assignmentsByVariantId = useMemo(
    () => new Map((policyQuery.data?.assignments ?? []).map((assignment) => [
      assignment.productVariantId,
      assignment,
    ])),
    [policyQuery.data?.assignments],
  );
  const visibleRows = rows.filter((row) => {
    const matchesSearch = `${row.productName} ${row.variantName} ${row.variantSku}`.toLowerCase().includes(search.trim().toLowerCase());
    const effective = policyQuery.data
      ? effectiveEbayPolicies(assignmentsByVariantId.get(row.productVariantId), policyQuery.data.defaults).fulfillmentPolicyId
      : null;
    return matchesSearch && (fulfillmentFilter === "__all__"
      || (fulfillmentFilter === "__missing__" ? !effective : effective === fulfillmentFilter));
  });
  const checkedRows = rows.filter((row) => checkedIds.has(row.productVariantId));
  const allVisibleChecked = visibleRows.length > 0 && visibleRows.every((row) => checkedIds.has(row.productVariantId));
  const someVisibleChecked = visibleRows.some((row) => checkedIds.has(row.productVariantId));

  async function refreshAssignments() {
    await queryClient.invalidateQueries({ queryKey }, { throwOnError: true });
  }

  async function replaceField(
    row: DropshipCatalogRow,
    field: PolicyField,
    selectedValue: string,
  ): Promise<void> {
    const pendingKey = `${row.productVariantId}:${field}`;
    if (pendingRows.current.has(row.productVariantId) || bulkOpen) return;
    const current = assignmentsByVariantId.get(row.productVariantId) ?? EMPTY_OVERRIDE;
    const next = {
      fulfillmentPolicyId: current.fulfillmentPolicyId,
      returnPolicyId: current.returnPolicyId,
      paymentPolicyId: current.paymentPolicyId,
      [field]: selectedValue === INHERIT_VALUE ? null : selectedValue,
    };
    pendingRows.current.add(row.productVariantId);
    setPendingFields((values) => new Set(values).add(pendingKey));
    setSaveError("");
    setSaveMessage("");
    try {
      const result = await putJson<ReplaceDropshipEbayListingPolicyOverrideResponse>(
        `/api/dropship/ebay/listing-policy-overrides/${row.productVariantId}`,
        {
          storeConnectionId,
          expectedRevisionId: "revisionId" in current ? current.revisionId : null,
          ...next,
          idempotencyKey: createDropshipIdempotencyKey("ebay-listing-policy-override"),
        },
      );
      queryClient.setQueryData<DropshipEbayListingPolicyOverrideResponse>(queryKey, (existing) => {
        if (!existing) return existing;
        const assignments = existing.assignments.filter(
          (assignment) => assignment.productVariantId !== row.productVariantId,
        );
        if (result.assignment) assignments.push(result.assignment);
        assignments.sort((left, right) => left.productVariantId - right.productVariantId);
        return { ...existing, assignments };
      });
      onConfigurationChange();
    } catch (caught) {
      if (queryErrorCode(caught) === "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT") {
        await queryClient.invalidateQueries({ queryKey });
      }
      setSaveError(queryErrorMessage(caught, "The listing policy override could not be saved."));
    } finally {
      pendingRows.current.delete(row.productVariantId);
      setPendingFields((values) => {
        const nextValues = new Set(values);
        nextValues.delete(pendingKey);
        return nextValues;
      });
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Listing policies</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Store defaults are fallbacks. Choose different policies for individual listings, or check several listings and assign policies together.
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Fulfillment overrides are accepted only when their handling time, destinations, and services fit Card Shellz capabilities. Shipping charges remain yours.
            </p>
          </div>
          <Badge variant="outline">{rows.length} selected for listing</Badge>
        </div>
      </div>
      {policyQuery.isLoading ? (
        <div className="grid gap-3 p-4 md:grid-cols-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : policyQuery.error ? (
        <div role="alert" className="m-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          {queryErrorMessage(policyQuery.error, "Listing policy overrides could not be loaded.")}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-zinc-500">Select catalog items to configure listing-level policies.</div>
      ) : policyQuery.data ? (
        <>
          <div className="space-y-3 border-b border-zinc-200 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Search listing policies" placeholder="Search product, variant, or SKU"
                value={search} onChange={(event) => setSearch(event.target.value)} />
              <ListingSetupCombobox ariaLabel="Filter by effective fulfillment policy" emptyMessage="No matching policies."
                searchPlaceholder="Search fulfillment policies..." placeholder="All fulfillment policies" value={fulfillmentFilter}
                onValueChange={setFulfillmentFilter} options={[
                  { id: "__all__", name: "All fulfillment policies" },
                  { id: "__missing__", name: "Missing fulfillment policy" },
                  ...policyQuery.data.options.fulfillmentPolicies,
                ]} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-500">{visibleRows.length} shown · {checkedRows.length} checked across filters</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={checkedRows.length === 0 || bulkOpen}
                  onClick={() => setCheckedIds(new Set())}>Clear checks</Button>
                <Button size="sm" disabled={checkedRows.length === 0 || checkedRows.length > MAX_EBAY_POLICY_BULK_ASSIGNMENTS || pendingFields.size > 0 || bulkOpen}
                  onClick={() => { if (pendingRows.current.size === 0) setBulkOpen(true); }}>Assign policies ({checkedRows.length})</Button>
              </div>
            </div>
            {checkedRows.length > MAX_EBAY_POLICY_BULK_ASSIGNMENTS && (
              <p role="alert" className="text-xs text-amber-800">Choose at most {MAX_EBAY_POLICY_BULK_ASSIGNMENTS} listings per policy update.</p>
            )}
          </div>
          {saveMessage && <div role="status" className="m-3 text-sm text-emerald-800">{saveMessage}</div>}
          {saveError && (
            <div role="alert" className="m-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
              {saveError}
            </div>
          )}
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[1000px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox aria-label="Check all shown listings" disabled={visibleRows.length === 0 || bulkOpen}
                      checked={allVisibleChecked ? true : someVisibleChecked ? "indeterminate" : false}
                      onCheckedChange={(checked) => setCheckedIds((current) => {
                        const next = new Set(current);
                        for (const row of visibleRows) { if (checked === true) next.add(row.productVariantId); else next.delete(row.productVariantId); }
                        return next;
                      })} />
                  </TableHead>
                  <TableHead className="w-[24%]">Selected listing</TableHead>
                  <TableHead className="w-[23%]">Fulfillment policy</TableHead>
                  <TableHead className="w-[19%]">Return policy</TableHead>
                  <TableHead className="w-[19%]">Payment policy</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-zinc-500">No listings match these filters.</TableCell></TableRow>}
                {visibleRows.map((row) => {
                  const assignment = assignmentsByVariantId.get(row.productVariantId) ?? null;
                  const overrideCount = assignment
                    ? [assignment.fulfillmentPolicyId, assignment.returnPolicyId, assignment.paymentPolicyId]
                        .filter((value) => value !== null).length
                    : 0;
                  const effective = effectiveEbayPolicies(assignment, policyQuery.data.defaults);
                  const needsPolicy = Object.values(effective).some((value) => value === null);
                  const rowPending = [...pendingFields].some(
                    (pendingKey) => pendingKey.startsWith(`${row.productVariantId}:`),
                  );
                  return (
                    <TableRow key={row.productVariantId}>
                      <TableCell>
                        <Checkbox aria-label={`Check ${row.variantSku} for policy assignment`} checked={checkedIds.has(row.productVariantId)}
                          disabled={bulkOpen} onCheckedChange={(checked) => setCheckedIds((current) => {
                            const next = new Set(current);
                            if (checked === true) next.add(row.productVariantId); else next.delete(row.productVariantId);
                            return next;
                          })} />
                      </TableCell>
                      <TableCell>
                        <div className="line-clamp-2 font-medium" title={row.productName}>{row.productName}</div>
                        <div className="truncate text-xs text-zinc-500" title={`${row.variantName} · ${row.variantSku}`}>
                          {row.variantName} · {row.variantSku}
                        </div>
                      </TableCell>
                      <TableCell>
                        <PolicyFieldCombobox
                          field="fulfillmentPolicyId"
                          assignment={assignment}
                          defaultPolicyId={policyQuery.data.defaults.fulfillmentPolicyId}
                          options={ebayPolicyDisplayOptions(policyQuery.data, "fulfillmentPolicyId")}
                          disabled={rowPending || bulkOpen}
                          onChange={(value) => replaceField(row, "fulfillmentPolicyId", value)}
                        />
                      </TableCell>
                      <TableCell>
                        <PolicyFieldCombobox
                          field="returnPolicyId"
                          assignment={assignment}
                          defaultPolicyId={policyQuery.data.defaults.returnPolicyId}
                          options={policyQuery.data.options.returnPolicies}
                          disabled={rowPending || bulkOpen}
                          onChange={(value) => replaceField(row, "returnPolicyId", value)}
                        />
                      </TableCell>
                      <TableCell>
                        <PolicyFieldCombobox
                          field="paymentPolicyId"
                          assignment={assignment}
                          defaultPolicyId={policyQuery.data.defaults.paymentPolicyId}
                          options={policyQuery.data.options.paymentPolicies}
                          disabled={rowPending || bulkOpen}
                          onChange={(value) => replaceField(row, "paymentPolicyId", value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={needsPolicy ? "border-amber-200 bg-amber-50 text-amber-800" : overrideCount > 0
                            ? "border-violet-200 bg-violet-50 text-violet-800"
                            : "border-zinc-200 bg-zinc-50 text-zinc-700"}
                        >
                          {needsPolicy ? "Missing policy" : overrideCount > 0 ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}` : "Store defaults"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {bulkOpen && <EbayListingPolicyBulkDialog data={policyQuery.data} productVariantIds={checkedRows.map((row) => row.productVariantId)}
            onClose={() => setBulkOpen(false)} onConflict={refreshAssignments} onSaved={async (count) => {
              onConfigurationChange();
              await refreshAssignments();
              setCheckedIds(new Set());
              setSaveMessage(`Policies saved for ${count} listings. Preview them before pushing to eBay.`);
            }} />}
        </>
      ) : null}
    </section>
  );
}

function PolicyFieldCombobox({
  assignment,
  defaultPolicyId,
  disabled,
  field,
  onChange,
  options,
}: {
  assignment: DropshipEbayListingPolicyOverride | null;
  defaultPolicyId: string | null;
  disabled: boolean;
  field: PolicyField;
  onChange: (value: string) => void;
  options: readonly ListingSetupDisplayOption[];
}) {
  const defaultOption = options.find((option) => option.id === defaultPolicyId) ?? null;
  const inheritedName = defaultOption?.name ?? defaultPolicyId ?? "Not configured";
  const displayOptions: ListingSetupDisplayOption[] = [
    { id: INHERIT_VALUE, name: `Store default — ${inheritedName}` },
    ...options,
  ];
  const assignedId = assignment?.[field];
  if (assignedId && !options.some((option) => option.id === assignedId)) displayOptions.push({
    id: assignedId, name: `Unavailable policy (${assignedId})`, disabled: true,
    description: "Choose a current policy or inherit the store default.",
  });
  return (
    <ListingSetupCombobox
      ariaLabel={`${field} listing override`}
      disabled={disabled}
      emptyMessage="No matching policies."
      onValueChange={onChange}
      options={displayOptions}
      placeholder="Use store default"
      searchPlaceholder="Search policies..."
      value={assignment?.[field] ?? INHERIT_VALUE}
    />
  );
}

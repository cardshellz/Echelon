import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
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

const INHERIT_VALUE = "__store_default__";
type PolicyField = "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId";

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
  const assignmentsByVariantId = useMemo(
    () => new Map((policyQuery.data?.assignments ?? []).map((assignment) => [
      assignment.productVariantId,
      assignment,
    ])),
    [policyQuery.data?.assignments],
  );

  async function replaceField(
    row: DropshipCatalogRow,
    field: PolicyField,
    selectedValue: string,
  ): Promise<void> {
    const pendingKey = `${row.productVariantId}:${field}`;
    if (pendingFields.has(pendingKey)) return;
    const current = assignmentsByVariantId.get(row.productVariantId) ?? EMPTY_OVERRIDE;
    const next = {
      fulfillmentPolicyId: current.fulfillmentPolicyId,
      returnPolicyId: current.returnPolicyId,
      paymentPolicyId: current.paymentPolicyId,
      [field]: selectedValue === INHERIT_VALUE ? null : selectedValue,
    };
    setPendingFields((values) => new Set(values).add(pendingKey));
    setSaveError("");
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
            <h2 className="text-lg font-semibold">Listing policy overrides (optional)</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Every listing inherits the store defaults above. Change only the listings that need a different buyer-facing policy.
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Fulfillment overrides are accepted only when their handling time, destinations, and services fit Card Shellz capabilities. Shipping charges remain yours.
            </p>
          </div>
          <Badge variant="outline">{rows.length} selected</Badge>
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
          {saveError && (
            <div role="alert" className="m-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
              {saveError}
            </div>
          )}
          <div className="max-h-96 overflow-auto">
            <Table className="min-w-[1100px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Selected listing</TableHead>
                  <TableHead>Fulfillment policy</TableHead>
                  <TableHead>Return policy</TableHead>
                  <TableHead>Payment policy</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const assignment = assignmentsByVariantId.get(row.productVariantId) ?? null;
                  const overrideCount = assignment
                    ? [assignment.fulfillmentPolicyId, assignment.returnPolicyId, assignment.paymentPolicyId]
                        .filter((value) => value !== null).length
                    : 0;
                  const rowPending = [...pendingFields].some(
                    (pendingKey) => pendingKey.startsWith(`${row.productVariantId}:`),
                  );
                  return (
                    <TableRow key={row.productVariantId}>
                      <TableCell>
                        <div className="font-medium">{row.productName}</div>
                        <div className="text-xs text-zinc-500">{row.variantName} · {row.variantSku}</div>
                      </TableCell>
                      <TableCell className="min-w-64">
                        <PolicyFieldCombobox
                          field="fulfillmentPolicyId"
                          assignment={assignment}
                          defaultPolicyId={policyQuery.data.defaults.fulfillmentPolicyId}
                          options={policyQuery.data.options.fulfillmentPolicies.map((option) => ({
                            ...option,
                            disabled: !option.compatible,
                            description: option.compatible
                              ? "Compatible with Card Shellz fulfillment"
                              : option.compatibilityIssues[0]?.message ?? "Not compatible",
                          }))}
                          disabled={rowPending}
                          onChange={(value) => replaceField(row, "fulfillmentPolicyId", value)}
                        />
                      </TableCell>
                      <TableCell className="min-w-64">
                        <PolicyFieldCombobox
                          field="returnPolicyId"
                          assignment={assignment}
                          defaultPolicyId={policyQuery.data.defaults.returnPolicyId}
                          options={policyQuery.data.options.returnPolicies}
                          disabled={rowPending}
                          onChange={(value) => replaceField(row, "returnPolicyId", value)}
                        />
                      </TableCell>
                      <TableCell className="min-w-64">
                        <PolicyFieldCombobox
                          field="paymentPolicyId"
                          assignment={assignment}
                          defaultPolicyId={policyQuery.data.defaults.paymentPolicyId}
                          options={policyQuery.data.options.paymentPolicies}
                          disabled={rowPending}
                          onChange={(value) => replaceField(row, "paymentPolicyId", value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={overrideCount > 0
                            ? "border-violet-200 bg-violet-50 text-violet-800"
                            : "border-zinc-200 bg-zinc-50 text-zinc-700"}
                        >
                          {overrideCount > 0 ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}` : "Store defaults"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
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

import { useEffect, useId, useState } from "react";
import {
  EBAY_POLICY_FIELDS,
  EBAY_POLICY_KINDS,
  EBAY_POLICY_LABELS as labels,
  getEbayPolicySelectionState,
  type EbayPolicyValues,
  type EbayPolicyPatch,
  type EbayPolicyCatalogOptions,
  type EbayPolicyScope,
} from "@shared/ebay-business-policies";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PolicyCatalogOptions = EbayPolicyCatalogOptions;
export type PolicyCatalogStatus = "loading" | "unavailable" | "ready";
const catalogKeys = {
  fulfillment: "fulfillmentPolicies",
  return: "returnPolicies",
  payment: "paymentPolicies",
} as const;
const POLICY_VALUE_PREFIX = "policy:";
const INHERIT_VALUE = "inherit";

export function policyChanges(
  saved: EbayPolicyValues,
  edited: EbayPolicyValues,
): EbayPolicyPatch {
  const patch: EbayPolicyPatch = {};
  for (const field of Object.values(EBAY_POLICY_FIELDS))
    if (saved[field] !== edited[field]) patch[field] = edited[field];
  return patch;
}

/** Background reads never discard edits. The original snapshot accompanies a
 * patch so the server can reject a conflicting external edit. */
export function useEbayPolicyDraft(
  saved: EbayPolicyValues,
  scope?: EbayPolicyScope,
) {
  const [state, setState] = useState(() => ({
    base: saved,
    values: saved,
    scope,
  }));
  const savedKey = JSON.stringify(saved);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    setState((current) =>
      Object.keys(policyChanges(current.base, current.values)).length
        ? current
        : { base: saved, values: saved, scope },
    );
  }, [savedKey, scopeKey]);
  const patch = policyChanges(state.base, state.values);
  return {
    ...state,
    patch,
    dirty: Object.keys(patch).length > 0,
    changedElsewhere:
      JSON.stringify(state.base) !== savedKey ||
      JSON.stringify(state.scope) !== scopeKey,
    change: (next: EbayPolicyPatch) =>
      setState((current) => ({
        ...current,
        values: { ...current.values, ...next },
      })),
    reload: () => setState({ base: saved, values: saved, scope }),
    saved: () =>
      setState((current) => ({
        ...current,
        base: current.values,
        values: current.values,
      })),
  };
}

/** An unknown stored ID is a visible disabled choice, never an empty control
 * or an implicit inheritance change. Every level uses the same catalog. */
export function EbayPolicyFields({
  values,
  catalog,
  status,
  onChange,
  inheritLabel,
  disabled = false,
  labelPrefix,
}: {
  values: EbayPolicyValues;
  catalog: PolicyCatalogOptions | undefined;
  status: PolicyCatalogStatus;
  onChange: (patch: EbayPolicyPatch) => void;
  inheritLabel?: string;
  disabled?: boolean;
  labelPrefix: string;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      {status !== "ready" && (
        <p role="status" className="text-xs text-amber-800 dark:text-amber-200">
          {status === "loading"
            ? "Loading eBay policies. Saved selections are shown below."
            : "eBay policies are unavailable. Saved selections are retained; refresh policies before saving."}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {EBAY_POLICY_KINDS.map((kind) => {
          const field = EBAY_POLICY_FIELDS[kind];
          const value = values[field];
          const displayId =
            value !== null && value.trim().length === 0
              ? JSON.stringify(value)
              : value;
          const selection =
            status === "ready" && catalog
              ? getEbayPolicySelectionState(kind, value, catalog)
              : null;
          const missing = selection?.status === "unavailable";
          const text =
            value === null
              ? (inheritLabel ??
                `No ${labels[kind].toLowerCase()} policy selected`)
              : status !== "ready"
                ? `Saved ${labels[kind].toLowerCase()} policy ${displayId} (not checked)`
                : missing
                  ? `Unavailable ${labels[kind].toLowerCase()} policy ${displayId}`
                  : (selection?.name ?? value);
          return (
            <div key={kind} className="min-w-0">
              <Label htmlFor={`${id}-${kind}`} className="text-xs">
                {labels[kind]}
              </Label>
              <Select
                value={
                  value === null
                    ? INHERIT_VALUE
                    : `${POLICY_VALUE_PREFIX}${value}`
                }
                disabled={disabled || status !== "ready"}
                onValueChange={(next) => {
                  if (next === INHERIT_VALUE) onChange({ [field]: null });
                  else if (next.startsWith(POLICY_VALUE_PREFIX))
                    onChange({
                      [field]: next.slice(POLICY_VALUE_PREFIX.length),
                    });
                }}
              >
                <SelectTrigger
                  id={`${id}-${kind}`}
                  aria-label={`${labelPrefix} ${labels[kind].toLowerCase()} policy`}
                  className="min-h-11 h-auto py-2 text-xs [&>span]:whitespace-normal [&>span]:text-left [&>span]:break-all"
                >
                  <SelectValue>{text}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {inheritLabel && (
                    <SelectItem value={INHERIT_VALUE}>
                      {inheritLabel}
                    </SelectItem>
                  )}
                  {value !== null && (missing || status !== "ready") && (
                    <SelectItem
                      value={`${POLICY_VALUE_PREFIX}${value}`}
                      disabled
                    >
                      {text}
                    </SelectItem>
                  )}
                  {status === "ready" &&
                    catalog?.[catalogKeys[kind]].map((option) => (
                      <SelectItem
                        key={option.id}
                        value={`${POLICY_VALUE_PREFIX}${option.id}`}
                      >
                        {option.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {missing && (
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                  This saved policy is unavailable for this eBay account and
                  marketplace. Choose an available policy
                  {inheritLabel ? " or inherit the default" : ""}.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PolicyDraftConflict({ onReload }: { onReload: () => void }) {
  return (
    <div role="alert" className="text-xs space-y-1">
      <p>
        Saved policies changed while you were editing, or the eBay account or
        marketplace changed. Your edits are retained. Reload the saved values
        before making another change.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>
        Reload saved policies
      </Button>
    </div>
  );
}

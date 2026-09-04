import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { createDropshipIdempotencyKey, putJson, queryErrorCode, queryErrorMessage,
  type DropshipEbayListingPolicyOverrideResponse, type ReplaceDropshipEbayListingPoliciesResponse } from "@/lib/dropship-ops-surface";
import { buildEbayBulkPolicyAssignments, EBAY_POLICY_FIELDS, EBAY_POLICY_LABELS, ebayPolicyDisplayOptions,
  INHERIT_POLICY_VALUE, UNCHANGED_POLICY_VALUE, type EbayPolicyPatch } from "@/lib/dropship-ebay-policy-assignment";
import { ListingSetupCombobox } from "./EbayListingSetupPanel";

export function EbayListingPolicyBulkDialog({ data, productVariantIds, onClose, onSaved, onConflict }: {
  data: DropshipEbayListingPolicyOverrideResponse;
  productVariantIds: readonly number[];
  onClose: () => void;
  onSaved: (count: number) => Promise<void>;
  onConflict: () => Promise<void>;
}) {
  // Keep the exact rows/revisions reviewed when opening the dialog. A concurrent
  // edit must produce a conflict, not silently change what this operation means.
  const [snapshot] = useState(() => ({ data, productVariantIds: [...productVariantIds] }));
  const [patch, setPatch] = useState<EbayPolicyPatch>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflicted, setConflicted] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const inFlight = useRef(false);
  const requestIdentity = useRef<{ fingerprint: string; key: string } | null>(null);
  const hasChange = EBAY_POLICY_FIELDS.some((field) => patch[field] !== undefined);

  async function save() {
    if (inFlight.current || conflicted) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      if (savedCount !== null) {
        await refreshAfterSave(savedCount);
        return;
      }
      const assignments = buildEbayBulkPolicyAssignments({ productVariantIds: snapshot.productVariantIds,
        assignments: snapshot.data.assignments, patch });
      const request = { storeConnectionId: snapshot.data.storeConnectionId, assignments };
      const fingerprint = JSON.stringify(request);
      if (requestIdentity.current?.fingerprint !== fingerprint) requestIdentity.current = {
        fingerprint, key: createDropshipIdempotencyKey("ebay-policy-bulk"),
      };
      // A lost response retries the identical operation key, never a second write.
      await putJson<ReplaceDropshipEbayListingPoliciesResponse>("/api/dropship/ebay/listing-policy-overrides/bulk", {
        ...request, idempotencyKey: requestIdentity.current.key,
      });
      // A successful write and a failed refresh are different outcomes. Never
      // reissue an already-confirmed write just because the refresh failed.
      setSavedCount(assignments.length);
      await refreshAfterSave(assignments.length);
    } catch (caught) {
      if (queryErrorCode(caught) === "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT") {
        setConflicted(true);
        setError("A selected listing changed. Nothing was applied. Close this window, review the refreshed policies, and try again.");
        try {
          await onConflict();
        } catch {
          setError("A selected listing changed. Nothing was applied. The refreshed policies could not be loaded; close this window and reload the catalog before trying again.");
        }
      } else setError(queryErrorMessage(caught, "Policies could not be saved. You can retry this operation."));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function refreshAfterSave(count: number): Promise<void> {
    try {
      await onSaved(count);
      onClose();
    } catch {
      setError(`Policies were saved for ${count} listings, but the refreshed list could not be loaded. Retry the refresh; your changes will not be submitted again.`);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
      <DialogContent className="sm:max-w-lg" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Assign policies to {snapshot.productVariantIds.length} listings</DialogTitle>
          <DialogDescription>Applies to your checked listings, including any hidden by filters. Leave unchanged preserves each listing’s current choice. This does not push listings to eBay.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {EBAY_POLICY_FIELDS.map((field) => {
            const options = ebayPolicyDisplayOptions(snapshot.data, field);
            const defaultId = snapshot.data.defaults[field];
            const defaultName = options.find((option) => option.id === defaultId)?.name ?? defaultId ?? "Not configured";
            return <div key={field} className="space-y-2">
              <Label>{EBAY_POLICY_LABELS[field]}</Label>
              <ListingSetupCombobox ariaLabel={`Bulk ${EBAY_POLICY_LABELS[field]}`} disabled={pending || conflicted || savedCount !== null}
                emptyMessage="No matching policies." searchPlaceholder="Search policies..." placeholder="Leave unchanged"
                value={patch[field] === undefined ? UNCHANGED_POLICY_VALUE : patch[field] ?? INHERIT_POLICY_VALUE}
                options={[{ id: UNCHANGED_POLICY_VALUE, name: "Leave unchanged" },
                  { id: INHERIT_POLICY_VALUE, name: `Store default — ${defaultName}` }, ...options]}
                onValueChange={(value) => setPatch((current) => ({ ...current,
                  [field]: value === UNCHANGED_POLICY_VALUE ? undefined : value === INHERIT_POLICY_VALUE ? null : value }))} />
            </div>;
          })}
          <p className="text-xs text-zinc-500">Every selected listing is validated. All changes save together, or none do.</p>
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>{savedCount === null ? "Cancel" : "Close"}</Button>
          <Button disabled={pending || !hasChange || conflicted} onClick={() => void save()}>
            {pending ? savedCount === null ? "Saving policies…" : "Refreshing policies…"
              : savedCount === null ? "Apply to selected listings" : "Refresh saved policies"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

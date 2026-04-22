// AddToCatalogDialog.tsx
//
// Spec A follow-up: "Suggest-at-save" catalog flow. When the user saves a PO
// that contains lines not currently in the vendor's catalog, this dialog
// asks whether to add them. Per Overlord's 2026-04-21 spec:
//   - Three actions: [Add all] (primary), [Review each], [Add none]
//   - Cannot dismiss via Esc / backdrop without picking one of the three
//   - On [Add all] or [Add N selected] the upsert runs BEFORE the PO save.
//     If the upsert fails the PO save is NOT attempted.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { formatMills, centsToMills } from "@shared/utils/money";

export type CatalogCandidate = {
  clientId: string;
  productId: number;
  productVariantId: number;
  productName: string;
  sku: string | null;
  // Per-unit cost. Mills (4-decimal) is authoritative when present; cents
  // remains for back-compat display of legacy candidates.
  unitCostCents: number;
  unitCostMills?: number;
};

// Render per-unit cost at 4 decimals so the dialog matches what will
// actually be stored on the vendor_products row. If the candidate doesn't
// carry mills (legacy producer), we derive them from cents (exact).
function formatCandidateCost(c: CatalogCandidate): string {
  const mills =
    typeof c.unitCostMills === "number"
      ? c.unitCostMills
      : centsToMills(Math.max(0, c.unitCostCents | 0));
  return formatMills(mills);
}

export type AddToCatalogDecision =
  | { action: "add-all" }
  | { action: "add-selected"; selectedClientIds: string[] }
  | { action: "add-none" };

type Props = {
  open: boolean;
  vendorName: string;
  candidates: CatalogCandidate[];
  submitting: boolean;
  error: string | null;
  onDecide: (decision: AddToCatalogDecision) => void;
};

export function AddToCatalogDialog(props: Props) {
  const { open, vendorName, candidates, submitting, error, onDecide } = props;

  // "review" mode: show checkboxes and let the user deselect per-item.
  const [reviewMode, setReviewMode] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(candidates.map((c) => [c.clientId, true])),
  );

  // Re-seed selection when the dialog (re)opens with a different candidate set.
  const candidateKey = useMemo(
    () => candidates.map((c) => c.clientId).join(","),
    [candidates],
  );
  useEffect(() => {
    setSelected(Object.fromEntries(candidates.map((c) => [c.clientId, true])));
    setReviewMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, open]);

  const selectedCount = useMemo(
    () => candidates.filter((c) => selected[c.clientId]).length,
    [candidates, selected],
  );

  return (
    <DialogPrimitive.Root open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/80",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
          onPointerDown={(e) => e.preventDefault()}
        />
        <div className="fixed inset-0 z-50 overflow-y-auto flex items-center justify-center p-4 pointer-events-none">
          <DialogPrimitive.Content
            className={cn(
              "relative z-50 grid w-full max-w-lg gap-4 border bg-background p-6 shadow-lg",
              "pointer-events-auto",
              "sm:rounded-lg",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            )}
            // Block Esc close and outside-click close. The user MUST pick an
            // action. Radix fires onEscapeKeyDown / onPointerDownOutside
            // before closing; preventDefault on these vetoes the close.
            onEscapeKeyDown={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <div className="flex flex-col gap-1">
              <DialogPrimitive.Title className="text-lg font-semibold">
                Add new products to {vendorName}'s catalog?
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                {candidates.length}{" "}
                {candidates.length === 1 ? "product" : "products"} on this PO{" "}
                {candidates.length === 1 ? "isn't" : "aren't"} in {vendorName}'s
                catalog yet.
              </DialogPrimitive.Description>
            </div>

            <div className="max-h-[50vh] overflow-y-auto divide-y border rounded-md">
              {candidates.map((c) => (
                <div
                  key={c.clientId}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  {reviewMode ? (
                    <Checkbox
                      checked={!!selected[c.clientId]}
                      onCheckedChange={(v) =>
                        setSelected((prev) => ({ ...prev, [c.clientId]: !!v }))
                      }
                      aria-label={`Include ${c.productName}`}
                    />
                  ) : (
                    <span
                      className="text-emerald-600"
                      aria-hidden="true"
                      title="Will be added"
                    >
                      ✓
                    </span>
                  )}
                  <span className="flex-1 truncate">
                    <span className="font-medium">{c.productName}</span>
                    {c.sku && (
                      <span className="font-mono text-xs text-muted-foreground ml-2">
                        {c.sku}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums text-xs">
                    {formatCandidateCost(c)}/ea
                  </span>
                </div>
              ))}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Couldn't update the catalog</div>
                  <div className="text-xs opacity-90">{error}</div>
                  <div className="text-xs opacity-80 mt-1">
                    The PO was NOT saved. Pick an action to continue.
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                disabled={submitting}
                onClick={() => onDecide({ action: "add-none" })}
              >
                Add none
              </Button>
              {!reviewMode && (
                <Button
                  variant="outline"
                  disabled={submitting}
                  onClick={() => setReviewMode(true)}
                >
                  Review each
                </Button>
              )}
              {reviewMode ? (
                <Button
                  disabled={submitting}
                  onClick={() =>
                    onDecide({
                      action: "add-selected",
                      selectedClientIds: candidates
                        .filter((c) => selected[c.clientId])
                        .map((c) => c.clientId),
                    })
                  }
                >
                  {submitting
                    ? "Adding..."
                    : selectedCount > 0
                      ? `Add ${selectedCount} selected`
                      : "Add none"}
                </Button>
              ) : (
                <Button
                  disabled={submitting}
                  onClick={() => onDecide({ action: "add-all" })}
                >
                  {submitting ? "Adding..." : "Add all"}
                </Button>
              )}
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

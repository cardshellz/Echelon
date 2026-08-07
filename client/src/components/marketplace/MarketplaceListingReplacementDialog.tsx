import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MarketplaceListingRegistrationOwner } from "./MarketplaceListingRegistrationDialog";

export interface MarketplaceListingReplacementVariant {
  id: number;
  sku: string;
  name: string;
  included: boolean;
  lockedExcluded?: boolean;
}

export interface MarketplaceListingReplacementDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  owner: MarketplaceListingRegistrationOwner;
  productName: string;
  variants: readonly MarketplaceListingReplacementVariant[];
  onCompleted?(): void;
}

const rebuildPreviewSchema = z.object({
  productId: z.number().int().positive(),
  groupKey: z.string().min(1),
  currentExternalListingId: z.string().min(1),
  currentSkus: z.array(z.string().min(1)).min(1),
  desiredSkus: z.array(z.string().min(1)).min(1),
  addedSkus: z.array(z.string().min(1)),
  removedSkus: z.array(z.string().min(1)),
  rebuildRequired: z.boolean(),
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type RebuildPreview = z.infer<typeof rebuildPreviewSchema>;

const pushResponseSchema = z.object({
  results: z.array(z.object({
    productId: z.number().int().positive(),
    success: z.boolean(),
    listingId: z.string().optional(),
    error: z.string().optional(),
    rebuildPreview: rebuildPreviewSchema.optional(),
  }).passthrough()).min(1),
}).passthrough();

export const MARKETPLACE_LISTING_REPLACEMENT_REQUEST_TIMEOUT_MS = 360_000;

export function replacementEndpointBase(
  owner: MarketplaceListingRegistrationOwner,
): string {
  if (owner.kind !== "channel") {
    throw new Error("Listing rebuild must be invoked through the owning marketplace surface.");
  }
  return "/api/ebay/listings/push";
}

export function MarketplaceListingReplacementDialog({
  open,
  onOpenChange,
  owner,
  productName,
  variants,
  onCompleted,
}: MarketplaceListingReplacementDialogProps) {
  const [preview, setPreview] = useState<RebuildPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "execute" | null>(null);
  const [completedListingId, setCompletedListingId] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setBusy("preview");
    setError(null);
    setPreview(null);
    setCompletedListingId(null);
    try {
      if (owner.kind !== "channel") {
        throw new Error("Dropship rebuild must be started from the owning store connection.");
      }
      const response = await postRebuildRequest(replacementEndpointBase(owner), {
        productIds: [owner.productId],
        rebuild: { mode: "preview" },
      });
      const result = response.results[0];
      if (!result.success || !result.rebuildPreview) {
        throw new Error(result.error ?? "The listing rebuild preview was unavailable.");
      }
      setPreview(result.rebuildPreview);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }, [owner]);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError(null);
      setBusy(null);
      setCompletedListingId(null);
      return;
    }
    void loadPreview();
  }, [loadPreview, open]);

  const executeRebuild = async () => {
    if (!preview || !preview.rebuildRequired || owner.kind !== "channel") return;
    setBusy("execute");
    setError(null);
    try {
      const response = await postRebuildRequest(replacementEndpointBase(owner), {
        productIds: [owner.productId],
        rebuild: { mode: "execute", preview },
      });
      const result = response.results[0];
      if (!result.success || !result.listingId) {
        throw new Error(result.error ?? "The rebuilt listing was not published.");
      }
      setCompletedListingId(result.listingId);
      onCompleted?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (busy === null) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rebuild eBay listing</DialogTitle>
          <DialogDescription>
            End the current listing for {productName}, then publish a new listing containing exactly the active variants below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border divide-y">
            {variants.map((variant) => (
              <div key={variant.id} className="flex items-center justify-between gap-4 p-3">
                <div>
                  <p className="font-medium">{variant.name}</p>
                  <code className="text-xs text-muted-foreground">{variant.sku}</code>
                </div>
                <span className={variant.included ? "text-sm text-blue-700" : "text-sm text-muted-foreground"}>
                  {variant.included ? "Included" : "Archived - removed"}
                </span>
              </div>
            ))}
          </div>

          {busy === "preview" && (
            <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the current eBay listing...
            </div>
          )}

          {preview && !preview.rebuildRequired && (
            <div className="flex gap-2 rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              The live listing has no stale variants. Use the normal Update listing action instead.
            </div>
          )}

          {preview?.rebuildRequired && !completedListingId && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <div className="flex gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">The current listing will be ended before the new listing is published.</p>
                  <p className="mt-1">
                    Remove {preview.removedSkus.join(", ")}; publish {preview.desiredSkus.join(", ")}.
                  </p>
                </div>
              </div>
            </div>
          )}

          {completedListingId && (
            <div className="flex gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              New eBay listing {completedListingId} is live and Echelon now points to it.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-medium">Listing rebuild could not continue.</p>
              <p className="mt-1">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy !== null}>
            {completedListingId ? "Close" : "Cancel"}
          </Button>
          {error && !completedListingId && (
            <Button variant="outline" onClick={() => void loadPreview()} disabled={busy !== null}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Read eBay again
            </Button>
          )}
          {preview?.rebuildRequired && !completedListingId && (
            <Button onClick={() => void executeRebuild()} disabled={busy !== null}>
              {busy === "execute" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Rebuild listing
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function postRebuildRequest(url: string, body: unknown) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    MARKETPLACE_LISTING_REPLACEMENT_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `Request failed (${response.status}).`;
      throw new Error(message);
    }
    return pushResponseSchema.parse(payload);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "The request timed out. Read eBay again before retrying.";
  }
  if (cause instanceof z.ZodError) {
    return "The server returned an invalid listing rebuild response.";
  }
  return cause instanceof Error ? cause.message : "The listing rebuild request failed.";
}

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  postRegistration,
  registrationPreviewResponseSchema,
  type MarketplaceListingRegistrationOwner,
} from "./MarketplaceListingRegistrationDialog";

export interface MarketplaceListingChangeVariant {
  id: number;
  sku: string;
  name: string;
  included: boolean;
  lockedExcluded?: boolean;
}

export interface MarketplaceListingChangesDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  owner: MarketplaceListingRegistrationOwner;
  productName: string;
  variants: readonly MarketplaceListingChangeVariant[];
  onCompleted?(): void;
}

const rebuildPreviewSchema = z.object({
  productId: z.number().int().positive(),
  groupKey: z.string().min(1),
  currentExternalListingId: z.string().min(1),
  sourceState: z.enum(["active", "withdrawn"]),
  currentSkus: z.array(z.string().min(1)).min(1),
  activeSkus: z.array(z.string().min(1)),
  inactiveSkus: z.array(z.string().min(1)),
  desiredSkus: z.array(z.string().min(1)).min(1),
  addedSkus: z.array(z.string().min(1)),
  removedSkus: z.array(z.string().min(1)),
  rebuildRequired: z.boolean(),
  confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type RebuildPreview = z.infer<typeof rebuildPreviewSchema>;
type Completion = Readonly<{ listingId: string; mode: "verify" | "update" | "replace" }>;

const registrationConfirmResponseSchema = z.object({
  result: z.object({
    kind: z.enum(["created", "replay"]),
    receipt: z.object({
      registrationId: z.number().int().positive(),
      publicationId: z.number().int().positive(),
      registeredAt: z.string().datetime(),
    }),
  }),
});

const pushResponseSchema = z.object({
  results: z.array(z.object({
    productId: z.number().int().positive(),
    success: z.boolean(),
    listingId: z.string().optional(),
    error: z.string().optional(),
    rebuildPreview: rebuildPreviewSchema.optional(),
  }).passthrough()).min(1),
}).passthrough();

export const MARKETPLACE_LISTING_CHANGES_REQUEST_TIMEOUT_MS = 360_000;

export function listingChangesEndpointBase(
  owner: MarketplaceListingRegistrationOwner,
): string {
  if (owner.kind !== "channel") {
    throw new Error("Listing changes must be invoked through the owning marketplace surface.");
  }
  return "/api/ebay/listings/push";
}

export function MarketplaceListingChangesDialog({
  open,
  onOpenChange,
  owner,
  productName,
  variants,
  onCompleted,
}: MarketplaceListingChangesDialogProps) {
  const [preview, setPreview] = useState<RebuildPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "update" | "replace" | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [baselineWarning, setBaselineWarning] = useState<string | null>(null);
  const variantsBySku = useMemo(
    () => new Map(variants.map((variant) => [variant.sku, variant])),
    [variants],
  );

  const loadPreview = useCallback(async () => {
    setBusy("preview");
    setError(null);
    setPreview(null);
    setCompletion(null);
    setBaselineWarning(null);
    try {
      if (owner.kind !== "channel") {
        throw new Error("Listing changes must be started from the owning store connection.");
      }
      const response = await postListingChangeRequest(listingChangesEndpointBase(owner), {
        productIds: [owner.productId],
        rebuild: { mode: "preview" },
      });
      const result = response.results[0];
      if (!result.success || !result.rebuildPreview) {
        throw new Error(result.error ?? "The live listing comparison was unavailable.");
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
      setCompletion(null);
      setBaselineWarning(null);
      return;
    }
    void loadPreview();
  }, [loadPreview, open]);

  const execute = async (mode: "update" | "replace") => {
    if (!preview || owner.kind !== "channel") return;
    setBusy(mode);
    setError(null);
    try {
      const body = mode === "update"
        ? { productIds: [owner.productId], updateExisting: { mode: "execute" as const, preview } }
        : { productIds: [owner.productId], rebuild: { mode: "execute" as const, preview } };
      const response = await postListingChangeRequest(listingChangesEndpointBase(owner), body);
      const result = response.results[0];
      if (!result.success || !result.listingId) {
        throw new Error(result.error ?? `The listing ${mode} did not complete.`);
      }
      setCompletion({ listingId: result.listingId, mode });
      try {
        await refreshListingAnalysis(owner, result.listingId);
      } catch (baselineCause) {
        setBaselineWarning(
          `The eBay change succeeded, but Echelon could not refresh its comparison baseline: ${errorMessage(baselineCause)}`,
        );
      }
      onCompleted?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveVerifiedState = async () => {
    if (!preview || owner.kind !== "channel") return;
    setBusy("update");
    setError(null);
    try {
      await refreshListingAnalysis(owner, preview.currentExternalListingId);
      setCompletion({ listingId: preview.currentExternalListingId, mode: "verify" });
      onCompleted?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const hasMembershipChanges = Boolean(
    preview && (preview.addedSkus.length > 0 || preview.removedSkus.length > 0),
  );

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (busy === null) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review eBay listing changes</DialogTitle>
          <DialogDescription>
            Compare the live eBay listing with Echelon before choosing how to apply changes for {productName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {busy === "preview" && (
            <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the current eBay listing...
            </div>
          )}

          {preview && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Current eBay listing</p>
                  <p className="font-medium">{preview.currentExternalListingId}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{preview.activeSkus.length} buyer-visible variant{preview.activeSkus.length === 1 ? "" : "s"}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Desired Echelon listing</p>
                  <p className="font-medium">{preview.groupKey}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{preview.desiredSkus.length} active variant{preview.desiredSkus.length === 1 ? "" : "s"}</p>
                </div>
              </div>

              <div className="rounded-md border divide-y">
                {[...new Set([...preview.currentSkus, ...preview.desiredSkus])].sort().map((sku) => {
                  const variant = variantsBySku.get(sku);
                  const isActive = preview.activeSkus.includes(sku);
                  const isInactive = preview.inactiveSkus.includes(sku);
                  const isDesired = preview.desiredSkus.includes(sku);
                  const status = !isActive && isDesired
                    ? "Will be added"
                    : isInactive
                      ? "Historical/inactive on eBay - no action needed"
                      : !isDesired
                        ? "Will be removed or disabled"
                        : "Unchanged";
                  return (
                    <div key={sku} className="flex items-center justify-between gap-4 p-3">
                      <div>
                        <p className="font-medium">{variant?.name ?? "eBay variant"}</p>
                        <code className="text-xs text-muted-foreground">{sku}</code>
                      </div>
                      <span className={status === "Unchanged" || status.startsWith("Historical/") ? "text-sm text-muted-foreground" : "text-sm font-medium text-blue-700"}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>

              {!hasMembershipChanges && preview.sourceState === "active" && (
                <div className="flex gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                  The live eBay variants already match Echelon. No listing membership update is needed.
                </div>
              )}

              {hasMembershipChanges && preview.sourceState === "active" && !completion && (
                <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-950">
                  <p className="font-medium">Update the existing listing is recommended.</p>
                  <p className="mt-1">This keeps listing ID {preview.currentExternalListingId} and its history. eBay will validate whether each removed variation can be deleted; a variation with prior sales may need to remain unavailable instead.</p>
                </div>
              )}

              {preview.rebuildRequired && !completion && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">Replace listing is a last resort.</p>
                      <p className="mt-1">This ends the current listing and publishes a new listing ID, so existing listing history is not preserved.</p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {completion && (
            <div className="flex gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              {completion.mode === "verify"
                ? `eBay listing ${completion.listingId} already matched Echelon and is now verified.`
                : completion.mode === "update"
                  ? `Existing eBay listing ${completion.listingId} was updated in place.`
                  : `Replacement eBay listing ${completion.listingId} is live and Echelon now points to it.`}
            </div>
          )}

          {baselineWarning && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              {baselineWarning}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-medium">Listing changes could not be applied.</p>
              <p className="mt-1">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy !== null}>
            {completion ? "Close" : "Cancel"}
          </Button>
          {error && !completion && (
            <Button variant="outline" onClick={() => void loadPreview()} disabled={busy !== null}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Read eBay again
            </Button>
          )}
          {preview && preview.sourceState === "active" && !hasMembershipChanges && !completion && (
            <Button onClick={() => void saveVerifiedState()} disabled={busy !== null}>
              {busy === "update" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save verified state
            </Button>
          )}
          {preview?.rebuildRequired && !completion && (
            <Button variant="outline" onClick={() => void execute("replace")} disabled={busy !== null}>
              {busy === "replace" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Replace listing instead
            </Button>
          )}
          {preview && preview.sourceState === "active" && hasMembershipChanges && !completion && (
            <Button onClick={() => void execute("update")} disabled={busy !== null}>
              {busy === "update" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update existing listing
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function postListingChangeRequest(url: string, body: unknown) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    MARKETPLACE_LISTING_CHANGES_REQUEST_TIMEOUT_MS,
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
    return "The server returned an invalid listing-change response.";
  }
  return cause instanceof Error ? cause.message : "The listing-change request failed.";
}
async function refreshListingAnalysis(
  owner: MarketplaceListingRegistrationOwner,
  externalListingId: string,
): Promise<void> {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("This browser cannot create a secure listing-analysis idempotency key.");
  }
  const ownerId = owner.kind === "channel" ? owner.channelId : owner.storeConnectionId;
  const idempotencyKey = [
    "marketplace-listing-registration",
    owner.kind,
    ownerId,
    owner.marketplaceId,
    owner.productId,
    globalThis.crypto.randomUUID(),
  ].join(":");
  const endpointBase = owner.kind === "channel"
    ? "/api/marketplace-listings/registrations/channel/ebay"
    : "/api/marketplace-listings/registrations/dropship/ebay";
  const requestBody = {
    ...(owner.kind === "channel"
      ? { channelId: owner.channelId }
      : { storeConnectionId: owner.storeConnectionId }),
    productId: owner.productId,
    marketplaceId: owner.marketplaceId,
    providerPublicationKey: null,
    externalListingId,
    idempotencyKey,
  };
  const preview = await postRegistration(
    endpointBase + "/preview",
    requestBody,
    registrationPreviewResponseSchema,
  );
  await postRegistration(
    endpointBase + "/confirm",
    { ...requestBody, expectedObservationHash: preview.preview.observationHash },
    registrationConfirmResponseSchema,
  );
}

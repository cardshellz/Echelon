import { useEffect, useMemo, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import type { MarketplaceListingRegistrationOwner } from "./MarketplaceListingRegistrationDialog";

export interface MarketplaceListingReplacementVariant {
  id: number;
  sku: string;
  name: string;
  included: boolean;
  lockedExcluded?: boolean;
}

interface ReplacementApiErrorPayload {
  code: string;
  message: string;
}

interface ReplacementPlan {
  operationId: number;
  status: string;
  currentPhase: string;
  targetPublicationId: number;
}

type ExecutionResult =
  | { kind: "completed"; stepKey: string }
  | { kind: "failed"; stepKey: string }
  | { kind: "manual_recovery_required"; stepKey: string }
  | { kind: "cancelled"; stepKey: string };

const operationSchema = z
  .object({
    operationId: z.number().int().positive(),
    status: z.string().min(1),
    currentPhase: z.string().min(1),
    targetPublicationId: z.number().int().positive(),
  })
  .passthrough();

const planResponseSchema = z
  .object({
    kind: z.enum(["created", "replay"]),
    operation: operationSchema,
  })
  .passthrough();

const executionResponseSchema = z.object({
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("completed"), stepKey: z.string() }),
    z.object({ kind: z.literal("failed"), stepKey: z.string() }),
    z.object({
      kind: z.literal("manual_recovery_required"),
      stepKey: z.string(),
    }),
    z.object({ kind: z.literal("cancelled"), stepKey: z.string() }),
  ]),
});

export const MARKETPLACE_LISTING_REPLACEMENT_REQUEST_TIMEOUT_MS = 360_000;

export function buildMarketplaceListingReplacementMembers(
  variants: readonly MarketplaceListingReplacementVariant[],
  includedVariantIds: ReadonlySet<number>,
) {
  return variants.map((variant) =>
    includedVariantIds.has(variant.id)
      ? {
          productVariantId: variant.id,
          disposition: "included" as const,
          reasonCode: null,
        }
      : {
          productVariantId: variant.id,
          disposition: "excluded" as const,
          reasonCode: variant.lockedExcluded
            ? "local_variant_inactive"
            : "operator_excluded_from_replacement",
        },
  );
}

export function replacementEndpointBase(
  owner: MarketplaceListingRegistrationOwner,
): string {
  return owner.kind === "channel"
    ? "/api/marketplace-listings/replacements/channel/ebay"
    : "/api/marketplace-listings/replacements/dropship/ebay";
}

export interface MarketplaceListingReplacementDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  owner: MarketplaceListingRegistrationOwner;
  productName: string;
  variants: readonly MarketplaceListingReplacementVariant[];
  onCompleted?(): void;
}

export function MarketplaceListingReplacementDialog({
  open,
  onOpenChange,
  owner,
  productName,
  variants,
  onCompleted,
}: MarketplaceListingReplacementDialogProps) {
  const [includedVariantIds, setIncludedVariantIds] = useState<Set<number>>(
    new Set(),
  );
  const [plan, setPlan] = useState<ReplacementPlan | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [error, setError] = useState<ReplacementApiErrorPayload | null>(null);
  const [busy, setBusy] = useState<"planning" | "executing" | null>(null);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPlan(null);
      setResult(null);
      setError(null);
      setBusy(null);
      keyRef.current = null;
      return;
    }
    setIncludedVariantIds(
      new Set(
        variants
          .filter((variant) => variant.included)
          .map((variant) => variant.id),
      ),
    );
    keyRef.current = createReplacementIdempotencyKey(owner);
  }, [open, owner, variants]);

  const members = useMemo(
    () =>
      buildMarketplaceListingReplacementMembers(variants, includedVariantIds),
    [includedVariantIds, variants],
  );
  const endpointBase = replacementEndpointBase(owner);
  const ownerBody =
    owner.kind === "channel"
      ? {
          channelId: owner.channelId,
          productId: owner.productId,
          marketplaceId: owner.marketplaceId,
        }
      : {
          storeConnectionId: owner.storeConnectionId,
          productId: owner.productId,
          marketplaceId: owner.marketplaceId,
        };

  const planReplacement = async () => {
    if (!keyRef.current || includedVariantIds.size === 0) return;
    setBusy("planning");
    setError(null);
    setResult(null);
    try {
      const response = await postReplacement(
        endpointBase + "/plan",
        {
          ...ownerBody,
          targetMembers: members,
          idempotencyKey: keyRef.current,
        },
        planResponseSchema,
      );
      setPlan(response.operation);
    } catch (requestError) {
      setError(normalizeReplacementError(requestError));
    } finally {
      setBusy(null);
    }
  };

  const executeReplacement = async () => {
    if (!plan) return;
    setBusy("executing");
    setError(null);
    try {
      const response = await postReplacement(
        `${endpointBase}/${plan.operationId}/execute`,
        ownerBody,
        executionResponseSchema,
      );
      setResult(response.result);
      if (response.result.kind === "completed") onCompleted?.();
    } catch (requestError) {
      setError(normalizeReplacementError(requestError));
    } finally {
      setBusy(null);
    }
  };

  const succeeded = result?.kind === "completed";
  const locked = plan !== null || busy !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Replace live eBay listing</DialogTitle>
          <DialogDescription>
            Build a new listing for {productName} with exactly the selected
            variants, verify it, then switch Echelon to the new listing.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-6 space-y-4">
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <div className="flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                Execution temporarily withdraws the current listing before
                publishing the replacement. If publication fails, Echelon
                attempts to remove the target and restore the source. A failed
                restoration is reported as manual recovery required.
              </p>
            </div>
          </div>

          <div className="rounded-md border divide-y">
            {variants.map((variant) => (
              <div
                key={variant.id}
                className="flex items-center justify-between gap-4 p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{variant.name}</p>
                  <code className="text-xs text-muted-foreground">
                    {variant.sku}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {variant.lockedExcluded
                      ? "Archived - will be removed"
                      : includedVariantIds.has(variant.id) ? "Included" : "Excluded"}
                  </span>
                  <Switch
                    checked={includedVariantIds.has(variant.id)}
                    disabled={locked || variant.lockedExcluded === true}
                    onCheckedChange={(checked) => {
                      setIncludedVariantIds((current) => {
                        const next = new Set(current);
                        if (checked) next.add(variant.id);
                        else next.delete(variant.id);
                        return next;
                      });
                    }}
                    aria-label={variant.lockedExcluded ? `${variant.sku} is archived and will be removed` : `${includedVariantIds.has(variant.id) ? "Exclude" : "Include"} ${variant.sku}`}
                  />
                </div>
              </div>
            ))}
          </div>

          {includedVariantIds.size === 0 && (
            <p className="text-sm text-red-700">
              Select at least one variant for the replacement listing.
            </p>
          )}
          {plan && !result && (
            <div className="rounded-md border border-blue-300 bg-blue-50 p-4 text-sm text-blue-950">
              Plan #{plan.operationId} is ready. Target publication #
              {plan.targetPublicationId} will contain {includedVariantIds.size}{" "}
              of {variants.length} variants. Review this count before executing.
            </div>
          )}
          {result && (
            <div
              className={`rounded-md border p-4 text-sm ${succeeded ? "border-green-300 bg-green-50 text-green-950" : "border-red-300 bg-red-50 text-red-950"}`}
            >
              <div className="flex gap-2">
                {succeeded ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5" />
                ) : (
                  <AlertTriangle className="h-4 w-4 mt-0.5" />
                )}
                <p>{executionResultMessage(result)}</p>
              </div>
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-950">
              <p className="font-medium">{error.message}</p>
              <code className="text-xs">{error.code}</code>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t">
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => onOpenChange(false)}
          >
            {succeeded ? "Close" : "Cancel"}
          </Button>
          {!plan && !result && (
            <Button
              disabled={busy !== null || includedVariantIds.size === 0}
              onClick={planReplacement}
            >
              {busy === "planning" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Review replacement
            </Button>
          )}
          {plan && !result && (
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={executeReplacement}
            >
              {busy === "executing" && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Replace listing
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function postReplacement<T extends z.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: T,
): Promise<z.output<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    MARKETPLACE_LISTING_REPLACEMENT_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(payload);
      throw parsed.success
        ? parsed.data.error
        : {
            code: "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_FAILED",
            message: `Replacement request failed (${response.status}).`,
          };
    }
    return schema.parse(payload);
  } finally {
    window.clearTimeout(timeout);
  }
}

function createReplacementIdempotencyKey(
  owner: MarketplaceListingRegistrationOwner,
): string {
  if (!globalThis.crypto?.randomUUID)
    throw new Error("Secure UUID generation is unavailable.");
  const scope =
    owner.kind === "channel"
      ? `channel-${owner.channelId}`
      : `dropship-${owner.storeConnectionId}`;
  return `marketplace-replacement:${scope}:${owner.productId}:${globalThis.crypto.randomUUID()}`;
}

function normalizeReplacementError(error: unknown): ReplacementApiErrorPayload {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
  ) {
    return { code: String(error.code), message: String(error.message) };
  }
  if (error instanceof z.ZodError)
    return {
      code: "MARKETPLACE_LISTING_REPLACEMENT_RESPONSE_INVALID",
      message: "The server returned an invalid replacement response.",
    };
  if (error instanceof DOMException && error.name === "AbortError")
    return {
      code: "MARKETPLACE_LISTING_REPLACEMENT_TIMEOUT",
      message:
        "The replacement request timed out. Check operation status before retrying.",
    };
  return {
    code: "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_FAILED",
    message:
      error instanceof Error
        ? error.message
        : "The replacement request failed.",
  };
}

function executionResultMessage(result: ExecutionResult): string {
  switch (result.kind) {
    case "completed":
      return "Replacement completed and Echelon now controls the new listing.";
    case "failed":
      return "Replacement failed, and compensation restored the previous listing state.";
    case "manual_recovery_required":
      return "Automatic recovery failed. Do not retry blindly; manual eBay recovery is required.";
    case "cancelled":
      return "The replacement operation was cancelled before completion.";
  }
}

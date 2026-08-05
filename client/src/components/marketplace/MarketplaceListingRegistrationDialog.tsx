import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type MarketplaceListingRegistrationOwner =
  | Readonly<{
      kind: "channel";
      channelId: number;
      productId: number;
      marketplaceId: string;
    }>
  | Readonly<{
      kind: "dropship";
      storeConnectionId: number;
      productId: number;
      marketplaceId: string;
    }>;

interface RegistrationPreviewMember {
  productVariantId: number;
  skuSnapshot: string;
  isActiveSnapshot: boolean;
  availableQuantitySnapshot: number;
  disposition: "included" | "excluded";
  reasonCode: string | null;
  externalOfferId: string | null;
  externalVariantId: string | null;
  externalVariantIdentityNamespace: string | null;
  externalOfferIdentityNamespace: string | null;
  externalInventoryItemId: string | null;
  externalInventoryItemIdentityNamespace: string | null;
}

interface RegistrationPreview {
  providerAccount: {
    accountNamespace: string;
    externalAccountId: string;
    externalDisplayNameSnapshot: string | null;
  };
  providerPublicationKey: string | null;
  externalListingId: string;
  members: RegistrationPreviewMember[];
  observationHash: string;
  observedAt: string;
}

interface RegistrationReceipt {
  registrationId: number;
  publicationId: number;
  registeredAt: string;
}

interface RegistrationApiErrorPayload {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

class RegistrationApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: RegistrationApiErrorPayload,
  ) {
    super(payload.message);
    this.name = "RegistrationApiError";
  }
}

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const registrationPreviewMemberSchema: z.ZodType<RegistrationPreviewMember> = z
  .object({
    productVariantId: positiveSafeIntegerSchema,
    skuSnapshot: z.string().trim().min(1).max(100),
    isActiveSnapshot: z.boolean(),
    availableQuantitySnapshot: z.number().int().safe(),
    disposition: z.enum(["included", "excluded"]),
    reasonCode: z.string().nullable(),
    externalVariantId: z.string().max(255).nullable(),
    externalVariantIdentityNamespace: z.string().max(160).nullable(),
    externalOfferId: z.string().max(255).nullable(),
    externalOfferIdentityNamespace: z.string().max(160).nullable(),
    externalInventoryItemId: z.string().max(255).nullable(),
    externalInventoryItemIdentityNamespace: z.string().max(160).nullable(),
  })
  .strict();

const registrationPreviewSchema: z.ZodType<RegistrationPreview> = z.object({
  providerAccount: z.object({
    accountNamespace: z.string().trim().min(1).max(100),
    externalAccountId: z.string().trim().min(1).max(255),
    externalDisplayNameSnapshot: z.string().nullable(),
  }),
  providerPublicationKey: z.string().nullable(),
  externalListingId: z.string().trim().min(1).max(255),
  members: z.array(registrationPreviewMemberSchema).min(1).max(10_000),
  observationHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.string().datetime(),
});

const registrationReceiptSchema: z.ZodType<RegistrationReceipt> = z.object({
  registrationId: positiveSafeIntegerSchema,
  publicationId: positiveSafeIntegerSchema,
  registeredAt: z.string().datetime(),
});

export const registrationPreviewResponseSchema = z.object({
  preview: registrationPreviewSchema,
});

const registrationConfirmResponseSchema = z.object({
  result: z.object({
    kind: z.enum(["created", "replay"]),
    receipt: registrationReceiptSchema,
  }),
});

export const MARKETPLACE_LISTING_REGISTRATION_REQUEST_TIMEOUT_MS = 120_000;

export interface MarketplaceListingRegistrationDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  owner: MarketplaceListingRegistrationOwner;
  productName: string;
  externalListingId: string;
  onRegistered?(receipt: RegistrationReceipt): void;
}

export function MarketplaceListingRegistrationDialog({
  open,
  onOpenChange,
  owner,
  productName,
  externalListingId,
  onRegistered,
}: MarketplaceListingRegistrationDialogProps) {
  const [preview, setPreview] = useState<RegistrationPreview | null>(null);
  const [receipt, setReceipt] = useState<RegistrationReceipt | null>(null);
  const [error, setError] = useState<RegistrationApiErrorPayload | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => () => {
    requestVersionRef.current += 1;
    requestAbortControllerRef.current?.abort();
    requestAbortControllerRef.current = null;
  }, []);

  const requestAbortControllerRef = useRef<AbortController | null>(null);
  const endpointBase =
    owner.kind === "channel"
      ? "/api/marketplace-listings/registrations/channel/ebay"
      : "/api/marketplace-listings/registrations/dropship/ebay";

  const requestBody = useMemo(
    () => ({
      ...(owner.kind === "channel"
        ? { channelId: owner.channelId }
        : { storeConnectionId: owner.storeConnectionId }),
      productId: owner.productId,
      marketplaceId: owner.marketplaceId,
      providerPublicationKey: null,
      externalListingId,
    }),
    [externalListingId, owner],
  );

  const loadPreview = useCallback(async () => {
    const idempotencyKey = idempotencyKeyRef.current;
    if (!idempotencyKey) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    requestAbortControllerRef.current?.abort();
    const requestController = new AbortController();
    requestAbortControllerRef.current = requestController;
    setIsPreviewing(true);
    setError(null);
    try {
      const response = await postRegistration(
        endpointBase + "/preview",
        { ...requestBody, idempotencyKey },
        registrationPreviewResponseSchema,
        { signal: requestController.signal },
      );
      if (requestVersionRef.current !== requestVersion) return;
      setPreview(response.preview);
    } catch (requestError) {
      if (requestVersionRef.current !== requestVersion) return;
      setPreview(null);
      setError(normalizeRegistrationError(requestError));
    } finally {
      if (requestVersionRef.current === requestVersion) {
        setIsPreviewing(false);
        if (requestAbortControllerRef.current === requestController) {
          requestAbortControllerRef.current = null;
        }
      }
    }
  }, [endpointBase, requestBody]);

  useEffect(() => {
    if (!open) {
      requestVersionRef.current += 1;
      setPreview(null);
      setReceipt(null);
      requestAbortControllerRef.current?.abort();
      requestAbortControllerRef.current = null;
      setError(null);
      setIsPreviewing(false);
      setIsConfirming(false);
      idempotencyKeyRef.current = null;
      return;
    }

    try {
      idempotencyKeyRef.current = createRegistrationIdempotencyKey(owner);
    } catch (keyError) {
      setPreview(null);
      setReceipt(null);
      setError(normalizeRegistrationError(keyError));
      setIsPreviewing(false);
      return;
    }
    setReceipt(null);
    void loadPreview();
  }, [loadPreview, open, owner]);

  const includedMembers = preview?.members.filter(
    (member) => member.disposition === "included",
  ) ?? [];
  const inactiveIncludedMembers = includedMembers.filter(
    (member) => !member.isActiveSnapshot,
  );
  const zeroQuantityIncludedMembers = includedMembers.filter(
    (member) => member.availableQuantitySnapshot === 0,
  );

  const confirm = async () => {
    if (!preview || !idempotencyKeyRef.current) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    requestAbortControllerRef.current?.abort();
    const requestController = new AbortController();
    requestAbortControllerRef.current = requestController;
    setIsConfirming(true);
    setError(null);
    try {
      const response = await postRegistration(
        endpointBase + "/confirm",
        {
          ...requestBody,
          idempotencyKey: idempotencyKeyRef.current,
          expectedObservationHash: preview.observationHash,
        },
        registrationConfirmResponseSchema,
        { signal: requestController.signal },
      );
      if (requestVersionRef.current !== requestVersion) return;
      setReceipt(response.result.receipt);
      onRegistered?.(response.result.receipt);
    } catch (requestError) {
      if (requestVersionRef.current !== requestVersion) return;
      setError(normalizeRegistrationError(requestError));
    } finally {
      if (requestVersionRef.current === requestVersion) {
        setIsConfirming(false);
        if (requestAbortControllerRef.current === requestController) {
          requestAbortControllerRef.current = null;
        }
      }
    }
  };

  const refreshPreview = () => {
    try {
      idempotencyKeyRef.current = createRegistrationIdempotencyKey(owner);
      setReceipt(null);
      void loadPreview();
    } catch (keyError) {
      setPreview(null);
      setReceipt(null);
      setError(normalizeRegistrationError(keyError));
      setIsPreviewing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isConfirming) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-4xl max-h-[90vh] flex flex-col p-0"
        onEscapeKeyDown={(event) => { if (isConfirming) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (isConfirming) event.preventDefault(); }}
      >
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Analyze live eBay listing</DialogTitle>
          <DialogDescription>
            Compare the listing currently on eBay with Echelon&apos;s intended variants
            for {productName}. This reads eBay and records the reviewed state;
            it does not edit, end, or relist anything on eBay.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-6 pb-2 space-y-4">
          {isPreviewing && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the complete live listing from eBay...
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">{error.message}</p>
                  <p className="mt-1 text-xs font-mono break-all">{error.code}</p>
                  {formatRegistrationErrorContext(error.context) && (
                    <p className="mt-1 text-xs">
                      {formatRegistrationErrorContext(error.context)}
                    </p>
                  )}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={refreshPreview}
                disabled={isPreviewing || isConfirming}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Read eBay again
              </Button>
            </div>
          )}

          {receipt && (
            <div className="rounded-md border border-green-300 bg-green-50 p-4 text-sm text-green-900">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Baseline registered</p>
                  <p className="mt-1">
                    Registration {receipt.registrationId} now protects publication{" "}
                    {receipt.publicationId} as the current live baseline.
                  </p>
                </div>
              </div>
            </div>
          )}

          {preview && !receipt && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <PreviewFact
                  label="Seller account"
                  value={
                    preview.providerAccount.externalDisplayNameSnapshot ||
                    preview.providerAccount.externalAccountId
                  }
                  detail={preview.providerAccount.accountNamespace}
                />
                <PreviewFact
                  label="eBay listing"
                  value={preview.externalListingId}
                  detail="Live listing ID"
                />
                <PreviewFact
                  label="Variation group"
                  value={preview.providerPublicationKey || "Single variation"}
                  detail={
                    includedMembers.length +
                    " observed variant" +
                    (includedMembers.length === 1 ? "" : "s")
                  }
                />
              </div>

              {inactiveIncludedMembers.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                  <div className="flex items-start gap-2">
                    <Archive className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>
                      eBay still contains {inactiveIncludedMembers.length} archived local
                      variant{inactiveIncludedMembers.length === 1 ? "" : "s"}. Registration
                      preserves that fact so a later replacement can remove the stale
                      variation safely.
                    </p>
                  </div>
                </div>
              )}

              {zeroQuantityIncludedMembers.length > 0 && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                  {zeroQuantityIncludedMembers.length} included variant
                  {zeroQuantityIncludedMembers.length === 1 ? " has" : "s have"} zero
                  local availability. Zero quantity does not remove a variation from the
                  observed eBay group.
                </div>
              )}

              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Local state</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead>Observed on eBay</TableHead>
                      <TableHead>Offer ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.members.map((member) => (
                      <TableRow key={member.productVariantId}>
                        <TableCell className="font-mono text-xs">
                          {member.skuSnapshot}
                        </TableCell>
                        <TableCell>
                          {member.isActiveSnapshot ? (
                            <Badge variant="outline">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Archived</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {member.availableQuantitySnapshot.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {member.disposition === "included" ? (
                            <Badge className="bg-blue-600 hover:bg-blue-600">
                              Included
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Not in live listing
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {member.externalOfferId || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4 shrink-0" />
                Confirm re-reads eBay before saving. If the seller account, listing,
                group, offers, or members changed after this preview, registration stops
                and requires a new review.
              </div>
            </>
          )}
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isConfirming}
          >
            {receipt ? "Close" : "Cancel"}
          </Button>
          {!receipt && (
            <Button
              type="button"
              onClick={confirm}
              disabled={!preview || isPreviewing || isConfirming}
            >
              {isConfirming && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save listing analysis
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewFact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium break-all">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export async function postRegistration<Output>(
  url: string,
  body: Record<string, unknown>,
  responseSchema: z.ZodType<Output>,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<Output> {
  const timeoutMs = options.timeoutMs ?? MARKETPLACE_LISTING_REGISTRATION_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RegistrationApiError(0, {
      code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_CONFIG_INVALID",
      message: "The listing-registration request timeout is invalid.",
    });
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    try {
      payload = await response.json();
    } catch (error) {
      if (timedOut || controller.signal.aborted) throw error;
      payload = null;
    }
  } catch (error) {
    if (timedOut) {
      throw new RegistrationApiError(504, {
        code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_TIMEOUT",
        message: "The listing-registration request timed out. No successful registration was confirmed.",
        context: { timeoutMs },
      });
    }
    if (controller.signal.aborted) {
      throw new RegistrationApiError(0, {
        code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_CANCELLED",
        message: "The listing-registration request was cancelled.",
      });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  if (!response.ok) {
    const error =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
        ? (payload.error as Partial<RegistrationApiErrorPayload>)
        : null;
    throw new RegistrationApiError(response.status, {
      code:
        typeof error?.code === "string"
          ? error.code
          : "MARKETPLACE_LISTING_REGISTRATION_REQUEST_FAILED",
      message:
        typeof error?.message === "string"
          ? error.message
          : "Marketplace listing registration request failed.",
      context:
        error?.context && typeof error.context === "object"
          ? error.context
          : undefined,
    });
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RegistrationApiError(502, {
      code: "MARKETPLACE_LISTING_REGISTRATION_RESPONSE_INVALID",
      message: "The server returned an invalid listing-registration response.",
      context: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

function formatRegistrationErrorContext(
  context: Record<string, unknown> | undefined,
): string | null {
  if (!context) return null;
  const details: string[] = [];
  if (typeof context.resource === "string") details.push(`eBay resource: ${context.resource}`);
  if (typeof context.sku === "string") details.push(`SKU: ${context.sku}`);
  if (typeof context.groupKey === "string") details.push(`Group: ${context.groupKey}`);
  if (typeof context.status === "number") details.push(`HTTP status: ${context.status}`);
  return details.length > 0 ? details.join(" | ") : null;
}

function normalizeRegistrationError(error: unknown): RegistrationApiErrorPayload {
  if (error instanceof RegistrationApiError) return error.payload;
  return {
    code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_FAILED",
    message:
      error instanceof Error
        ? error.message
        : "Marketplace listing registration request failed.",
  };
}

function createRegistrationIdempotencyKey(
  owner: MarketplaceListingRegistrationOwner,
): string {
  if (
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.randomUUID !== "function"
  ) {
    throw new RegistrationApiError(0, {
      code: "MARKETPLACE_LISTING_REGISTRATION_IDEMPOTENCY_UNAVAILABLE",
      message:
        "This browser cannot create a secure listing-registration idempotency key.",
    });
  }
  const ownerId =
    owner.kind === "channel" ? owner.channelId : owner.storeConnectionId;
  return (
    "marketplace-listing-registration:" +
    owner.kind +
    ":" +
    ownerId +
    ":" +
    owner.marketplaceId +
    ":" +
    owner.productId +
    ":" +
    globalThis.crypto.randomUUID()
  );
}

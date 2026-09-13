import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GitMerge,
  Loader2,
  RefreshCw,
} from "lucide-react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  applyShopifyOwnershipRepair,
  fetchShopifyOwnershipReview,
  SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS,
  ShopifyOwnershipRepairApiError,
  shopifyOwnershipReviewFilterSchema,
  type ShopifyOwnershipRepairRequest,
  type ShopifyOwnershipReviewFilter,
  type ShopifyDuplicateOwnershipGroup,
} from "@/lib/shopify-ownership-review";
import {
  fetchShopifyProductConsolidationPreview,
  type ShopifyProductConsolidationPreview,
} from "@/lib/shopify-product-consolidation";

const PAGE_SIZE = 20;

const decisionReasonLabels = {
  single_active_owner_with_matching_evidence:
    "One active owner has matching catalog and channel evidence",
  remote_product_missing: "The Shopify product no longer exists",
  owner_count_exceeds_two: "More than two local products claim this product",
  owner_count_exceeds_safe_limit:
    "More than 100 local products claim this product",
  shipping_group_conflict: "The local owners use different shipping groups",
  owner_mapping_conflict: "At least one owner has conflicting mapping evidence",
  multiple_active_owners: "More than one local owner has active variants",
  no_active_owner: "None of the local owners has active variants",
  active_owner_catalog_id_mismatch:
    "The active owner's catalog product ID does not match",
  active_owner_missing_channel_evidence:
    "The active owner lacks matching channel evidence",
} as const;

export function ShopifyOwnershipReview({
  channelId,
  onOpenProduct,
  canRepair = false,
  onRepairApplied,
}: {
  channelId: number;
  onOpenProduct: (productId: number) => void;
  canRepair?: boolean;
  onRepairApplied?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ShopifyOwnershipReviewFilter>("all");
  const [page, setPage] = useState(1);
  const [showRepairDialog, setShowRepairDialog] = useState(false);
  const [repairReason, setRepairReason] = useState("");
  const [repairDraft, setRepairDraft] = useState<{
    expectedShopDomain: string;
    recommendations: ShopifyOwnershipRepairRequest["recommendations"];
    detachedProductCount: number;
    totalAvailableRecommendationCount: number;
    idempotencyKey: string;
  } | null>(null);
  const pendingRequest = useRef<ShopifyOwnershipRepairRequest | null>(null);
  const [showConsolidationDialog, setShowConsolidationDialog] = useState(false);
  const [consolidationDraft, setConsolidationDraft] = useState<{
    group: ShopifyDuplicateOwnershipGroup;
    canonicalProductId: number | null;
  } | null>(null);
  const reviewQuery = useQuery({
    queryKey: [
      "/api/channels",
      channelId,
      "shopify-mapping-reconciliation",
      "ownership-review",
      filter,
      page,
      PAGE_SIZE,
    ],
    queryFn: () => fetchShopifyOwnershipReview({
      channelId,
      filter,
      page,
      pageSize: PAGE_SIZE,
    }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const review = reviewQuery.data;
  const totalPages = review?.pagination.totalPages ?? 0;
  const prepareRepairMutation = useMutation({
    mutationFn: () => fetchShopifyOwnershipReview({
      channelId,
      filter: "canonical_owner_recommended",
      page: 1,
      pageSize: SHOPIFY_OWNERSHIP_REPAIR_MAX_GROUPS,
    }),
    onSuccess: (latestReview) => {
      if (latestReview.items.length === 0) {
        toast({
          title: "No clear recommendations remain",
          description: "The ownership review is already current.",
        });
        void reviewQuery.refetch();
        return;
      }
      pendingRequest.current = null;
      setRepairReason("");
      setRepairDraft({
        expectedShopDomain: latestReview.channel.shopDomain,
        recommendations: latestReview.items.map((group) => ({
          shopifyProductId: group.shopifyProductId,
          expectedPreviewHash: group.previewHash,
        })),
        detachedProductCount: latestReview.items.reduce(
          (count, group) => count + group.nonCanonicalProductIds.length,
          0,
        ),
        totalAvailableRecommendationCount:
          latestReview.pagination.totalItems,
        idempotencyKey: crypto.randomUUID(),
      });
      setShowRepairDialog(true);
    },
  });
  const applyRepairMutation = useMutation({
    mutationFn: async () => {
      if (!repairDraft) throw new Error("Repair review is not loaded");
      const request = pendingRequest.current ?? {
        expectedShopDomain: repairDraft.expectedShopDomain,
        recommendations: repairDraft.recommendations,
        idempotencyKey: repairDraft.idempotencyKey,
        reason: repairReason,
      };
      pendingRequest.current = request;
      return applyShopifyOwnershipRepair({ channelId, request });
    },
    onSuccess: (result) => {
      pendingRequest.current = null;
      setRepairDraft(null);
      setRepairReason("");
      setShowRepairDialog(false);
      setPage(1);
      void queryClient.invalidateQueries({
        queryKey: [
          "/api/channels",
          channelId,
          "shopify-mapping-reconciliation",
        ],
      });
      onRepairApplied?.();
      toast({
        title: "Duplicate ownership resolved",
        description:
          `${result.resolvedGroupCount} Shopify products kept one canonical owner; `
          + `${result.detachedProductIds.length} inactive owners were detached.`,
      });
    },
  });
  const consolidationPreviewMutation = useMutation<
    ShopifyProductConsolidationPreview,
    Error,
    { shopifyProductId: string; canonicalProductId: number }
  >({
    mutationFn: (request) => fetchShopifyProductConsolidationPreview({
      channelId,
      ...request,
    }),
  });

  const openRepairReview = () => {
    if (repairDraft) {
      setShowRepairDialog(true);
      return;
    }
    prepareRepairMutation.mutate();
  };
  const canRefreshRejectedRepair = applyRepairMutation.error
    instanceof ShopifyOwnershipRepairApiError
    && [
      "SHOPIFY_OWNERSHIP_REPAIR_PREVIEW_STALE",
      "SHOPIFY_OWNERSHIP_REPAIR_REVIEW_REQUIRED",
      "SHOPIFY_OWNERSHIP_REPAIR_ACTIVE_VARIANT",
      "SHOPIFY_OWNERSHIP_REPAIR_SCOPE_OVERLAP",
      "SHOPIFY_MAPPING_STORE_CHANGED",
    ].includes(applyRepairMutation.error.code ?? "");
  const refreshRejectedRepair = () => {
    pendingRequest.current = null;
    setRepairDraft(null);
    setRepairReason("");
    setShowRepairDialog(false);
    applyRepairMutation.reset();
    prepareRepairMutation.mutate();
  };
  const openConsolidationReview = (group: ShopifyDuplicateOwnershipGroup) => {
    consolidationPreviewMutation.reset();
    setConsolidationDraft({
      group,
      canonicalProductId: group.recommendedProductId,
    });
    setShowConsolidationDialog(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border border-blue-200 bg-blue-50 p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2 text-sm text-blue-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Review evidence is read-only. Mappings change only after an
            authorized explicit apply.
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canRepair && (review?.summary.canonicalOwnerRecommendationCount ?? 0) > 0 && (
            <Button
              size="sm"
              disabled={
                prepareRepairMutation.isPending
                || applyRepairMutation.isPending
              }
              onClick={openRepairReview}
            >
              {prepareRepairMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {repairDraft ? "Resume reviewed repair" : "Resolve clear recommendations"}
            </Button>
          )}
          <Select
            value={filter}
            onValueChange={(value) => {
              setFilter(shopifyOwnershipReviewFilterSchema.parse(value));
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-[210px] bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ownership conflicts</SelectItem>
              <SelectItem value="canonical_owner_recommended">
                Clear recommendations
              </SelectItem>
              <SelectItem value="manual_review">Manual review</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 bg-white"
            aria-label="Refresh ownership review"
            title="Refresh ownership review"
            disabled={reviewQuery.isFetching}
            onClick={() => void reviewQuery.refetch()}
          >
            {reviewQuery.isFetching
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {prepareRepairMutation.error && (
        <div role="alert" className="border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {prepareRepairMutation.error.message}
        </div>
      )}

      {reviewQuery.isLoading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading ownership evidence
        </div>
      ) : reviewQuery.error ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 border border-red-200 bg-red-50 p-4 text-center">
          <div className="flex items-center gap-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4" />
            {reviewQuery.error.message}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reviewQuery.refetch()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      ) : review ? (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span>
              <strong>{review.summary.duplicateOwnershipGroupCount}</strong>
              {" "}ownership conflicts
            </span>
            <span className="text-green-700">
              <strong>
                {review.summary.canonicalOwnerRecommendationCount}
              </strong>
              {" "}clear recommendations
            </span>
            <span className="text-red-700">
              <strong>
                {review.summary.manualReviewOwnershipGroupCount}
              </strong>
              {" "}require manual review
            </span>
            <span className="text-xs text-muted-foreground sm:ml-auto">
              {new Date(review.generatedAt).toLocaleString()}
            </span>
          </div>

          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shopify product</TableHead>
                  <TableHead>Local owners</TableHead>
                  <TableHead className="w-[280px]">Review result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {review.items.map((group) => (
                  <TableRow key={group.shopifyProductId}>
                    <TableCell className="align-top">
                      <div className="font-medium">
                        {group.remoteTitle ?? "Not found in Shopify"}
                      </div>
                      <code className="text-xs text-muted-foreground">
                        {group.shopifyProductId}
                      </code>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {new Set(group.owners.map(
                          (owner) => owner.shippingGroupCode,
                        )).size > 1
                          ? "Conflicting shipping groups"
                          : group.shippingGroupCode ?? "No shipping group"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-3">
                        {group.owners.map((owner) => {
                          const isRecommended =
                            owner.productId === group.recommendedProductId;
                          return (
                            <div key={owner.productId}>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  variant="link"
                                  size="sm"
                                  className="h-auto p-0 text-left font-medium"
                                  onClick={() => onOpenProduct(owner.productId)}
                                >
                                  {owner.productName}
                                </Button>
                                {isRecommended && (
                                  <Badge
                                    variant="outline"
                                    className="border-green-300 text-green-700"
                                  >
                                    Recommended owner
                                  </Badge>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {owner.productSku ?? `Product #${owner.productId}`}
                                {" / "}
                                {owner.activeVariantCount} active variants
                                {" / "}
                                {owner.mappingStatus}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      {group.decision === "canonical_owner_recommended" ? (
                        <Badge
                          variant="outline"
                          className="border-green-300 text-green-700"
                        >
                          <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                          Clear recommendation
                        </Badge>
                      ) : (
                        <Badge variant="destructive">Manual review</Badge>
                      )}
                      <div className="mt-2 text-xs text-muted-foreground">
                        {decisionReasonLabels[group.reason]}
                      </div>
                      {canRepair && group.decision === "manual_review" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => openConsolidationReview(group)}
                        >
                          <GitMerge className="mr-2 h-4 w-4" />
                          Review product consolidation
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {review.items.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No ownership conflicts match this filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-2">
              <span className="text-xs text-muted-foreground">
                Page {review.pagination.page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Previous ownership page"
                title="Previous page"
                disabled={page <= 1 || reviewQuery.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Next ownership page"
                title="Next page"
                disabled={page >= totalPages || reviewQuery.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      ) : null}

      <Dialog
        open={showRepairDialog}
        onOpenChange={(open) => {
          if (!applyRepairMutation.isPending) setShowRepairDialog(open);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Apply reviewed Shopify ownership repair?</DialogTitle>
            <DialogDescription>
              This keeps the one active, evidence-matched Echelon product as
              owner and detaches only inactive duplicate owners. Products,
              variants, and history are retained. Changed or ambiguous evidence
              is rejected by the server.
            </DialogDescription>
          </DialogHeader>
          {repairDraft && (
            <div className="space-y-4">
              <div className="border bg-muted/30 p-3 text-sm">
                <div>
                  <strong>{repairDraft.recommendations.length}</strong>
                  {" "}Shopify ownership conflicts in this batch
                </div>
                <div>
                  <strong>{repairDraft.detachedProductCount}</strong>
                  {" "}inactive local owners will be detached
                </div>
                {repairDraft.totalAvailableRecommendationCount
                  > repairDraft.recommendations.length && (
                  <div className="mt-2 text-amber-700">
                    {repairDraft.totalAvailableRecommendationCount
                      - repairDraft.recommendations.length}
                    {" "}additional clear recommendations require another batch.
                  </div>
                )}
              </div>
              {pendingRequest.current && (
                <div className="border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  The prior result was uncertain. Retry sends the exact same
                  command and idempotency key; its scope and reason are locked.
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="shopify-ownership-repair-reason">
                  Audit reason
                </Label>
                <Textarea
                  id="shopify-ownership-repair-reason"
                  value={pendingRequest.current?.reason ?? repairReason}
                  onChange={(event) => setRepairReason(event.target.value)}
                  disabled={Boolean(pendingRequest.current)}
                  maxLength={500}
                  rows={3}
                  placeholder="Why are these reviewed duplicate owners being detached?"
                />
              </div>
              {applyRepairMutation.error && (
                <div role="alert" className="border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {applyRepairMutation.error.message}
                  {canRefreshRejectedRepair && (
                    <Button
                      variant="link"
                      size="sm"
                      className="ml-2 h-auto p-0 text-red-700 underline"
                      onClick={refreshRejectedRepair}
                    >
                      Refresh evidence
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={applyRepairMutation.isPending}
              onClick={() => setShowRepairDialog(false)}
            >
              Close
            </Button>
            <Button
              disabled={
                applyRepairMutation.isPending
                || !repairDraft
                || (!pendingRequest.current && !repairReason.trim())
              }
              onClick={() => applyRepairMutation.mutate()}
            >
              {applyRepairMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {pendingRequest.current ? "Retry same repair" : "Apply reviewed repair"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showConsolidationDialog}
        onOpenChange={(open) => {
          if (!consolidationPreviewMutation.isPending) {
            setShowConsolidationDialog(open);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review one canonical Echelon product</DialogTitle>
            <DialogDescription>
              This preview traces inventory and operational dependencies before
              any product or variant identity can be consolidated. Previewing
              never changes Echelon or Shopify.
            </DialogDescription>
          </DialogHeader>

          {consolidationDraft && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-2">
                  <Label htmlFor="canonical-product-owner">
                    Product to keep as the canonical owner
                  </Label>
                  <Select
                    value={consolidationDraft.canonicalProductId?.toString() ?? ""}
                    onValueChange={(value) => {
                      consolidationPreviewMutation.reset();
                      setConsolidationDraft((current) => current ? {
                        ...current,
                        canonicalProductId: Number(value),
                      } : current);
                    }}
                  >
                    <SelectTrigger id="canonical-product-owner">
                      <SelectValue placeholder="Choose the product to keep" />
                    </SelectTrigger>
                    <SelectContent>
                      {consolidationDraft.group.owners.map((owner) => (
                        <SelectItem
                          key={owner.productId}
                          value={owner.productId.toString()}
                        >
                          {owner.productName} ({owner.productSku ?? `#${owner.productId}`})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  disabled={
                    consolidationDraft.canonicalProductId === null
                    || consolidationPreviewMutation.isPending
                  }
                  onClick={() => {
                    if (consolidationDraft.canonicalProductId === null) return;
                    consolidationPreviewMutation.mutate({
                      shopifyProductId:
                        consolidationDraft.group.shopifyProductId,
                      canonicalProductId:
                        consolidationDraft.canonicalProductId,
                    });
                  }}
                >
                  {consolidationPreviewMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Load current evidence
                </Button>
              </div>

              {consolidationPreviewMutation.error && (
                <div role="alert" className="border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {consolidationPreviewMutation.error.message}
                </div>
              )}

              {consolidationPreviewMutation.data && (
                <ConsolidationPreview
                  preview={consolidationPreviewMutation.data}
                />
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={consolidationPreviewMutation.isPending}
              onClick={() => setShowConsolidationDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConsolidationPreview({
  preview,
}: {
  preview: ShopifyProductConsolidationPreview;
}) {
  const actionsByVariant = new Map(
    preview.plan.actions.map((action) => [action.sourceVariantId, action]),
  );
  return (
    <div className="space-y-4">
      <div className={preview.plan.canApply
        ? "border border-green-200 bg-green-50 p-3 text-sm text-green-800"
        : "border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"}
      >
        {preview.plan.canApply
          ? "No blocking dependency was found in this snapshot. This screen remains preview-only."
          : `${preview.plan.blockers.length} blocking dependencies must be resolved before consolidation.`}
        <div className="mt-1 font-mono text-[11px] opacity-75">
          Evidence {preview.plan.previewHash.slice(0, 12)} · {new Date(preview.generatedAt).toLocaleString()}
        </div>
      </div>

      {preview.plan.blockers.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Blocking dependencies</div>
          {preview.plan.blockers.map((item, index) => (
            <div
              key={`${item.code}-${item.productId}-${item.variantId}-${index}`}
              className="border border-amber-200 bg-amber-50 p-3 text-sm"
            >
              <div className="font-medium">{item.message}</div>
              <code className="text-xs text-muted-foreground">
                {item.code}
                {item.productId ? ` · product ${item.productId}` : ""}
                {item.variantId ? ` · variant ${item.variantId}` : ""}
              </code>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {preview.evidence.products.map((product) => (
          <div key={product.id} className="border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-medium">{product.name}</div>
              <Badge variant="outline">Product {product.id}</Badge>
              {product.id === preview.plan.canonicalProductId && (
                <Badge className="bg-blue-600">Canonical</Badge>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {product.sku ?? "No product SKU"} · {product.inventoryStrategy}
              {product.draftTransformationModelId
                ? ` · draft model ${product.draftTransformationModelId}`
                : ""}
            </div>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variant</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>Physical / committed</TableHead>
                    <TableHead>Plan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.variants.map((variant) => {
                    const action = actionsByVariant.get(variant.id);
                    return (
                      <TableRow key={variant.id}>
                        <TableCell>
                          <div className="font-medium">{variant.sku ?? variant.name}</div>
                          <div className="text-xs text-muted-foreground">
                            Variant {variant.id}{variant.isActive ? "" : " · inactive"}
                          </div>
                        </TableCell>
                        <TableCell>
                          {variant.unitsPerVariant} {variant.uomType}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {variant.onHandQty} on hand · {variant.reservedQty} reserved
                          <br />
                          {variant.pickedQty} picked · {variant.packedQty} packed
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {action?.action.replaceAll("_", " ") ?? "blocked"}
                          </Badge>
                          {action?.action === "retire_duplicate" && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              Replaced by variant {action.targetVariantId}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

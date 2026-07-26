import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  fetchShopifyOwnershipReview,
  shopifyOwnershipReviewFilterSchema,
  type ShopifyOwnershipReviewFilter,
} from "@/lib/shopify-ownership-review";

const PAGE_SIZE = 20;

const decisionReasonLabels = {
  single_active_owner_with_matching_evidence:
    "One active owner has matching catalog and channel evidence",
  remote_product_missing: "The Shopify product no longer exists",
  owner_count_exceeds_two: "More than two local products claim this product",
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
}: {
  channelId: number;
  onOpenProduct: (productId: number) => void;
}) {
  const [filter, setFilter] = useState<ShopifyOwnershipReviewFilter>("all");
  const [page, setPage] = useState(1);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border border-blue-200 bg-blue-50 p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2 text-sm text-blue-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Read-only evidence. No product or Shopify mapping is changed here.
          </span>
        </div>
        <div className="flex items-center gap-2">
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
                        {group.shippingGroupCode ?? "Conflicting shipping groups"}
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
    </div>
  );
}

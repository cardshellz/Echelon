import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  listingCatalogPageSchema,
  listingDraftItemSchema,
  listingDraftSchema,
  listingOperationSchema,
  listingPriceRuleSchema,
  listingReviewSchema,
  listingWorkspaceSchema,
  saveListingDraftSchema,
  submitListingReviewSchema,
  type ListingCatalogItem,
  type ListingDraft,
  type ListingDraftItem,
  type ListingPriceRule,
  type ListingReview,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { publicationRequest } from "./api";
import {
  addDraftItems,
  errorMessage,
  MAX_DRAFT_ITEMS,
  mergeRetryDraftItems,
  money,
  priceSourceLabel,
} from "./model";
import { ListingActivity } from "./ListingActivity";
import { ListingCatalogPicker } from "./ListingCatalogPicker";
import { ListingItemEditor } from "./ListingItemEditor";
import { ListingPricingRules } from "./ListingPricingRules";
import { ListingReviewDialog } from "./ListingReviewDialog";

type Workspace = z.infer<typeof listingWorkspaceSchema>;
interface Props {
  channelId: number;
  connectionId: number;
  canEdit: boolean;
  existingItems: ReactNode;
}

export function ChannelListingPublicationWorkspace({
  channelId,
  connectionId,
  canEdit,
  existingItems,
}: Props) {
  const base = `/api/channels/${channelId}/listing-publications`;
  const client = useQueryClient();
  const [tab, setTab] = useState("listings");
  const [draft, setDraft] = useState<ListingDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState<
    "save" | "review" | "submit" | "retry" | null
  >(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<ListingReview | null>(null);
  const [submitError, setSubmitError] = useState("");
  const command = useRef<{ reviewId: string; key: string } | null>(null);
  const [pickedMetadata, setPickedMetadata] = useState<
    Map<number, ListingCatalogItem>
  >(new Map());
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const workspace = useQuery({
    queryKey: [base],
    queryFn: () => publicationRequest("GET", base, listingWorkspaceSchema),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    const incoming = workspace.data?.draft;
    if (incoming && !dirty)
      setDraft((previous) =>
        previous && previous.revision > incoming.revision ? previous : incoming,
      );
  }, [workspace.data?.draft, dirty]);
  // Browser navigation must not silently discard an unsaved explicit assortment.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const selectedIds = useMemo(
    () => new Set(draft?.items.map((item) => item.variantId) ?? []),
    [draft?.items],
  );
  const ids = [...selectedIds].sort((a, b) => a - b).join(",");
  const catalog = useQuery({
    queryKey: [base, "selected-catalog", ids],
    enabled: ids.length > 0,
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/catalog?${new URLSearchParams({ variantIds: ids })}`,
        listingCatalogPageSchema,
      ),
  });
  const metadata = useMemo(
    () =>
      new Map([
        ...pickedMetadata,
        ...(catalog.data?.items.map(
          (item) => [item.variantId, item] as const,
        ) ?? []),
      ]),
    [pickedMetadata, catalog.data],
  );
  const currentItems = [...selectedIds]
    .map((id) => metadata.get(id))
    .filter((item): item is ListingCatalogItem => item !== undefined);

  function changeItems(items: ListingDraftItem[]) {
    setDraft((previous) => (previous ? { ...previous, items } : previous));
    setDirty(true);
    setReview(null);
    setSubmitError("");
    setNotice("");
    command.current = null;
  }
  async function persistDraft(): Promise<ListingDraft> {
    if (!draft) throw new Error("The draft is still loading.");
    if (!dirty) return draft;
    const input = saveListingDraftSchema.parse({
      expectedRevision: draft.revision,
      items: draft.items,
    });
    const saved = await publicationRequest(
      "PUT",
      `${base}/draft`,
      listingDraftSchema,
      input,
    );
    setDraft(saved);
    setDirty(false);
    client.setQueryData<Workspace>([base], (previous) =>
      previous ? { ...previous, draft: saved } : previous,
    );
    return saved;
  }
  async function saveDraft() {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      await persistDraft();
      setNotice("Draft saved. No listing has been submitted.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }
  async function reviewDraft() {
    setBusy("review");
    setError("");
    setNotice("");
    try {
      const saved = await persistDraft();
      const next = await publicationRequest(
        "POST",
        `${base}/review`,
        listingReviewSchema,
        { expectedRevision: saved.revision },
      );
      setReview(next);
      setSubmitError("");
      command.current = { reviewId: next.id, key: crypto.randomUUID() };
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }
  async function submit() {
    if (!review || !command.current || command.current.reviewId !== review.id)
      return;
    setBusy("submit");
    setSubmitError("");
    try {
      const input = submitListingReviewSchema.parse({
        reviewId: review.id,
        reviewHash: review.reviewHash,
        commandKey: command.current.key,
      });
      await publicationRequest(
        "POST",
        `${base}/operations`,
        listingOperationSchema,
        input,
      );
      setReview(null);
      command.current = null;
      setDirty(false);
      setPickedMetadata(new Map());
      setTab("activity");
      setNotice(
        "Submission queued. Follow Walmart’s per-item response in Activity.",
      );
      await client.invalidateQueries({ queryKey: [base] });
    } catch (failure) {
      setSubmitError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }
  async function savePricing(rule: ListingPriceRule) {
    await publicationRequest(
      "PUT",
      `${base}/pricing`,
      listingPriceRuleSchema,
      listingPriceRuleSchema.parse(rule),
    );
    setReview(null);
    command.current = null;
    await client.invalidateQueries({ queryKey: [base] });
    setNotice(
      "Pricing rule saved. Review the draft to validate final prices before publishing.",
    );
  }
  async function reconcile(id: string) {
    await publicationRequest(
      "POST",
      `${base}/operations/${id}/reconcile`,
      listingOperationSchema,
      {},
    );
    await client.invalidateQueries({ queryKey: [base] });
  }
  async function editFailed(id: string) {
    setBusy("retry");
    try {
      const response = await publicationRequest(
        "GET",
        `${base}/operations/${id}/retry-items`,
        z.object({
          items: z.array(listingDraftItemSchema).max(MAX_DRAFT_ITEMS),
        }),
      );
      const latest = currentDraft.current;
      if (!latest) throw new Error("The draft is still loading.");
      if (response.items.length === 0)
        throw new Error(
          "There are no confirmed failed items available to edit. Refresh Walmart status.",
        );
      changeItems(mergeRetryDraftItems(latest.items, response.items));
      setTab("listings");
      setNotice(
        "Failed items added to the draft. Correct their details, then save and review before publishing.",
      );
    } finally {
      setBusy(null);
    }
  }
  const editingItem = draft?.items.find((item) => item.variantId === editing);
  if (workspace.isLoading)
    return (
      <p role="status" className="text-sm">
        Loading listing workspace…
      </p>
    );
  if (!workspace.data || !draft)
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p role="alert" className="text-sm text-destructive">
            {workspace.error
              ? errorMessage(workspace.error)
              : "The listing workspace is unavailable."}
          </p>
          <Button variant="outline" onClick={() => void workspace.refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-4">
      {workspace.error && (
        <p role="alert" className="text-sm text-destructive">
          Status refresh failed: {errorMessage(workspace.error)}
        </p>
      )}
      {error && (
        <div className="space-y-2 rounded-md border border-destructive p-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {dirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const refreshed = await workspace.refetch();
                if (refreshed.data) {
                  setDraft(refreshed.data.draft);
                  setDirty(false);
                  setError("");
                  setNotice("Saved draft reloaded; local changes discarded.");
                }
              }}
            >
              Discard local changes and reload saved draft
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (!busy) setTab(value);
        }}
      >
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
          <TabsTrigger value="listings">Listing Feed</TabsTrigger>
          <TabsTrigger value="pricing">Pricing Rules</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="existing">Existing listings</TabsTrigger>
        </TabsList>
        <TabsContent value="listings">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Listing Feed</CardTitle>
                  <CardDescription>
                    Select Echelon products, set prices, and review new listings
                    before publishing to this channel.
                  </CardDescription>
                </div>
                {canEdit && (
                  <Button
                    disabled={
                      busy !== null || draft.items.length >= MAX_DRAFT_ITEMS
                    }
                    onClick={() => setPicking(true)}
                  >
                    Add products
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {draft.items.length} selected · future variants stay unselected.
                {dirty ? " Unsaved changes." : ""}{" "}
                <a href="/channels/inventory" className="underline">
                  Stock policy is managed in Channel Inventory.
                </a>
              </p>
              {catalog.error && (
                <p role="alert" className="text-sm text-destructive">
                  Selected catalog details could not load:{" "}
                  {errorMessage(catalog.error)}
                </p>
              )}
              {draft.items.length === 0 ? (
                <div className="py-10 text-center">
                  <h3 className="font-medium">No products selected yet</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Add only the packs and variants you want to sell on Walmart.
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {draft.items.map((item) => {
                    const info = metadata.get(item.variantId);
                    return (
                      <div
                        key={item.variantId}
                        className="flex flex-wrap items-start gap-3 py-4"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">
                            {item.title ??
                              info?.name ??
                              `Variant ${item.variantId}`}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {info?.variantName}{" "}
                            {info
                              ? `· ${info.unitLabel}`
                              : "Catalog details unavailable"}
                          </p>
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {info?.sku}
                          </p>
                          <p className="mt-2 text-xs">
                            {item.productType || "Choose Walmart product type"}{" "}
                            ·{" "}
                            {item.method === "match"
                              ? "Catalog match"
                              : "Create product"}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-medium">
                            {money(
                              item.priceOverrideCents ??
                                info?.priceCents ??
                                null,
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.priceOverrideCents !== null
                              ? "Fixed item price"
                              : priceSourceLabel(info?.priceSource)}
                          </p>
                          <Badge variant="secondary" className="mt-2">
                            Draft · review required
                          </Badge>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => setEditing(item.variantId)}
                          >
                            {canEdit ? "Edit details" : "View details"}
                          </Button>
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                changeItems(
                                  draft.items.filter(
                                    (current) =>
                                      current.variantId !== item.variantId,
                                  ),
                                )
                              }
                              aria-label={`Remove ${info?.sku ?? `variant ${item.variantId}`} from draft`}
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {canEdit && (
                <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                  <Button
                    variant="outline"
                    disabled={busy !== null || !dirty}
                    onClick={() => void saveDraft()}
                  >
                    {busy === "save" ? "Saving…" : "Save draft"}
                  </Button>
                  <Button
                    disabled={busy !== null || draft.items.length === 0}
                    onClick={() => void reviewDraft()}
                  >
                    {busy === "review"
                      ? "Checking readiness…"
                      : `Review ${draft.items.length} items`}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="pricing">
          <ListingPricingRules
            key={JSON.stringify(workspace.data.pricingRule)}
            rule={workspace.data.pricingRule}
            items={currentItems}
            draftItems={draft.items}
            canEdit={canEdit}
            onSave={savePricing}
          />
        </TabsContent>
        <TabsContent value="activity">
          <ListingActivity
            channelId={channelId}
            connectionId={connectionId}
            operations={workspace.data.operations}
            canEdit={canEdit}
            onReconcile={reconcile}
            onEditFailed={editFailed}
          />
        </TabsContent>
        <TabsContent value="existing">{existingItems}</TabsContent>
      </Tabs>
      {picking && canEdit && (
        <ListingCatalogPicker
          base={base}
          selectedIds={selectedIds}
          onClose={() => setPicking(false)}
          onAdd={(items) => {
            try {
              changeItems(addDraftItems(draft.items, items));
              setPickedMetadata(
                (previous) =>
                  new Map([
                    ...previous,
                    ...items.map((item) => [item.variantId, item] as const),
                  ]),
              );
              setPicking(false);
              setError("");
            } catch (failure) {
              setError(errorMessage(failure));
            }
          }}
        />
      )}
      {editingItem && (
        <ListingItemEditor
          key={editingItem.variantId}
          base={base}
          item={editingItem}
          catalog={metadata.get(editingItem.variantId)}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSave={(item) => {
            changeItems(
              draft.items.map((current) =>
                current.variantId === item.variantId ? item : current,
              ),
            );
            setEditing(null);
          }}
        />
      )}
      {review && canEdit && (
        <ListingReviewDialog
          key={review.id}
          review={review}
          submitting={busy === "submit"}
          error={submitError}
          onClose={() => {
            setReview(null);
            command.current = null;
          }}
          onSubmit={() => void submit()}
        />
      )}
    </div>
  );
}

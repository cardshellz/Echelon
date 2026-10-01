import { useEffect, useMemo, useRef, useState } from "react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { publicationRequest } from "./api";
import {
  addDraftItems,
  errorMessage,
  MAX_DRAFT_ITEMS,
  mergeRetryDraftItems,
} from "./model";
import { ChannelListingFeed } from "./ChannelListingFeed";
import { ListingActivity } from "./ListingActivity";
import { ListingCatalogPicker } from "./ListingCatalogPicker";
import { ListingItemEditor } from "./ListingItemEditor";
import { ListingPricingRules } from "./ListingPricingRules";
import { ListingReviewDialog } from "./ListingReviewDialog";
import { ListingBulkEditor } from "./ListingBulkEditor";
import { applyBulkEditBatch, type BulkEditCommand } from "./bulk-edit-batch";

type Workspace = z.infer<typeof listingWorkspaceSchema>;
interface Props {
  channelId: number;
  connectionId: number;
  canEdit: boolean;
  providerName: string;
  onMappingsChanged?(): Promise<void>;
}

export function ChannelListingPublicationWorkspace({
  channelId,
  connectionId,
  canEdit,
  providerName,
  onMappingsChanged,
}: Props) {
  const base = `/api/channels/${channelId}/listing-publications`;
  const client = useQueryClient();
  const [tab, setTab] = useState("listings");
  const [draft, setDraft] = useState<ListingDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [bulkItems, setBulkItems] = useState<ListingDraftItem[] | null>(null);
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
  // Selection belongs to the workspace, not the filtered account page. Removed
  // or submitted drafts must never remain eligible for a later bulk operation.
  useEffect(() => {
    setBulkSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => selectedIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [selectedIds]);
  const activeBulkSelection = useMemo(
    () => new Set([...bulkSelectedIds].filter((id) => selectedIds.has(id))),
    [bulkSelectedIds, selectedIds],
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
  function openBulkEditor() {
    if (!canEdit || busy !== null || !currentDraft.current) return;
    const items = currentDraft.current.items.filter((item) =>
      activeBulkSelection.has(item.variantId),
    );
    if (items.length === 0) return;
    setBulkItems(structuredClone(items));
  }
  function applyBulkPatch(command: BulkEditCommand) {
    const latest = currentDraft.current;
    if (!canEdit || busy !== null || !latest || !bulkItems)
      throw new Error(
        "Wait for the current change to finish before editing these drafts.",
      );
    // Recheck selected snapshots against the latest draft after background
    // refreshes. Unselected edits survive; changed selected items require reopening.
    const next = applyBulkEditBatch(latest.items, bulkItems, command, {
      canEdit,
    });
    changeItems(next);
    setNotice(
      `Updated ${bulkItems.length} draft items. Save the draft when you are ready.`,
    );
    setBulkItems(null);
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
        "Submission queued. Follow each item's status in the listing feed or Activity.",
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
    await client.invalidateQueries({
      queryKey: [`/api/channels/${channelId}/catalog`],
    });
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
          "There are no confirmed failed items available to edit. Refresh the submission status.",
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
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1">
          <TabsTrigger value="listings">Listing Feed</TabsTrigger>
          <TabsTrigger value="pricing">Pricing Rules</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="listings">
          <ChannelListingFeed
            channelId={channelId}
            providerName={providerName}
            canEdit={canEdit}
            draftItems={draft.items}
            metadata={metadata}
            operations={workspace.data.operations}
            busy={busy !== null}
            dirty={dirty}
            selectedDraftIds={activeBulkSelection}
            onDraftSelectionChange={setBulkSelectedIds}
            onBulkEdit={openBulkEditor}
            catalogError={
              catalog.error ? errorMessage(catalog.error) : undefined
            }
            onAdd={() => setPicking(true)}
            onEdit={setEditing}
            onRemove={(variantId) =>
              changeItems(
                draft.items.filter((item) => item.variantId !== variantId),
              )
            }
            onSave={() => void saveDraft()}
            onReview={() => void reviewDraft()}
            onActivity={() => setTab("activity")}
            onMappingsChanged={async () => {
              await client.invalidateQueries({ queryKey: [base] });
              await onMappingsChanged?.();
            }}
          />
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
      </Tabs>
      {picking && canEdit && (
        <ListingCatalogPicker
          base={base}
          providerName={providerName}
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
      {bulkItems && canEdit && (
        <ListingBulkEditor
          base={base}
          items={bulkItems}
          metadata={metadata}
          canEdit={canEdit && busy === null}
          onClose={() => setBulkItems(null)}
          onApply={applyBulkPatch}
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
          onEditItem={(variantId) => {
            if (busy !== null) return;
            setReview(null);
            command.current = null;
            setEditing(variantId);
          }}
        />
      )}
    </div>
  );
}

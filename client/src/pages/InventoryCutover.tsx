import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supplyTransformationsAdminViewSchema } from "@shared/types/inventory-availability-admin";
import {
  applyInventoryAvailabilityBackfillDraftRequestSchema,
  applyInventoryAvailabilityBackfillDraftResultSchema,
  inventoryAvailabilityBackfillQueueResponseSchema,
  refreshInventoryAvailabilityBackfillDraftRequestSchema,
  refreshInventoryAvailabilityBackfillDraftResultSchema,
  reviewInventoryAvailabilityBackfillDraftRequestSchema,
  reviewInventoryAvailabilityBackfillDraftResultSchema,
  type InventoryAvailabilityBackfillQueueResponse,
  type InventoryAvailabilityBackfillQueueRow,
} from "@shared/types/inventory-availability-backfill";
import {
  abortInventoryActivationRequestSchema,
  captureInventoryPublicationReadbacksRequestSchema,
  inventoryActivationDryRunSchema,
  inventoryActivationCommandResultSchema,
  inventoryPublicationReadbackRunSchema,
  openInventoryActivationStatusResponseSchema,
  prepareInventoryActivationRequestSchema,
  runInventoryActivationDryRunRequestSchema,
} from "@shared/types/inventory-availability-phase4";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import type { SupplyTransformationsAdminView } from "./supply-transformations-model";
import { fetchJson, HttpResponseError } from "./inventory-planning-http";
import { inventoryPlanningProductHref, parseInventoryPlanningProductId } from "./inventory-planning-navigation";
import { MigrationQueuePanel } from "./inventory-migration-queue-panel";
import { InventoryCatalogBatchPanel } from "./inventory-catalog-batch-panel";
import { InventoryCutoverPreflightPanel } from "./inventory-cutover-preflight-panel";
import { InventoryCutoverControls } from "./inventory-cutover-controls";
import { InventoryCutoverOpeningPanel } from "./inventory-cutover-opening-panel";
import { InventoryPublicationRecoveryPanel } from "./inventory-publication-recovery-panel";

export default function InventoryCutover() {
  const { user, hasPermission } = useAuth();
  const canView = hasPermission("inventory_planning", "view");
  const canEdit = hasPermission("inventory_planning", "edit");
  const canActivate = hasPermission("inventory_planning", "activate");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const searchParams = useSearch();
  const [, navigate] = useLocation();
  const productId = parseInventoryPlanningProductId(searchParams);
  const setProductId = (selectedId: number) => navigate(inventoryPlanningProductHref("/inventory/cutover", selectedId));
  const backfillIdempotencyKey = useRef<string | null>(null);
  const refreshBackfillIdempotencyKey = useRef<string | null>(null);
  const reviewIdempotencyKey = useRef<string | null>(null);
  const activationDryRunIdempotencyKey = useRef<string | null>(null);
  const publicationReadbackIdempotencyKey = useRef<string | null>(null);
  const activationPrepareIdempotencyKey = useRef<string | null>(null);
  const activationAbortIdempotencyKey = useRef<string | null>(null);
  const [queueSearch, setQueueSearch] = useState("");
  const [queueStateFilter, setQueueStateFilter] = useState("all");
  const [backfillReason, setBackfillReason] = useState("");
  const [refreshBackfillReason, setRefreshBackfillReason] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [activationDryRunReason, setActivationDryRunReason] = useState("");
  const [publicationReadbackReason, setPublicationReadbackReason] = useState("");
  const [activationPrepareReason, setActivationPrepareReason] = useState("");
  const [activationAbortReason, setActivationAbortReason] = useState("");

  const migrationQueueQuery = useQuery<InventoryAvailabilityBackfillQueueResponse>({
    queryKey: ["/api/inventory-planning/admin/migration-queue"],
    queryFn: () => fetchJson(
      "/api/inventory-planning/admin/migration-queue",
      inventoryAvailabilityBackfillQueueResponseSchema,
    ),
    enabled: canView,
  });

  const viewQuery = useQuery<SupplyTransformationsAdminView>({
    queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
    queryFn: () => fetchJson(
      `/api/inventory-planning/admin/supply-transformations/${productId}`,
      supplyTransformationsAdminViewSchema,
    ),
    enabled: canView && productId !== null,
  });
  const view = viewQuery.data;

  useEffect(() => {
    backfillIdempotencyKey.current = null;
    refreshBackfillIdempotencyKey.current = null;
    reviewIdempotencyKey.current = null;
    setBackfillReason("");
    setRefreshBackfillReason("");
    setReviewReason("");
  }, [productId]);

  const applyBackfillDraft = useMutation({
    mutationFn: (row: InventoryAvailabilityBackfillQueueRow) => {
      const request = applyInventoryAvailabilityBackfillDraftRequestSchema.parse({
        expectedInputHash: row.inputHash,
        expectedResultHash: row.resultHash,
        changeReason: backfillReason,
        idempotencyKey: backfillIdempotencyKey.current
          ?? `phase3-backfill:${row.productId}:${crypto.randomUUID()}`,
      });
      backfillIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        `/api/inventory-planning/admin/migration-queue/${row.productId}/drafts`,
        applyInventoryAvailabilityBackfillDraftResultSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: async (result, row) => {
      backfillIdempotencyKey.current = null;
      setBackfillReason("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/supply-transformations", row.productId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue/channel-preview", row.productId],
        }),
      ]);
      toast({
        title: result.alreadyApplied ? "Draft already recorded" : "Backfill draft recorded",
        description: "The deterministic candidate is a draft only. Runtime ATP and channels are unchanged.",
      });
    },
    onError: (error: Error) => {
      if (error instanceof HttpResponseError && error.status === 409) {
        backfillIdempotencyKey.current = null;
        void queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue"],
        });
      }
      toast({ title: "Backfill draft not recorded", description: error.message, variant: "destructive" });
    },
  });

  const reviewBackfillDraft = useMutation({
    mutationFn: ({
      row,
      decision,
    }: {
      row: InventoryAvailabilityBackfillQueueRow;
      decision: "approved" | "changes_required";
    }) => {
      if (!row.draft) throw new Error("Reload the queue; the selected product has no draft.");
      const request = reviewInventoryAvailabilityBackfillDraftRequestSchema.parse({
        expectedModelId: row.draft.modelId,
        expectedModelVersion: row.draft.version,
        expectedDefinitionHash: row.draft.definitionHash,
        expectedHeadRevision: row.draft.headRevision,
        expectedLatestReviewId: row.review?.reviewId ?? null,
        decision,
        reason: reviewReason,
        idempotencyKey: reviewIdempotencyKey.current
          ?? `phase3-review:${row.productId}:${crypto.randomUUID()}`,
      });
      reviewIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        `/api/inventory-planning/admin/migration-queue/${row.productId}/reviews`,
        reviewInventoryAvailabilityBackfillDraftResultSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: async (result) => {
      reviewIdempotencyKey.current = null;
      setReviewReason("");
      await queryClient.invalidateQueries({
        queryKey: ["/api/inventory-planning/admin/migration-queue"],
      });
      toast({
        title: result.review.decision === "approved" ? "Draft approved" : "Changes required",
        description: "Review evidence was recorded. This does not activate the model or publish inventory.",
      });
    },
    onError: (error: Error) => {
      if (error instanceof HttpResponseError && error.status === 409) {
        reviewIdempotencyKey.current = null;
        void queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue"],
        });
      }
      toast({ title: "Review not recorded", description: error.message, variant: "destructive" });
    },
  });

  const refreshBackfillDraft = useMutation({
    mutationFn: (row: InventoryAvailabilityBackfillQueueRow) => {
      const draft = row.draft;
      if (
        !draft
        || draft.origin !== "phase3_backfill"
        || draft.originInputHash === null
        || draft.originResultHash === null
      ) {
        throw new Error("Reload the queue; only a current Phase 3 backfill draft can be refreshed.");
      }
      const request = refreshInventoryAvailabilityBackfillDraftRequestSchema.parse({
        expectedInputHash: row.inputHash,
        expectedResultHash: row.resultHash,
        expectedDraftVersion: draft.version,
        expectedDraftDefinitionHash: draft.definitionHash,
        expectedDraftHeadRevision: draft.headRevision,
        expectedDraftOriginInputHash: draft.originInputHash,
        expectedDraftOriginResultHash: draft.originResultHash,
        changeReason: refreshBackfillReason,
        idempotencyKey: refreshBackfillIdempotencyKey.current
          ?? `phase3-backfill-refresh:${row.productId}:${crypto.randomUUID()}`,
      });
      refreshBackfillIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        `/api/inventory-planning/admin/migration-queue/${row.productId}/drafts/${draft.modelId}/refresh`,
        refreshInventoryAvailabilityBackfillDraftResultSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: async (result, row) => {
      refreshBackfillIdempotencyKey.current = null;
      setRefreshBackfillReason("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/supply-transformations", row.productId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue/channel-preview", row.productId],
        }),
      ]);
      toast({
        title: result.alreadyApplied ? "Draft refresh already recorded" : "Stale draft superseded",
        description: `Draft v${result.version} now carries current deterministic provenance. Runtime ATP and channels are unchanged.`,
      });
    },
    onError: (error: Error) => {
      if (error instanceof HttpResponseError && error.status === 409) {
        refreshBackfillIdempotencyKey.current = null;
        void queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue"],
        });
      }
      toast({
        title: "Stale draft not refreshed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const runActivationDryRun = useMutation({
    mutationFn: () => {
      const queue = migrationQueueQuery.data;
      if (!queue) throw new Error("Load the current full migration queue first.");
      const request = runInventoryActivationDryRunRequestSchema.parse({
        expectedCatalogInputHash: queue.catalogInputHash,
        expectedCatalogResultHash: queue.catalogResultHash,
        idempotencyKey: activationDryRunIdempotencyKey.current
          ?? `inventory-availability-activation-dry-run:${crypto.randomUUID()}`,
        reason: activationDryRunReason,
      });
      activationDryRunIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        "/api/inventory-planning/admin/activation-runs/dry-run",
        inventoryActivationDryRunSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: (result) => {
      activationDryRunIdempotencyKey.current = null;
      toast({
        title: result.state === "blocked" ? "Publication preparation dry run found blockers" : "Publication preparation dry run is ready",
        description: "Evidence was recorded without changing runtime ATP or contacting providers.",
        variant: result.state === "blocked" ? "destructive" : "default",
      });
    },
    onError: (error: Error) => {
      if (error instanceof HttpResponseError && error.status === 409) {
        activationDryRunIdempotencyKey.current = null;
        void queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/migration-queue"],
        });
      }
      toast({ title: "Activation dry run failed", description: error.message, variant: "destructive" });
    },
  });

  const capturePublicationReadbacks = useMutation({
    mutationFn: () => {
      const request = captureInventoryPublicationReadbacksRequestSchema.parse({
        idempotencyKey: publicationReadbackIdempotencyKey.current
          ?? `inventory-publication-readback:${crypto.randomUUID()}`,
        reason: publicationReadbackReason,
      });
      publicationReadbackIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        "/api/inventory-planning/admin/publication-readbacks/capture",
        inventoryPublicationReadbackRunSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: (result) => {
      publicationReadbackIdempotencyKey.current = null;
      runActivationDryRun.reset();
      toast({
        title: result.state === "completed" ? "Provider quantities refreshed" : "Some readbacks failed",
        description: `${result.observedRows} exact target/SKU rows observed; ${result.failedRows} failed. Run a new activation dry run next.`,
        variant: result.state === "completed" ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Provider readback failed", description: error.message, variant: "destructive" });
    },
  });

  const openActivationQuery = useQuery({
    queryKey: ["/api/inventory-planning/admin/activation-runs/open", user?.id],
    queryFn: ({ signal }) => fetchJson(
      "/api/inventory-planning/admin/activation-runs/open",
      openInventoryActivationStatusResponseSchema,
      { signal, cache: "no-store" },
    ),
    enabled: canView && canActivate,
    refetchInterval: (query) => query.state.data?.activation?.state === "publishing" ? 3_000 : false,
  });

  const prepareActivation = useMutation({
    mutationFn: () => {
      const dryRun = runActivationDryRun.data;
      if (!dryRun || dryRun.state !== "ready_for_publication") {
        throw new Error("Run a fresh, ready full-catalog activation dry run first.");
      }
      const request = prepareInventoryActivationRequestSchema.parse({
        sourceDryRunId: dryRun.activationRunId,
        expectedDryRunResultHash: dryRun.resultHash,
        idempotencyKey: activationPrepareIdempotencyKey.current
          ?? `inventory-availability-activation-prepare:${crypto.randomUUID()}`,
        reason: activationPrepareReason,
      });
      activationPrepareIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        "/api/inventory-planning/admin/activation-runs/prepare",
        inventoryActivationCommandResultSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: (result) => {
      activationPrepareIdempotencyKey.current = null;
      void openActivationQuery.refetch();
      toast({
        title: result.state === "publication_verified"
          ? "Conservative preparation verified"
          : "Conservative publication queued",
        description: "Legacy ATP and reservations remain authoritative. Complete the final review below before explicitly switching authority.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Activation preparation failed", description: error.message, variant: "destructive" });
    },
  });

  const abortActivation = useMutation({
    mutationFn: () => {
      const activationRunId = openActivationQuery.data?.activation?.activationRunId
        ?? prepareActivation.data?.activationRunId;
      if (!activationRunId) throw new Error("No activation preparation is available to abort.");
      const request = abortInventoryActivationRequestSchema.parse({
        activationRunId,
        idempotencyKey: activationAbortIdempotencyKey.current
          ?? `inventory-availability-activation-abort:${crypto.randomUUID()}`,
        reason: activationAbortReason,
      });
      activationAbortIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        "/api/inventory-planning/admin/activation-runs/abort",
        inventoryActivationCommandResultSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: (result) => {
      activationAbortIdempotencyKey.current = null;
      setActivationAbortReason("");
      void openActivationQuery.refetch();
      toast({
        title: "Activation preparation aborted",
        description: result.publicationCatchupPending
          ? "The configuration freeze was released. Legacy authority remains active; current-quantity catch-up is queued, not yet confirmed at providers."
          : "The configuration freeze was released. Runtime authority remains legacy.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Activation abort failed", description: error.message, variant: "destructive" });
    },
  });

  const openActivationStatus = openActivationQuery.data?.activation ?? null;
  const displayedActivationId = openActivationStatus?.activationRunId
    ?? (abortActivation.data === undefined ? prepareActivation.data?.activationRunId : undefined);
  const displayedActivationState = openActivationStatus?.state
    ?? (abortActivation.data === undefined ? prepareActivation.data?.state : undefined);
  const displayedRuntimeAuthority = openActivationStatus?.runtimeAuthority
    ?? (abortActivation.data === undefined ? prepareActivation.data?.runtimeAuthority : undefined);
  const activationStatusUnavailable = canActivate
    && (openActivationQuery.isLoading || openActivationQuery.isError);

  const filteredMigrationRows = useMemo(() => {
    const normalizedSearch = queueSearch.trim().toLowerCase();
    return (migrationQueueQuery.data?.products ?? []).filter((row) => {
      const stateMatches = queueStateFilter === "all" || row.queueState === queueStateFilter;
      const searchMatches = normalizedSearch.length === 0
        || row.productName.toLowerCase().includes(normalizedSearch)
        || (row.productSku ?? "").toLowerCase().includes(normalizedSearch)
        || String(row.productId) === normalizedSearch;
      return stateMatches && searchMatches;
    });
  }, [migrationQueueQuery.data?.products, queueSearch, queueStateFilter]);
  const selectedMigrationRow = migrationQueueQuery.data?.products.find((row) =>
    row.productId === productId) ?? null;


  if (!canView) {
    return <div className="p-6 text-sm">Inventory planning view permission is required to access cutover.</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Inventory Cutover</h1>
        <p className="text-sm text-muted-foreground">
          Review catalog readiness, publication preparation, and explicit runtime cutover.
          Draft and review actions do not activate inventory authority.
        </p>
        <Link href={inventoryPlanningProductHref("/inventory/supply-transformations", productId)}
          className="mt-2 inline-block text-sm underline underline-offset-2">
          Open product transformation editor
        </Link>
      </div>
      <Card className="border-amber-300 bg-amber-50/60">
        <CardContent className="flex gap-3 pt-6 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <div className="font-semibold text-amber-900">Review each operation before submitting</div>
            <div className="text-amber-800">
              Drafts and approvals are separate from publication and runtime authority.
              Preparation can lower provider quantities; switching authority requires the
              explicit final-review controls and inventory activation permission.
            </div>
          </div>
        </CardContent>
      </Card>

      <InventoryCatalogBatchPanel rows={migrationQueueQuery.data?.products ?? []} canEdit={canEdit} />

      {viewQuery.isLoading && <div className="text-sm text-muted-foreground">Loading selected product evidence…</div>}
      {viewQuery.error && <div className="text-sm text-destructive">{(viewQuery.error as Error).message}</div>}
      <MigrationQueuePanel
        queue={migrationQueueQuery.data ?? null}
        rows={filteredMigrationRows}
        selectedRow={selectedMigrationRow}
        selectedView={view ?? null}
        isLoading={migrationQueueQuery.isLoading}
        error={migrationQueueQuery.error as Error | null}
        canEdit={canEdit}
        search={queueSearch}
        stateFilter={queueStateFilter}
        backfillReason={backfillReason}
        refreshBackfillReason={refreshBackfillReason}
        reviewReason={reviewReason}
        isApplying={applyBackfillDraft.isPending}
        isRefreshing={refreshBackfillDraft.isPending}
        isReviewing={reviewBackfillDraft.isPending}
        onSearchChange={setQueueSearch}
        onStateFilterChange={setQueueStateFilter}
        onSelectProduct={setProductId}
        onBackfillReasonChange={setBackfillReason}
        onRefreshBackfillReasonChange={(value) => {
          setRefreshBackfillReason(value);
          refreshBackfillIdempotencyKey.current = null;
        }}
        onReviewReasonChange={setReviewReason}
        onApply={(row) => applyBackfillDraft.mutate(row)}
        onRefresh={(row) => refreshBackfillDraft.mutate(row)}
        onReview={(row, decision) => reviewBackfillDraft.mutate({ row, decision })}
      />

      <InventoryCutoverPreflightPanel canView={hasPermission("inventory_planning", "view")} actorId={user?.id ?? null} />
      <InventoryCutoverOpeningPanel key={`opening:${user?.id}`} actorId={user?.id ?? null} canActivate={canActivate}
        onStateChanged={() => { void openActivationQuery.refetch(); }} />

      <Card>
        <CardHeader>
          <CardTitle>Full-catalog publication preparation dry run</CardTitle>
          <p className="text-sm text-muted-foreground">
            First refresh exact provider quantities, then run the full-catalog dry run. A ready run
            may prepare conservative publication while legacy ATP and reservations stay authoritative.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="publication-readback-reason">1. Provider-readback reason</Label>
            <Textarea
              id="publication-readback-reason"
              value={publicationReadbackReason}
              onChange={(event) => {
                setPublicationReadbackReason(event.target.value);
                publicationReadbackIdempotencyKey.current = null;
              }}
              placeholder="Why exact provider quantities are being refreshed"
              disabled={!canActivate}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!canActivate || !publicationReadbackReason.trim() || capturePublicationReadbacks.isPending}
              onClick={() => capturePublicationReadbacks.mutate()}
            >
              {capturePublicationReadbacks.isPending ? "Reading providers…" : "Refresh provider quantities"}
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="activation-dry-run-reason">2. Full-catalog review reason</Label>
            <Textarea
              id="activation-dry-run-reason"
              value={activationDryRunReason}
              onChange={(event) => {
                setActivationDryRunReason(event.target.value);
                activationDryRunIdempotencyKey.current = null;
              }}
              placeholder="Why the complete catalog is being revalidated"
              disabled={!canActivate}
            />
          </div>
          <Button
            type="button"
            disabled={
              !canActivate
              || !migrationQueueQuery.data
              || !activationDryRunReason.trim()
              || runActivationDryRun.isPending
            }
            onClick={() => runActivationDryRun.mutate()}
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            {runActivationDryRun.isPending ? "Running full-catalog dry run…" : "Run activation dry run"}
          </Button>
          {!canActivate && (
            <div className="text-sm text-muted-foreground">
              The inventory planning activate ability is required to create activation-review evidence.
            </div>
          )}
          {runActivationDryRun.data && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={runActivationDryRun.data.state === "blocked" ? "destructive" : "default"}>
                  {runActivationDryRun.data.state.replaceAll("_", " ")}
                </Badge>
                <span>{runActivationDryRun.data.summary.readyProducts} ready</span>
                <span>{runActivationDryRun.data.summary.blockedProducts} blocked</span>
                <span>{runActivationDryRun.data.summary.publicationRows} channel/SKU rows</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Run {runActivationDryRun.data.activationRunId} · result {runActivationDryRun.data.resultHash.slice(0, 12)} ·
                runtime unchanged · no provider write · no outbox enqueue
              </div>
            </div>
          )}
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50/40 p-3">
            <Label htmlFor="activation-prepare-reason">3. Conservative-publication reason</Label>
            <Textarea
              id="activation-prepare-reason"
              value={activationPrepareReason}
              onChange={(event) => {
                setActivationPrepareReason(event.target.value);
                activationPrepareIdempotencyKey.current = null;
              }}
              placeholder="Why the reviewed catalog is ready for conservative provider publication"
              disabled={!canActivate || activationStatusUnavailable || displayedActivationId !== undefined}
            />
            <div className="text-xs text-amber-900">
              This action can lower provider quantities to min(current provider quantity, proposed
              quantity). It cannot raise quantities or switch runtime ATP/reservation authority.
            </div>
            <Button
              type="button"
              disabled={
                !canActivate
                || runActivationDryRun.data?.state !== "ready_for_publication"
                || !activationPrepareReason.trim()
                || prepareActivation.isPending
                || activationStatusUnavailable
                || displayedActivationId !== undefined
              }
              onClick={() => prepareActivation.mutate()}
            >
              {prepareActivation.isPending ? "Preparing conservative publication…" : "Prepare conservative publication"}
            </Button>
            {openActivationQuery.isError && (
              <div className="text-xs text-destructive">
                Open preparation status could not be verified. Preparation is disabled until status reload succeeds.
              </div>
            )}
            {displayedActivationId !== undefined && displayedActivationState !== undefined && (
              <div className="space-y-2 rounded-md border bg-background p-3">
                <div className="text-sm">
                  Run {displayedActivationId} · {displayedActivationState.replaceAll("_", " ")} ·
                  runtime authority {displayedRuntimeAuthority}
                </div>
                {openActivationStatus && (
                  <div className="text-xs text-muted-foreground">
                    {openActivationStatus.outbox.verified}/{openActivationStatus.outbox.total} verified ·{
                      " "}{openActivationStatus.outbox.queued} queued ·{
                      " "}{openActivationStatus.outbox.retryableOrDrifted} retrying/drifted ·{
                      " "}{openActivationStatus.outbox.deadLetter} dead letter
                  </div>
                )}
                {displayedRuntimeAuthority === "legacy" && <>
                {(openActivationStatus?.outbox.leased ?? 0) > 0 && (
                  <div className="text-xs text-amber-800">
                    Wait for {openActivationStatus!.outbox.leased} in-flight provider write(s) before aborting.
                  </div>
                )}
                <Label htmlFor="activation-abort-reason">Abort reason</Label>
                <Input
                  id="activation-abort-reason"
                  value={activationAbortReason}
                  onChange={(event) => {
                    setActivationAbortReason(event.target.value);
                    activationAbortIdempotencyKey.current = null;
                  }}
                  placeholder="Why this preparation should be stopped"
                />
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    !canActivate
                    || !activationAbortReason.trim()
                    || abortActivation.isPending
                    || openActivationQuery.isFetching
                    || (openActivationStatus?.outbox.leased ?? 0) > 0
                  }
                  onClick={() => abortActivation.mutate()}
                >
                  {abortActivation.isPending ? "Aborting…" : "Abort preparation"}
                </Button>
                </>}
                {displayedRuntimeAuthority !== undefined && (
                  <InventoryCutoverControls
                    key={`${user?.id}:${displayedActivationId}:${displayedRuntimeAuthority}`}
                    actorId={user?.id ?? null}
                    canActivate={canActivate && !activationStatusUnavailable}
                    activationRunId={displayedActivationId}
                    runtimeAuthority={displayedRuntimeAuthority}
                    onStateChanged={() => { void openActivationQuery.refetch(); }}
                  />
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <InventoryPublicationRecoveryPanel
        key={`${user?.id}:${displayedActivationId ?? "latest"}`}
        actorId={user?.id ?? null}
        canActivate={canActivate}
        activationRunId={displayedActivationId ?? null}
        onStateChanged={() => { void openActivationQuery.refetch(); }}
      />

    </div>
  );
}

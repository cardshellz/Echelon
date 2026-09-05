import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTransformationModelDraftRequestSchema,
  createTransformationModelDraftResultSchema,
  inventoryPlanningProductOptionsResponseSchema,
  supplyTransformationsAdminViewSchema,
  updateTransformationModelDraftRequestSchema,
  type CreateTransformationModelDraftRequest,
  type UpdateTransformationModelDraftRequest,
} from "@shared/types/inventory-availability-admin";
import {
  applyInventoryAvailabilityBackfillDraftRequestSchema,
  applyInventoryAvailabilityBackfillDraftResultSchema,
  inventoryAvailabilityBackfillQueueResponseSchema,
  inventoryAvailabilityChannelPreviewSchema,
  refreshInventoryAvailabilityBackfillDraftRequestSchema,
  refreshInventoryAvailabilityBackfillDraftResultSchema,
  reviewInventoryAvailabilityBackfillDraftRequestSchema,
  reviewInventoryAvailabilityBackfillDraftResultSchema,
  type InventoryAvailabilityBackfillQueueResponse,
  type InventoryAvailabilityBackfillQueueRow,
  type InventoryAvailabilityChannelPreview,
} from "@shared/types/inventory-availability-backfill";
import {
  plannerShadowRunSchema,
  runPlannerShadowRequestSchema,
  type PlannerShadowRunDto,
} from "@shared/types/inventory-availability-planner";
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
import { z } from "zod";
import {
  AlertTriangle,
  ArrowRight,
  Pencil,
  PlayCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  activeBuildRecipeIdsFromModel,
  bindingSnapshotEquation,
  deriveLosslessPath,
  deriveRecipePath,
  directedPairIsOccupied,
  draftHasUnsupportedBindings,
  isCompatibleConversionRecipe,
  prefillPathsFromModel,
  preserveSelectedProductOption,
  productOptionLabel,
  recipeEquation,
  variantDisplayName,
  type PathDraft,
  type ProductOption,
  type SupplyTransformationsAdminView,
  type TransformationAdminBinding,
  type TransformationAdminModel,
  type TransformationAdminRecipe,
  type TransformationAdminVariant,
  unavailableBuildBindingsForEdit,
  transformationRuntimeLabel,
} from "./supply-transformations-model";
import { PromiseSafetyPolicyPanel } from "./promise-safety-policy-panel";
import { InventoryCatalogBatchPanel } from "./inventory-catalog-batch-panel";

type DraftMutationInput =
  | { kind: "create"; request: CreateTransformationModelDraftRequest }
  | {
      kind: "update";
      productId: number;
      draftModelId: number;
      request: UpdateTransformationModelDraftRequest;
    };

export default function SupplyTransformations() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory_planning", "edit");
  const canActivate = hasPermission("inventory_planning", "activate");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nextRowId = useRef(1);
  const idempotencyKey = useRef<string | null>(null);
  const shadowIdempotencyKey = useRef<string | null>(null);
  const backfillIdempotencyKey = useRef<string | null>(null);
  const refreshBackfillIdempotencyKey = useRef<string | null>(null);
  const reviewIdempotencyKey = useRef<string | null>(null);
  const activationDryRunIdempotencyKey = useRef<string | null>(null);
  const publicationReadbackIdempotencyKey = useRef<string | null>(null);
  const activationPrepareIdempotencyKey = useRef<string | null>(null);
  const activationAbortIdempotencyKey = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [productId, setProductId] = useState<number | null>(null);
  const [editingCurrentDraft, setEditingCurrentDraft] = useState(false);
  const [buildToPromiseEnabled, setBuildToPromiseEnabled] = useState(false);
  const [selectedBuildRecipeIds, setSelectedBuildRecipeIds] = useState<number[]>([]);
  const [buildAuthorityResolutionConfirmed, setBuildAuthorityResolutionConfirmed] = useState(false);
  const [paths, setPaths] = useState<PathDraft[]>([]);
  const [changeReason, setChangeReason] = useState("");
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
  });

  const productsQuery = useQuery<ProductOption[]>({
    queryKey: ["/api/inventory-planning/admin/products", deferredSearch],
    queryFn: async () => (await fetchJson(
      `/api/inventory-planning/admin/products?limit=50${
        deferredSearch ? `&q=${encodeURIComponent(deferredSearch)}` : ""
      }`,
      inventoryPlanningProductOptionsResponseSchema,
    )).products,
  });
  const viewQuery = useQuery<SupplyTransformationsAdminView>({
    queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
    queryFn: () => fetchJson(
      `/api/inventory-planning/admin/supply-transformations/${productId}`,
      supplyTransformationsAdminViewSchema,
    ),
    enabled: productId !== null,
  });
  const view = viewQuery.data;
  const shadowQuery = useQuery<PlannerShadowRunDto | null>({
    queryKey: ["/api/inventory-planning/admin/supply-transformations/shadow-runs/latest", productId],
    queryFn: async () => {
      try {
        return await fetchJson(
          `/api/inventory-planning/admin/supply-transformations/${productId}/shadow-runs/latest`,
          plannerShadowRunSchema,
        );
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: productId !== null,
    retry: false,
  });
  const channelPreviewQuery = useQuery<InventoryAvailabilityChannelPreview | null>({
    queryKey: ["/api/inventory-planning/admin/migration-queue/channel-preview", productId],
    queryFn: async () => {
      try {
        return await fetchJson(
          `/api/inventory-planning/admin/migration-queue/${productId}/channel-preview`,
          inventoryAvailabilityChannelPreviewSchema,
        );
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: productId !== null,
    retry: false,
  });

  useEffect(() => {
    setEditingCurrentDraft(false);
    setBuildToPromiseEnabled(false);
    setSelectedBuildRecipeIds([]);
    setBuildAuthorityResolutionConfirmed(false);
    setPaths([]);
    setChangeReason("");
    idempotencyKey.current = null;
    shadowIdempotencyKey.current = null;
    backfillIdempotencyKey.current = null;
    refreshBackfillIdempotencyKey.current = null;
    reviewIdempotencyKey.current = null;
    setBackfillReason("");
    setRefreshBackfillReason("");
    setReviewReason("");
  }, [productId]);

  useEffect(() => {
    idempotencyKey.current = null;
  }, [buildToPromiseEnabled, changeReason, paths, selectedBuildRecipeIds]);

  const persistDraft = useMutation({
    mutationFn: (input: DraftMutationInput) => {
      if (input.kind === "create") {
        return fetchJson(
          `/api/inventory-planning/admin/supply-transformations/${input.request.productId}/drafts`,
          createTransformationModelDraftResultSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input.request),
          },
        );
      }
      return fetchJson(
        `/api/inventory-planning/admin/supply-transformations/${input.productId}/drafts/${input.draftModelId}`,
        createTransformationModelDraftResultSchema,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.request),
        },
      );
    },
    onSuccess: async (result, input) => {
      idempotencyKey.current = null;
      setEditingCurrentDraft(false);
      await queryClient.invalidateQueries({
        queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["/api/inventory-planning/admin/migration-queue"],
      });
      toast({
        title: input.kind === "create" ? "Draft created" : "New draft version saved",
        description: input.kind === "create"
          ? `Validated draft v${result.version} was recorded. Runtime ATP is unchanged.`
          : `Draft v${result.version} needs its own approval. Earlier versions and approvals are preserved. Live rules are unchanged.`,
      });
    },
    onError: async (error: Error) => {
      if (
        error instanceof HttpResponseError
        && error.status === 409
        && error.code === "INVENTORY_AVAILABILITY_DRAFT_STALE"
      ) {
        idempotencyKey.current = null;
        setEditingCurrentDraft(false);
        setBuildToPromiseEnabled(false);
        setSelectedBuildRecipeIds([]);
        setBuildAuthorityResolutionConfirmed(false);
        setPaths([]);
        setChangeReason("");
        await queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
        });
        toast({
          title: "Draft changed and was reloaded",
          description: "Your unsaved edit was not applied. Review the current draft before editing again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Draft not saved",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  const runShadow = useMutation({
    mutationFn: (selectedProductId: number) => {
      const request = runPlannerShadowRequestSchema.parse({
        idempotencyKey: shadowIdempotencyKey.current
          ?? `inventory-availability-shadow:${selectedProductId}:${crypto.randomUUID()}`,
      });
      shadowIdempotencyKey.current = request.idempotencyKey;
      return fetchJson(
        `/api/inventory-planning/admin/supply-transformations/${selectedProductId}/shadow-runs`,
        plannerShadowRunSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
    },
    onSuccess: async (_result, selectedProductId) => {
      shadowIdempotencyKey.current = null;
      await queryClient.invalidateQueries({
        queryKey: [
          "/api/inventory-planning/admin/supply-transformations/shadow-runs/latest",
          selectedProductId,
        ],
      });
      await queryClient.invalidateQueries({
        queryKey: [
          "/api/inventory-planning/admin/migration-queue/channel-preview",
          selectedProductId,
        ],
      });
      toast({
        title: "Shadow comparison recorded",
        description: "Legacy and proposed ATP were compared from one snapshot. Runtime ATP is unchanged.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Shadow comparison failed",
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
        title: result.state === "blocked" ? "Activation dry run found blockers" : "Activation dry run is ready",
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
    queryKey: ["/api/inventory-planning/admin/activation-runs/open"],
    queryFn: () => fetchJson(
      "/api/inventory-planning/admin/activation-runs/open",
      openInventoryActivationStatusResponseSchema,
    ),
    enabled: canActivate,
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
        description: "Legacy ATP and reservations remain authoritative. Canonical authority cannot be committed from this release.",
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
    onSuccess: () => {
      activationAbortIdempotencyKey.current = null;
      setActivationAbortReason("");
      void openActivationQuery.refetch();
      toast({
        title: "Activation preparation aborted",
        description: "The configuration freeze was released. Runtime authority remains legacy.",
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

  const isEditing = Boolean(view && (view.draftModel === null || editingCurrentDraft));
  const activeVariants = view?.variants.filter((variant) => variant.isActive) ?? [];
  const activeAssemblyRecipes = view?.recipes.filter((recipe) =>
    recipe.recipeType === "assembly" && recipe.status === "active") ?? [];
  const draftEditIsUnsupported = Boolean(
    view?.draftModel && draftHasUnsupportedBindings(view.draftModel),
  );
  const unavailableBuildBindings = view?.draftModel
    ? unavailableBuildBindingsForEdit(view.draftModel, view.recipes)
    : [];
  const unresolvedUnavailableBuildAuthority = editingCurrentDraft
    && unavailableBuildBindings.length > 0
    && buildToPromiseEnabled
    && !buildAuthorityResolutionConfirmed;
  const productOptions = preserveSelectedProductOption(
    productsQuery.data ?? [],
    view ? {
      id: view.product.id,
      sku: view.product.sku,
      name: view.product.name,
    } : null,
  );
  const previewModel = view?.draftModel ?? view?.activeModel ?? null;
  const previewPaths = previewModel
    ? prefillPathsFromModel(previewModel, 1).paths
    : [];
  const displayedPaths = isEditing ? paths : previewPaths;
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

  const addPath = (destinationVariantId: number) => {
    if (!view) return;
    const destination = activeVariants.find((variant) => variant.id === destinationVariantId);
    if (!destination) return;
    const source = activeVariants.find((variant) =>
      variant.id !== destination.id
      && variant.unitsPerVariant !== destination.unitsPerVariant
      && !directedPairIsOccupied(paths, destination.id, variant.id));
    if (!source) return;
    setPaths((current) => [
      ...current,
      deriveLosslessPath(nextRowId.current++, source, destination),
    ]);
  };

  const addRecipePath = (destinationVariantId: number) => {
    if (!view) return;
    const destination = activeVariants.find((variant) => variant.id === destinationVariantId);
    if (!destination) return;
    setPaths((current) => {
      const recipe = view.recipes.find((candidate) => {
        if (!isCompatibleConversionRecipe(candidate, destination, view.variants)) return false;
        const component = candidate.components[0]!;
        return !directedPairIsOccupied(
          current,
          destination.id,
          component.componentVariantId,
        );
      });
      if (!recipe) return current;
      const component = recipe.components[0]!;
      return [...current, deriveRecipePath({
        rowId: nextRowId.current++,
        sourceVariantId: component.componentVariantId,
        destinationVariantId: destination.id,
        inputQty: "1",
        outputQty: "1",
        operationType: "directed_conversion",
        authorityState: "allowed",
        recipeId: null,
        recipeBindingKey: null,
      }, recipe)];
    });
  };

  const updatePath = (rowId: number, update: Partial<PathDraft>) => {
    if (!view) return;
    setPaths((current) => current.map((path) => {
      if (path.rowId !== rowId) return path;
      const destination = activeVariants.find((variant) =>
        variant.id === path.destinationVariantId);
      if (!destination) return path;
      if (update.recipeId !== undefined && update.recipeId !== null) {
        const recipe = view.recipes.find((candidate) =>
          candidate.id === update.recipeId
          && isCompatibleConversionRecipe(candidate, destination, view.variants));
        return recipe ? deriveRecipePath(path, recipe) : path;
      }
      const sourceVariantId = update.sourceVariantId ?? path.sourceVariantId;
      const source = activeVariants.find((variant) => variant.id === sourceVariantId);
      if (!source) return path;
      if (update.recipeId === null || (path.recipeId === null && update.sourceVariantId !== undefined)) {
        return deriveLosslessPath(
          path.rowId,
          source,
          destination,
          update.authorityState ?? path.authorityState,
        );
      }
      return { ...path, ...update };
    }));
  };

  const request = useMemo(() => {
    if (!view || !isEditing) return null;
    const candidate = buildCreateRequestCandidate({
      view,
      buildToPromiseEnabled,
      selectedBuildRecipeIds,
      paths,
      changeReason,
      idempotencyKey: "pending-validation",
    });
    const parsed = createTransformationModelDraftRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [
    buildToPromiseEnabled,
    changeReason,
    isEditing,
    paths,
    selectedBuildRecipeIds,
    view,
  ]);

  const submitDraft = () => {
    if (!view || !isEditing) return;
    const candidate = buildCreateRequestCandidate({
      view,
      buildToPromiseEnabled,
      selectedBuildRecipeIds,
      paths,
      changeReason,
      idempotencyKey: idempotencyKey.current
        ?? `transformation-model:${view.product.id}:${crypto.randomUUID()}`,
    });
    const parsed = createTransformationModelDraftRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      toast({
        title: "Review the draft",
        description: parsed.error.issues[0]?.message ?? "The draft is incomplete.",
        variant: "destructive",
      });
      return;
    }
    idempotencyKey.current = parsed.data.idempotencyKey;
    if (editingCurrentDraft && view.draftModel) {
      if (!view.head || view.head.draftModelId !== view.draftModel.id) {
        toast({
          title: "Reload the draft",
          description: "The loaded draft head is missing or inconsistent.",
          variant: "destructive",
        });
        return;
      }
      const { productId: requestProductId, ...definition } = parsed.data;
      persistDraft.mutate({
        kind: "update",
        productId: requestProductId,
        draftModelId: view.draftModel.id,
        request: updateTransformationModelDraftRequestSchema.parse({
          expectedVersion: view.draftModel.version,
          expectedDefinitionHash: view.draftModel.definitionHash,
          expectedHeadRevision: view.head.revision,
          ...definition,
        }),
      });
      return;
    }
    persistDraft.mutate({ kind: "create", request: parsed.data });
  };

  const beginDraftEdit = () => {
    if (!view?.draftModel || draftHasUnsupportedBindings(view.draftModel)) return;
    const prefill = prefillPathsFromModel(view.draftModel, nextRowId.current);
    nextRowId.current = prefill.nextRowId;
    setBuildToPromiseEnabled(view.draftModel.buildToPromiseEnabled);
    setSelectedBuildRecipeIds(activeBuildRecipeIdsFromModel(view.draftModel, view.recipes));
    setBuildAuthorityResolutionConfirmed(
      unavailableBuildBindingsForEdit(view.draftModel, view.recipes).length === 0,
    );
    setPaths(prefill.paths);
    setChangeReason("");
    idempotencyKey.current = null;
    setEditingCurrentDraft(true);
  };

  const cancelDraftEdit = () => {
    setEditingCurrentDraft(false);
    setBuildToPromiseEnabled(false);
    setSelectedBuildRecipeIds([]);
    setBuildAuthorityResolutionConfirmed(false);
    setPaths([]);
    setChangeReason("");
    idempotencyKey.current = null;
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Supply &amp; Transformations</h1>
        <p className="text-sm text-muted-foreground">
          Define explicit package conversions and build authority. Drafts do not affect ATP,
          reservations, builds, or channel quantities.
        </p>
      </div>

      <Card className="border-amber-300 bg-amber-50/60">
        <CardContent className="flex gap-3 pt-6 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <div className="font-semibold text-amber-900">Legacy runtime authority remains active</div>
            <div className="text-amber-800">
              This release can capture provider readback and conservatively lower external
              quantities for a reviewed preparation. It cannot switch ATP or reservation authority
              to canonical; there is no authority-commit endpoint.
            </div>
          </div>
        </CardContent>
      </Card>

      <InventoryCatalogBatchPanel rows={migrationQueueQuery.data?.products ?? []} canEdit={canEdit} />

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

      <Card>
        <CardHeader>
          <CardTitle>Phase 4 full-catalog activation dry run</CardTitle>
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
                    !activationAbortReason.trim()
                    || abortActivation.isPending
                    || openActivationQuery.isFetching
                    || (openActivationStatus?.outbox.leased ?? 0) > 0
                  }
                  onClick={() => abortActivation.mutate()}
                >
                  {abortActivation.isPending ? "Aborting…" : "Abort preparation"}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Select a product</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="transformation-product-search">Search</Label>
            <Input
              id="transformation-product-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="SKU or product name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transformation-product">Product</Label>
            <select
              id="transformation-product"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={productId ?? ""}
              onChange={(event) => setProductId(
                event.target.value ? Number(event.target.value) : null,
              )}
            >
              <option value="">Choose a product</option>
              {productOptions.map((product) => (
                <option key={product.id} value={product.id}>{productOptionLabel(product)}</option>
              ))}
            </select>
            {productsQuery.isLoading && (
              <div className="text-xs text-muted-foreground">Loading products…</div>
            )}
            {productsQuery.error && (
              <div className="text-xs text-destructive">
                {(productsQuery.error as Error).message}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {viewQuery.isLoading && <div className="text-sm text-muted-foreground">Loading model…</div>}
      {viewQuery.error && (
        <div className="text-sm text-destructive">{(viewQuery.error as Error).message}</div>
      )}

      {view && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {view.product.sku ?? `Product ${view.product.id}`} — {view.product.name}
                <Badge variant="outline">Legacy strategy: {view.product.legacyInventoryStrategy}</Badge>
                {view.draftModel && <Badge>draft v{view.draftModel.version}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>Head revision: {view.head?.revision ?? "not created"}</div>
              <div>
                Sealed model: {view.activeModel
                  ? `sealed v${view.activeModel.version}`
                  : "none"}
              </div>
              <div className="font-medium text-amber-800">
                {transformationRuntimeLabel(view)}
              </div>
              {view.draftModel && !editingCurrentDraft && canEdit && draftEditIsUnsupported && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  This draft contains warehouse-scoped or unsupported recipe authority. Editing is
                  disabled because this network-only page cannot preserve those controls. Use the
                  future warehouse-aware editor for this draft.
                </div>
              )}
              {view.draftModel && !editingCurrentDraft && canEdit && !draftEditIsUnsupported && (
                <Button type="button" variant="outline" onClick={beginDraftEdit}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit current draft
                </Button>
              )}
              {view.draftModel && editingCurrentDraft && (
                <>
                  <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-blue-900">
                    Editing draft v{view.draftModel.version}. Saving creates a new manual version
                    that needs its own approval. Earlier versions and approvals stay in history;
                    automatic refresh cannot replace your manual rules. Live rules are unchanged.
                  </div>
                  {unavailableBuildBindings.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                      Frozen build recipe binding{unavailableBuildBindings.length === 1 ? "" : "s"}{" "}
                      {unavailableBuildBindings.map((binding) =>
                        `${binding.recipeCodeSnapshot} v${binding.recipeVersionSnapshot}`).join(", ")}{" "}
                      {unavailableBuildBindings.length === 1 ? "is" : "are"} no longer selectable.
                      Saving is disabled until you change the current recipe selection or turn
                      build-to-promise off.
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <PromiseSafetyPolicyPanel productId={view.product.id} canEdit={canEdit} />

          <ShadowComparisonPanel
            run={shadowQuery.data ?? null}
            isLoading={shadowQuery.isLoading}
            error={shadowQuery.error as Error | null}
            canRun={canEdit}
            isRunning={runShadow.isPending}
            onRun={() => runShadow.mutate(view.product.id)}
          />

          <ChannelPublicationPreviewPanel
            preview={channelPreviewQuery.data ?? null}
            isLoading={channelPreviewQuery.isLoading}
            error={channelPreviewQuery.error as Error | null}
          />

          <DestinationColumns
            view={view}
            paths={displayedPaths}
            editable={canEdit && isEditing}
            onAddPath={addPath}
            onAddRecipePath={addRecipePath}
            onChangePath={updatePath}
            onRemovePath={(rowId) => setPaths((current) =>
              current.filter((candidate) => candidate.rowId !== rowId))}
          />

          {isEditing && canEdit && (
            <>
              <BuildAuthorityEditor
                view={view}
                recipes={activeAssemblyRecipes}
                enabled={buildToPromiseEnabled}
                selectedRecipeIds={selectedBuildRecipeIds}
                onEnabledChange={(enabled) => {
                  setBuildToPromiseEnabled(enabled);
                  if (!enabled) setBuildAuthorityResolutionConfirmed(true);
                }}
                onRecipeSelectionChange={(recipeIds) => {
                  setSelectedBuildRecipeIds(recipeIds);
                  setBuildAuthorityResolutionConfirmed(true);
                }}
              />

              <Card>
                <CardHeader><CardTitle>Record draft</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="transformation-change-reason">Change reason</Label>
                    <Textarea
                      id="transformation-change-reason"
                      value={changeReason}
                      onChange={(event) => setChangeReason(event.target.value)}
                      placeholder="Why this transformation authority is correct"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={
                        !request
                        || persistDraft.isPending
                        || (editingCurrentDraft && (!view.head || !view.draftModel))
                        || (buildToPromiseEnabled && selectedBuildRecipeIds.length === 0)
                        || unresolvedUnavailableBuildAuthority
                      }
                      onClick={submitDraft}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {persistDraft.isPending
                        ? "Validating…"
                        : editingCurrentDraft
                          ? "Save draft updates"
                          : "Create validated draft"}
                    </Button>
                    {editingCurrentDraft && (
                      <Button type="button" variant="outline" onClick={cancelDraftEdit}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {view.draftModel && !editingCurrentDraft && (
            <DraftEvidence model={view.draftModel} view={view} />
          )}
          {!canEdit && (
            <div className="text-sm text-muted-foreground">
              You have view access only. The inventory planning edit ability is required to
              create or update drafts.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MigrationQueuePanel({
  queue,
  rows,
  selectedRow,
  selectedView,
  isLoading,
  error,
  canEdit,
  search,
  stateFilter,
  backfillReason,
  refreshBackfillReason,
  reviewReason,
  isApplying,
  isRefreshing,
  isReviewing,
  onSearchChange,
  onStateFilterChange,
  onSelectProduct,
  onBackfillReasonChange,
  onRefreshBackfillReasonChange,
  onReviewReasonChange,
  onApply,
  onRefresh,
  onReview,
}: {
  queue: InventoryAvailabilityBackfillQueueResponse | null;
  rows: InventoryAvailabilityBackfillQueueRow[];
  selectedRow: InventoryAvailabilityBackfillQueueRow | null;
  selectedView: SupplyTransformationsAdminView | null;
  isLoading: boolean;
  error: Error | null;
  canEdit: boolean;
  search: string;
  stateFilter: string;
  backfillReason: string;
  refreshBackfillReason: string;
  reviewReason: string;
  isApplying: boolean;
  isRefreshing: boolean;
  isReviewing: boolean;
  onSearchChange: (value: string) => void;
  onStateFilterChange: (value: string) => void;
  onSelectProduct: (productId: number) => void;
  onBackfillReasonChange: (value: string) => void;
  onRefreshBackfillReasonChange: (value: string) => void;
  onReviewReasonChange: (value: string) => void;
  onApply: (row: InventoryAvailabilityBackfillQueueRow) => void;
  onRefresh: (row: InventoryAvailabilityBackfillQueueRow) => void;
  onReview: (
    row: InventoryAvailabilityBackfillQueueRow,
    decision: "approved" | "changes_required",
  ) => void;
}) {
  const isManual = selectedRow?.draft?.origin === "operator";
  const reviewDefinition = isManual
    ? selectedRow?.draftDefinition
    : selectedRow?.candidateDefinition;
  const variants = selectedView?.product.id === selectedRow?.productId
    ? selectedView?.variants ?? [] : [];
  const manualEvidenceReady = !isManual || (selectedView?.product.id === selectedRow?.productId
    && selectedView?.draftModel?.id === selectedRow?.draft?.modelId
    && selectedView?.draftModel?.definitionHash === selectedRow?.draft?.definitionHash
    && selectedView?.head?.revision === selectedRow?.draft?.headRevision);
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Phase 3 migration queue</CardTitle>
        <p className="text-sm text-muted-foreground">
          Every active product is classified by one deterministic algorithm. Applying a candidate
          creates only a draft; approval is review evidence, not activation.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Classifying active products…</div>}
        {error && <div className="text-sm text-destructive">{error.message}</div>}
        {queue && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{queue.summary.totalActiveProducts} active</Badge>
              <Badge variant="destructive">{queue.summary.blocked} blocked</Badge>
              <Badge variant="secondary">{queue.summary.excluded} excluded from ATP</Badge>
              <Badge variant="outline">{queue.summary.notBackfilled} not backfilled</Badge>
              <Badge variant="outline">{queue.summary.conflictingDraft} conflicting draft</Badge>
              <Badge variant="outline">{queue.summary.awaitingReview} awaiting review</Badge>
              <Badge variant="outline">{queue.summary.changesRequired} changes required</Badge>
              <Badge>{queue.summary.approved} approved</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="migration-queue-search">Search full queue</Label>
                <Input
                  id="migration-queue-search"
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="Product ID, SKU, or name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="migration-queue-state">Queue state</Label>
                <select
                  id="migration-queue-state"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={stateFilter}
                  onChange={(event) => onStateFilterChange(event.target.value)}
                >
                  <option value="all">All states</option>
                  <option value="blocked">Blocked</option>
                  <option value="excluded">Excluded from ATP</option>
                  <option value="not_backfilled">Not backfilled</option>
                  <option value="conflicting_draft">Conflicting draft</option>
                  <option value="awaiting_review">Awaiting review</option>
                  <option value="changes_required">Changes required</option>
                  <option value="approved">Approved</option>
                </select>
              </div>
            </div>
            <div className="max-h-[32rem] overflow-auto rounded-md border">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="sticky top-0 border-b bg-muted text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Legacy strategy</th>
                    <th className="px-3 py-2">Candidate</th>
                    <th className="px-3 py-2 text-right">Variants</th>
                    <th className="px-3 py-2 text-right">Recipes</th>
                    <th className="px-3 py-2 text-right">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.productId}
                      className={`cursor-pointer border-b last:border-b-0 hover:bg-muted/40 ${
                        selectedRow?.productId === row.productId ? "bg-blue-50" : ""
                      }`}
                      onClick={() => onSelectProduct(row.productId)}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.productSku ?? `Product ${row.productId}`}</div>
                        <div className="text-xs text-muted-foreground">{row.productName}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={row.queueState === "blocked" ? "destructive" : "outline"}>
                          {formatQueueState(row.queueState)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{row.legacyInventoryStrategy}</td>
                      <td className="px-3 py-2">{formatQueueState(row.classification)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.activeVariantCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.activeRecipeCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.issues.length}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No products match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-muted-foreground">
              Input {queue.catalogInputHash.slice(0, 12)} · result {queue.catalogResultHash.slice(0, 12)} ·
              captured {new Date(queue.capturedAt).toLocaleString()}
            </div>
          </>
        )}

        {selectedRow && (
          <div className="space-y-4 rounded-md border p-4">
            <div>
              <div className="font-semibold">
                {selectedRow.productSku ?? `Product ${selectedRow.productId}`} — {selectedRow.productName}
              </div>
              <div className="text-xs text-muted-foreground">
                {isManual ? "Saved manual rules" : "Generated candidate"} {(
                  isManual ? selectedRow.draft?.definitionHash : selectedRow.candidateDefinitionHash
                )?.slice(0, 12) ?? "blocked"} ·
                input {selectedRow.inputHash.slice(0, 12)} · result {selectedRow.resultHash.slice(0, 12)}
              </div>
            </div>
            {reviewDefinition && (
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <div>Directed paths: {reviewDefinition.paths.length}</div>
                <div>Recipe bindings: {reviewDefinition.recipeBindings.length}</div>
                <div>Build-to-promise: {reviewDefinition.buildToPromiseEnabled ? "enabled" : "off"}</div>
              </div>
            )}
            {isManual && reviewDefinition && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <div className="font-medium">Exact saved directions being reviewed</div>
                {reviewDefinition.paths.map((path) => (
                  <div key={`${path.sourceVariantId}:${path.destinationVariantId}`}>
                    {path.inputQty} × {variantById.get(path.sourceVariantId)?.sku
                      ?? `variant #${path.sourceVariantId}`} → {path.outputQty} ×{" "}
                    {variantById.get(path.destinationVariantId)?.sku
                      ?? `variant #${path.destinationVariantId}`} — {path.authorityState}
                  </div>
                ))}
                <div className="text-muted-foreground">
                  Every conversion step requires a listed allowed direction. Approving does not add the reverse direction.
                  Review any saved recipe bindings in the draft evidence below.
                </div>
                {!manualEvidenceReady && (
                  <div className="text-amber-800">
                    Waiting for matching product and draft details. If they do not load, reload
                    the page before reviewing.
                  </div>
                )}
              </div>
            )}
            {selectedRow.issues.length > 0 && (
              <div className="space-y-2">
                {selectedRow.issues.map((entry) => (
                  <div
                    key={`${entry.code}:${entry.message}`}
                    className={`rounded-md border p-3 text-sm ${
                      entry.severity === "blocking"
                        ? "border-red-300 bg-red-50 text-red-900"
                        : "border-amber-300 bg-amber-50 text-amber-900"
                    }`}
                  >
                    <span className="font-medium">{entry.code}</span>: {entry.message}
                  </div>
                ))}
              </div>
            )}
            {selectedRow.draft && (
              <div className="text-sm">
                Draft v{selectedRow.draft.version} · {selectedRow.draft.origin.replaceAll("_", " ")} ·
                definition {selectedRow.draft.definitionHash.slice(0, 12)} ·
                {isManual
                  ? selectedRow.draft.operatorInputHash === selectedRow.inputHash
                    ? " manual rules; catalog source unchanged"
                    : " manual rules; catalog source changed — save a new version before review"
                  : selectedRow.draft.candidateMatch
                  ? " exact definition and provenance match"
                  : selectedRow.draft.definitionMatch
                    ? " definition matches, provenance is stale"
                    : " definition differs"}
              </div>
            )}
            {canEdit && selectedRow.queueState === "not_backfilled" && (
              <div className="space-y-3">
                <Label htmlFor="backfill-change-reason">Draft reason</Label>
                <Textarea
                  id="backfill-change-reason"
                  value={backfillReason}
                  onChange={(event) => onBackfillReasonChange(event.target.value)}
                  placeholder="Why this deterministic legacy-to-draft mapping is being recorded"
                />
                <Button
                  type="button"
                  disabled={!backfillReason.trim() || isApplying || !selectedRow.candidateDefinition}
                  onClick={() => onApply(selectedRow)}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {isApplying ? "Recording draft…" : "Record deterministic draft"}
                </Button>
              </div>
            )}
            {canEdit && selectedRow.queueState === "conflicting_draft"
              && selectedRow.draft?.origin === "phase3_backfill" && (
              <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                <div className="text-sm text-amber-900">
                  The existing Phase 3 draft does not exactly match the current deterministic
                  input, result, and definition. Refreshing preserves it as immutable history and
                  creates the next inactive draft version.
                </div>
                <Label htmlFor="backfill-refresh-reason">Supersession reason</Label>
                <Textarea
                  id="backfill-refresh-reason"
                  value={refreshBackfillReason}
                  onChange={(event) => onRefreshBackfillReasonChange(event.target.value)}
                  placeholder="Why this stale deterministic draft is being superseded"
                />
                <Button
                  type="button"
                  disabled={!refreshBackfillReason.trim() || isRefreshing || !selectedRow.candidateDefinition}
                  onClick={() => onRefresh(selectedRow)}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {isRefreshing ? "Refreshing draft…" : "Supersede and refresh draft"}
                </Button>
              </div>
            )}
            {selectedRow.queueState === "conflicting_draft"
              && selectedRow.draft?.origin === "operator" && (
              <div className="text-sm text-amber-800">
                This draft was authored by an operator. Deterministic backfill will not overwrite
                or supersede it; review and edit it manually.
              </div>
            )}
            {canEdit && ["awaiting_review", "changes_required"].includes(selectedRow.queueState)
              && selectedRow.draft && (
              <div className="space-y-3">
                <Label htmlFor="backfill-review-reason">Review reason</Label>
                <Textarea
                  id="backfill-review-reason"
                  value={reviewReason}
                  onChange={(event) => onReviewReasonChange(event.target.value)}
                  placeholder="Evidence supporting approval or required changes"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={!reviewReason.trim() || isReviewing || !manualEvidenceReady}
                    onClick={() => onReview(selectedRow, "approved")}
                  >
                    Approve saved rules
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!reviewReason.trim() || isReviewing || !manualEvidenceReady}
                    onClick={() => onReview(selectedRow, "changes_required")}
                  >
                    Require changes
                  </Button>
                </div>
              </div>
            )}
            {selectedRow.review && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                Review: {formatQueueState(selectedRow.review.decision)} by {selectedRow.review.reviewedBy}
                {" "}on {new Date(selectedRow.review.reviewedAt).toLocaleString()} — {selectedRow.review.reason}
              </div>
            )}
            {selectedRow.queueState === "changes_required" && (
              <div className="text-sm text-amber-800">
                Edit the draft below if its definition is wrong, or record a later approval with
                new evidence. The review ledger preserves both decisions.
              </div>
            )}
            {selectedRow.queueState === "approved" && (
              <div className="font-medium text-emerald-700">
                Approved — not live. These saved rules are approved for activation, but this
                approval does not change the rules currently in use.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelPublicationPreviewPanel({
  preview,
  isLoading,
  error,
}: {
  preview: InventoryAvailabilityChannelPreview | null;
  isLoading: boolean;
  error: Error | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel-publication preview</CardTitle>
        <p className="text-sm text-muted-foreground">
          Replays current legacy channel allocation policy against the legacy and proposed ATP
          values from one shadow snapshot. No adapter is called and no allocation audit is written.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Calculating read-only preview…</div>}
        {error && <div className="text-sm text-destructive">{error.message}</div>}
        {!isLoading && !error && !preview && (
          <div className="text-sm text-muted-foreground">
            Record a current shadow ATP comparison to preview channel quantities.
          </div>
        )}
        {preview && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">legacy allocation policy</Badge>
              <span>Shadow {preview.shadowRunId}</span>
              <span>·</span>
              <span>{preview.modelVersion === null ? "no model evidence" : `model v${preview.modelVersion}`}</span>
              <span>·</span>
              <span>provider write: no</span>
              <span>·</span>
              <span>allocation audit: no</span>
            </div>
            {preview.blockers.map((blocker) => (
              <div key={blocker.code} className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                <span className="font-medium">{blocker.code}</span>: {blocker.message}
              </div>
            ))}
            {preview.rows.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Channel</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Warehouse scope</th>
                      <th className="px-3 py-2 text-right">Legacy ATP</th>
                      <th className="px-3 py-2 text-right">Proposed ATP</th>
                      <th className="px-3 py-2 text-right">Legacy publish</th>
                      <th className="px-3 py-2 text-right">Proposed publish</th>
                      <th className="px-3 py-2 text-right">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={`${row.channelId}:${row.productVariantId}`} className="border-b last:border-b-0">
                        <td className="px-3 py-2">
                          <div className="font-medium">{row.channelName}</div>
                          <div className="text-xs text-muted-foreground">{row.channelProvider}</div>
                        </td>
                        <td className="px-3 py-2">{row.sku ?? `Variant ${row.productVariantId}`}</td>
                        <td className="px-3 py-2">{formatQueueState(row.warehouseScopeSource)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPlannerQuantity(row.legacyAtpUnits)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPlannerQuantity(row.proposedAtpUnits)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPlannerQuantity(row.legacyPublishedUnits)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPlannerQuantity(row.proposedPublishedUnits)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPlannerDifference(row.differenceUnits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function formatQueueState(value: string): string {
  return value.replaceAll("_", " ");
}

function ShadowComparisonPanel({
  run,
  isLoading,
  error,
  canRun,
  isRunning,
  onRun,
}: {
  run: PlannerShadowRunDto | null;
  isLoading: boolean;
  error: Error | null;
  canRun: boolean;
  isRunning: boolean;
  onRun: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Shadow ATP comparison</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Compare legacy and proposed ATP from the same sealed snapshot. This records evidence
              only; it does not switch readers, reserve stock, or publish channel quantities.
            </p>
          </div>
          {canRun && (
            <Button type="button" variant="outline" disabled={isRunning} onClick={onRun}>
              <PlayCircle className="mr-2 h-4 w-4" />
              {isRunning ? "Comparing…" : "Run comparison"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Loading evidence…</div>}
        {error && <div className="text-sm text-destructive">{error.message}</div>}
        {!isLoading && !error && !run && (
          <div className="text-sm text-muted-foreground">
            No shadow comparison has been recorded for this product.
          </div>
        )}
        {run && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={run.status === "completed" ? "outline" : "destructive"}>
                {run.status === "completed" ? "planner evidence ready" : "configuration blocked"}
              </Badge>
              <span>Legacy {run.legacyInventoryStrategy}</span>
              <span>·</span>
              <span>Snapshot {run.snapshotFingerprint.slice(0, 12)}</span>
              <span>·</span>
              <span>captured {new Date(run.capturedAt).toLocaleString()}</span>
              <span>·</span>
              <span>completed {new Date(run.completedAt).toLocaleString()}</span>
              <span>·</span>
              <span>{run.modelVersion === null ? "no selected model" : `model v${run.modelVersion}`}</span>
            </div>
            {run.blockerCodes.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                Activation blockers: {run.blockerCodes.join(", ")}. The numeric preview remains
                evidence only and is not safe for operational cutover.
              </div>
            )}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Scope</th>
                    <th className="px-3 py-2">SKU</th>
                    <th className="px-3 py-2 text-right">Legacy ATP</th>
                    <th className="px-3 py-2 text-right">Proposed ATP</th>
                    <th className="px-3 py-2 text-right">Difference</th>
                    <th className="px-3 py-2">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {run.results.map((result) => {
                    return (
                      <tr
                        key={`${result.warehouseId ?? "network"}:${result.productVariantId}`}
                        className="border-b last:border-b-0"
                      >
                        <td className="px-3 py-2">
                          {result.warehouseId === null
                            ? "Network"
                            : `${result.warehouseCodeSnapshot} (${result.warehouseId})`}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium">
                            {result.productVariantSkuSnapshot ?? `Variant ${result.productVariantId}`}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {result.productVariantNameSnapshot}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPlannerQuantity(result.legacyAtpUnits)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPlannerQuantity(result.proposedAtpUnits)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatPlannerDifference(result.differenceUnits)}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {result.classifications.map(formatShadowClassification).join(", ")}
                          {result.readinessState === "blocked" && (
                            <div className="mt-1 font-medium text-amber-800">Blocked from cutover</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!canRun && (
          <div className="text-xs text-muted-foreground">
            The inventory planning edit ability is required to record a new comparison.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatPlannerQuantity(value: string): string {
  return BigInt(value).toLocaleString();
}

function formatPlannerDifference(value: string): string {
  const parsed = BigInt(value);
  return `${parsed > BigInt(0) ? "+" : ""}${parsed.toLocaleString()}`;
}

function formatShadowClassification(value: string): string {
  return value.replaceAll("_", " ");
}

function DestinationColumns({
  view,
  paths,
  editable,
  onAddPath,
  onAddRecipePath,
  onChangePath,
  onRemovePath,
}: {
  view: SupplyTransformationsAdminView;
  paths: PathDraft[];
  editable: boolean;
  onAddPath: (destinationVariantId: number) => void;
  onAddRecipePath: (destinationVariantId: number) => void;
  onChangePath: (rowId: number, update: Partial<PathDraft>) => void;
  onRemovePath: (rowId: number) => void;
}) {
  const activeVariants = view.variants.filter((variant) => variant.isActive);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authority by output SKU</CardTitle>
        <p className="text-xs text-muted-foreground">
          Each output column owns every incoming source path and its Allowed/Blocked authority.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view.variants.map((destination) => {
          const destinationPaths = paths.filter((path) =>
            path.destinationVariantId === destination.id);
          const canAddLosslessPath = destination.isActive && activeVariants.some((source) =>
            source.id !== destination.id
            && source.unitsPerVariant !== destination.unitsPerVariant
            && !directedPairIsOccupied(paths, destination.id, source.id));
          const canAddRecipePath = destination.isActive && view.recipes.some((recipe) => {
            if (!isCompatibleConversionRecipe(recipe, destination, view.variants)) return false;
            const component = recipe.components[0]!;
            return !directedPairIsOccupied(
              paths,
              destination.id,
              component.componentVariantId,
            );
          });
          return (
            <div key={destination.id} className="space-y-3 rounded-md border p-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="font-semibold">{variantDisplayName(destination)}</div>
                  {destination.salesEligibility === "internal_only" && (
                    <Badge variant="secondary">Internal supply only</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Output · {destination.unitsPerVariant} base unit{
                    destination.unitsPerVariant === 1 ? "" : "s"
                  }
                </div>
                {destination.salesEligibility === "internal_only" && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    This column can hold operational conversion paths, but it is never a customer ATP target.
                  </div>
                )}
              </div>
              {destinationPaths.map((path) => editable ? (
                <DestinationPathEditor
                  key={path.rowId}
                  path={path}
                  destination={destination}
                  allPaths={paths}
                  view={view}
                  onChange={(update) => onChangePath(path.rowId, update)}
                  onRemove={() => onRemovePath(path.rowId)}
                />
              ) : (
                <DestinationPathEvidence key={path.rowId} path={path} view={view} />
              ))}
              {destinationPaths.length === 0 && (
                <div className="text-xs text-muted-foreground">Exact physical supply only</div>
              )}
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canAddLosslessPath}
                    onClick={() => onAddPath(destination.id)}
                  >
                    <Plus className="mr-2 h-3.5 w-3.5" /> Add package path
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canAddRecipePath}
                    onClick={() => onAddRecipePath(destination.id)}
                  >
                    <Plus className="mr-2 h-3.5 w-3.5" /> Add recipe path
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function DestinationPathEditor({
  path,
  destination,
  allPaths,
  view,
  onChange,
  onRemove,
}: {
  path: PathDraft;
  destination: TransformationAdminVariant;
  allPaths: PathDraft[];
  view: SupplyTransformationsAdminView;
  onChange: (update: Partial<PathDraft>) => void;
  onRemove: () => void;
}) {
  const variants = view.variants.filter((variant) => variant.isActive);
  const source = variants.find((variant) => variant.id === path.sourceVariantId);
  const compatibleRecipes = view.recipes.filter((recipe) => {
    if (!isCompatibleConversionRecipe(recipe, destination, view.variants)) return false;
    const component = recipe.components[0]!;
    return !directedPairIsOccupied(
      allPaths,
      destination.id,
      component.componentVariantId,
      path.rowId,
    );
  });
  const selectedRecipe = path.recipeId === null
    ? null
    : view.recipes.find((recipe) => recipe.id === path.recipeId) ?? null;
  return (
    <div className="space-y-3 rounded-md bg-muted/60 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">
          {variantDisplayName(source)} <ArrowRight className="inline h-3 w-3" />{
            " "}{variantDisplayName(destination)}
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Remove path">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-1">
        <Label>Source SKU</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={path.sourceVariantId}
          disabled={path.recipeId !== null}
          onChange={(event) => onChange({ sourceVariantId: Number(event.target.value) })}
        >
          {variants
            .filter((variant) =>
              variant.id !== destination.id
              && (path.recipeId !== null
                || variant.unitsPerVariant !== destination.unitsPerVariant)
              && !directedPairIsOccupied(allPaths, destination.id, variant.id, path.rowId))
            .map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variantDisplayName(variant)} ({variant.unitsPerVariant})
              </option>
            ))}
        </select>
      </div>
      <div className="rounded border bg-background p-2 text-xs">
        <div className="font-medium">
          {path.inputQty} × {variantDisplayName(source)} → {path.outputQty} ×{
            " "}{variantDisplayName(destination)}
        </div>
        <div className="text-muted-foreground">
          {selectedRecipe
            ? `Locked to ${selectedRecipe.code} v${selectedRecipe.version}`
            : "Reduced lossless ratio derived from package units"}
        </div>
      </div>
      <div className="space-y-1">
        <Label>Recipe authority</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={path.recipeId ?? ""}
          onChange={(event) => onChange({
            recipeId: event.target.value ? Number(event.target.value) : null,
          })}
        >
          {source && source.unitsPerVariant !== destination.unitsPerVariant && (
            <option value="">Lossless package path</option>
          )}
          {compatibleRecipes.map((recipe) => (
            <option key={recipe.id} value={recipe.id}>
              {recipe.code} v{recipe.version} · {recipeEquation(recipe, view.variants)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label>Authority</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={path.authorityState}
          onChange={(event) => onChange({
            authorityState: event.target.value as PathDraft["authorityState"],
          })}
        >
          <option value="allowed">Allowed</option>
          <option value="blocked">Blocked</option>
        </select>
      </div>
    </div>
  );
}

function DestinationPathEvidence({
  path,
  view,
}: {
  path: PathDraft;
  view: SupplyTransformationsAdminView;
}) {
  const source = view.variants.find((variant) => variant.id === path.sourceVariantId);
  const destination = view.variants.find((variant) => variant.id === path.destinationVariantId);
  const model = view.draftModel ?? view.activeModel;
  const binding = path.recipeBindingKey === null
    ? null
    : model?.bindings.find((candidate) =>
      candidate.bindingKey === path.recipeBindingKey) ?? null;
  return (
    <div className="space-y-2 rounded bg-muted p-2 text-sm">
      <div className="font-medium">
        {path.inputQty} × {variantDisplayName(source)} <ArrowRight className="inline h-3 w-3" />{
          " "}{path.outputQty} × {variantDisplayName(destination)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant={path.authorityState === "allowed" ? "default" : "secondary"}>
          {path.authorityState}
        </Badge>
        <Badge variant="outline">{formatOperation(path.operationType)}</Badge>
      </div>
      <div className="text-xs text-muted-foreground">
        {binding
          ? `Authorized by ${binding.recipeCodeSnapshot} v${binding.recipeVersionSnapshot}: ${bindingSnapshotEquation(binding, view.variants)}`
          : "Lossless package conversion; no recipe authority required."}
      </div>
    </div>
  );
}

function BuildAuthorityEditor({
  view,
  recipes,
  enabled,
  selectedRecipeIds,
  onEnabledChange,
  onRecipeSelectionChange,
}: {
  view: SupplyTransformationsAdminView;
  recipes: TransformationAdminRecipe[];
  enabled: boolean;
  selectedRecipeIds: number[];
  onEnabledChange: (enabled: boolean) => void;
  onRecipeSelectionChange: (recipeIds: number[]) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Build-to-promise authority</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="font-medium">Allow component assembly in ATP</div>
            <div className="text-xs text-muted-foreground">
              Product-level draft authority only; it is not a channel setting or runtime switch.
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </div>
        {recipes.map((recipe) => (
          <label key={recipe.id} className="flex gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              checked={selectedRecipeIds.includes(recipe.id)}
              onChange={(event) => onRecipeSelectionChange(
                event.target.checked
                  ? [...selectedRecipeIds, recipe.id]
                  : selectedRecipeIds.filter((id) => id !== recipe.id),
              )}
            />
            <span className="text-sm">
              <span className="font-medium">{recipe.code} v{recipe.version} · {recipe.name}</span>
              <span className="block text-muted-foreground">
                {recipeEquation(recipe, view.variants)}
              </span>
            </span>
          </label>
        ))}
        {recipes.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No active assembly recipe outputs this product.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DraftEvidence({
  model,
  view,
}: {
  model: TransformationAdminModel;
  view: SupplyTransformationsAdminView;
}) {
  const buildBindings = model.bindings.filter((binding) =>
    binding.relationshipRole === "component_build");
  return (
    <Card>
      <CardHeader><CardTitle>Immutable draft evidence</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 md:grid-cols-2">
          <div><span className="font-medium">Draft:</span> v{model.version} · ID {model.id}</div>
          <div>
            <span className="font-medium">Build-to-promise:</span>{" "}
            {model.buildToPromiseEnabled ? "Enabled" : "Off"}
          </div>
          <div><span className="font-medium">Validation:</span> {model.validationState}</div>
          <div className="break-all">
            <span className="font-medium">Definition hash:</span> {model.definitionHash}
          </div>
        </div>
        <div>
          <div className="font-medium">Build authority recipes</div>
          {buildBindings.length === 0 ? (
            <div className="text-muted-foreground">None recorded.</div>
          ) : (
            <div className="mt-2 space-y-2">
              {buildBindings.map((binding) => (
                <BindingSnapshotEvidence
                  key={binding.bindingKey}
                  binding={binding}
                  variants={view.variants}
                />
              ))}
            </div>
          )}
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Draft v{model.version} records recipe version and ordered BOM snapshots. Editing creates
          an audited new draft version requiring its own approval; live recipe changes do not silently
          rewrite its recorded evidence. It cannot be activated here and has no runtime effect.
        </div>
      </CardContent>
    </Card>
  );
}

function BindingSnapshotEvidence({
  binding,
  variants,
}: {
  binding: TransformationAdminBinding;
  variants: TransformationAdminVariant[];
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="font-medium">
        {binding.recipeCodeSnapshot} v{binding.recipeVersionSnapshot}
      </div>
      <div className="text-muted-foreground">
        {bindingSnapshotEquation(binding, variants)}
      </div>
      <div className="text-xs text-muted-foreground">
        Immutable recipe hash: {binding.recipeDefinitionHash} · Scope:{" "}
        {binding.warehouseId === null ? "network" : `warehouse ${binding.warehouseId}`}
      </div>
    </div>
  );
}

function buildCreateRequestCandidate(input: {
  view: SupplyTransformationsAdminView;
  buildToPromiseEnabled: boolean;
  selectedBuildRecipeIds: number[];
  paths: PathDraft[];
  changeReason: string;
  idempotencyKey: string;
}): CreateTransformationModelDraftRequest {
  const directionalBindings = Array.from(new Map(input.paths.flatMap((path) =>
    path.recipeId === null || path.recipeBindingKey === null
      ? []
      : [[path.recipeBindingKey, {
          bindingKey: path.recipeBindingKey,
          recipeId: path.recipeId,
          relationshipRole: "directional_conversion" as const,
          warehouseId: null,
        }] as const],
  )).values());
  const existingBuildBindingKeyByRecipeId = new Map(
    (input.view.draftModel?.bindings ?? [])
      .filter((binding) =>
        binding.relationshipRole === "component_build" && binding.warehouseId === null)
      .map((binding) => [binding.recipeId, binding.bindingKey] as const),
  );
  return {
    productId: input.view.product.id,
    buildToPromiseEnabled: input.buildToPromiseEnabled,
    paths: input.paths.map((path) => ({
      sourceVariantId: path.sourceVariantId,
      destinationVariantId: path.destinationVariantId,
      inputQty: Number(path.inputQty),
      outputQty: Number(path.outputQty),
      operationType: path.operationType,
      authorityState: path.authorityState,
      transformationRecipeBindingKey: path.recipeBindingKey,
    })),
    recipeBindings: [
      ...input.selectedBuildRecipeIds.map((recipeId) => ({
        bindingKey: existingBuildBindingKeyByRecipeId.get(recipeId) ?? recipeBindingKey(recipeId),
        recipeId,
        relationshipRole: "component_build" as const,
        warehouseId: null,
      })),
      ...directionalBindings,
    ],
    changeReason: input.changeReason,
    idempotencyKey: input.idempotencyKey,
  };
}

function formatOperation(operation: PathDraft["operationType"]): string {
  switch (operation) {
    case "assemble_pack": return "assemble pack";
    case "break_pack": return "break pack";
    case "directed_conversion": return "directed recipe";
  }
}

function recipeBindingKey(recipeId: number): string {
  return `recipe:${recipeId}:network`;
}

async function fetchJson<Schema extends z.ZodTypeAny>(
  url: string,
  schema: Schema,
  init?: RequestInit,
): Promise<z.output<Schema>> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const serverError = parseServerError(body);
    throw new HttpResponseError(
      response.status,
      serverError?.code ?? null,
      serverError?.message ?? `Request failed (${response.status}).`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "response";
    throw new Error(
      `Server returned invalid data at ${path}: ${issue?.message ?? "invalid response"}.`,
    );
  }
  return parsed.data;
}

class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

function parseServerError(body: unknown): { code: string | null; message: string } | null {
  const parsed = z.object({
    error: z.union([
      z.string(),
      z.object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.array(z.string()).optional(),
      }).passthrough(),
    ]),
  }).passthrough().safeParse(body);
  if (!parsed.success) return null;
  if (typeof parsed.data.error === "string") {
    return { code: null, message: parsed.data.error };
  }
  const message = parsed.data.error.details?.[0] ?? parsed.data.error.message;
  return message ? { code: parsed.data.error.code ?? null, message } : null;
}

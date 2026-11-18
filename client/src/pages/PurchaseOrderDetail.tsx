import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProcurementContext } from "@/components/procurement-context";
import { isImmutableRecommendationPurchaseOrder } from "@/features/po-edit/purchase-order-editability";
import { loadDocumentRelationships, relationshipQueryKey } from "@/features/purchasing/DocumentRelationships";
import { usePoFinancialEvidence } from "@/features/purchasing/PoFinancialEvidence";
import { hasPendingPoVarianceApproval } from "@/features/purchasing/PoVarianceApproval";
import { PurchaseApprovalRecovery as PurchaseApprovalRecoveryNotice } from "@/features/purchasing/PurchaseApprovalRecovery";
import { PurchaseLifecycleWorkspace } from "@/features/purchasing/PurchaseLifecycleWorkspace";
import { PurchaseOrderEntryRecoveryNotice } from "@/features/purchasing/PurchaseOrderEntryRecovery";
import { usePoShipmentCosts } from "@/features/purchasing/use-po-shipment-costs";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { usePurchaseApproval } from "@/hooks/use-purchase-approval";
import { usePurchaseOrderEntry } from "@/hooks/use-purchase-order-entry";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { parseProcurementJourney, procurementRecordHref } from "@/lib/procurement-navigation";
import { procurementScheduleDateInput } from "@/lib/procurement-schedule-date";
import type { PurchaseApprovalIntent, PurchaseApprovalRecovery } from "@/lib/purchase-approval-command";
import { parseSupplierDispatchResult, parseSupplierPreparationResult, supplierDispatchReviewedVersion } from "@/lib/supplier-dispatch";
import { poFinancialWorkflowSchema } from "@shared/procurement/po-financial-workflow";
import { projectPurchaseLineShipping, type PurchaseLineShipping } from "@shared/procurement/purchase-line-shipping";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  type AutoDraftActionPlan,
  type ExternalSendReview,
  formatActor,
  type NavigationSnapshot,
  type PoLifecycleActionId,
  type PoLifecycleSummary,
  type RelatedUsersMap,
} from "./purchase-order-detail/po-detail-types-and-helpers";
import {
  PoDetailHeaderBar,
  PoQuickActionsRail,
  PoStatusBannersAndSummary,
  usePoHeaderCharges,
} from "./purchase-order-detail/PoHeaderAndOverview";
import {
  PoExceptionsTab,
  PoHistoryTab,
  PoInvoicesTab,
  PoPaymentsTab,
} from "./purchase-order-detail/PoInvoicesExceptionsAndHistoryTabs";
import {
  PoLifecycleDialogs,
  usePoDocumentAndEmail,
} from "./purchase-order-detail/PoLifecycleAndDocumentDialogs";
import { PoLineDialogs } from "./purchase-order-detail/PoLineDialogs";
import {
  PoLinesTab,
  usePoLineEditing,
} from "./purchase-order-detail/PoLinesSection";
import {
  PoReceiptsTab,
  PoReceiveAndShipmentDialogs,
  PoShipmentsTab,
  usePoShipmentsAndReceipts,
} from "./purchase-order-detail/PoShipmentsAndReceiptsSection";

export type { StageTooltipInfo } from "./purchase-order-detail/po-detail-types-and-helpers";

export default function PurchaseOrderDetail() {
  const { user: shipmentCommandUser, hasPermission } = useAuth();
  const purchaseApproval = usePurchaseApproval();
  const purchaseEntry = usePurchaseOrderEntry();
  const entryBlocked = !purchaseEntry.ready || purchaseEntry.pending || Boolean(purchaseEntry.recovery || purchaseEntry.error);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const searchStr = useSearch();
  const procurementNavigation = useProcurementNavigation();
  const poId = procurementNavigation.record?.kind === "purchase" ? procurementNavigation.record.id : null;
  const navigationIdentity = procurementNavigation.record
    ? procurementRecordHref(procurementNavigation.record, parseProcurementJourney(searchStr))
    : location;
  const navigationVisit = React.useRef({ identity: navigationIdentity, generation: 0, mounted: true });
  if (navigationVisit.current.identity !== navigationIdentity) {
    navigationVisit.current = {
      identity: navigationIdentity,
      generation: navigationVisit.current.generation + 1,
      mounted: navigationVisit.current.mounted,
    };
  }
  useEffect(() => {
    navigationVisit.current.mounted = true;
    return () => { navigationVisit.current.mounted = false; };
  }, []);

  // Mutation observers update their callbacks on re-render. Keep the initiating
  // purchase and journey so a late response cannot attach its child to another PO.
  const captureNavigation = (): NavigationSnapshot => {
    const generation = navigationVisit.current.generation;
    return {
      poId,
      childHref: procurementNavigation.childHref,
      isCurrent: () => navigationVisit.current.mounted && navigationVisit.current.generation === generation,
    };
  };

  const activeTab = procurementNavigation.tab;
  const setActiveTab = procurementNavigation.setTab;
  const requestedTabs = new URLSearchParams(searchStr).getAll("tab");
  const hasExplicitLifecycleTab = requestedTabs.length === 1 && requestedTabs[0] === activeTab;

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showCloseShortDialog, setShowCloseShortDialog] = useState(false);
  const [closeShortReason, setCloseShortReason] = useState("");
  const [showAckDialog, setShowAckDialog] = useState(false);
  const [ackData, setAckData] = useState({ vendorRefNumber: "", confirmedDeliveryDate: "" });
  const [externalSendReview, setExternalSendReview] = useState<ExternalSendReview | null>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleData, setScheduleData] = useState({
    expectedDeliveryDate: "",
    confirmedDeliveryDate: "",
    notes: "",
  });

  // Core PO query & financial / shipment cost projections
  const { data: po, isLoading, isFetching: isPoRefreshing, error: poError, refetch: refetchPo } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${poId}`],
    enabled: !!poId,
  });
  const shipmentCosts = usePoShipmentCosts(poId);
  const financialEvidence = usePoFinancialEvidence(poId);

  const immutableRecommendationPo = isImmutableRecommendationPurchaseOrder(po);
  const isDraft = po?.status === "draft";
  const canEditLines = Boolean(hasPermission("purchasing", "edit") && isDraft && !immutableRecommendationPo);
  const canEditLine = (line: any) =>
    canEditLines &&
    (line.lineType ?? "product") === "product" &&
    (line.status ?? "open") === "open" &&
    [line.receivedQty, line.damagedQty, line.returnedQty, line.cancelledQty]
      .every((quantity) => Number(quantity ?? 0) === 0);
  const isNotCancelled = po && !["cancelled"].includes(po.status);
  const canEditHeader = Boolean(hasPermission("purchasing", "edit") && isNotCancelled && !immutableRecommendationPo);

  // Feature section controllers
  const charges = usePoHeaderCharges({ poId, po, hasPermission });
  const lineEditing = usePoLineEditing({ poId, po, canEditLine });
  const shipmentsController = usePoShipmentsAndReceipts({
    poId,
    activeTab,
    searchStr,
    navigate,
    captureNavigation,
  });
  const docAndEmail = usePoDocumentAndEmail({
    poId,
    po,
    hasPermission,
    navigate,
    captureNavigation,
  });

  const lifecycle = (po as any)?.lifecycle as PoLifecycleSummary | undefined;
  const autoDraftActionPlan = (po as any)?.autoDraftActionPlan as AutoDraftActionPlan | null | undefined;
  const financialEvidenceLoading = financialEvidence.isPending || financialEvidence.isFetching;
  const financialEvidenceAvailable = financialEvidence.isSuccess && !financialEvidenceLoading;
  const financialGuidanceLoading = financialEvidenceLoading || isPoRefreshing;
  const financialReviewRequired = financialEvidenceAvailable && financialEvidence.data?.state === "review_required";
  const parsedFinancialWorkflow = poFinancialWorkflowSchema.safeParse((po as any)?.financialWorkflow);
  // Both reads can succeed across an intervening invoice write. A newer amount
  // snapshot must never inherit a financial action from an older assessment.
  const financialSnapshotsAgree = parsedFinancialWorkflow.success && parsedFinancialWorkflow.data.purchaseOrderId === poId &&
    financialEvidenceAvailable && canonicalJson(parsedFinancialWorkflow.data.evidence) === canonicalJson(financialEvidence.data);
  const financialSnapshotsConflict = parsedFinancialWorkflow.success && financialEvidenceAvailable && !financialSnapshotsAgree;
  const financialGuidanceFailed = financialEvidence.isError || !!poError || financialSnapshotsConflict;
  const financialContextAvailable = financialEvidenceAvailable && !isPoRefreshing && !poError && financialSnapshotsAgree;
  const financialCompletionSupported = financialContextAvailable && financialEvidence.data?.state === "complete" &&
    parsedFinancialWorkflow.success && parsedFinancialWorkflow.data.state === "settled";
  const financialGuidanceLabel = financialGuidanceLoading ? "Loading financial evidence…"
    : financialGuidanceFailed ? "Reload financial evidence" : "Review linked invoices";
  const financialGuidanceDetail = financialGuidanceLoading ? "Wait for the current invoice and payment evidence before deciding the next financial action."
    : financialSnapshotsConflict ? "Invoice evidence changed between reads. Reload the financial evidence before choosing the next action."
    : financialGuidanceFailed ? "Purchase order financial amounts could not be verified. Reload the evidence before relying on payment or balance totals."
      : "Review linked invoices before relying on this PO's payment or balance totals.";
  // This affects displayed financial guidance only. Server lifecycle authority
  // and every physical action remain unchanged.
  const reviewAutoDraftFinances = !!autoDraftActionPlan &&
    ["done", "record_payment", "create_invoice", "review_financial_evidence", "review_invoice_approval"].includes(autoDraftActionPlan.primaryAction.id) &&
    (!financialContextAvailable ||
      (financialReviewRequired && autoDraftActionPlan.primaryAction.id !== "review_financial_evidence") ||
      (autoDraftActionPlan.primaryAction.id === "done" && !financialCompletionSupported));

  const lifecycleActionIds = new Set(
    (lifecycle?.nextActions ?? []).map((action) => action.id),
  );
  const canLifecycleAction = (id: PoLifecycleActionId, fallback: boolean) =>
    lifecycle ? lifecycleActionIds.has(id) : fallback;

  const relatedUsers: RelatedUsersMap | undefined = (po as any)?.relatedUsers;
  const cancelledByFormatted = formatActor((po as any)?.cancelledBy, relatedUsers);

  // Feature-flag redirect: when the new PO editor is enabled, land-on-draft
  // via direct URL should hop over to the new inline editor.
  const { data: procurementSettings } = useQuery<{ useNewPoEditor?: boolean }>({
    queryKey: ["/api/settings/procurement"],
    staleTime: 60_000,
  });
  useEffect(() => {
    if (
      procurementSettings?.useNewPoEditor === true &&
      hasPermission("purchasing", "edit") &&
      po?.id &&
      po?.status === "draft" &&
      !immutableRecommendationPo &&
      !procurementNavigation.purchaseHref &&
      !hasExplicitLifecycleTab
    ) {
      navigate(`/purchase-orders/${po.id}/edit`, { replace: true });
    }
  }, [procurementSettings?.useNewPoEditor, hasPermission, po?.id, po?.status, immutableRecommendationPo, navigate, procurementNavigation.purchaseHref, hasExplicitLifecycleTab]);

  // Committed purchases open on their connected lifecycle.
  useEffect(() => {
    if (po?.id && po.status !== "draft" && requestedTabs.length === 0) {
      const params = new URLSearchParams(searchStr);
      params.set("tab", "lifecycle");
      navigate(`/purchase-orders/${po.id}?${params.toString()}`, { replace: true });
    }
  }, [po?.id, po?.status, searchStr, navigate]);

  const { data: historyData } = useQuery<{ history: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/history`],
    enabled: !!poId && activeTab === "history",
  });

  const relationshipsQuery = useQuery({
    queryKey: relationshipQueryKey({ kind: "purchase", id: poId ?? 0 }),
    queryFn: ({ signal }) => {
      if (poId === null) throw new Error("A valid purchase order is required to load document links.");
      return loadDocumentRelationships({ kind: "purchase", id: poId }, signal);
    },
    enabled: !!poId,
  });
  const relatedDocuments = relationshipsQuery.data;
  const shippingByLine = React.useMemo(
    () => (relationshipsQuery.isSuccess && relatedDocuments
      ? projectPurchaseLineShipping(relatedDocuments)
      : new Map<number, PurchaseLineShipping>()),
    [relatedDocuments, relationshipsQuery.isSuccess],
  );
  const linkedShipments = relatedDocuments?.shipments ?? [];

  // Load linked documents on entry so the financial review handoff is ready.
  const { data: invoicesData, isPending: invoicesLoading, isFetching: invoicesRefreshing, isError: invoicesError, refetch: refetchInvoices } = useQuery<{ invoices: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/invoices`],
    enabled: !!poId,
  });

  const { data: paymentsData, isPending: paymentsLoading, isFetching: paymentsRefreshing, isError: paymentsError, refetch: refetchPayments } = useQuery<{ payments: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/payments`],
    enabled: !!poId && activeTab === "payments",
  });

  const [showResolvedExceptions, setShowResolvedExceptions] = useState(() =>
    hasPendingPoVarianceApproval(poId, shipmentCommandUser?.id),
  );
  const { data: exceptionsData, refetch: refetchExceptions } = useQuery<{ exceptions: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/exceptions`, showResolvedExceptions],
    queryFn: async () => {
      const url = showResolvedExceptions
        ? `/api/purchase-orders/${poId}/exceptions?includeResolved=true`
        : `/api/purchase-orders/${poId}/exceptions`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load exceptions");
      return res.json();
    },
    enabled: !!poId,
  });
  useEffect(() => {
    if (hasPendingPoVarianceApproval(poId, shipmentCommandUser?.id)) setShowResolvedExceptions(true);
  }, [poId, shipmentCommandUser?.id]);

  const allExceptions = exceptionsData?.exceptions ?? [];
  const openExceptions = allExceptions.filter((e: any) => ["open", "acknowledged"].includes(e.status));
  const closedExceptions = allExceptions.filter((e: any) => ["resolved", "dismissed"].includes(e.status));
  const openExceptionCount = openExceptions.length;
  const maxOpenSeverity = openExceptions.reduce<"info" | "warn" | "error" | null>((acc, e) => {
    const order: Record<string, number> = { info: 1, warn: 2, error: 3 };
    if (!acc) return e.severity;
    return order[e.severity] > order[acc] ? e.severity : acc;
  }, null);

  const lines = po?.lines ?? [];
  const history = historyData?.history ?? [];

  const canSubmitPo = canLifecycleAction("submit", po?.status === "draft");
  const canReturnPoToDraft = canLifecycleAction("return_to_draft", po?.status === "pending_approval");
  const canApprovePo = canLifecycleAction("approve", po?.status === "pending_approval");
  const canSendPo = canLifecycleAction("send", po?.status === "approved");
  const canSendPoToVendor = canLifecycleAction(
    "send_to_vendor",
    po?.status === "draft" || po?.status === "approved",
  );
  const canAcknowledgePo = canLifecycleAction("acknowledge", po?.physicalStatus === "sent");
  const canMarkPoShipped = canLifecycleAction("mark_shipped", po?.physicalStatus === "acknowledged");
  const canMarkPoInTransit = canLifecycleAction("mark_in_transit", po?.physicalStatus === "shipped");
  const canMarkPoArrived = canLifecycleAction(
    "mark_arrived",
    po?.physicalStatus === "in_transit" || po?.physicalStatus === "shipped",
  );
  const canCreateReceiptForPo = canLifecycleAction(
    "create_receipt",
    ["sent", "acknowledged", "partially_received"].includes(po?.status),
  );
  const cancellationAction = lifecycle?.nextActions?.find((action) => action.id === "cancel");
  const canCancelPo = Boolean(
    cancellationAction?.endpoint &&
    cancellationAction.requiredPermission &&
    hasPermission(cancellationAction.requiredPermission.resource, cancellationAction.requiredPermission.action),
  );
  const cancellationLabel = cancellationAction?.label ?? "Cancel";
  const canClosePo = canLifecycleAction("close", po?.status === "received");
  const closeShortAction = lifecycle?.nextActions?.find((action) => action.id === "close_short");
  const canCloseShortPo = Boolean(
    canLifecycleAction("close_short", false) &&
    !poError &&
    !isPoRefreshing &&
    closeShortAction?.endpoint === `/api/purchase-orders/${poId}/close-short` &&
    closeShortAction.requiredPermission &&
    hasPermission(closeShortAction.requiredPermission.resource, closeShortAction.requiredPermission.action),
  );
  const scheduleStatus = po?.physicalStatus ?? po?.status;
  const canEditSchedule = Boolean(
    po && !["received", "closed", "cancelled", "short_closed"].includes(scheduleStatus),
  );
  const canSetConfirmedDelivery = Boolean(
    po && !["draft", "pending_approval", "approved"].includes(scheduleStatus),
  );
  const scheduleMinimumDate = procurementScheduleDateInput(po?.sentToVendorAt ?? po?.orderDate ?? po?.createdAt);

  const openScheduleEditor = () => {
    setScheduleData({
      expectedDeliveryDate: procurementScheduleDateInput(po?.expectedDeliveryDate),
      confirmedDeliveryDate: procurementScheduleDateInput(po?.confirmedDeliveryDate),
      notes: "",
    });
    setShowScheduleDialog(true);
  };

  // Lifecycle transition mutations
  function createTransitionMutation(endpoint: string, method = "POST") {
    return useMutation<any, Error, void>({
      mutationFn: async () => {
        const res = await fetch(`/api/purchase-orders/${poId}/${endpoint}`, {
          method,
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Failed to ${endpoint}`);
        }
        return res.json();
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
        toast({ title: "Success", description: `PO ${endpoint.replace(/-/g, " ")} completed` });
      },
      onError: (err: Error) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      },
    });
  }

  const submitMutation = createTransitionMutation("submit");
  const returnToDraftMutation = createTransitionMutation("return-to-draft");
  const approveMutation = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async (request: {
      body: PurchaseApprovalIntent;
      recovery?: PurchaseApprovalRecovery;
      navigation: NavigationSnapshot;
      visit: ReturnType<typeof purchaseApproval.captureVisit>;
    }) => {
      if (!request.navigation.isCurrent() || !request.visit.isCurrent()) {
        throw new Error("The purchase review changed. Review the current purchase and operator before approving.");
      }
      return purchaseApproval.execute(request.body, request.recovery);
    },
    onSuccess: (_approved, request) => {
      void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${request.body.purchaseOrderId}`] });
      void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${request.body.purchaseOrderId}/history`] });
      void queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (request.navigation.isCurrent() && request.visit.isCurrent()) {
        toast({ title: "Purchase approval confirmed", description: "The reviewed purchase terms and approval are saved in history." });
      }
    },
    onError: (error: Error, request) => {
      if (!request.navigation.isCurrent() || !request.visit.isCurrent()) return;
      void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${request.body.purchaseOrderId}`] });
      toast({ title: "Purchase approval was not confirmed", description: error.message, variant: "destructive" });
    },
  });
  const approvalBlocked = approveMutation.isPending || !purchaseApproval.allowed || !purchaseApproval.ready || Boolean(purchaseApproval.recovery || purchaseApproval.error);

  function approveReviewedPurchase() {
    if (approvalBlocked || !poId || !po || po.id !== poId) return;
    try {
      const expectedUpdatedAt = supplierDispatchReviewedVersion(po.updatedAt);
      approveMutation.mutate({
        body: {
          purchaseOrderId: poId,
          expectedUpdatedAt,
          expectedTotalCents: po.totalCents,
          expectedLinesFingerprint: po.approvalLinesFingerprint,
        },
        navigation: captureNavigation(),
        visit: purchaseApproval.captureVisit(),
      });
    } catch (error) {
      toast({
        title: "Purchase review required",
        description: error instanceof Error ? error.message : "Reload and review the current purchase terms.",
        variant: "destructive",
      });
    }
  }

  function recoverPurchaseApproval(recovery: PurchaseApprovalRecovery) {
    approveMutation.mutate({
      body: recovery.body,
      recovery,
      navigation: captureNavigation(),
      visit: purchaseApproval.captureVisit(),
    });
  }

  const sendMutation = useMutation({
    mutationFn: async (review: ExternalSendReview) => {
      if (!review.isCurrent()) throw new Error("The selected PO changed. Review the current PO before recording an external send.");
      const res = await fetch(`/api/purchase-orders/${review.poId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmedSentExternally: true, expectedUpdatedAt: review.expectedUpdatedAt }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : "Supplier dispatch was not confirmed.";
        throw new Error(message);
      }
      return parseSupplierDispatchResult(body, review.poId);
    },
    onSuccess: (outcome, review) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${review.poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${review.poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (!review.isCurrent()) return;
      setExternalSendReview(null);
      if (outcome === "recorded") {
        toast({ title: "External send recorded", description: "The operator confirmation is saved in PO history." });
      } else {
        toast({
          title: "Approval required",
          description: "Supplier dispatch was not recorded. Review the current approval requirements before continuing.",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error, review) => {
      if (review.isCurrent()) toast({ title: "External send was not confirmed", description: error.message, variant: "destructive" });
    },
  });
  useEffect(() => {
    setExternalSendReview(null);
    sendMutation.reset();
  }, [navigationIdentity]);

  function openExternalSendConfirmation() {
    if (!poId || !po || po.id !== poId || po.status !== "approved") return;
    try {
      const expectedUpdatedAt = supplierDispatchReviewedVersion(po.updatedAt);
      sendMutation.reset();
      setExternalSendReview({ ...captureNavigation(), poId, poNumber: po.poNumber, expectedUpdatedAt });
    } catch (error) {
      toast({
        title: "PO review required",
        description: error instanceof Error ? error.message : "Reload the PO before recording supplier dispatch.",
        variant: "destructive",
      });
    }
  }

  const closeMutation = createTransitionMutation("close");

  const { data: approvalTiersData } = useQuery<{ tiers: any[] }>({
    queryKey: ["/api/purchasing/approval-tiers"],
  });
  const isSoloMode = (approvalTiersData?.tiers?.length ?? 0) === 0;

  const { data: settingsData } = useQuery<Record<string, string | null>>({
    queryKey: ["/api/settings"],
    select: (data: any) => data,
  });
  const requireAcknowledgment = settingsData?.requireVendorAcknowledgment === "true";

  // Exception lifecycle mutations
  const ackExceptionMutation = useMutation({
    mutationFn: async (exceptionId: number) => {
      const res = await fetch(`/api/po-exceptions/${exceptionId}/acknowledge`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Acknowledge failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      void refetchExceptions();
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Exception acknowledged" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const resolveExceptionMutation = useMutation({
    mutationFn: async ({ id, resolutionNote }: { id: number; resolutionNote: string }) => {
      const res = await fetch(`/api/po-exceptions/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionNote }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Resolve failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      void refetchExceptions();
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Exception resolved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const dismissExceptionMutation = useMutation({
    mutationFn: async ({ id, note }: { id: number; note?: string }) => {
      const res = await fetch(`/api/po-exceptions/${id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || "" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Dismiss failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      void refetchExceptions();
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Exception dismissed" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const sendToVendorMutation = useMutation({
    networkMode: "always",
    onMutate: () => ({ navigation: captureNavigation(), visit: purchaseEntry.captureVisit() }),
    mutationFn: async () => {
      const targetId = poId;
      if (!targetId) throw new Error("Select a PO before preparing supplier review.");
      if (entryBlocked) throw new Error("Recover the saved purchase request before preparing another purchase.");
      const result = await purchaseEntry.execute({ action: "prepare", targetId, payload: {} });
      return parseSupplierPreparationResult(result.po, targetId);
    },
    onSuccess: async (updatedPo, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${updatedPo.id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (!context?.navigation.isCurrent() || !context.visit.isCurrent()) return;
      const current = await refetchPo();
      if (!context.navigation.isCurrent() || !context.visit.isCurrent()) return;
      if (!current.error && current.data?.id === updatedPo.id && current.data.status === "approved") {
        docAndEmail.setShowDocDialog(true);
        void docAndEmail.loadDocumentPreview();
      }
      toast({
        title: updatedPo.status === "pending_approval" ? "Submitted for approval" : "PO ready for supplier review",
        description: "Supplier dispatch has not been recorded. Review the document before sending it outside Echelon.",
      });
    },
    onError: (err: Error, _variables, context) => {
      if (!context?.navigation.isCurrent() || !context.visit.isCurrent()) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function recoverPurchaseEntry() {
    const saved = purchaseEntry.recovery;
    if (!saved) return;
    const visit = purchaseEntry.captureVisit();
    const navigation = captureNavigation();
    try {
      const result = await purchaseEntry.execute(saved.body, saved);
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${result.po.id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (!visit.isCurrent() || !navigation.isCurrent()) return;
      toast({ title: "Purchase request confirmed", description: "Review the current purchase order before continuing." });
      if (result.po.id !== poId) navigate(`/purchase-orders/${result.po.id}`);
      else void refetchPo();
    } catch { /* The recovery notice retains the request and reports the failure. */ }
  }

  const acknowledgeMutation = useMutation({
    mutationFn: async (data: typeof ackData) => {
      const res = await fetch(`/api/purchase-orders/${poId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorRefNumber: data.vendorRefNumber || undefined,
          confirmedDeliveryDate: data.confirmedDeliveryDate || undefined,
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowAckDialog(false);
      toast({ title: "Acknowledged", description: "Vendor acknowledgment recorded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateScheduleMutation = useMutation({
    mutationFn: async (data: typeof scheduleData) => {
      const res = await fetch(`/api/purchase-orders/${poId}/delivery-schedule`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedDeliveryDate: data.expectedDeliveryDate || null,
          confirmedDeliveryDate: data.confirmedDeliveryDate || null,
          notes: data.notes.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to update delivery schedule");
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/procurement/health"] });
      setShowScheduleDialog(false);
      toast({ title: "Schedule updated", description: "Delivery dates and audit history were updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Schedule update failed", description: err.message, variant: "destructive" });
    },
  });

  const markShippedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/mark-shipped`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Marked as shipped" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const markInTransitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/mark-in-transit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Marked as in transit" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const markArrivedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/mark-arrived`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Marked as arrived" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!canCancelPo || !cancellationAction?.endpoint) {
        throw new Error("Cancellation is unavailable. Refresh the purchase order and review your current permissions.");
      }
      const res = await fetch(cancellationAction.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setShowCancelDialog(false);
      setCancelReason("");
      toast({ title: "Cancelled", description: "Purchase order cancelled" });
    },
    onError: async (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] }),
      ]);
    },
  });

  const refreshCloseShortState = async (purchaseOrderId: number) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}/history`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}/workspace`] }),
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] }),
    ]);
  };
  const closeShortMutation = useMutation({
    onMutate: captureNavigation,
    mutationFn: async (command: { purchaseOrderId: number; endpoint: string; reason: string }) => {
      if (!canCloseShortPo || command.purchaseOrderId !== poId || command.endpoint !== closeShortAction?.endpoint) {
        throw new Error("Close-short is unavailable. Refresh the purchase order and review your current permissions.");
      }
      const reason = command.reason.trim();
      if (!reason) throw new Error("Enter a reason for closing the receipt short.");
      const response = await fetch(command.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "Unable to close this purchase order short.");
      if (body?.id !== command.purchaseOrderId || body.status !== "closed" || body.physicalStatus !== "short_closed") {
        throw new Error("The close-short response could not be confirmed. Reload the purchase order before retrying.");
      }
      return body;
    },
    onSuccess: async (_result, command, context) => {
      await refreshCloseShortState(command.purchaseOrderId);
      if (!context?.isCurrent()) return;
      setShowCloseShortDialog(false);
      setCloseShortReason("");
      toast({ title: "PO closed short", description: "The reason was saved with the remaining receipt work." });
    },
    onError: async (_error: Error, command) => {
      await refreshCloseShortState(command.purchaseOrderId);
    },
  });
  useEffect(() => {
    setShowCloseShortDialog(false);
    setCloseShortReason("");
    closeShortMutation.reset();
  }, [poId]);

  const runAutoDraftPrimaryAction = async () => {
    if (reviewAutoDraftFinances) {
      if (financialGuidanceLoading) return;
      if (financialGuidanceFailed) {
        await Promise.all([financialEvidence.refetch(), refetchPo()]);
        return;
      }
      setActiveTab("invoices");
      return;
    }
    const action = autoDraftActionPlan?.primaryAction;
    if (!action) return;
    if (action.tab) setActiveTab(action.tab);

    switch (action.id) {
      case "open_lines":
      case "open_exceptions":
      case "review_financial_evidence":
      case "review_invoice_approval":
      case "done":
      case "cancelled":
        return;
      case "create_invoice":
        await docAndEmail.openCreateInvoiceDialogFromPo();
        return;
      case "record_payment":
        setActiveTab("invoices");
        return;
      case "submit":
        submitMutation.mutate();
        return;
      case "approve":
        approveReviewedPurchase();
        return;
      case "send":
        openExternalSendConfirmation();
        return;
      case "send_to_vendor":
        if (po?.status === "approved") {
          docAndEmail.setShowDocDialog(true);
          void docAndEmail.loadDocumentPreview();
        } else if (isSoloMode) {
          sendToVendorMutation.mutate();
        } else {
          submitMutation.mutate();
        }
        return;
      case "acknowledge":
        setShowAckDialog(true);
        return;
      case "mark_shipped":
        markShippedMutation.mutate();
        return;
      case "mark_in_transit":
        markInTransitMutation.mutate();
        return;
      case "mark_arrived":
        markArrivedMutation.mutate();
        return;
      case "create_receipt":
        shipmentsController.createReceiptMutation.mutate();
        return;
      case "close":
        closeMutation.mutate();
        return;
      case "return_to_draft":
        returnToDraftMutation.mutate();
        return;
      case "cancel":
        setShowCancelDialog(true);
        return;
      case "close_short":
        if (canCloseShortPo) setShowCloseShortDialog(true);
        return;
    }
  };

  const autoDraftPrimaryActionPending = (() => {
    switch (autoDraftActionPlan?.primaryAction.id) {
      case "submit":
        return submitMutation.isPending;
      case "approve":
        return approvalBlocked;
      case "send":
        return sendMutation.isPending;
      case "send_to_vendor":
        return po?.status === "approved"
          ? sendMutation.isPending
          : entryBlocked || (isSoloMode && !purchaseEntry.allowed("prepare")) || sendToVendorMutation.isPending || submitMutation.isPending;
      case "mark_shipped":
        return markShippedMutation.isPending;
      case "mark_in_transit":
        return markInTransitMutation.isPending;
      case "mark_arrived":
        return markArrivedMutation.isPending;
      case "create_receipt":
        return shipmentsController.createReceiptMutation.isPending;
      case "create_invoice":
        return docAndEmail.createInvoiceMutation.isPending;
      case "close":
        return closeMutation.isPending;
      case "close_short":
        return closeShortMutation.isPending;
      case "return_to_draft":
        return returnToDraftMutation.isPending;
      default:
        return false;
    }
  })();

  const autoDraftPrimaryButtonLabel = (() => {
    if (reviewAutoDraftFinances) return financialGuidanceLabel;
    switch (autoDraftActionPlan?.primaryAction.id) {
      case "open_lines":
        return "Open lines";
      case "open_exceptions":
        return "Open exceptions";
      case "create_invoice":
        return "Create invoice";
      case "record_payment":
        return "Review invoice payment";
      case "done":
        return "No action";
      case "cancelled":
        return "Review history";
      default:
        return autoDraftActionPlan?.primaryAction.label ?? "Open";
    }
  })();

  const autoDraftPrimaryButtonDisabled =
    !autoDraftActionPlan ||
    autoDraftPrimaryActionPending ||
    (reviewAutoDraftFinances && financialGuidanceLoading) ||
    (!reviewAutoDraftFinances && ["done", "cancelled"].includes(autoDraftActionPlan.primaryAction.id));

  const entryRecoveryPanel = (
    <PurchaseOrderEntryRecoveryNotice
      recovery={purchaseEntry.recovery}
      storageError={purchaseEntry.error}
      error={purchaseEntry.commandError}
      pending={purchaseEntry.pending}
      allowed={purchaseEntry.recovery ? purchaseEntry.allowed(purchaseEntry.recovery.body.action) : false}
      onRecover={recoverPurchaseEntry}
      onRead={purchaseEntry.refresh}
    />
  );

  const approvalRecoveryPanel = (
    <PurchaseApprovalRecoveryNotice
      recovery={purchaseApproval.recovery}
      error={purchaseApproval.error}
      pending={approveMutation.isPending}
      allowed={purchaseApproval.allowed}
      onRecover={recoverPurchaseApproval}
      onRefresh={purchaseApproval.refresh}
    />
  );

  if (isLoading) {
    return (
      <div className="p-2 md:p-6 space-y-4">
        <ProcurementContext navigation={procurementNavigation} />
        {approvalRecoveryPanel}
        {entryRecoveryPanel}
        <Button variant="ghost" size="sm" asChild>
          <Link href={procurementNavigation.backHref("/purchase-orders")}>
            {procurementNavigation.backLabel ?? "Back to purchase orders"}
          </Link>
        </Button>
        <div className="flex items-center justify-center min-h-[50vh]" role="status" aria-label="Loading purchase order">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  if (poError && !po) {
    const notFound = poError instanceof Error && poError.message.startsWith("404:");
    return (
      <div className="p-2 md:p-6 space-y-4">
        <ProcurementContext navigation={procurementNavigation} />
        {approvalRecoveryPanel}
        {entryRecoveryPanel}
        <div role="alert" className="rounded-lg border p-4 space-y-3">
          <p className="font-medium">{notFound ? "Purchase order not found." : "Unable to load purchase order."}</p>
          {!notFound && (
            <p className="text-sm text-muted-foreground">
              The purchase order could not be retrieved. Try again or return to the previous record.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!notFound && (
              <Button variant="outline" size="sm" onClick={() => void refetchPo()}>
                <RotateCcw className="h-4 w-4 mr-1" />
                Retry
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link href={procurementNavigation.backHref("/purchase-orders")}>
                {procurementNavigation.backLabel ?? "Back to purchase orders"}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!po) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Purchase order not found.</p>
        <ProcurementContext navigation={procurementNavigation} />
        {approvalRecoveryPanel}
        {entryRecoveryPanel}
        <Button variant="link" asChild>
          <Link href={procurementNavigation.backHref("/purchase-orders")}>
            {procurementNavigation.backLabel ?? "Back to purchase orders"}
          </Link>
        </Button>
      </div>
    );
  }

  const canCreatePurchasing = hasPermission("purchasing", "create");

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <ProcurementContext navigation={procurementNavigation} />
      {approvalRecoveryPanel}
      {entryRecoveryPanel}

      <PoDetailHeaderBar
        po={po}
        poId={poId}
        procurementNavigation={procurementNavigation}
        charges={charges}
        canEditHeader={canEditHeader}
        canEditSchedule={canEditSchedule}
        openScheduleEditor={openScheduleEditor}
        canSendPoToVendor={canSendPoToVendor}
        isSoloMode={isSoloMode}
        entryBlocked={entryBlocked}
        canPreparePurchaseEntry={purchaseEntry.allowed("prepare")}
        sendToVendorPending={sendToVendorMutation.isPending}
        onSendToVendor={() => sendToVendorMutation.mutate()}
        canSubmitPo={canSubmitPo}
        submitPending={submitMutation.isPending}
        onSubmitPo={() => submitMutation.mutate()}
        canApprovePo={canApprovePo}
        approvalBlocked={approvalBlocked}
        onApprovePo={approveReviewedPurchase}
        canReturnPoToDraft={canReturnPoToDraft}
        returnToDraftPending={returnToDraftMutation.isPending}
        onReturnPoToDraft={() => returnToDraftMutation.mutate()}
        canSendPo={canSendPo}
        sendPending={sendMutation.isPending}
        onOpenExternalSendConfirmation={openExternalSendConfirmation}
        canAcknowledgePo={canAcknowledgePo}
        requireAcknowledgment={requireAcknowledgment}
        onOpenAckDialog={() => setShowAckDialog(true)}
        canCreateReceiptForPo={canCreateReceiptForPo}
        onOpenReceivePicker={() => shipmentsController.setShowReceivePicker(true)}
        canClosePo={canClosePo}
        closePending={closeMutation.isPending}
        onClosePo={() => closeMutation.mutate()}
        canCloseShortPo={canCloseShortPo}
        closeShortPending={closeShortMutation.isPending}
        onOpenCloseShortDialog={() => setShowCloseShortDialog(true)}
        canCancelPo={canCancelPo}
        cancellationLabel={cancellationLabel}
        onOpenCancelDialog={() => setShowCancelDialog(true)}
        onOpenDocumentPreview={async () => {
          docAndEmail.setShowDocDialog(true);
          await docAndEmail.loadDocumentPreview();
        }}
        canCreatePurchasing={canCreatePurchasing}
        onOpenCreateInvoiceDialog={docAndEmail.openCreateInvoiceDialogFromPo}
      />

      <PoStatusBannersAndSummary
        po={po}
        poId={poId}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        openExceptionCount={openExceptionCount}
        maxOpenSeverity={maxOpenSeverity}
        cancelledByFormatted={cancelledByFormatted}
        issuedInvoicesCount={invoicesData?.invoices?.length ?? 0}
        recordedApplicationsCount={paymentsData?.payments?.length ?? 0}
        receiptsCount={shipmentsController.receipts.length}
        financialEvidence={financialEvidence}
        procurementNavigation={procurementNavigation}
        history={history}
        charges={charges}
        canEditHeader={canEditHeader}
        canEditLines={canEditLines}
        shipmentCosts={shipmentCosts}
        immutableRecommendationPo={immutableRecommendationPo}
        autoDraftActionPlan={autoDraftActionPlan}
        linesCount={lines.length}
        reviewAutoDraftFinances={reviewAutoDraftFinances}
        financialGuidanceLabel={financialGuidanceLabel}
        financialGuidanceDetail={financialGuidanceDetail}
        financialGuidanceLoading={financialGuidanceLoading}
        financialGuidanceFailed={financialGuidanceFailed}
        financialContextAvailable={financialContextAvailable}
        financialReviewRequired={financialReviewRequired}
        financialCompletionSupported={financialCompletionSupported}
        autoDraftPrimaryActionPending={autoDraftPrimaryActionPending}
        autoDraftPrimaryButtonLabel={autoDraftPrimaryButtonLabel}
        autoDraftPrimaryButtonDisabled={autoDraftPrimaryButtonDisabled}
        onRunAutoDraftPrimaryAction={runAutoDraftPrimaryAction}
      />

      {/* Tabs + Quick Actions side rail */}
      <div className={`flex flex-col ${activeTab === "lines" ? "2xl:flex-row" : "md:flex-row"} gap-4 items-start`}>
        <div className="flex-1 min-w-0 w-full">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="flex h-auto max-w-full flex-wrap justify-start">
              <TabsTrigger value="lifecycle">Lifecycle</TabsTrigger>
              <TabsTrigger value="lines">Lines ({lines.length})</TabsTrigger>
              <TabsTrigger value="receipts">Receipts</TabsTrigger>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
              <TabsTrigger value="shipments">Shipments {linkedShipments.length > 0 ? `(${linkedShipments.length})` : ""}</TabsTrigger>
              <TabsTrigger value="exceptions" data-testid="tab-exceptions">
                Exceptions{openExceptionCount > 0 ? ` (${openExceptionCount})` : ""}
              </TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>

            <TabsContent value="lifecycle" className="space-y-4">
              {poId && activeTab === "lifecycle" && (
                <PurchaseLifecycleWorkspace purchaseOrderId={poId} navigation={procurementNavigation} />
              )}
            </TabsContent>

            <PoLinesTab
              po={po}
              lines={lines}
              canEditLines={canEditLines}
              canEditLine={canEditLine}
              lineEditing={lineEditing}
              relationshipsError={relationshipsQuery.isError}
              relationshipsPending={relationshipsQuery.isPending}
              onRefetchRelationships={() => void relationshipsQuery.refetch()}
              shippingByLine={shippingByLine}
              shipmentCosts={shipmentCosts}
              onRefetchPo={refetchPo}
              procurementNavigation={procurementNavigation}
            />

            <PoReceiptsTab
              receipts={shipmentsController.receipts}
              childHref={procurementNavigation.childHref}
            />

            <PoShipmentsTab
              po={po}
              linesCount={lines.length}
              shippingApplicable={charges.shippingApplicable}
              poIncoterms={charges.poIncoterms}
              shipmentsController={shipmentsController}
            />

            <PoInvoicesTab
              po={po}
              canCreatePurchasing={canCreatePurchasing}
              onOpenCreateInvoiceDialog={docAndEmail.openCreateInvoiceDialogFromPo}
              invoicesData={invoicesData}
              invoicesLoading={invoicesLoading}
              invoicesRefreshing={invoicesRefreshing}
              invoicesError={invoicesError}
              onRefetchInvoices={() => void refetchInvoices()}
              childHref={procurementNavigation.childHref}
            />

            <PoPaymentsTab
              paymentsData={paymentsData}
              paymentsLoading={paymentsLoading}
              paymentsRefreshing={paymentsRefreshing}
              paymentsError={paymentsError}
              onRefetchPayments={() => void refetchPayments()}
            />

            <PoExceptionsTab
              poId={poId}
              openExceptions={openExceptions}
              closedExceptions={closedExceptions}
              showResolvedExceptions={showResolvedExceptions}
              setShowResolvedExceptions={setShowResolvedExceptions}
              childHref={procurementNavigation.childHref}
              onAcknowledgeException={(id) => ackExceptionMutation.mutate(id)}
              onResolveException={(id, resolutionNote) => resolveExceptionMutation.mutate({ id, resolutionNote })}
              onDismissException={(id, note) => dismissExceptionMutation.mutate({ id, note })}
              exceptionBusy={
                ackExceptionMutation.isPending ||
                resolveExceptionMutation.isPending ||
                dismissExceptionMutation.isPending
              }
              relatedUsers={relatedUsers}
              onVarianceApproved={() => {
                void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/exceptions`] });
                void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
                void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
              }}
              onRefetchExceptions={() => { void refetchExceptions(); }}
            />

            <PoHistoryTab
              poId={poId}
              shipmentCosts={shipmentCosts}
              history={history}
              relatedUsers={relatedUsers}
            />
          </Tabs>
        </div>

        <PoQuickActionsRail
          po={po}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          canSendPoToVendor={canSendPoToVendor}
          isSoloMode={isSoloMode}
          entryBlocked={entryBlocked}
          canPreparePurchaseEntry={purchaseEntry.allowed("prepare")}
          sendToVendorPending={sendToVendorMutation.isPending}
          onSendToVendor={() => sendToVendorMutation.mutate()}
          canAcknowledgePo={canAcknowledgePo}
          onOpenAckDialog={() => setShowAckDialog(true)}
          canMarkPoShipped={canMarkPoShipped}
          markShippedPending={markShippedMutation.isPending}
          onMarkShipped={() => markShippedMutation.mutate()}
          canMarkPoInTransit={canMarkPoInTransit}
          markInTransitPending={markInTransitMutation.isPending}
          onMarkInTransit={() => markInTransitMutation.mutate()}
          canMarkPoArrived={canMarkPoArrived}
          markArrivedPending={markArrivedMutation.isPending}
          onMarkArrived={() => markArrivedMutation.mutate()}
          onOpenCreateShipmentDialog={() => shipmentsController.setShowCreateShipmentDialog(true)}
          canCreateReceiptForPo={canCreateReceiptForPo}
          onOpenReceivePicker={() => shipmentsController.setShowReceivePicker(true)}
          canCancelPo={canCancelPo}
          cancellationLabel={cancellationLabel}
          onOpenCancelDialog={() => setShowCancelDialog(true)}
          financialCompletionSupported={financialCompletionSupported}
        />
      </div>

      <PoLineDialogs po={po} lineEditing={lineEditing} />

      <PoLifecycleDialogs
        po={po}
        poId={poId}
        docAndEmail={docAndEmail}
        canCreatePurchasing={canCreatePurchasing}
        showCloseShortDialog={showCloseShortDialog}
        setShowCloseShortDialog={setShowCloseShortDialog}
        closeShortReason={closeShortReason}
        setCloseShortReason={setCloseShortReason}
        canCloseShortPo={canCloseShortPo}
        closeShortEndpoint={closeShortAction?.endpoint}
        closeShortPending={closeShortMutation.isPending}
        closeShortError={closeShortMutation.error}
        onConfirmCloseShort={(command) => closeShortMutation.mutate(command)}
        showCancelDialog={showCancelDialog}
        setShowCancelDialog={setShowCancelDialog}
        canCancelPo={canCancelPo}
        cancellationLabel={cancellationLabel}
        cancelReason={cancelReason}
        setCancelReason={setCancelReason}
        cancelPending={cancelMutation.isPending}
        onConfirmCancel={(reason) => cancelMutation.mutate(reason)}
        showScheduleDialog={showScheduleDialog}
        setShowScheduleDialog={setShowScheduleDialog}
        scheduleMinimumDate={scheduleMinimumDate}
        canSetConfirmedDelivery={canSetConfirmedDelivery}
        scheduleData={scheduleData}
        setScheduleData={setScheduleData}
        updateSchedulePending={updateScheduleMutation.isPending}
        onSaveSchedule={() => updateScheduleMutation.mutate(scheduleData)}
        externalSendReview={externalSendReview}
        setExternalSendReview={setExternalSendReview}
        sendPending={sendMutation.isPending}
        sendError={sendMutation.error}
        onConfirmExternalSend={(review) => sendMutation.mutate(review)}
        showAckDialog={showAckDialog}
        setShowAckDialog={setShowAckDialog}
        ackData={ackData}
        setAckData={setAckData}
        acknowledgePending={acknowledgeMutation.isPending}
        onConfirmAcknowledge={() => acknowledgeMutation.mutate(ackData)}
      />

      <PoReceiveAndShipmentDialogs
        po={po}
        shipmentsController={shipmentsController}
        procurementNavigation={procurementNavigation}
        navigate={navigate}
      />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  FileSearch,
  History,
  MinusCircle,
  PlusCircle,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildAdminDogfoodReadinessUrl,
  buildAdminOrderIntakeUrl,
  buildAdminReturnCreateInput,
  buildAdminReturnSourceOrderUrl,
  buildAdminReturnPolicyInput,
  buildAdminReturnPolicyUrl,
  buildAdminReturnStatusUpdateInput,
  buildAdminReturnsUrl,
  buildAdminStoreConnectionsUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  isRmaStatusTerminal,
  legalRmaTransitions,
  optionalQueryErrorMessage,
  postJson,
  queryErrorMessage,
  type DropshipAdminNoInspectionReviewInput,
  type DropshipAdminNoInspectionReviewResponse,
  type DropshipAdminOrderOpsIntakeListItem,
  type DropshipAdminOrderOpsListResponse,
  type DropshipAdminOrderOpsStoreSummary,
  type DropshipAdminOrderOpsVendorSummary,
  type DropshipAdminReturnCreateResponse,
  type DropshipAdminReturnPolicyCreateResponse,
  type DropshipAdminReturnPolicyResponse,
  type DropshipAdminReturnSourceOrder,
  type DropshipAdminReturnSourceOrderLine,
  type DropshipAdminReturnSourceOrderResponse,
  type DropshipAdminReturnStatusUpdateResponse,
  type DropshipAdminRmaLabelSource,
  type DropshipAdminRmaReasonCode,
  type DropshipAdminStoreConnectionListItem,
  type DropshipAdminStoreConnectionListResponse,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResponse,
  type DropshipReturnDetail,
  type DropshipReturnDetailResponse,
  type DropshipReturnFaultCategory,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
  type DropshipReturnPolicyConfig,
  type DropshipRmaStatus,
} from "@/lib/dropship-ops-surface";
import { ReturnInspectionModal } from "@/components/dropship/ReturnInspectionModal";

type ReturnOpsStatusFilter = DropshipRmaStatus | "default" | "all";

interface DropshipProductVariantOption {
  id: number;
  sku: string | null;
  name: string;
  productId: number;
  active?: number | null;
  isActive?: boolean;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

interface DropshipSelectOption {
  value: string;
  label: string;
  detail?: string;
  search?: string;
}

interface ReturnCreateItemFormState {
  source: "order" | "manual_exception";
  orderLineIndex: string;
  externalLineItemId: string;
  productVariantId: string;
  manualDescription: string;
  exceptionReason: string;
  quantity: string;
}

interface ReturnCreateFormState {
  vendorId: string;
  storeConnectionId: string;
  intakeId: string;
  omsOrderId: string;
  reasonCode: DropshipAdminRmaReasonCode | "";
  faultCategory: DropshipReturnFaultCategory | "none";
  returnWindowDays: string;
  labelSource: DropshipAdminRmaLabelSource | "";
  returnTrackingNumber: string;
  vendorNotes: string;
  items: ReturnCreateItemFormState[];
}

interface ReturnPolicyFormState {
  name: string;
  returnWindowDays: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
}

const emptyReturnCreateItemForm: ReturnCreateItemFormState = {
  source: "manual_exception",
  orderLineIndex: "",
  externalLineItemId: "",
  productVariantId: "",
  manualDescription: "",
  exceptionReason: "",
  quantity: "1",
};

const emptyReturnCreateForm: ReturnCreateFormState = {
  vendorId: "",
  storeConnectionId: "",
  intakeId: "",
  omsOrderId: "",
  reasonCode: "",
  faultCategory: "none",
  returnWindowDays: "30",
  labelSource: "",
  returnTrackingNumber: "",
  vendorNotes: "",
  items: [],
};

const emptyReturnPolicyForm: ReturnPolicyFormState = {
  name: "",
  returnWindowDays: "30",
  isActive: true,
  effectiveFrom: "",
  effectiveTo: "",
};

function makeEmptyReturnCreateForm(): ReturnCreateFormState {
  return {
    ...emptyReturnCreateForm,
    items: [],
  };
}

const returnOpsStatusFilters: ReturnOpsStatusFilter[] = [
  "default",
  "all",
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
  "disputed",
  "no_inspection_review",
  "credited",
  "closed",
];

const returnOpsTerminalStatuses = new Set<DropshipRmaStatus>([
  "credited",
  "closed",
]);

const returnFaultCategories: DropshipReturnFaultCategory[] = [
  "card_shellz",
  "vendor",
  "customer",
  "carrier",
];

export function ReturnOpsTab({
  showLegacyPolicyPanel = true,
  showCreatePanel = true,
  initialRmaId = null,
}: {
  showLegacyPolicyPanel?: boolean;
  showCreatePanel?: boolean;
  initialRmaId?: number | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ReturnOpsStatusFilter>("default");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as ReturnOpsStatusFilter,
  });
  const [createForm, setCreateForm] = useState<ReturnCreateFormState>(() =>
    makeEmptyReturnCreateForm(),
  );
  const [policyForm, setPolicyForm] = useState<ReturnPolicyFormState>(
    emptyReturnPolicyForm,
  );
  const [creatingRma, setCreatingRma] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [statusInputs, setStatusInputs] = useState<
    Record<number, DropshipRmaStatus>
  >({});
  const [statusNotes, setStatusNotes] = useState<Record<number, string>>({});
  const [pendingRmaId, setPendingRmaId] = useState<number | null>(null);
  const [selectedInspectionRmaId, setSelectedInspectionRmaId] = useState<
    number | null
  >(null);
  const [inspectionModalOpen, setInspectionModalOpen] = useState(false);
  const consumedInitialRmaIdRef = useRef<number | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewPendingDecision, setReviewPendingDecision] = useState<
    "approve" | "deny" | null
  >(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  const returnsUrl = useMemo(
    () =>
      buildAdminReturnsUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
      }),
    [appliedFilters],
  );
  const returnPolicyUrl = useMemo(() => buildAdminReturnPolicyUrl(), []);
  const returnVendorOptionsUrl = useMemo(
    () =>
      buildAdminDogfoodReadinessUrl({
        search: "",
        status: "all",
        platform: "all",
        limit: 100,
      }),
    [],
  );
  const returnStoreConnectionsUrl = useMemo(
    () =>
      buildAdminStoreConnectionsUrl({
        search: "",
        status: "all",
        platform: "all",
        limit: 100,
      }),
    [],
  );
  const returnOrderIntakeUrl = useMemo(
    () =>
      buildAdminOrderIntakeUrl({
        search: "",
        status: "all",
        limit: 100,
      }),
    [],
  );

  const returnsQuery = useQuery<DropshipReturnListResponse>({
    queryKey: [returnsUrl],
    queryFn: () => fetchJson<DropshipReturnListResponse>(returnsUrl),
  });
  const returnPolicyQuery = useQuery<DropshipAdminReturnPolicyResponse>({
    queryKey: [returnPolicyUrl],
    queryFn: () =>
      fetchJson<DropshipAdminReturnPolicyResponse>(returnPolicyUrl),
    enabled: showLegacyPolicyPanel,
  });
  const returnDetailQuery = useQuery<DropshipReturnDetailResponse>({
    queryKey: ["dropship-admin-return-detail", selectedInspectionRmaId],
    queryFn: () => {
      if (selectedInspectionRmaId === null)
        throw new Error("Missing selected RMA.");
      return fetchJson<DropshipReturnDetailResponse>(
        `/api/dropship/admin/returns/${selectedInspectionRmaId}`,
      );
    },
    enabled: selectedInspectionRmaId !== null,
  });
  const returnVendorOptionsQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [returnVendorOptionsUrl, "return-vendors"],
    queryFn: () =>
      fetchJson<DropshipDogfoodReadinessResponse>(returnVendorOptionsUrl),
    enabled: showCreatePanel,
  });
  const returnStoreConnectionsQuery =
    useQuery<DropshipAdminStoreConnectionListResponse>({
      queryKey: [returnStoreConnectionsUrl, "return-store-connections"],
      queryFn: () =>
        fetchJson<DropshipAdminStoreConnectionListResponse>(
          returnStoreConnectionsUrl,
        ),
      enabled: showCreatePanel,
    });
  const returnOrderIntakesQuery = useQuery<DropshipAdminOrderOpsListResponse>({
    queryKey: [returnOrderIntakeUrl, "return-order-intakes"],
    queryFn: () =>
      fetchJson<DropshipAdminOrderOpsListResponse>(returnOrderIntakeUrl),
    enabled: showCreatePanel,
  });
  const returnVariantsQuery = useQuery<DropshipProductVariantOption[]>({
    queryKey: ["/api/product-variants", "return-options"],
    queryFn: () =>
      fetchJson<DropshipProductVariantOption[]>("/api/product-variants"),
    enabled: showCreatePanel,
  });
  const selectedReturnVendorId = /^\d+$/.test(createForm.vendorId)
    ? Number(createForm.vendorId)
    : null;
  const selectedReturnIntakeId = /^\d+$/.test(createForm.intakeId)
    ? Number(createForm.intakeId)
    : null;
  const returnCreateOrderQuery = useQuery<DropshipAdminReturnSourceOrderResponse>({
    queryKey: [
      "dropship-admin-return-create-order",
      selectedReturnVendorId,
      selectedReturnIntakeId,
    ],
    queryFn: () => {
      if (selectedReturnVendorId === null || selectedReturnIntakeId === null) {
        throw new Error("Missing vendor or intake ID.");
      }
      return fetchJson<DropshipAdminReturnSourceOrderResponse>(
        buildAdminReturnSourceOrderUrl({
          vendorId: selectedReturnVendorId,
          intakeId: selectedReturnIntakeId,
        }),
      );
    },
    enabled:
      showCreatePanel &&
      selectedReturnVendorId !== null &&
      selectedReturnIntakeId !== null,
  });

  const rmas = returnsQuery.data?.items ?? [];
  const activeReturnPolicy = returnPolicyQuery.data?.policy ?? null;
  const returnVendorOptions = useMemo(
    () => buildVendorSelectOptions(returnVendorOptionsQuery.data?.items ?? []),
    [returnVendorOptionsQuery.data?.items],
  );
  const returnStoreConnections = useMemo(
    () => returnStoreConnectionsQuery.data?.items ?? [],
    [returnStoreConnectionsQuery.data?.items],
  );
  const returnOrderIntakes = useMemo(
    () => returnOrderIntakesQuery.data?.items ?? [],
    [returnOrderIntakesQuery.data?.items],
  );
  const returnVariantOptions = useMemo(
    () =>
      (returnVariantsQuery.data ?? [])
        .filter((variant) => variant.isActive !== false && variant.active !== 0)
        .sort((first, second) => {
          const skuCompare = (first.sku ?? "").localeCompare(second.sku ?? "");
          if (skuCompare !== 0) return skuCompare;
          const nameCompare = first.name.localeCompare(second.name);
          return nameCompare !== 0 ? nameCompare : first.id - second.id;
        }),
    [returnVariantsQuery.data],
  );

  useEffect(() => {
    if (
      initialRmaId === null ||
      consumedInitialRmaIdRef.current === initialRmaId
    ) {
      return;
    }
    consumedInitialRmaIdRef.current = initialRmaId;
    setSelectedInspectionRmaId(initialRmaId);
    setInspectionModalOpen(false);
    setReviewReason("");
    setError("");
    setMessage("");
  }, [initialRmaId]);

  useEffect(() => {
    const rma = returnDetailQuery.data?.rma;
    if (!rma) return;
    if (rma.rmaId === initialRmaId && rma.status === "inspecting") {
      setInspectionModalOpen(true);
    }
  }, [initialRmaId, returnDetailQuery.data?.rma]);

  function applyReturnFilters() {
    setAppliedFilters({ search, status });
  }

  function updateCreateForm(patch: Partial<ReturnCreateFormState>) {
    setCreateForm((current) => ({ ...current, ...patch }));
  }

  function updateReturnPolicyForm(patch: Partial<ReturnPolicyFormState>) {
    setPolicyForm((current) => ({ ...current, ...patch }));
  }

  function updateCreateItem(
    index: number,
    patch: Partial<ReturnCreateItemFormState>,
  ) {
    setCreateForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    }));
  }

  function addCreateItem() {
    setCreateForm((current) => ({
      ...current,
      items: [...current.items, { ...emptyReturnCreateItemForm }],
    }));
  }

  function removeCreateItem(index: number) {
    setCreateForm((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function updatePendingStatus(rmaId: number, nextStatus: DropshipRmaStatus) {
    setStatusInputs((current) => ({ ...current, [rmaId]: nextStatus }));
  }

  function updateStatusNote(rmaId: number, note: string) {
    setStatusNotes((current) => ({ ...current, [rmaId]: note }));
  }

  function selectInspectionRma(rma: DropshipReturnListItem) {
    setSelectedInspectionRmaId(rma.rmaId);
    setReviewReason("");
    setError("");
    setMessage("");
    if (rma.status === "inspecting") {
      setInspectionModalOpen(true);
    }
  }

  function clearInspectionSelection() {
    setSelectedInspectionRmaId(null);
    setInspectionModalOpen(false);
    setReviewReason("");
  }

  async function submitNoInspectionReview(decision: "approve" | "deny") {
    const rma = returnDetailQuery.data?.rma;
    if (!rma || rma.status !== "no_inspection_review") return;
    if (decision === "deny" && !reviewReason.trim()) {
      setError("Denying a lost-in-transit review requires a reason.");
      return;
    }
    setReviewPendingDecision(decision);
    setError("");
    setMessage("");
    try {
      const response = await postJson<DropshipAdminNoInspectionReviewResponse>(
        `/api/dropship/admin/returns/${rma.rmaId}/no-inspection-review`,
        {
          decision,
          reason: reviewReason.trim() || null,
          idempotencyKey: createDropshipIdempotencyKey(
            `admin-no-inspection-review-${rma.rmaId}-${decision}`,
          ),
        } satisfies DropshipAdminNoInspectionReviewInput,
      );
      setMessage(
        response.decision === "approve"
          ? `RMA ${rma.rmaNumber} approved — pool credit of ${formatCents(response.creditCents)} posted.`
          : `RMA ${rma.rmaNumber} no-inspection review denied and closed.`,
      );
      setReviewReason("");
      await Promise.all([
        returnsQuery.refetch(),
        returnDetailQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Dropship no-inspection review failed.",
      );
    } finally {
      setReviewPendingDecision(null);
    }
  }

  async function saveReturnStatus(rma: DropshipReturnListItem) {
    const nextStatus = statusInputs[rma.rmaId];
    if (!nextStatus || nextStatus === rma.status) return;
    setPendingRmaId(rma.rmaId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminReturnStatusUpdateInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-return-status-${rma.rmaId}`,
        ),
        status: nextStatus,
        notes: statusNotes[rma.rmaId] ?? "",
      });
      const response = await postJson<DropshipAdminReturnStatusUpdateResponse>(
        `/api/dropship/admin/returns/${rma.rmaId}/status`,
        input,
      );
      setMessage(
        `RMA ${response.rma.rmaNumber} moved to ${formatStatus(response.rma.status)}.`,
      );
      toast({
        title: "Status updated",
        description: `RMA ${response.rma.rmaNumber} moved to ${formatStatus(response.rma.status)}`,
      });
      setStatusNotes((current) => ({ ...current, [rma.rmaId]: "" }));
      setStatusInputs((current) => {
        const next = { ...current };
        delete next[rma.rmaId];
        return next;
      });
      await Promise.all([
        returnsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      const errMsg =
        caught instanceof Error
          ? caught.message
          : "Dropship return status update failed.";
      setError(errMsg);
      toast({
        title: "Status update failed",
        description: errMsg,
        variant: "destructive",
      });
    } finally {
      setPendingRmaId(null);
    }
  }

  async function createReturn() {
    setCreatingRma(true);
    setError("");
    setMessage("");
    try {
      const input = buildAdminReturnCreateInput({
        ...createForm,
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-return-create-${createForm.vendorId || "vendor"}`,
        ),
      });
      const response = await postJson<DropshipAdminReturnCreateResponse>(
        "/api/dropship/admin/returns",
        input,
      );
      setMessage(
        `RMA ${response.rma.rmaNumber} created for vendor ${response.rma.vendorId}.`,
      );
      setCreateForm(makeEmptyReturnCreateForm());
      await Promise.all([
        returnsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
      ]);
    } catch (caught) {
      const errMsg =
        caught instanceof Error
          ? caught.message
          : "Dropship return creation failed.";
      setError(errMsg);
      toast({
        title: "RMA not created",
        description: errMsg,
        variant: "destructive",
      });
    } finally {
      setCreatingRma(false);
    }
  }

  async function saveReturnPolicy() {
    setSavingPolicy(true);
    setError("");
    setMessage("");
    try {
      const response = await postJson<DropshipAdminReturnPolicyCreateResponse>(
        "/api/dropship/admin/returns/policies",
        buildAdminReturnPolicyInput({
          ...policyForm,
          idempotencyKey: createDropshipIdempotencyKey(
            `admin-return-policy-${policyForm.returnWindowDays || "window"}`,
          ),
        }),
      );
      setMessage(
        `Return policy ${response.policy.name} set to ${response.policy.returnWindowDays} days.`,
      );
      setPolicyForm(emptyReturnPolicyForm);
      await Promise.all([
        returnPolicyQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Dropship return policy save failed.",
      );
    } finally {
      setSavingPolicy(false);
    }
  }

  return (
    <div className="space-y-5">
      {(returnsQuery.error ||
        (showLegacyPolicyPanel && returnPolicyQuery.error) ||
        (showCreatePanel &&
          (returnVendorOptionsQuery.error ||
            returnStoreConnectionsQuery.error ||
            returnOrderIntakesQuery.error ||
            returnVariantsQuery.error)) ||
        error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              (returnsQuery.error
                ? queryErrorMessage(
                    returnsQuery.error,
                    "Unable to load dropship returns.",
                  )
                : queryErrorMessage(
                    (showLegacyPolicyPanel ? returnPolicyQuery.error : null) ??
                      (showCreatePanel
                        ? (returnVendorOptionsQuery.error ??
                          returnStoreConnectionsQuery.error ??
                          returnOrderIntakesQuery.error ??
                          returnVariantsQuery.error)
                        : null),
                    "Unable to load dropship return setup data.",
                  ))}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Receiving &amp; inspection</h2>
            <p className="text-sm text-muted-foreground">
              Receive and inspect legacy dropship RMAs while their records are
              migrated into the unified RMA lifecycle.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="RMA, order, tracking, or vendor"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) =>
                setStatus(value as ReturnOpsStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {returnOpsStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {returnOpsStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyReturnFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </section>

      <section
        className={`grid gap-3 md:grid-cols-2 ${
          showLegacyPolicyPanel ? "xl:grid-cols-5" : "xl:grid-cols-4"
        }`}
      >
        <CatalogMetric
          icon={<RotateCcw className="h-4 w-4" />}
          label="Matching RMAs"
          value={String(returnsQuery.data?.total ?? 0)}
        />
        <CatalogMetric
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Visible open"
          value={String(
            rmas.filter((rma) => !returnOpsTerminalStatuses.has(rma.status))
              .length,
          )}
        />
        <CatalogMetric
          icon={<FileSearch className="h-4 w-4" />}
          label="Awaiting inspection"
          value={String(
            rmas.filter(
              (rma) => rma.status === "received" || rma.status === "inspecting",
            ).length,
          )}
        />
        <CatalogMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Visible credited"
          value={String(rmas.filter((rma) => rma.status === "credited").length)}
        />
        {showLegacyPolicyPanel && (
          <CatalogMetric
            icon={<History className="h-4 w-4" />}
            label="Return window"
            value={
              activeReturnPolicy
                ? `${activeReturnPolicy.returnWindowDays}d`
                : "Not set"
            }
          />
        )}
      </section>

      {showLegacyPolicyPanel && (
        <ReturnPolicyPanel
          activePolicy={activeReturnPolicy}
          form={policyForm}
          isLoading={returnPolicyQuery.isLoading || returnPolicyQuery.isFetching}
          isSaving={savingPolicy}
          onChange={updateReturnPolicyForm}
          onSave={saveReturnPolicy}
        />
      )}

      {showCreatePanel && (
        <ReturnCreatePanel
          form={createForm}
          isSaving={creatingRma}
          order={returnCreateOrderQuery.data?.order ?? null}
          orderError={optionalQueryErrorMessage(
            returnCreateOrderQuery.error,
            "Unable to load the selected order.",
          )}
          orderLoading={
            returnCreateOrderQuery.isLoading || returnCreateOrderQuery.isFetching
          }
          intakes={returnOrderIntakes}
          intakesLoading={
            returnOrderIntakesQuery.isLoading ||
            returnOrderIntakesQuery.isFetching
          }
          onAddItem={addCreateItem}
          onChange={updateCreateForm}
          onItemChange={updateCreateItem}
          onRemoveItem={removeCreateItem}
          onSubmit={createReturn}
          storeConnections={returnStoreConnections}
          storeConnectionsLoading={
            returnStoreConnectionsQuery.isLoading ||
            returnStoreConnectionsQuery.isFetching
          }
          variants={returnVariantOptions}
          variantsLoading={
            returnVariantsQuery.isLoading || returnVariantsQuery.isFetching
          }
          vendorOptions={returnVendorOptions}
          vendorsLoading={
            returnVendorOptionsQuery.isLoading ||
            returnVendorOptionsQuery.isFetching
          }
        />
      )}

      <ReturnOpsTable
        isLoading={returnsQuery.isLoading || returnsQuery.isFetching}
        onInspect={selectInspectionRma}
        onStatusChange={updatePendingStatus}
        onStatusNoteChange={updateStatusNote}
        onStatusSave={saveReturnStatus}
        pendingRmaId={pendingRmaId}
        rmas={rmas}
        statusInputs={statusInputs}
        statusNotes={statusNotes}
        total={returnsQuery.data?.total ?? 0}
      />

      <ReturnInspectionModal
        rmaId={selectedInspectionRmaId}
        open={inspectionModalOpen}
        onOpenChange={(open) => {
          setInspectionModalOpen(open);
          if (!open) clearInspectionSelection();
        }}
        onInspectionComplete={() => {
          void returnsQuery.refetch();
        }}
      />

      <NoInspectionReviewPanel
        error={returnDetailQuery.error}
        isLoading={returnDetailQuery.isLoading || returnDetailQuery.isFetching}
        onCancel={clearInspectionSelection}
        onReasonChange={setReviewReason}
        onSubmit={submitNoInspectionReview}
        pendingDecision={reviewPendingDecision}
        reason={reviewReason}
        rma={returnDetailQuery.data?.rma ?? null}
        selectedRmaId={selectedInspectionRmaId}
      />
    </div>
  );
}

function ReturnPolicyPanel({
  activePolicy,
  form,
  isLoading,
  isSaving,
  onChange,
  onSave,
}: {
  activePolicy: DropshipReturnPolicyConfig | null;
  form: ReturnPolicyFormState;
  isLoading: boolean;
  isSaving: boolean;
  onChange: (patch: Partial<ReturnPolicyFormState>) => void;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Return policy</h2>
            {activePolicy && (
              <Badge
                variant="outline"
                className={
                  activePolicy.isActive
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : ""
                }
              >
                {activePolicy.isActive ? "Active" : "Inactive"}
              </Badge>
            )}
          </div>
          {isLoading ? (
            <Skeleton className="mt-2 h-4 w-72" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {activePolicy
                ? `${activePolicy.name}: ${activePolicy.returnWindowDays} days from accepted order. Effective ${formatDateTime(activePolicy.effectiveFrom)}.`
                : "No active policy. Vendor RMA submission is blocked until a policy is configured."}
            </p>
          )}
        </div>
        <Button
          type="button"
          className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          disabled={isSaving}
          onClick={onSave}
        >
          <Save className={isSaving ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Create policy
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <AdminReturnInput
          label="Policy name"
          value={form.name}
          disabled={isSaving}
          onChange={(value) => onChange({ name: value })}
        />
        <AdminReturnInput
          label="Window days"
          value={form.returnWindowDays}
          disabled={isSaving}
          onChange={(value) => onChange({ returnWindowDays: value })}
        />
        <AdminReturnInput
          label="Effective from"
          value={form.effectiveFrom}
          placeholder="Optional ISO date"
          disabled={isSaving}
          onChange={(value) => onChange({ effectiveFrom: value })}
        />
        <AdminReturnInput
          label="Effective to"
          value={form.effectiveTo}
          placeholder="Optional ISO date"
          disabled={isSaving}
          onChange={(value) => onChange({ effectiveTo: value })}
        />
        <div>
          <label className="text-sm font-medium">Status</label>
          <Select
            value={form.isActive ? "active" : "inactive"}
            onValueChange={(value) =>
              onChange({ isActive: value === "active" })
            }
            disabled={isSaving}
          >
            <SelectTrigger className="mt-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

function ReturnCreatePanel({
  form,
  intakes,
  intakesLoading,
  isSaving,
  onAddItem,
  onChange,
  onItemChange,
  onRemoveItem,
  onSubmit,
  order,
  orderError,
  orderLoading,
  storeConnections,
  storeConnectionsLoading,
  variants,
  variantsLoading,
  vendorOptions,
  vendorsLoading,
}: {
  form: ReturnCreateFormState;
  intakes: DropshipAdminOrderOpsIntakeListItem[];
  intakesLoading: boolean;
  isSaving: boolean;
  onAddItem: () => void;
  onChange: (patch: Partial<ReturnCreateFormState>) => void;
  onItemChange: (index: number, patch: Partial<ReturnCreateItemFormState>) => void;
  onRemoveItem: (index: number) => void;
  onSubmit: () => void;
  order: DropshipAdminReturnSourceOrder | null;
  orderError: string | null;
  orderLoading: boolean;
  storeConnections: DropshipAdminStoreConnectionListItem[];
  storeConnectionsLoading: boolean;
  variants: DropshipProductVariantOption[];
  variantsLoading: boolean;
  vendorOptions: DropshipSelectOption[];
  vendorsLoading: boolean;
}) {
  function formatSourceOrderPrice(cents: number | null, currency: string | null): string {
    if (!Number.isSafeInteger(cents) || cents === null || cents < 0) return "Not recorded";
    const dollars = Math.trunc(cents / 100);
    const remainder = cents % 100;
    const amount = `${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
    return currency ? `${currency} ${amount}` : amount;
  }

  const storeConnectionOptions = storeConnections.map(storeConnectionSelectOption);
  const intakeOptions = intakes.map(orderIntakeSelectOption);
  const omsOrderOptions = buildOmsOrderSelectOptions(intakes);
  const orderItems = form.items.filter((item) => item.source === "order");
  const manualItems = form.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.source === "manual_exception");

  function selectStoreConnection(storeConnectionId: string) {
    const connection = storeConnections.find(
      (candidate) => String(candidate.storeConnectionId) === storeConnectionId,
    );
    onChange({
      storeConnectionId,
      intakeId: "",
      omsOrderId: "",
      items: [],
      ...(connection ? { vendorId: String(connection.vendor.vendorId) } : {}),
    });
  }

  function selectVendor(vendorId: string) {
    onChange({
      vendorId,
      storeConnectionId: "",
      intakeId: "",
      omsOrderId: "",
      items: [],
    });
  }

  function selectIntake(intakeId: string) {
    const intake = intakes.find(
      (candidate) => String(candidate.intakeId) === intakeId,
    );
    onChange({
      intakeId,
      items: [],
      ...(intake
        ? {
            vendorId: String(intake.vendor.vendorId),
            storeConnectionId: String(intake.storeConnection.storeConnectionId),
            omsOrderId: intake.omsOrderId === null ? "" : String(intake.omsOrderId),
          }
        : {}),
    });
  }

  function selectOmsOrder(omsOrderId: string) {
    const intake = intakes.find(
      (candidate) =>
        candidate.omsOrderId !== null && String(candidate.omsOrderId) === omsOrderId,
    );
    onChange({
      omsOrderId,
      items: [],
      ...(intake
        ? {
            vendorId: String(intake.vendor.vendorId),
            storeConnectionId: String(intake.storeConnection.storeConnectionId),
            intakeId: String(intake.intakeId),
          }
        : {}),
    });
  }

  function selectedOrderItemIndex(lineIndex: number): number {
    return form.items.findIndex(
      (item) => item.source === "order" && item.orderLineIndex === String(lineIndex),
    );
  }

  function toggleOrderLine(
    line: DropshipAdminReturnSourceOrderLine,
    checked: boolean,
  ) {
    const selectedIndex = selectedOrderItemIndex(line.lineIndex);
    if (!checked) {
      if (selectedIndex >= 0) onRemoveItem(selectedIndex);
      return;
    }
    if (selectedIndex >= 0) return;
    onChange({
      items: [
        ...form.items,
        {
          source: "order",
          orderLineIndex: String(line.lineIndex),
          externalLineItemId: line.externalLineItemId ?? "",
          productVariantId:
            line.productVariantId === null ? "" : String(line.productVariantId),
          manualDescription: line.title ?? line.sku ?? "Order item",
          exceptionReason: "",
          quantity: String(line.quantity),
        },
      ],
    });
  }

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Create RMA</h2>
          <p className="text-sm text-muted-foreground">
            Select the source order, then choose the exact lines being returned.
          </p>
        </div>
        <Button type="button" className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSubmit}>
          <PlusCircle className={isSaving ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Create RMA
        </Button>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.3fr]">
        <div className="grid gap-3 md:grid-cols-2">
          <SearchableOptionPicker label="Vendor" value={form.vendorId} disabled={isSaving} options={vendorOptions} isLoading={vendorsLoading} placeholder="Select vendor" searchPlaceholder="Search vendor, email, or member..." emptyText="No dropship vendors found." onChange={selectVendor} />
          <div className="space-y-1">
            <div className="text-sm font-medium">RMA number</div>
            <div className="flex min-h-10 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
              Assigned automatically when created
            </div>
          </div>
          <SearchableOptionPicker label="Store connection" value={form.storeConnectionId} disabled={isSaving} clearable clearLabel="No store connection" options={storeConnectionOptions} isLoading={storeConnectionsLoading} placeholder="Optional" searchPlaceholder="Search store, vendor, or email..." emptyText="No store connections found." onChange={selectStoreConnection} />
          <SearchableOptionPicker label="Source order" value={form.intakeId} disabled={isSaving} clearable clearLabel="No source order" options={intakeOptions} isLoading={intakesLoading} placeholder="Select order" searchPlaceholder="Search marketplace order, OMS order, store, or vendor..." emptyText="No dropship orders found." onChange={selectIntake} />
          <SearchableOptionPicker label="OMS order" value={form.omsOrderId} disabled={isSaving} clearable clearLabel="No OMS order" options={omsOrderOptions} isLoading={intakesLoading} placeholder="Inferred from source order" searchPlaceholder="Search OMS order, intake, or marketplace order..." emptyText="No OMS orders found." onChange={selectOmsOrder} />
          <AdminReturnInput label="Return window days" value={form.returnWindowDays} disabled={isSaving} onChange={(value) => onChange({ returnWindowDays: value })} />
          <div>
            <label className="text-sm font-medium">Return reason</label>
            <Select
              value={form.reasonCode || "none"}
              onValueChange={(value) =>
                onChange({
                  reasonCode:
                    value === "none" ? "" : (value as DropshipAdminRmaReasonCode),
                })
              }
              disabled={isSaving}
            >
              <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not specified</SelectItem>
                <SelectItem value="buyer_return">Buyer return</SelectItem>
                <SelectItem value="damaged">Damaged</SelectItem>
                <SelectItem value="wrong_item">Wrong item</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">Fault category</label>
            <Select value={form.faultCategory} onValueChange={(value) => onChange({ faultCategory: value as DropshipReturnFaultCategory | "none" })} disabled={isSaving}>
              <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Pending</SelectItem>
                {returnFaultCategories.map((category) => <SelectItem key={category} value={category}>{formatStatus(category)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">Return label</label>
            <Select
              value={form.labelSource || "none"}
              onValueChange={(value) => {
                if (value === "none") {
                  onChange({ labelSource: "", returnTrackingNumber: "" });
                  return;
                }
                onChange({ labelSource: value as DropshipAdminRmaLabelSource });
              }}
              disabled={isSaving}
            >
              <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No label or tracking</SelectItem>
                <SelectItem value="marketplace">Marketplace provided</SelectItem>
                <SelectItem value="vendor">Vendor provided</SelectItem>
                <SelectItem value="ops">Ops provided</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <AdminReturnInput
            label="Tracking number"
            value={form.returnTrackingNumber}
            placeholder={form.labelSource ? "Optional" : "Select a return label first"}
            disabled={isSaving || !form.labelSource}
            onChange={(value) => onChange({ returnTrackingNumber: value })}
          />
          <div className="md:col-span-2">
            <label className="text-sm font-medium" htmlFor="dropship-return-create-notes">Vendor notes</label>
            <Textarea id="dropship-return-create-notes" className="mt-2 min-h-24" maxLength={5000} value={form.vendorNotes} onChange={(event) => onChange({ vendorNotes: event.target.value })} disabled={isSaving} />
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">Items on source order</div>
                <p className="text-sm text-muted-foreground">Select only the lines and quantities being returned.</p>
              </div>
              <Badge variant="outline">{orderItems.length} selected</Badge>
            </div>
            {!form.intakeId ? (
              <div className="mt-4 rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">Select a source order to load its items.</div>
            ) : orderLoading ? (
              <div className="mt-4 space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
            ) : orderError ? (
              <Alert variant="destructive" className="mt-4"><AlertCircle className="h-4 w-4" /><AlertDescription>{orderError}</AlertDescription></Alert>
            ) : !order || order.lines.length === 0 ? (
              <div className="mt-4 rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">This order has no returnable item lines.</div>
            ) : (
              <div className="mt-4 space-y-2">
                {order.lines.map((line) => {
                  const itemIndex = selectedOrderItemIndex(line.lineIndex);
                  const selectedItem = itemIndex >= 0 ? form.items[itemIndex] : null;
                  const lineLabel = line.title ?? line.sku ?? `Order line ${line.lineIndex + 1}`;
                  return (
                    <div key={line.lineIndex} className="rounded-md border p-3">
                      <div className="flex items-start gap-3">
                        <Checkbox checked={itemIndex >= 0} disabled={isSaving} onCheckedChange={(checked) => toggleOrderLine(line, checked === true)} aria-label={`Return ${lineLabel}`} />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{lineLabel}</div>
                          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>SKU: {line.sku ?? "Not provided"}</span>
                            <span>Ordered: {line.quantity}</span>
                            <span>Unit price: {formatSourceOrderPrice(line.unitRetailPriceCents, order.currency)}</span>
                            <span>Line total: {formatSourceOrderPrice(line.lineRetailTotalCents, order.currency)}</span>
                          </div>
                        </div>
                      </div>
                      {selectedItem && itemIndex >= 0 ? (
                        <div className="mt-3 border-t pt-3 sm:max-w-xs">
                          <div>
                            <label className="text-xs font-medium">Return quantity</label>
                            <Input className="mt-1" type="number" min={1} max={line.quantity} value={selectedItem.quantity} disabled={isSaving} onChange={(event) => onItemChange(itemIndex, { quantity: event.target.value })} />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-md border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">Manual exceptions</div>
                <p className="text-sm text-muted-foreground">Use only when an item cannot be matched to the source order. A reason is required and audited.</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="gap-2" disabled={isSaving} onClick={onAddItem}>
                <PlusCircle className="h-4 w-4" /> Add exception
              </Button>
            </div>
            {manualItems.length === 0 ? (
              <div className="mt-4 rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No manual exceptions.</div>
            ) : (
              <div className="mt-4 space-y-3">
                {manualItems.map(({ item, index }, exceptionIndex) => (
                  <div key={index} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium">Manual exception {exceptionIndex + 1}</div>
                      <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={() => onRemoveItem(index)}>Remove</Button>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <ProductVariantSkuPicker clearable disabled={isSaving} isLoading={variantsLoading} label="Catalog variant (optional)" placeholder="Search SKU" variants={variants} value={item.productVariantId} onChange={(value) => onItemChange(index, { productVariantId: value })} />
                      <AdminReturnInput label="Item description" value={item.manualDescription} placeholder="Required when no catalog variant is selected" disabled={isSaving} onChange={(value) => onItemChange(index, { manualDescription: value })} />
                      <AdminReturnInput label="Quantity" value={item.quantity} disabled={isSaving} onChange={(value) => onItemChange(index, { quantity: value })} />
                      <div className="sm:col-span-2">
                        <label className="text-sm font-medium">Exception reason *</label>
                        <Textarea className="mt-2 min-h-20" maxLength={2000} value={item.exceptionReason} onChange={(event) => onItemChange(index, { exceptionReason: event.target.value })} disabled={isSaving} placeholder="Explain why this item cannot be tied to an order line." />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function AdminReturnInput({
  disabled = false,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Input
        className="mt-2"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function NoInspectionReviewPanel({
  error,
  isLoading,
  onCancel,
  onReasonChange,
  onSubmit,
  pendingDecision,
  reason,
  rma,
  selectedRmaId,
}: {
  error: unknown;
  isLoading: boolean;
  onCancel: () => void;
  onReasonChange: (value: string) => void;
  onSubmit: (decision: "approve" | "deny") => void;
  pendingDecision: "approve" | "deny" | null;
  reason: string;
  rma: DropshipReturnDetail | null;
  selectedRmaId: number | null;
}) {
  if (selectedRmaId === null) return null;
  if (isLoading) return null;
  if (error) return null;
  if (!rma || rma.status !== "no_inspection_review") return null;

  const evidence = rma.noInspectionEvidence;
  const pending = pendingDecision !== null;
  const denyDisabled = pending || !reason.trim();

  return (
    <section
      className="rounded-md border border-amber-300 bg-amber-50/60 p-4"
      data-testid="panel-no-inspection-review"
    >
      <div className="flex flex-col gap-3 border-b border-amber-200 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            Lost-in-transit review for {rma.rmaNumber}
          </h2>
          <p className="text-sm text-muted-foreground">
            {rma.vendorName || rma.vendorEmail || `Vendor ${rma.vendorId}`} /{" "}
            {rma.platform ? formatStatus(rma.platform) : "No platform"} /{" "}
            {rma.returnTrackingNumber || "No return tracking"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Approving credits the vendor from the insurance pool. Denying closes
            the RMA. Both are final.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className={returnOpsStatusTone(rma.status)}>
            {formatStatus(rma.status)}
          </Badge>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <div className="rounded-md border bg-card p-3">
            <div className="text-sm font-medium">Evidence pack</div>
            {evidence ? (
              <dl className="mt-2 grid gap-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Trigger</dt>
                  <dd className="font-medium">
                    {evidence.trigger === "carrier_lost_status"
                      ? "Carrier reported lost"
                      : "Delivery timeout"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Tracking</dt>
                  <dd className="font-mono text-xs">
                    {evidence.trackingNumber || "None"}
                  </dd>
                </div>
                {evidence.carrierStatus && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Carrier status</dt>
                    <dd className="font-medium">
                      {formatStatus(evidence.carrierStatus)}
                    </dd>
                  </div>
                )}
                {evidence.expectedDeliveryAt && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Expected delivery</dt>
                    <dd>{formatDateTime(evidence.expectedDeliveryAt)}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Timeout window</dt>
                  <dd>
                    {evidence.noInspectionTimeoutDays} days past expected
                    delivery
                  </dd>
                </div>
                {evidence.marketplaceCaseRef && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Marketplace case</dt>
                    <dd className="font-mono text-xs">
                      {evidence.marketplaceCaseRef}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Detected</dt>
                  <dd>{formatDateTime(evidence.detectedAt)}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No evidence pack recorded on this RMA.
              </p>
            )}
          </div>

          {evidence?.trackingHistory && evidence.trackingHistory.length > 0 && (
            <div className="rounded-md border bg-card p-3">
              <div className="text-sm font-medium">Tracking history</div>
              <ul className="mt-2 space-y-1 text-sm">
                {evidence.trackingHistory.map((event, index) => (
                  <li
                    key={`${event.occurredAt}-${index}`}
                    className="flex justify-between gap-4"
                  >
                    <span>
                      {event.description || formatStatus(event.status)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(event.occurredAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-md border bg-card p-3">
            <div className="text-sm font-medium">Requested items</div>
            <ul className="mt-2 space-y-1 text-sm">
              {rma.items.map((item) => (
                <li key={item.rmaItemId} className="flex justify-between gap-4">
                  <span>
                    Variant {item.productVariantId ?? "unknown"} ×{" "}
                    {item.quantity}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatStatus(item.status)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">
              Reason (required to deny)
            </label>
            <Textarea
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Audit note — required when denying"
              className="mt-2 min-h-[96px]"
              maxLength={2000}
              disabled={pending}
            />
          </div>
          <div className="grid gap-2">
            <Button
              type="button"
              className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              disabled={pending}
              onClick={() => onSubmit("approve")}
              data-testid="button-no-inspection-approve"
            >
              <CheckCircle2
                className={
                  pendingDecision === "approve"
                    ? "h-4 w-4 animate-spin"
                    : "h-4 w-4"
                }
              />
              Approve pool credit
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-2"
              disabled={denyDisabled}
              onClick={() => onSubmit("deny")}
              data-testid="button-no-inspection-deny"
            >
              <XCircle
                className={
                  pendingDecision === "deny"
                    ? "h-4 w-4 animate-spin"
                    : "h-4 w-4"
                }
              />
              Deny and close
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReturnOpsTable({
  isLoading,
  onInspect,
  onStatusChange,
  onStatusNoteChange,
  onStatusSave,
  pendingRmaId,
  rmas,
  statusInputs,
  statusNotes,
  total,
}: {
  isLoading: boolean;
  onInspect: (rma: DropshipReturnListItem) => void;
  onStatusChange: (rmaId: number, status: DropshipRmaStatus) => void;
  onStatusNoteChange: (rmaId: number, note: string) => void;
  onStatusSave: (rma: DropshipReturnListItem) => void;
  pendingRmaId: number | null;
  rmas: DropshipReturnListItem[];
  statusInputs: Record<number, DropshipRmaStatus>;
  statusNotes: Record<number, string>;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (rmas.length === 0) {
    return (
      <EmptyState
        title="No RMAs"
        description="No dropship RMAs match the current filters."
      />
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold">RMAs</h2>
          <p className="text-sm text-muted-foreground">
            {total} matching RMA{total === 1 ? "" : "s"}
          </p>
        </div>
        <RotateCcw className="h-5 w-5 text-muted-foreground" />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">RMA</TableHead>
            <TableHead>Vendor/order</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fault</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Milestones</TableHead>
            <TableHead className="w-[145px]">Updated</TableHead>
            <TableHead className="w-[120px]">Inspection</TableHead>
            <TableHead className="w-[310px]">Status update</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rmas.map((rma) => {
            const nextStatus = statusInputs[rma.rmaId] ?? rma.status;
            const allowedTransitions = legalRmaTransitions(rma.status);
            const isTerminal = isRmaStatusTerminal(rma.status);
            const statusActionDisabled =
              pendingRmaId !== null || nextStatus === rma.status || isTerminal;
            return (
              <TableRow key={rma.rmaId}>
                <TableCell>
                  <div className="font-mono text-sm">{rma.rmaNumber}</div>
                  <div className="text-xs text-muted-foreground">
                    Window {rma.returnWindowDays}d
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {rma.vendorName ||
                      rma.vendorEmail ||
                      `Vendor ${rma.vendorId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      rma.platform ? formatStatus(rma.platform) : null,
                      rma.intakeId ? `Intake ${rma.intakeId}` : null,
                      rma.omsOrderId ? `OMS ${rma.omsOrderId}` : null,
                    ]
                      .filter(Boolean)
                      .join(" / ") || "No linked order"}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={returnOpsStatusTone(rma.status)}
                  >
                    {formatStatus(rma.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {returnOpsTerminalStatuses.has(rma.status)
                      ? "Terminal"
                      : "Open"}
                  </div>
                </TableCell>
                <TableCell>
                  <div>
                    {rma.faultCategory
                      ? formatStatus(rma.faultCategory)
                      : "Pending"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {rma.reasonCode
                      ? formatStatus(rma.reasonCode)
                      : "No reason"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-mono">{rma.itemCount} lines</div>
                  <div className="text-xs text-muted-foreground">
                    {rma.totalQuantity} units
                  </div>
                </TableCell>
                <TableCell>
                  <div className="max-w-[220px] truncate font-mono text-xs">
                    {rma.returnTrackingNumber || "None"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {rma.returnTrackingNumber
                      ? "Tracking recorded"
                      : "No return tracking"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-xs text-muted-foreground">
                    {rma.receivedAt
                      ? `Received ${formatDateTime(rma.receivedAt)}`
                      : "Not received"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {rma.inspectedAt
                      ? `Inspected ${formatDateTime(rma.inspectedAt)}`
                      : "Not inspected"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {rma.creditedAt
                      ? `Credited ${formatDateTime(rma.creditedAt)}`
                      : "Not credited"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(rma.updatedAt)}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      rma.status === "inspecting" ? "default" : "outline"
                    }
                    className="gap-2"
                    disabled={
                      rma.status !== "inspecting" &&
                      rma.status !== "no_inspection_review"
                    }
                    onClick={() => onInspect(rma)}
                  >
                    <FileSearch className="h-4 w-4" />
                    {rma.status === "no_inspection_review"
                      ? "Review"
                      : "Inspect"}
                  </Button>
                </TableCell>
                <TableCell>
                  <div className="grid gap-2">
                    <Select
                      value={nextStatus}
                      onValueChange={(value) =>
                        onStatusChange(rma.rmaId, value as DropshipRmaStatus)
                      }
                      disabled={isTerminal}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allowedTransitions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {formatStatus(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        value={statusNotes[rma.rmaId] ?? ""}
                        onChange={(event) =>
                          onStatusNoteChange(rma.rmaId, event.target.value)
                        }
                        placeholder="Optional audit note"
                        maxLength={5000}
                        disabled={isTerminal}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        disabled={statusActionDisabled}
                        onClick={() => onStatusSave(rma)}
                      >
                        <Save
                          className={
                            pendingRmaId === rma.rmaId
                              ? "h-4 w-4 animate-spin"
                              : "h-4 w-4"
                          }
                        />
                        Save
                      </Button>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function ProductVariantSkuPicker({
  clearable = false,
  disabled = false,
  isLoading,
  label = "SKU",
  onChange,
  placeholder = "Select SKU",
  value,
  variants,
}: {
  clearable?: boolean;
  disabled?: boolean;
  isLoading: boolean;
  label?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
  variants: DropshipProductVariantOption[];
}) {
  const [open, setOpen] = useState(false);
  const selectedVariant =
    variants.find((variant) => String(variant.id) === value) ?? null;

  return (
    <div>
      {label && <label className="text-sm font-medium">{label}</label>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={`${label ? "mt-2 " : ""}h-10 w-full justify-between`}
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span
              className={
                selectedVariant ? "truncate" : "truncate text-muted-foreground"
              }
            >
              {isLoading
                ? "Loading SKUs..."
                : selectedVariant
                  ? formatVariantOption(selectedVariant)
                  : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          <Command>
            <CommandInput placeholder="Search SKU or name..." />
            <CommandList>
              <CommandEmpty>No SKU found.</CommandEmpty>
              <CommandGroup>
                {clearable && value && (
                  <CommandItem
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                    value="__clear_variant__"
                  >
                    <MinusCircle className="mr-2 h-4 w-4" />
                    Clear SKU
                  </CommandItem>
                )}
                {variants.map((variant) => (
                  <CommandItem
                    key={variant.id}
                    onSelect={() => {
                      onChange(String(variant.id));
                      setOpen(false);
                    }}
                    value={variantOptionSearchValue(variant)}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${String(variant.id) === value ? "opacity-100" : "opacity-0"}`}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {variant.sku || `Variant ${variant.id}`}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {variant.name} - ID {variant.id}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SearchableOptionPicker({
  clearLabel = "Clear selection",
  clearable = false,
  disabled = false,
  emptyText,
  isLoading,
  label,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
}: {
  clearLabel?: string;
  clearable?: boolean;
  disabled?: boolean;
  emptyText: string;
  isLoading: boolean;
  label: string;
  onChange: (value: string) => void;
  options: DropshipSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption =
    options.find((option) => option.value === value) ?? null;

  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="mt-2 h-10 w-full justify-between"
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span
              className={
                selectedOption || value
                  ? "truncate"
                  : "truncate text-muted-foreground"
              }
            >
              {isLoading
                ? "Loading..."
                : selectedOption
                  ? selectedOption.label
                  : value
                    ? `Selected ID ${value} (not found)`
                    : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {clearable && value && (
                  <CommandItem
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                    value="__clear_selection__"
                  >
                    <MinusCircle className="mr-2 h-4 w-4" />
                    {clearLabel}
                  </CommandItem>
                )}
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    value={
                      option.search ??
                      `${option.label} ${option.detail ?? ""} ${option.value}`
                    }
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${option.value === value ? "opacity-100" : "opacity-0"}`}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{option.label}</div>
                      {option.detail && (
                        <div className="truncate text-xs text-muted-foreground">
                          {option.detail}
                        </div>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function CatalogMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

function EmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <Empty className="mt-4 rounded-md border border-dashed">
      <EmptyMedia variant="icon">
        <FileSearch />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function returnOpsStatusLabel(status: ReturnOpsStatusFilter): string {
  if (status === "default") return "Open returns";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function returnOpsStatusTone(status: DropshipRmaStatus): string {
  if (status === "credited" || status === "closed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "approved" ||
    status === "received" ||
    status === "inspecting"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "rejected") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function buildVendorSelectOptions(
  items: DropshipDogfoodReadinessItem[],
): DropshipSelectOption[] {
  const vendors = new Map<number, DropshipDogfoodReadinessItem["vendor"]>();
  for (const item of items) {
    vendors.set(item.vendor.vendorId, item.vendor);
  }
  return Array.from(vendors.values())
    .sort((first, second) =>
      vendorDisplayName(first).localeCompare(vendorDisplayName(second)),
    )
    .map((vendor) => ({
      value: String(vendor.vendorId),
      label: vendorDisplayName(vendor),
      detail: [
        vendor.email,
        vendor.memberId,
        formatStatus(vendor.status),
        formatStatus(vendor.entitlementStatus),
      ]
        .filter(Boolean)
        .join(" / "),
      search: [
        vendor.vendorId,
        vendor.businessName,
        vendor.email,
        vendor.memberId,
        vendor.status,
        vendor.entitlementStatus,
      ]
        .filter(Boolean)
        .join(" "),
    }));
}

function vendorDisplayName(
  vendor:
    | DropshipDogfoodReadinessItem["vendor"]
    | DropshipAdminOrderOpsVendorSummary,
): string {
  return vendor.businessName || vendor.email || `Vendor ${vendor.vendorId}`;
}

function storeConnectionDisplayName(
  connection:
    | DropshipAdminStoreConnectionListItem
    | DropshipAdminOrderOpsStoreSummary,
): string {
  return (
    connection.externalDisplayName ||
    connection.shopDomain ||
    `${formatStatus(connection.platform)} store`
  );
}

function storeConnectionSelectOption(
  connection: DropshipAdminStoreConnectionListItem,
): DropshipSelectOption {
  const storeLabel = storeConnectionDisplayName(connection);
  const vendorLabel = vendorDisplayName(connection.vendor);
  return {
    value: String(connection.storeConnectionId),
    label: storeLabel,
    detail: [
      vendorLabel,
      formatStatus(connection.platform),
      formatStatus(connection.status),
      `ID ${connection.storeConnectionId}`,
    ].join(" / "),
    search: [
      connection.storeConnectionId,
      storeLabel,
      connection.externalAccountId,
      connection.shopDomain,
      connection.platform,
      connection.status,
      vendorLabel,
      connection.vendor.email,
      connection.vendor.memberId,
      connection.vendor.vendorId,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function orderIntakeSelectOption(
  intake: DropshipAdminOrderOpsIntakeListItem,
): DropshipSelectOption {
  const orderLabel =
    intake.externalOrderNumber ||
    intake.externalOrderId ||
    `Intake ${intake.intakeId}`;
  const storeLabel = storeConnectionDisplayName(intake.storeConnection);
  const vendorLabel = vendorDisplayName(intake.vendor);
  return {
    value: String(intake.intakeId),
    label: orderLabel,
    detail: [
      `Intake ${intake.intakeId}`,
      vendorLabel,
      storeLabel,
      intake.omsOrderId === null ? "" : `OMS ${intake.omsOrderId}`,
      formatStatus(intake.status),
    ]
      .filter(Boolean)
      .join(" / "),
    search: [
      intake.intakeId,
      intake.omsOrderId,
      intake.externalOrderId,
      intake.externalOrderNumber,
      intake.platform,
      intake.status,
      vendorLabel,
      intake.vendor.email,
      intake.vendor.memberId,
      storeLabel,
      intake.storeConnection.storeConnectionId,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function buildOmsOrderSelectOptions(
  intakes: DropshipAdminOrderOpsIntakeListItem[],
): DropshipSelectOption[] {
  const options = new Map<number, DropshipSelectOption>();
  for (const intake of intakes) {
    if (intake.omsOrderId === null) continue;
    const intakeOption = orderIntakeSelectOption(intake);
    options.set(intake.omsOrderId, {
      value: String(intake.omsOrderId),
      label: `OMS order ${intake.omsOrderId}`,
      detail: intakeOption.detail,
      search: `${intake.omsOrderId} ${intakeOption.search}`,
    });
  }
  return Array.from(options.values()).sort(
    (first, second) => Number(second.value) - Number(first.value),
  );
}

function formatVariantOption(variant: DropshipProductVariantOption): string {
  return `${variant.sku || `Variant ${variant.id}`} - ${variant.name}`;
}

function variantOptionSearchValue(
  variant: DropshipProductVariantOption,
): string {
  return `${variant.sku ?? ""} ${variant.name} ${variant.id}`;
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import {
  customerReturnLabelSettingsSchema,
  type CustomerReturnLabelSettings,
} from "@shared/returns/customer-return-label.contract";
import type {
  CustomerReturnPolicyShippingInput,
  ReturnPolicyShippingCatalog,
} from "@shared/returns/return-policy-shipping.contract";
import {
  ReturnPolicyShippingFields,
  returnShippingFieldIds,
} from "@/components/returns/ReturnPolicyShippingFields";
import {
  createReturnLabelSettingsDraft,
  refreshReturnLabelSettingsDraft,
  returnLabelSettingsReadiness,
  type ReturnLabelSettingsDraft,
} from "@/lib/customer-return-label-settings";
import {
  loadReturnPolicyShippingCatalog,
  parsePolicyShippingDraft,
  readReturnPolicySaveResponse,
  requestedReturnPolicy,
  requestedReturnPolicyChannel,
  returnPolicyVersionCommandSchema,
  returnPolicyDraftChannelId,
  ReturnPolicySaveError,
} from "@/lib/return-policy-shipping";
import { ReturnPolicyArchiveDialog } from "@/components/returns/ReturnPolicyArchiveDialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  FileText,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import {
  selectReturnPolicyVersions,
  type ReturnPolicyVersionView,
} from "@/lib/return-policy-version-view";
import {
  deriveReturnPolicyResolutionInput,
  isSameReturnPolicyResolutionInput,
  snapshotReturnPolicyResolutionInput,
  type ReturnPolicyResolutionInput,
} from "@/lib/return-policy-resolution";

type InternalScopeKind =
  | "global"
  | "business_context"
  | "channel_context"
  | "vendor_context"
  | "vendor_channel_context"
  | "store";
type AppliesTo = "all_orders" | "channel" | "vendor" | "store";

interface ReturnPolicy {
  id: number;
  name: string;
  scopeKind: InternalScopeKind;
  scopeKey: string;
  businessContext: "retail" | "dropship" | null;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
  version: number;
  status: string;
  returnWindowDays: number;
  returnDestination: string;
  approvalAuthority: string;
  labelProvider: string;
  returnShippingPayer: string;
  inspectionRequirement: string;
  inspectionOwner: string;
  customerRefundAuthority: string;
  vendorSettlementTrigger: string;
  returnlessRefundAllowed: boolean;
  notes: string | null;
  shipping: CustomerReturnLabelSettings | null;
}

interface ChannelReference {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
}

interface VendorReference {
  id: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
}

interface StoreReference {
  id: number;
  vendorId: number;
  platform: string;
  displayName: string | null;
  shopDomain: string | null;
  status: string;
}

interface Overview {
  policies: ReturnPolicy[];
  channels: ChannelReference[];
  referencedVendors: VendorReference[];
  referencedStores: StoreReference[];
  dropshipOmsChannelId: number;
}

interface Draft {
  name: string;
  appliesTo: AppliesTo;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
  returnWindowDays: number;
  returnDestination: string;
  approvalAuthority: string;
  labelProvider: string;
  returnShippingPayer: string;
  inspectionRequirement: string;
  inspectionOwner: string;
  customerRefundAuthority: string;
  vendorSettlementTrigger: string;
  returnlessRefundAllowed: boolean;
  notes: string | null;
}

type ResolutionInput = ReturnPolicyResolutionInput;

interface ResolutionResult {
  input: ResolutionInput;
  winner: ReturnPolicy;
  matched: Array<{ policy: ReturnPolicy; reason: string }>;
}

const APPLIES_TO_LABELS: Record<AppliesTo, string> = {
  all_orders: "All orders",
  channel: "One sales channel",
  vendor: "One dropship vendor",
  store: "One dropship store",
};

const emptyDraft = (): Draft => ({
  name: "",
  appliesTo: "channel",
  channelId: null,
  vendorId: null,
  storeConnectionId: null,
  returnWindowDays: 30,
  returnDestination: "card_shellz",
  approvalAuthority: "card_shellz",
  labelProvider: "shipstation",
  returnShippingPayer: "customer",
  inspectionRequirement: "required",
  inspectionOwner: "card_shellz",
  customerRefundAuthority: "card_shellz",
  vendorSettlementTrigger: "none",
  returnlessRefundAllowed: false,
  notes: null,
});

const emptyShippingCatalog: ReturnPolicyShippingCatalog = {
  providerConfigured: false,
  warehouses: [],
  carriers: [],
  message: null,
};
type PolicyVersionCommand = Draft & {
  expectedPolicyId: number | null;
  shipping: CustomerReturnPolicyShippingInput | null;
};
type PendingPolicyCommand = {
  input: PolicyVersionCommand;
  idempotencyKey: string;
};

function matchesDraftScope(policy: ReturnPolicy, draft: Draft): boolean {
  return (
    policy.status === "active" &&
    publicScope(policy) === draft.appliesTo &&
    (draft.appliesTo !== "channel" || policy.channelId === draft.channelId) &&
    (draft.appliesTo !== "vendor" || policy.vendorId === draft.vendorId) &&
    (draft.appliesTo !== "store" ||
      (policy.vendorId === draft.vendorId &&
        policy.storeConnectionId === draft.storeConnectionId))
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      body?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return body as T;
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAuditTimestamp(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Invalid timestamp"
    : date.toLocaleString();
}

function publicScope(policy: ReturnPolicy): AppliesTo | null {
  switch (policy.scopeKind) {
    case "global":
      return "all_orders";
    case "channel_context":
      return "channel";
    case "vendor_context":
      return "vendor";
    case "store":
      return "store";
    default:
      return null;
  }
}

function policyToDraft(policy: ReturnPolicy): Draft | null {
  const appliesTo = publicScope(policy);
  if (!appliesTo) return null;
  return {
    name: policy.name,
    appliesTo,
    channelId: returnPolicyDraftChannelId(appliesTo, policy.channelId),
    vendorId: policy.vendorId,
    storeConnectionId: policy.storeConnectionId,
    returnWindowDays: policy.returnWindowDays,
    returnDestination: policy.returnDestination,
    approvalAuthority: policy.approvalAuthority,
    labelProvider: policy.labelProvider,
    returnShippingPayer: policy.returnShippingPayer,
    inspectionRequirement: policy.inspectionRequirement,
    inspectionOwner: policy.inspectionOwner,
    customerRefundAuthority: policy.customerRefundAuthority,
    vendorSettlementTrigger: policy.vendorSettlementTrigger,
    returnlessRefundAllowed: policy.returnlessRefundAllowed,
    notes: policy.notes,
  };
}

function vendorLabel(vendor: VendorReference): string {
  return vendor.businessName || vendor.email || "Dropship vendor";
}

function vendorDetail(vendor: VendorReference): string {
  return [vendor.email, vendor.businessName ? null : vendor.memberId]
    .filter(Boolean)
    .join(" / ");
}

function storeLabel(store: StoreReference): string {
  return (
    store.displayName || store.shopDomain || `${humanize(store.platform)} store`
  );
}

function storeDetail(store: StoreReference): string {
  return [humanize(store.platform), store.shopDomain]
    .filter(Boolean)
    .join(" / ");
}

function scopeSummary(policy: ReturnPolicy, overview: Overview): string {
  const appliesTo = publicScope(policy);
  if (!appliesTo) return "Created with the retired scope model";
  if (appliesTo === "all_orders")
    return "Every order without a more specific policy";
  if (appliesTo === "channel")
    return (
      overview.channels.find((item) => item.id === policy.channelId)?.name ??
      "Unavailable sales channel"
    );
  const vendor = overview.referencedVendors.find(
    (item) => item.id === policy.vendorId,
  );
  if (appliesTo === "vendor")
    return vendor ? vendorLabel(vendor) : "Unavailable dropship vendor";
  const store = overview.referencedStores.find(
    (item) => item.id === policy.storeConnectionId,
  );
  return store
    ? `${storeLabel(store)}${vendor ? ` / ${vendorLabel(vendor)}` : ""}`
    : "Unavailable dropship store";
}

export default function ReturnPolicies() {
  const { toast } = useToast();
  const search = useSearch();
  const [archivePolicyId, setArchivePolicyId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [policyView, setPolicyView] =
    useState<ReturnPolicyVersionView>("active");
  const [scopeLocked, setScopeLocked] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [shippingConfigured, setShippingConfigured] = useState(false);
  const [shippingDraft, setShippingDraft] = useState<ReturnLabelSettingsDraft>(
    () =>
      createReturnLabelSettingsDraft({
        ...emptyShippingCatalog,
        settings: null,
      }),
  );
  const [originalShipping, setOriginalShipping] =
    useState<CustomerReturnLabelSettings | null>(null);
  const [basePolicies, setBasePolicies] = useState<ReturnPolicy[]>([]);
  const [editingPolicyId, setEditingPolicyId] = useState<number | null>(null);
  const [focusShipping, setFocusShipping] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const [policyChanged, setPolicyChanged] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const pendingCommand = useRef<PendingPolicyCommand | null>(null);
  const saveInProgress = useRef(false);
  const handledLink = useRef<string | null>(null);
  const linkedPolicyRequest = useRef<AbortController | null>(null);
  const editorGeneration = useRef(0);
  const [resolution, setResolution] = useState<ResolutionInput>({
    channelId: null,
    vendorId: null,
    storeConnectionId: null,
  });

  const overviewQuery = useQuery<Overview>({
    queryKey: ["/api/returns/admin/policies"],
  });
  const overview = overviewQuery.data;
  const shippingCatalogQuery = useQuery({
    queryKey: ["/api/returns/admin/policies/shipping-catalog"],
    queryFn: ({ signal }) => loadReturnPolicyShippingCatalog(signal),
    enabled: dialogOpen,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const shippingCatalog = shippingCatalogQuery.data;
  const shippingReadiness = shippingCatalog
    ? returnLabelSettingsReadiness(shippingDraft, {
        ...shippingCatalog,
        settings: originalShipping,
      })
    : null;
  const expectedPolicyId = scopeLocked
    ? editingPolicyId
    : (basePolicies.find((policy) => matchesDraftScope(policy, draft))?.id ??
      null);

  useEffect(() => {
    if (!dialogOpen || !shippingCatalog) return;
    setShippingDraft((current) =>
      refreshReturnLabelSettingsDraft(current, {
        ...shippingCatalog,
        settings: null,
      }),
    );
  }, [dialogOpen, shippingCatalog]);

  const createMutation = useMutation({
    mutationFn: async ({ input, idempotencyKey }: PendingPolicyCommand) =>
      readReturnPolicySaveResponse(
        await fetch("/api/returns/admin/policies/versions", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(input),
        }),
        input,
        { dropshipOmsChannelId: overview?.dropshipOmsChannelId ?? 0 },
      ),
    onSuccess: async () => {
      saveInProgress.current = false;
      pendingCommand.current = null;
      setSaveUncertain(false);
      setSaveError(null);
      await queryClient.invalidateQueries({
        queryKey: ["/api/returns/admin/policies"],
      });
      setDialogOpen(false);
      toast({
        title: "Return policy version created",
        description:
          "Return rules and shipping were saved together. The previous version for this target was retired atomically.",
      });
    },
    onError: (error: Error) => {
      saveInProgress.current = false;
      const definitive =
        error instanceof ReturnPolicySaveError && error.definitive;
      if (definitive) pendingCommand.current = null;
      setSaveUncertain(!definitive);
      setPolicyChanged(
        error instanceof ReturnPolicySaveError &&
          error.code === "RETURN_POLICY_CHANGED",
      );
      setSaveError(
        definitive
          ? error.message
          : "The save outcome was not confirmed. Your policy and shipping choices are fixed until you retry the same save.",
      );
    },
  });

  const savePolicy = () => {
    if (saveInProgress.current || createMutation.isPending || policyChanged)
      return;
    if (pendingCommand.current) {
      saveInProgress.current = true;
      createMutation.mutate(pendingCommand.current);
      return;
    }
    const shipping = shippingConfigured
      ? parsePolicyShippingDraft(shippingDraft)
      : null;
    if (
      shipping &&
      (!shipping.success ||
        !shippingReadiness?.canSave ||
        shippingCatalogQuery.isFetching ||
        shippingCatalogQuery.isError)
    )
      return;
    const input = returnPolicyVersionCommandSchema.safeParse({
      ...draft,
      expectedPolicyId,
      shipping: shipping?.success ? shipping.data : null,
    });
    if (!input.success) {
      setSaveError(
        "Review the policy scope, return rules and shipping choices before saving.",
      );
      return;
    }
    const command: PendingPolicyCommand = {
      input: input.data,
      idempotencyKey: crypto.randomUUID(),
    };
    pendingCommand.current = structuredClone(command);
    setSaveError(null);
    saveInProgress.current = true;
    createMutation.mutate(pendingCommand.current);
  };

  const initializeEditor = (
    policy: ReturnPolicy | null,
    shippingFocus = false,
    fromLink = false,
  ) => {
    // A navigation response cannot replace an in-flight or uncertain command.
    if (
      saveInProgress.current ||
      createMutation.isPending ||
      saveUncertain ||
      pendingCommand.current
    )
      return;
    if (!fromLink) {
      editorGeneration.current += 1;
      linkedPolicyRequest.current?.abort();
      linkedPolicyRequest.current = null;
      handledLink.current = search;
    }
    const next = policy ? policyToDraft(policy) : emptyDraft();
    if (!next) return;
    if (!policy)
      next.channelId =
        overview?.channels.find(
          (channel) =>
            channel.status === "active" &&
            channel.id !== overview.dropshipOmsChannelId,
        )?.id ?? null;
    const parsedShipping = customerReturnLabelSettingsSchema
      .nullable()
      .safeParse(policy === null ? null : policy.shipping);
    if (
      !parsedShipping.success ||
      (policy &&
        parsedShipping.data &&
        (parsedShipping.data.policyId !== policy.id ||
          parsedShipping.data.version !== policy.id))
    ) {
      setLinkError(
        "The policy's shipping configuration could not be verified. Refresh Policies before editing.",
      );
      return;
    }
    const shipping = parsedShipping.data;
    setDraft(next);
    setScopeLocked(policy !== null);
    setEditingPolicyId(policy?.id ?? null);
    setBasePolicies(overview?.policies ?? []);
    setOriginalShipping(shipping);
    setShippingConfigured(shipping !== null);
    setShippingDraft(
      createReturnLabelSettingsDraft({
        ...(shippingCatalog ?? emptyShippingCatalog),
        settings: shipping,
      }),
    );
    setFocusShipping(shippingFocus);
    setSaveError(null);
    setSaveUncertain(false);
    setPolicyChanged(false);
    pendingCommand.current = null;
    setDialogOpen(true);
  };

  const resolutionMutation = useMutation<
    ResolutionResult,
    Error,
    ResolutionInput
  >({
    mutationFn: async (input) => {
      const requestInput = snapshotReturnPolicyResolutionInput(input);
      const result = await readJson<Omit<ResolutionResult, "input">>(
        await fetch("/api/returns/admin/policies/resolve", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestInput),
        }),
      );
      return { input: requestInput, ...result };
    },
    onError: (error: Error) =>
      toast({
        variant: "destructive",
        title: "Policy could not be resolved",
        description: error.message,
      }),
  });

  const changeResolution = (next: ResolutionInput) => {
    resolutionMutation.reset();
    setResolution(next);
  };
  const visibleResolution =
    resolutionMutation.data &&
    isSameReturnPolicyResolutionInput(resolutionMutation.data.input, resolution)
      ? resolutionMutation.data
      : undefined;

  const openNew = () => {
    initializeEditor(null);
  };

  const openVersion = (policy: ReturnPolicy) => {
    initializeEditor(policy);
  };

  useEffect(() => {
    if (
      !overview ||
      overviewQuery.isFetching ||
      overviewQuery.isError ||
      handledLink.current === search
    )
      return;
    handledLink.current = search;
    setLinkError(null);
    const controller = new AbortController();
    linkedPolicyRequest.current = controller;
    const generation = editorGeneration.current;
    const availableOverview = overview;
    let completed = false;
    async function openLinkedPolicy() {
      try {
        const requested = requestedReturnPolicy(search);
        const channelId = requestedReturnPolicyChannel(search);
        let policyId = requested?.policyId;
        if (channelId !== null) {
          if (
            !availableOverview.channels.some(
              (channel) =>
                channel.id === channelId && channel.status === "active",
            )
          ) {
            throw new Error(
              "The requested sales channel is unavailable. Choose an active policy below.",
            );
          }
          const result = await readJson<{ winner: { id: number } }>(
            await fetch("/api/returns/admin/policies/resolve", {
              method: "POST",
              credentials: "include",
              cache: "no-store",
              signal: controller.signal,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                channelId,
                vendorId: null,
                storeConnectionId: null,
              }),
            }),
          );
          if (
            controller.signal.aborted ||
            editorGeneration.current !== generation
          )
            return;
          policyId = result.winner?.id;
          if (!Number.isSafeInteger(policyId) || !policyId || policyId <= 0)
            throw new Error("The applied return policy could not be verified.");
        }
        if (policyId === undefined) return;
        const policy = availableOverview.policies.find(
          (item) => item.id === policyId,
        );
        if (!policy || policy.status !== "active" || !publicScope(policy)) {
          setLinkError(
            "This policy is no longer an editable active version. Choose the current policy below.",
          );
          return;
        }
        if (
          controller.signal.aborted ||
          editorGeneration.current !== generation
        )
          return;
        initializeEditor(policy, requested?.shipping ?? true, true);
      } catch (error) {
        if (controller.signal.aborted) return;
        setLinkError(
          error instanceof Error
            ? error.message
            : "This policy link could not be verified.",
        );
      } finally {
        if (!controller.signal.aborted) completed = true;
      }
    }
    void openLinkedPolicy();
    return () => {
      controller.abort();
      if (linkedPolicyRequest.current === controller)
        linkedPolicyRequest.current = null;
      if (
        !completed &&
        editorGeneration.current === generation &&
        handledLink.current === search
      )
        handledLink.current = null;
    };
  }, [overview, overviewQuery.isFetching, overviewQuery.isError, search]);

  const visiblePolicies = useMemo(
    () => selectReturnPolicyVersions(overview?.policies ?? [], policyView),
    [overview?.policies, policyView],
  );
  const activePolicyCount = useMemo(
    () => selectReturnPolicyVersions(overview?.policies ?? [], "active").length,
    [overview?.policies],
  );
  const retiredPolicyCount = useMemo(
    () =>
      selectReturnPolicyVersions(overview?.policies ?? [], "history").length,
    [overview?.policies],
  );

  if (overviewQuery.isLoading)
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Loading return policies...
      </div>
    );
  if (!overview)
    return (
      <div className="p-8 text-sm text-destructive">
        Return policies could not be loaded.
      </div>
    );

  return (
    <div className="space-y-6 p-6">
      {linkError && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {linkError}
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" />
            <h1 className="text-2xl font-semibold">Return Policies</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Set the default return rules, then add narrower channel, vendor, or
            store policies only when needed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => overviewQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" />
            New policy
          </Button>
        </div>
      </div>

      <Tabs defaultValue="policies">
        <TabsList>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="preview">Test a policy</TabsTrigger>
        </TabsList>
        <TabsContent value="policies" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>
                  {policyView === "active"
                    ? "Active policy versions"
                    : "Policy history"}
                </CardTitle>
                <CardDescription>
                  {policyView === "active"
                    ? "The closest matching policy applies: store, then vendor, then sales channel, then all orders."
                    : "Retired versions are immutable audit history and never participate in policy resolution."}
                </CardDescription>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={policyView === "active" ? "default" : "outline"}
                  onClick={() => setPolicyView("active")}
                >
                  Active ({activePolicyCount})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={policyView === "history" ? "default" : "outline"}
                  onClick={() => setPolicyView("history")}
                >
                  History ({retiredPolicyCount})
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Policy</TableHead>
                    <TableHead>Applies to</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Return decisions</TableHead>
                    <TableHead className="text-right">
                      {policyView === "active" ? "Action" : "Status"}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visiblePolicies.map((policy) => {
                    const appliesTo = publicScope(policy);
                    return (
                      <TableRow key={policy.id}>
                        <TableCell>
                          <div className="font-medium">{policy.name}</div>
                          <div className="text-xs text-muted-foreground">
                            Version {policy.version}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {appliesTo
                              ? APPLIES_TO_LABELS[appliesTo]
                              : "Legacy scope"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-xs text-sm">
                            {scopeSummary(policy, overview)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div>
                            {policy.returnWindowDays} days /{" "}
                            {humanize(policy.returnDestination)}
                          </div>
                          <div className="text-muted-foreground">
                            Approval: {humanize(policy.approvalAuthority)} /
                            Label: {humanize(policy.labelProvider)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {policyView === "active" ? (
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!appliesTo}
                                title={
                                  appliesTo
                                    ? undefined
                                    : "Legacy policies must be replaced with a new simplified policy."
                                }
                                onClick={() => openVersion(policy)}
                              >
                                <FileText className="mr-2 h-4 w-4" />
                                New version
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setArchivePolicyId(policy.id)}
                                aria-label={`Archive ${policy.name}, version ${policy.version}`}
                              >
                                Archive
                              </Button>
                            </div>
                          ) : (
                            <Badge variant="secondary">Retired</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {visiblePolicies.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="h-24 text-center text-muted-foreground"
                      >
                        {policyView === "active"
                          ? "No active return policies. Start with an all-orders policy."
                          : "No retired policy versions."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="preview" className="mt-4">
          <ResolutionPreview
            overview={overview}
            value={resolution}
            onChange={changeResolution}
            onResolve={(input) => resolutionMutation.mutate(input)}
            loading={resolutionMutation.isPending}
            result={visibleResolution}
          />
        </TabsContent>
      </Tabs>

      <PolicyDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (createMutation.isPending || saveUncertain) return;
          setDialogOpen(open);
        }}
        overview={overview}
        draft={draft}
        onDraft={setDraft}
        scopeLocked={scopeLocked}
        saving={createMutation.isPending}
        uncertain={saveUncertain}
        saveError={saveError}
        policyChanged={policyChanged}
        onSave={savePolicy}
        shipping={{
          configured: shippingConfigured,
          draft: shippingDraft,
          catalog: shippingCatalog,
          loading: shippingCatalogQuery.isFetching,
          error: shippingCatalogQuery.error,
          readiness: shippingReadiness,
          focus: focusShipping,
          onConfigured: setShippingConfigured,
          onDraft: (patch) =>
            setShippingDraft((current) => ({ ...current, ...patch })),
          onRefresh: () => {
            void shippingCatalogQuery.refetch();
          },
        }}
      />
      {archivePolicyId !== null && (
        <ReturnPolicyArchiveDialog
          key={archivePolicyId}
          policyId={archivePolicyId}
          references={{
            channels: overview.channels,
            vendors: overview.referencedVendors.map((vendor) => ({
              id: vendor.id,
              name: vendorLabel(vendor),
            })),
            stores: overview.referencedStores.map((store) => ({
              id: store.id,
              name: storeLabel(store),
            })),
          }}
          onClose={() => setArchivePolicyId(null)}
          onArchived={() => {
            setArchivePolicyId(null);
            resolutionMutation.reset();
            void queryClient.invalidateQueries({
              queryKey: ["/api/returns/admin/policies"],
            });
            toast({
              title: "Return policy archived",
              description:
                "Historical returns keep their original policy records.",
            });
          }}
        />
      )}
    </div>
  );
}

function ResolutionPreview({
  overview,
  value,
  onChange,
  onResolve,
  loading,
  result,
}: {
  overview: Overview;
  value: ResolutionInput;
  onChange: (value: ResolutionInput) => void;
  onResolve: (input: ResolutionInput) => void;
  loading: boolean;
  result?: ResolutionResult;
}) {
  const dropship = value.channelId === overview.dropshipOmsChannelId;
  const [vendor, setVendor] = useState<VendorReference | null>(null);
  const [store, setStore] = useState<StoreReference | null>(null);
  const currentInput = deriveReturnPolicyResolutionInput({
    channelId: value.channelId,
    dropshipOmsChannelId: overview.dropshipOmsChannelId,
    selectedVendorId: vendor?.id ?? null,
    selectedStoreConnectionId: store?.id ?? null,
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Test which policy applies</CardTitle>
          <CardDescription>
            Select the order channel. Dropship orders can then be narrowed to a
            vendor or store.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <SelectField
            label="Sales channel"
            value={value.channelId?.toString() ?? "none"}
            options={overview.channels
              .filter((item) => item.status === "active")
              .map((item) => ({ value: item.id.toString(), label: item.name }))}
            onChange={(channelId) => {
              const id = Number(channelId);
              setVendor(null);
              setStore(null);
              onChange({
                channelId: id,
                vendorId: null,
                storeConnectionId: null,
              });
            }}
          />
          {dropship && (
            <VendorPicker
              label="Dropship vendor (optional)"
              selected={vendor}
              onSelect={(next) => {
                setVendor(next);
                setStore(null);
                onChange(
                  deriveReturnPolicyResolutionInput({
                    channelId: value.channelId,
                    dropshipOmsChannelId: overview.dropshipOmsChannelId,
                    selectedVendorId: next?.id ?? null,
                    selectedStoreConnectionId: null,
                  }),
                );
              }}
            />
          )}
          {dropship && vendor && (
            <StorePicker
              label="Dropship store (optional)"
              vendorId={vendor.id}
              selected={store}
              onSelect={(next) => {
                setStore(next);
                onChange(
                  deriveReturnPolicyResolutionInput({
                    channelId: value.channelId,
                    dropshipOmsChannelId: overview.dropshipOmsChannelId,
                    selectedVendorId: vendor.id,
                    selectedStoreConnectionId: next?.id ?? null,
                  }),
                );
              }}
            />
          )}
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!currentInput.channelId || loading}
              onClick={() =>
                onResolve(snapshotReturnPolicyResolutionInput(currentInput))
              }
            >
              {loading ? "Testing..." : "Test policy"}
            </Button>
          </div>
        </CardContent>
      </Card>
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Applies: {result.winner.name}</CardTitle>
            <CardDescription>
              Version {result.winner.version} is the closest policy for this
              order.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {result.matched.map((match) => (
              <div
                key={match.policy.id}
                className={`border p-3 ${match.policy.id === result.winner.id ? "border-green-500 bg-green-50" : ""}`}
              >
                <div className="font-medium">
                  {match.policy.name} / Version {match.policy.version}
                </div>
                <div className="text-sm text-muted-foreground">
                  {match.reason}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PolicyDialog({
  open,
  onOpenChange,
  overview,
  draft,
  onDraft,
  scopeLocked,
  saving,
  uncertain,
  saveError,
  policyChanged,
  onSave,
  shipping,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overview: Overview;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  scopeLocked: boolean;
  saving: boolean;
  uncertain: boolean;
  saveError: string | null;
  policyChanged: boolean;
  onSave: () => void;
  shipping: {
    configured: boolean;
    draft: ReturnLabelSettingsDraft;
    catalog: ReturnPolicyShippingCatalog | undefined;
    loading: boolean;
    error: Error | null;
    readiness: ReturnType<typeof returnLabelSettingsReadiness> | null;
    focus: boolean;
    onConfigured: (configured: boolean) => void;
    onDraft: (patch: Partial<ReturnLabelSettingsDraft>) => void;
    onRefresh: () => void;
  };
}) {
  const [vendor, setVendor] = useState<VendorReference | null>(null);
  const [store, setStore] = useState<StoreReference | null>(null);
  const wasOpen = useRef(false);
  const shippingSection = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setVendor(
        overview.referencedVendors.find((item) => item.id === draft.vendorId) ??
          null,
      );
      setStore(
        overview.referencedStores.find(
          (item) => item.id === draft.storeConnectionId,
        ) ?? null,
      );
    }
    if (!open && wasOpen.current) {
      setVendor(null);
      setStore(null);
    }
    wasOpen.current = open;
  }, [
    open,
    draft.vendorId,
    draft.storeConnectionId,
    overview.referencedVendors,
    overview.referencedStores,
  ]);

  const validTarget =
    draft.appliesTo === "all_orders" ||
    (draft.appliesTo === "channel" && draft.channelId !== null) ||
    (draft.appliesTo === "vendor" && draft.vendorId !== null) ||
    (draft.appliesTo === "store" &&
      draft.vendorId !== null &&
      draft.storeConnectionId !== null);
  const shippingCompatible =
    draft.returnDestination === "card_shellz" &&
    draft.labelProvider === "shipstation";
  const valid =
    draft.name.trim().length > 0 &&
    draft.name.trim().length <= 160 &&
    Number.isInteger(draft.returnWindowDays) &&
    draft.returnWindowDays >= 0 &&
    draft.returnWindowDays <= 3650 &&
    validTarget &&
    (!shipping.configured ||
      (shippingCompatible &&
        shipping.readiness?.canSave &&
        !shipping.loading &&
        !shipping.error));

  const updateAppliesTo = (appliesTo: AppliesTo) => {
    setVendor(null);
    setStore(null);
    onDraft({
      ...draft,
      appliesTo,
      channelId: appliesTo === "channel" ? draft.channelId : null,
      vendorId: null,
      storeConnectionId: null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-4xl overflow-y-auto"
        onOpenAutoFocus={(event) => {
          if (shipping.focus && shippingSection.current) {
            event.preventDefault();
            shippingSection.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {scopeLocked ? "Create policy version" : "Create return policy"}
          </DialogTitle>
          <DialogDescription>
            {scopeLocked
              ? "Who this policy applies to is fixed. Saving retires the current version and activates this one atomically."
              : "Start broad. Add a channel, vendor, or store policy only when its return decisions differ."}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={saving || uncertain} className="grid gap-5 py-2">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="Policy name"
              value={draft.name}
              onChange={(name) => onDraft({ ...draft, name })}
            />
            <SelectField
              label="Applies to"
              value={draft.appliesTo}
              disabled={scopeLocked}
              options={(
                Object.entries(APPLIES_TO_LABELS) as Array<[AppliesTo, string]>
              ).map(([value, label]) => ({ value, label }))}
              onChange={(value) => updateAppliesTo(value as AppliesTo)}
            />
          </div>

          {draft.appliesTo === "channel" && (
            <SelectField
              label="Sales channel"
              value={draft.channelId?.toString() ?? "none"}
              disabled={scopeLocked}
              options={overview.channels
                .filter((item) => item.status === "active")
                .map((item) => ({
                  value: item.id.toString(),
                  label: item.name,
                }))}
              onChange={(channelId) =>
                onDraft({ ...draft, channelId: Number(channelId) })
              }
            />
          )}
          {(draft.appliesTo === "vendor" || draft.appliesTo === "store") && (
            <VendorPicker
              label="Dropship vendor"
              disabled={scopeLocked}
              selected={vendor}
              onSelect={(next) => {
                setVendor(next);
                setStore(null);
                onDraft({
                  ...draft,
                  vendorId: next?.id ?? null,
                  storeConnectionId: null,
                });
              }}
            />
          )}
          {draft.appliesTo === "store" && vendor && (
            <StorePicker
              label="Dropship store"
              disabled={scopeLocked}
              vendorId={vendor.id}
              selected={store}
              onSelect={(next) => {
                setStore(next);
                onDraft({ ...draft, storeConnectionId: next?.id ?? null });
              }}
            />
          )}

          <div className="border-t pt-4">
            <h3 className="mb-3 font-medium">Return rules</h3>
            <div className="grid gap-4 md:grid-cols-3">
              <NumberField
                label="Return window (days)"
                value={draft.returnWindowDays}
                onChange={(returnWindowDays) =>
                  onDraft({ ...draft, returnWindowDays })
                }
              />
              <EnumField
                label="Physical return destination"
                value={draft.returnDestination}
                values={["card_shellz", "vendor", "marketplace"]}
                onChange={(returnDestination) =>
                  onDraft({ ...draft, returnDestination })
                }
              />
              <EnumField
                label="Approval authority"
                value={draft.approvalAuthority}
                values={["card_shellz", "marketplace", "vendor"]}
                onChange={(approvalAuthority) =>
                  onDraft({ ...draft, approvalAuthority })
                }
              />
              <EnumField
                label="Label provider"
                value={draft.labelProvider}
                values={["shipstation", "marketplace", "vendor", "none"]}
                onChange={(labelProvider) =>
                  onDraft({ ...draft, labelProvider })
                }
              />
              <EnumField
                label="Return shipping payer"
                value={draft.returnShippingPayer}
                values={[
                  "card_shellz",
                  "vendor",
                  "customer",
                  "marketplace",
                  "carrier",
                ]}
                onChange={(returnShippingPayer) =>
                  onDraft({ ...draft, returnShippingPayer })
                }
              />
              <EnumField
                label="Inspection requirement"
                value={draft.inspectionRequirement}
                values={["required", "conditional", "none"]}
                onChange={(inspectionRequirement) =>
                  onDraft({ ...draft, inspectionRequirement })
                }
              />
              <EnumField
                label="Inspection owner"
                value={draft.inspectionOwner}
                values={["card_shellz", "vendor", "marketplace"]}
                onChange={(inspectionOwner) =>
                  onDraft({ ...draft, inspectionOwner })
                }
              />
              <EnumField
                label="Customer refund authority"
                value={draft.customerRefundAuthority}
                values={["card_shellz", "marketplace", "vendor"]}
                onChange={(customerRefundAuthority) =>
                  onDraft({ ...draft, customerRefundAuthority })
                }
              />
              <EnumField
                label="Vendor settlement trigger"
                value={draft.vendorSettlementTrigger}
                values={[
                  "inspection_approved",
                  "customer_refunded",
                  "carrier_claim_paid",
                  "none",
                ]}
                onChange={(vendorSettlementTrigger) =>
                  onDraft({ ...draft, vendorSettlementTrigger })
                }
              />
            </div>
          </div>
          <div className="flex items-center justify-between border p-3">
            <div>
              <Label htmlFor="return-policy-returnless">
                Allow returnless refunds
              </Label>
              <p className="text-xs text-muted-foreground">
                Allows the refund authority to resolve eligible cases without
                physical receipt.
              </p>
            </div>
            <Switch
              id="return-policy-returnless"
              checked={draft.returnlessRefundAllowed}
              onCheckedChange={(returnlessRefundAllowed) =>
                onDraft({ ...draft, returnlessRefundAllowed })
              }
            />
          </div>
          <section
            ref={shippingSection}
            tabIndex={-1}
            aria-labelledby="return-policy-shipping-title"
            data-testid="return-policy-shipping"
            className="space-y-4 border-t pt-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="return-policy-shipping-title" className="font-medium">
                Return shipping
              </h3>
              <Button
                type="button"
                variant="outline"
                disabled={shipping.loading}
                onClick={shipping.onRefresh}
              >
                Refresh shipping choices
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              These shipping choices belong to this policy version. Orders using
              a more specific policy use that policy's shipping choices.
            </p>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={shipping.configured}
                onChange={(event) =>
                  shipping.onConfigured(event.target.checked)
                }
              />
              Configure return shipping
            </label>
            {!shipping.configured && (
              <p className="text-sm text-muted-foreground">
                This version will have no return-label configuration. Existing
                accepted returns keep their saved shipping details.
              </p>
            )}
            {shipping.loading && (
              <p role="status" className="text-sm">
                Loading shipping choices…
              </p>
            )}
            {shipping.error && (
              <p role="alert" className="text-sm text-destructive">
                {shipping.error.message}
              </p>
            )}
            {shipping.configured && (
              <>
                {!shippingCompatible && (
                  <p role="alert" className="text-sm text-destructive">
                    Return shipping requires Card Shellz as the physical return
                    destination and ShipStation as the label provider.
                  </p>
                )}
                {shipping.catalog && (
                  <>
                    <ReturnPolicyShippingFields
                      draft={shipping.draft}
                      catalog={shipping.catalog}
                      issues={shipping.readiness?.issues ?? []}
                      onChange={shipping.onDraft}
                    />
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={shipping.draft.enabled}
                        onChange={(event) =>
                          shipping.onDraft({ enabled: event.target.checked })
                        }
                      />
                      Enable real return labels for this policy
                    </label>
                  </>
                )}
                {(shipping.readiness?.issues.length ?? 0) > 0 && (
                  <div
                    data-testid="return-policy-shipping-blockers"
                    className="rounded-md border p-3 text-sm"
                  >
                    <p className="font-medium">Complete before saving</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {shipping.readiness?.issues.map((issue) => (
                        <li key={`${issue.field}:${issue.message}`}>
                          {issue.field ? (
                            <button
                              type="button"
                              className="text-left underline"
                              onClick={() => {
                                if (issue.field)
                                  document
                                    .getElementById(
                                      returnShippingFieldIds[issue.field],
                                    )
                                    ?.focus();
                              }}
                            >
                              {issue.message}
                            </button>
                          ) : (
                            issue.message
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
          <div>
            <Label htmlFor="return-policy-notes">Internal notes</Label>
            <Textarea
              id="return-policy-notes"
              className="mt-2"
              value={draft.notes ?? ""}
              onChange={(event) =>
                onDraft({ ...draft, notes: event.target.value || null })
              }
            />
          </div>
        </fieldset>
        {saveError && (
          <div
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            {saveError}
            {policyChanged && (
              <p>
                Close this editor, refresh Policies, then open the current
                version. Nothing was saved by this command.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={saving || uncertain}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={saving || policyChanged || (!uncertain && !valid)}
            onClick={onSave}
          >
            {saving ? "Saving..." : uncertain ? "Retry save" : "Create version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VendorPicker({
  label,
  selected,
  onSelect,
  disabled = false,
}: {
  label: string;
  selected: VendorReference | null;
  onSelect: (vendor: VendorReference | null) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = useQuery<{ vendors: VendorReference[] }>({
    queryKey: ["return-policy-vendors", search],
    queryFn: async () =>
      readJson(
        await fetch(
          `/api/returns/admin/policies/vendors?search=${encodeURIComponent(search)}&limit=20`,
          { credentials: "include" },
        ),
      ),
    enabled: !disabled && !selected,
  });
  return (
    <ReferencePicker
      label={label}
      search={search}
      onSearch={setSearch}
      selected={
        selected
          ? { label: vendorLabel(selected), detail: vendorDetail(selected) }
          : null
      }
      results={(query.data?.vendors ?? []).map((item) => ({
        key: item.id,
        label: vendorLabel(item),
        detail: vendorDetail(item),
        value: item,
      }))}
      onSelect={onSelect}
      onClear={() => {
        onSelect(null);
        setSearch("");
      }}
      disabled={disabled}
      loading={query.isFetching}
      emptyText="No vendors match this search."
    />
  );
}

function StorePicker({
  label,
  vendorId,
  selected,
  onSelect,
  disabled = false,
}: {
  label: string;
  vendorId: number;
  selected: StoreReference | null;
  onSelect: (store: StoreReference | null) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const query = useQuery<{ stores: StoreReference[] }>({
    queryKey: ["return-policy-stores", vendorId, search],
    queryFn: async () =>
      readJson(
        await fetch(
          `/api/returns/admin/policies/stores?vendorId=${vendorId}&search=${encodeURIComponent(search)}&limit=20`,
          { credentials: "include" },
        ),
      ),
    enabled: !disabled && !selected && vendorId > 0,
  });
  return (
    <ReferencePicker
      label={label}
      search={search}
      onSearch={setSearch}
      selected={
        selected
          ? { label: storeLabel(selected), detail: storeDetail(selected) }
          : null
      }
      results={(query.data?.stores ?? []).map((item) => ({
        key: item.id,
        label: storeLabel(item),
        detail: storeDetail(item),
        value: item,
      }))}
      onSelect={onSelect}
      onClear={() => {
        onSelect(null);
        setSearch("");
      }}
      disabled={disabled}
      loading={query.isFetching}
      emptyText="No stores for this vendor match the search."
    />
  );
}

function ReferencePicker<T>({
  label,
  search,
  onSearch,
  selected,
  results,
  onSelect,
  onClear,
  disabled,
  loading,
  emptyText,
}: {
  label: string;
  search: string;
  onSearch: (value: string) => void;
  selected: { label: string; detail: string } | null;
  results: Array<{ key: number; label: string; detail: string; value: T }>;
  onSelect: (value: T) => void;
  onClear: () => void;
  disabled: boolean;
  loading: boolean;
  emptyText: string;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label id={`${id}-label`} htmlFor={selected ? undefined : id}>
        {label}
      </Label>
      {selected ? (
        <div
          role="group"
          aria-labelledby={`${id}-label`}
          className="flex min-h-10 items-center justify-between border px-3 py-2"
        >
          <div>
            <div className="text-sm font-medium">{selected.label}</div>
            {selected.detail && (
              <div className="text-xs text-muted-foreground">
                {selected.detail}
              </div>
            )}
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Change selection"
              aria-label={`Change ${label}`}
              onClick={onClear}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              id={id}
              className="pl-9"
              value={search}
              disabled={disabled}
              placeholder={`Search ${label.toLowerCase()}`}
              onChange={(event) => onSearch(event.target.value)}
            />
          </div>
          {!disabled && (
            <div className="max-h-44 overflow-y-auto border">
              {loading ? (
                <div className="p-3 text-sm text-muted-foreground">
                  Searching...
                </div>
              ) : results.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  {emptyText}
                </div>
              ) : (
                results.map((result) => (
                  <button
                    key={result.key}
                    type="button"
                    className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                    onClick={() => onSelect(result.value)}
                  >
                    <div className="text-sm font-medium">{result.label}</div>
                    {result.detail && (
                      <div className="text-xs text-muted-foreground">
                        {result.detail}
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="mt-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="mt-2"
        type="number"
        min={0}
        max={3650}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
function EnumField({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <SelectField
      label={label}
      value={value}
      options={values.map((item) => ({ value: item, label: humanize(item) }))}
      onChange={onChange}
    />
  );
}
function SelectField({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="mt-2">
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  channelExposureDraftSaveResultSchema,
  createInventoryPublicationTargetRequestSchema,
  inventoryChannelExposureAdminViewSchema,
  inventoryChannelExposurePreviewSchema,
  inventoryPublicationTargetCommandResultSchema,
  saveChannelExposurePolicyDraftRequestSchema,
  savePublicationSourceBindingDraftRequestSchema,
  savePublicationVariantMappingDraftRequestSchema,
  setInventoryPublicationTargetPreviewStateRequestSchema,
  type ChannelExposurePolicyScope,
  type ChannelExposurePolicyValue,
  type InventoryChannelExposureAdminView,
} from "@shared/types/inventory-channel-exposure";
import type { z } from "zod";
import { GitBranch, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useAuth } from "@/lib/auth";

type PolicyScopeType = ChannelExposurePolicyScope["scopeType"];
type PolicyForm = {
  allocationSemantics: "inherit" | "exposure" | "partitioned";
  eligible: "inherit" | "eligible" | "ineligible";
  shareBps: string;
  holdbackSellableUnits: string;
  maxPublishMode: "inherit" | "unlimited" | "units";
  maxPublishSellableUnits: string;
  minPublishSellableUnits: string;
};

const EMPTY_POLICY: PolicyForm = {
  allocationSemantics: "inherit",
  eligible: "inherit",
  shareBps: "",
  holdbackSellableUnits: "",
  maxPublishMode: "inherit",
  maxPublishSellableUnits: "",
  minPublishSellableUnits: "",
};

export default function InventoryExposure() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory_planning", "edit");
  const canActivate = hasPermission("inventory_planning", "activate");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const policyIdempotencyKey = useRef<string | null>(null);
  const sourceIdempotencyKey = useRef<string | null>(null);
  const targetIdempotencyKey = useRef<string | null>(null);
  const targetStateIdempotencyKey = useRef<string | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [publicationTargetId, setPublicationTargetId] = useState<number | null>(null);
  const [scopeType, setScopeType] = useState<PolicyScopeType>("channel");
  const [variantId, setVariantId] = useState<number | null>(null);
  const [policyForm, setPolicyForm] = useState<PolicyForm>(EMPTY_POLICY);
  const [policyReason, setPolicyReason] = useState("");
  const [sourceNodeIds, setSourceNodeIds] = useState<number[]>([]);
  const [sourceReason, setSourceReason] = useState("");
  const [newTargetChannelId, setNewTargetChannelId] = useState<number | null>(null);
  const [newTargetConnectionId, setNewTargetConnectionId] = useState<number | null>(null);
  const [newTargetNodeId, setNewTargetNodeId] = useState<number | null>(null);
  const [newTargetScopeType, setNewTargetScopeType] = useState<"account" | "location">("account");
  const [newTargetExternalScopeId, setNewTargetExternalScopeId] = useState("");
  const [newTargetAuthority, setNewTargetAuthority] = useState<"echelon" | "external_provider" | "manual">("echelon");
  const [newTargetReason, setNewTargetReason] = useState("");
  const [targetStateReason, setTargetStateReason] = useState("");

  const viewQuery = useQuery<InventoryChannelExposureAdminView>({
    queryKey: ["/api/inventory-planning/admin/channel-exposure", productId],
    queryFn: () => requestJson(
      `/api/inventory-planning/admin/channel-exposure${productId ? `?productId=${productId}` : ""}`,
      inventoryChannelExposureAdminViewSchema,
    ),
  });
  const view = viewQuery.data;

  useEffect(() => {
    if (!view) return;
    if (productId === null && view.products[0]) setProductId(view.products[0].id);
    setPublicationTargetId((current) => current !== null
      && view.publicationTargets.some((target) => target.id === current)
      ? current : view.publicationTargets[0]?.id ?? null);
    setVariantId((current) => current !== null
      && view.selectedProduct?.variants.some((variant) => variant.id === current)
      ? current : view.selectedProduct?.variants.find((variant) =>
        variant.isActive && variant.salesEligibility === "sellable")?.id ?? null);
  }, [productId, view]);

  useEffect(() => {
    if (!view) return;
    const selectedChannelId = newTargetChannelId !== null
      && view.channels.some((item) => item.id === newTargetChannelId)
      ? newTargetChannelId : view.channels[0]?.id ?? null;
    if (selectedChannelId !== newTargetChannelId) setNewTargetChannelId(selectedChannelId);
    const connections = view.channels.find((item) => item.id === selectedChannelId)?.connections ?? [];
    if (newTargetConnectionId === null
      || !connections.some((item) => item.id === newTargetConnectionId)) {
      setNewTargetConnectionId(connections[0]?.id ?? null);
    }
    if (newTargetNodeId === null
      || !view.fulfillmentNodes.some((item) => item.id === newTargetNodeId)) {
      setNewTargetNodeId(view.fulfillmentNodes[0]?.id ?? null);
    }
  }, [newTargetChannelId, newTargetConnectionId, newTargetNodeId, view]);

  const target = view?.publicationTargets.find((item) => item.id === publicationTargetId) ?? null;
  const channel = view?.channels.find((item) => item.id === target?.channelId) ?? null;
  const newTargetConnections = view?.channels.find((item) =>
    item.id === newTargetChannelId)?.connections ?? [];
  const scope = useMemo<ChannelExposurePolicyScope | null>(() => {
    if (!target) return null;
    if (scopeType === "channel") return { scopeType, channelId: target.channelId };
    if (productId === null) return null;
    if (scopeType === "product") return { scopeType, channelId: target.channelId, productId };
    if (variantId === null) return null;
    return { scopeType, channelId: target.channelId, productId, productVariantId: variantId };
  }, [productId, scopeType, target, variantId]);
  const policyHead = view && scope
    ? view.policyHeads.find((head) => head.scopeKey === scopeKey(scope)) ?? null
    : null;
  const sourceHead = view?.sourceBindingHeads.find((head) =>
    head.publicationTargetId === publicationTargetId) ?? null;

  useEffect(() => {
    const policy = policyHead?.draftPolicy ?? policyHead?.activePolicy ?? null;
    setPolicyForm(policy ? policyToForm(policy.value) : EMPTY_POLICY);
    setPolicyReason("");
    policyIdempotencyKey.current = null;
  }, [policyHead?.activePolicy?.definitionHash, policyHead?.draftPolicy?.definitionHash, scopeType,
    target?.channelId, variantId]);

  useEffect(() => {
    const binding = sourceHead?.draftBinding ?? sourceHead?.activeBinding ?? null;
    setSourceNodeIds(binding?.fulfillmentNodeIds ?? []);
    setSourceReason("");
    sourceIdempotencyKey.current = null;
  }, [publicationTargetId, sourceHead?.activeBinding?.definitionHash,
    sourceHead?.draftBinding?.definitionHash]);

  useEffect(() => {
    setTargetStateReason("");
    targetStateIdempotencyKey.current = null;
  }, [publicationTargetId, target?.revision]);

  const previewQuery = useQuery({
    queryKey: ["/api/inventory-planning/admin/channel-exposure/preview", publicationTargetId, productId],
    queryFn: () => requestJson(
      `/api/inventory-planning/admin/channel-exposure/preview?publicationTargetId=${publicationTargetId}&productId=${productId}`,
      inventoryChannelExposurePreviewSchema,
    ),
    enabled: publicationTargetId !== null && productId !== null,
    retry: false,
  });

  const savePolicy = useMutation({
    mutationFn: async () => {
      if (!scope) throw new Error("Select a complete policy scope.");
      const value = parsePolicyForm(policyForm);
      const idempotencyKey = policyIdempotencyKey.current ?? crypto.randomUUID();
      policyIdempotencyKey.current = idempotencyKey;
      const request = saveChannelExposurePolicyDraftRequestSchema.parse({
        scope,
        value,
        expectedHeadRevision: policyHead?.revision ?? "0",
        expectedDraftPolicyId: policyHead?.draftPolicy?.policyId ?? null,
        expectedDraftDefinitionHash: policyHead?.draftPolicy?.definitionHash ?? null,
        changeReason: policyReason,
        idempotencyKey,
      });
      return requestJson(
        "/api/inventory-planning/admin/channel-exposure/policy-draft",
        channelExposureDraftSaveResultSchema,
        jsonRequest("PUT", request),
      );
    },
    onSuccess: async (result) => {
      policyIdempotencyKey.current = null;
      setPolicyReason("");
      await refreshExposure(queryClient);
      toast({
        title: "Channel policy draft saved",
        description: `Draft v${result.version} was recorded. Runtime publishing is unchanged.`,
      });
    },
    onError: (error: Error) => toast({
      title: "Channel policy was not saved",
      description: error.message,
      variant: "destructive",
    }),
  });

  const saveSourceBinding = useMutation({
    mutationFn: async () => {
      if (publicationTargetId === null) throw new Error("Select a publication target.");
      const idempotencyKey = sourceIdempotencyKey.current ?? crypto.randomUUID();
      sourceIdempotencyKey.current = idempotencyKey;
      const request = savePublicationSourceBindingDraftRequestSchema.parse({
        publicationTargetId,
        fulfillmentNodeIds: sourceNodeIds,
        expectedHeadRevision: sourceHead?.revision ?? "0",
        expectedDraftBindingId: sourceHead?.draftBinding?.bindingId ?? null,
        expectedDraftDefinitionHash: sourceHead?.draftBinding?.definitionHash ?? null,
        changeReason: sourceReason,
        idempotencyKey,
      });
      return requestJson(
        "/api/inventory-planning/admin/channel-exposure/source-binding-draft",
        channelExposureDraftSaveResultSchema,
        jsonRequest("PUT", request),
      );
    },
    onSuccess: async (result) => {
      sourceIdempotencyKey.current = null;
      setSourceReason("");
      await refreshExposure(queryClient);
      toast({
        title: "Fulfillment scope draft saved",
        description: `Draft v${result.version} was recorded. No provider work was created.`,
      });
    },
    onError: (error: Error) => toast({
      title: "Fulfillment scope was not saved",
      description: error.message,
      variant: "destructive",
    }),
  });

  const createTarget = useMutation({
    mutationFn: async () => {
      if (newTargetChannelId === null || newTargetConnectionId === null || newTargetNodeId === null) {
        throw new Error("Select a channel, connection, and compatibility fulfillment node.");
      }
      const idempotencyKey = targetIdempotencyKey.current ?? crypto.randomUUID();
      targetIdempotencyKey.current = idempotencyKey;
      const request = createInventoryPublicationTargetRequestSchema.parse({
        channelId: newTargetChannelId,
        channelConnectionId: newTargetConnectionId,
        legacyFulfillmentNodeId: newTargetNodeId,
        providerScopeType: newTargetScopeType,
        externalScopeId: newTargetExternalScopeId,
        publicationAuthority: newTargetAuthority,
        changeReason: newTargetReason,
        idempotencyKey,
      });
      return requestJson(
        "/api/inventory-planning/admin/channel-exposure/publication-target",
        inventoryPublicationTargetCommandResultSchema,
        jsonRequest("POST", request),
      );
    },
    onSuccess: async (result) => {
      targetIdempotencyKey.current = null;
      setNewTargetExternalScopeId("");
      setNewTargetReason("");
      setPublicationTargetId(result.publicationTargetId);
      await refreshExposure(queryClient);
      toast({
        title: "Disabled publication target created",
        description: "Configure sources and SKU mappings before enabling readiness preview.",
      });
    },
    onError: (error: Error) => toast({
      title: "Publication target was not created",
      description: error.message,
      variant: "destructive",
    }),
  });

  const setTargetPreviewState = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Select a publication target.");
      if (target.state === "live") throw new Error("A live target cannot be changed here.");
      const state = target.state === "preview" ? "disabled" : "preview";
      const idempotencyKey = targetStateIdempotencyKey.current ?? crypto.randomUUID();
      targetStateIdempotencyKey.current = idempotencyKey;
      const request = setInventoryPublicationTargetPreviewStateRequestSchema.parse({
        publicationTargetId: target.id,
        expectedRevision: target.revision,
        state,
        changeReason: targetStateReason,
        idempotencyKey,
      });
      return requestJson(
        "/api/inventory-planning/admin/channel-exposure/publication-target-preview-state",
        inventoryPublicationTargetCommandResultSchema,
        jsonRequest("PUT", request),
      );
    },
    onSuccess: async (result) => {
      targetStateIdempotencyKey.current = null;
      setTargetStateReason("");
      await refreshExposure(queryClient);
      toast({
        title: result.state === "preview" ? "Target included in readiness preview" : "Target disabled",
        description: "Runtime ATP and provider quantities are unchanged.",
      });
    },
    onError: (error: Error) => toast({
      title: "Publication target state was not changed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const updatePolicy = (patch: Partial<PolicyForm>) => {
    setPolicyForm((current) => ({ ...current, ...patch }));
    policyIdempotencyKey.current = null;
  };
  const toggleNode = (nodeId: number, checked: boolean) => {
    setSourceNodeIds((current) => checked
      ? [...new Set([...current, nodeId])].sort((left, right) => left - right)
      : current.filter((id) => id !== nodeId));
    sourceIdempotencyKey.current = null;
  };

  if (viewQuery.isLoading) return <div className="p-6">Loading inventory exposure…</div>;
  if (viewQuery.error || !view) {
    return <div className="p-6 text-destructive">{(viewQuery.error as Error)?.message ?? "Inventory exposure is unavailable."}</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inventory Exposure</h1>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
            Define which fulfillment nodes feed each exact provider target, then resolve channel,
            product, and SKU dials against canonical warehouse ATP.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline"><ShieldCheck className="mr-1 h-3.5 w-3.5" />Draft / preview only</Badge>
          <Badge variant="secondary">Legacy runtime retained</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create an exact provider destination</CardTitle>
          <p className="text-sm text-muted-foreground">
            New targets start disabled. Creation and readiness preview do not call a provider or
            change live channel quantities.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Field label="Channel">
              <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={newTargetChannelId ?? ""} disabled={!canEdit}
                onChange={(event) => {
                  setNewTargetChannelId(Number(event.target.value));
                  setNewTargetConnectionId(null);
                  targetIdempotencyKey.current = null;
                }}>
                {view.channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
            <Field label="Provider connection">
              <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={newTargetConnectionId ?? ""} disabled={!canEdit}
                onChange={(event) => {
                  setNewTargetConnectionId(Number(event.target.value));
                  targetIdempotencyKey.current = null;
                }}>
                {newTargetConnections.length === 0 && <option value="">No connection</option>}
                {newTargetConnections.map((item) => <option key={item.id} value={item.id}>
                  {item.externalAccountLabel ?? `Connection #${item.id}`}
                </option>)}
              </select>
            </Field>
            <Field label="Compatibility node">
              <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={newTargetNodeId ?? ""} disabled={!canEdit}
                onChange={(event) => {
                  setNewTargetNodeId(Number(event.target.value));
                  targetIdempotencyKey.current = null;
                }}>
                {view.fulfillmentNodes.map((node) => <option key={node.id} value={node.id}>
                  {node.code} — {node.name}
                </option>)}
              </select>
            </Field>
            <SelectField label="Provider scope" value={newTargetScopeType}
              disabled={!canEdit}
              onChange={(value) => {
                setNewTargetScopeType(value as "account" | "location");
                targetIdempotencyKey.current = null;
              }} options={["account", "location"]} />
            <Field label="External account/location ID">
              <Input value={newTargetExternalScopeId} disabled={!canEdit}
                onChange={(event) => {
                  setNewTargetExternalScopeId(event.target.value);
                  targetIdempotencyKey.current = null;
                }} />
            </Field>
            <SelectField label="Publication authority" value={newTargetAuthority}
              disabled={!canEdit}
              onChange={(value) => {
                setNewTargetAuthority(value as "echelon" | "external_provider" | "manual");
                targetIdempotencyKey.current = null;
              }} options={["echelon", "external_provider", "manual"]} />
          </div>
          <Field label="Reason for creating this disabled target">
            <Textarea value={newTargetReason} disabled={!canEdit}
              onChange={(event) => {
                setNewTargetReason(event.target.value);
                targetIdempotencyKey.current = null;
              }} />
          </Field>
          <Button disabled={!canEdit || newTargetConnectionId === null || newTargetNodeId === null
            || newTargetExternalScopeId.trim().length === 0 || newTargetReason.trim().length === 0
            || createTarget.isPending}
            onClick={() => createTarget.mutate()}>
            Create disabled target
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Review scope</CardTitle></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <Field label="Product">
            <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={productId ?? ""} onChange={(event) => setProductId(Number(event.target.value))}>
              {view.products.map((product) => <option key={product.id} value={product.id}>
                {product.sku ? `${product.sku} — ` : ""}{product.name}
              </option>)}
            </select>
          </Field>
          <Field label="Exact publication target">
            <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={publicationTargetId ?? ""}
              onChange={(event) => setPublicationTargetId(Number(event.target.value))}>
              {view.publicationTargets.length === 0 && <option value="">No targets configured</option>}
              {view.publicationTargets.map((item) => {
                const targetChannel = view.channels.find((candidate) => candidate.id === item.channelId);
                return <option key={item.id} value={item.id}>
                  {targetChannel?.name ?? `Channel ${item.channelId}`} · {item.providerScopeType} {item.externalScopeId} · {item.state}
                </option>;
              })}
            </select>
          </Field>
          {target && <div className="lg:col-span-2 space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div>
              <strong>{channel?.name ?? `Channel ${target.channelId}`}</strong> via connection #{target.channelConnectionId};
              provider authority <strong>{target.publicationAuthority}</strong>; state <strong>{target.state}</strong>;
              revision {target.revision}. The legacy single-node field is #{target.legacyFulfillmentNodeId};
              only the versioned source set below feeds the new preview.
            </div>
            {target.state !== "live" && <div className="grid items-end gap-3 md:grid-cols-[1fr_auto]">
              <Field label="Reason for changing readiness inclusion">
                <Input value={targetStateReason} disabled={!canActivate}
                  onChange={(event) => {
                    setTargetStateReason(event.target.value);
                    targetStateIdempotencyKey.current = null;
                  }} />
              </Field>
              <Button variant={target.state === "preview" ? "outline" : "default"}
                disabled={!canActivate || targetStateReason.trim().length === 0
                  || setTargetPreviewState.isPending}
                onClick={() => setTargetPreviewState.mutate()}>
                {target.state === "preview" ? "Remove from readiness preview" : "Include in readiness preview"}
              </Button>
            </div>}
          </div>}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><GitBranch className="h-5 w-5" />Fulfillment-node scope</CardTitle>
            <p className="text-sm text-muted-foreground">
              Select every internal, network, or 3PL node allowed to supply this exact target. An
              empty or missing scope publishes zero in the proposed model.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {view.fulfillmentNodes.map((node) => <label key={node.id}
              className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox checked={sourceNodeIds.includes(node.id)}
                disabled={!canEdit}
                onCheckedChange={(value) => toggleNode(node.id, value === true)} />
              <span className="text-sm">
                <span className="font-medium">{node.code} — {node.name}</span>
                <span className="block text-muted-foreground">
                  {node.nodeType.replaceAll("_", " ")} · warehouse {node.warehouseCode} · {node.lifecycleStatus}
                </span>
              </span>
            </label>)}
            <Field label="Reason for this draft">
              <Textarea value={sourceReason} disabled={!canEdit}
                onChange={(event) => { setSourceReason(event.target.value); sourceIdempotencyKey.current = null; }} />
            </Field>
            <Button disabled={!canEdit || !target || sourceNodeIds.length === 0
              || sourceReason.trim().length === 0 || saveSourceBinding.isPending}
              onClick={() => saveSourceBinding.mutate()}>
              Save fulfillment scope draft
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Channel dials</CardTitle>
            <p className="text-sm text-muted-foreground">
              Fields resolve independently from SKU to product to channel default. Blank fields
              inherit. Missing required fields fail closed to zero.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Policy level">
                <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={scopeType} onChange={(event) => setScopeType(event.target.value as PolicyScopeType)}>
                  <option value="channel">Channel default</option>
                  <option value="product">Product override</option>
                  <option value="variant">SKU override</option>
                </select>
              </Field>
              {scopeType === "variant" && <Field label="SKU">
                <select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={variantId ?? ""} onChange={(event) => setVariantId(Number(event.target.value))}>
                  {view.selectedProduct?.variants.filter((variant) => variant.salesEligibility === "sellable")
                    .map((variant) => <option key={variant.id} value={variant.id}>
                      {variant.sku ?? variant.name}{variant.isActive ? "" : " (inactive)"}
                    </option>)}
                </select>
              </Field>}
              <SelectField label="Allocation semantics" value={policyForm.allocationSemantics}
                onChange={(value) => updatePolicy({ allocationSemantics: value as PolicyForm["allocationSemantics"] })}
                options={["inherit", "exposure", "partitioned"]} />
              <SelectField label="Eligible" value={policyForm.eligible}
                onChange={(value) => updatePolicy({ eligible: value as PolicyForm["eligible"] })}
                options={["inherit", "eligible", "ineligible"]} />
              <InputField label="Share (basis points)" value={policyForm.shareBps}
                placeholder="inherit" onChange={(value) => updatePolicy({ shareBps: value })} />
              <InputField label="Channel holdback (sellable units)" value={policyForm.holdbackSellableUnits}
                placeholder="inherit" onChange={(value) => updatePolicy({ holdbackSellableUnits: value })} />
              <SelectField label="Maximum publish" value={policyForm.maxPublishMode}
                onChange={(value) => updatePolicy({ maxPublishMode: value as PolicyForm["maxPublishMode"] })}
                options={["inherit", "unlimited", "units"]} />
              {policyForm.maxPublishMode === "units" && <InputField label="Maximum sellable units"
                value={policyForm.maxPublishSellableUnits}
                onChange={(value) => updatePolicy({ maxPublishSellableUnits: value })} />}
              <InputField label="Minimum publish cutoff (sellable units)"
                value={policyForm.minPublishSellableUnits} placeholder="inherit"
                onChange={(value) => updatePolicy({ minPublishSellableUnits: value })} />
            </div>
            <Field label="Reason for this draft">
              <Textarea value={policyReason} disabled={!canEdit}
                onChange={(event) => { setPolicyReason(event.target.value); policyIdempotencyKey.current = null; }} />
            </Field>
            <Button disabled={!canEdit || !scope || policyReason.trim().length === 0 || savePolicy.isPending}
              onClick={() => savePolicy.mutate()}>
              Save channel policy draft
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exact target/SKU provider mappings</CardTitle>
          <p className="text-sm text-muted-foreground">
            Each sellable SKU needs an explicit inventory identity for this exact destination.
            Legacy feed values are suggestions only; saving creates an inactive mapping draft.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {!target && <p className="text-sm text-muted-foreground">Select or create a publication target.</p>}
          {target && view.selectedProduct?.variants
            .filter((variant) => variant.isActive && variant.salesEligibility === "sellable")
            .map((variant) => <VariantMappingRow key={`${target.id}:${variant.id}`}
              target={target} variant={variant} view={view} canEdit={canEdit} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Full calculation preview</CardTitle>
          <p className="text-sm text-muted-foreground">
            Canonical ATP is summed only across the selected source nodes. Share is applied first,
            then holdback, maximum, and the minimum cutoff. No outbox or provider call is created.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {previewQuery.isLoading && <p className="text-sm text-muted-foreground">Calculating preview…</p>}
          {previewQuery.error && <p className="text-sm text-destructive">{(previewQuery.error as Error).message}</p>}
          {previewQuery.data && <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            ATP shadow #{previewQuery.data.shadowRunId} captured {new Date(previewQuery.data.shadowCapturedAt).toLocaleString()}
            {previewQuery.data.modelId ? ` · model #${previewQuery.data.modelId} v${previewQuery.data.modelVersion}` : " · no transformation model"}
            {previewQuery.data.sourceBindingId
              ? ` · source binding #${previewQuery.data.sourceBindingId} v${previewQuery.data.sourceBindingVersion} (${previewQuery.data.sourceBindingAuthority})`
              : " · source binding missing"}
            {previewQuery.data.selectedPolicies.length > 0
              ? ` · ${previewQuery.data.selectedPolicies.length} selected policy definition(s)`
              : " · policy definitions missing"}
          </div>}
          {previewQuery.data?.blockers.map((blocker) => <div key={`${blocker.code}:${JSON.stringify(blocker.context)}`}
            className="rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
            <strong>{blocker.code}</strong>: {blocker.message}
          </div>)}
          {previewQuery.data && <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>SKU</TableHead><TableHead className="text-right">Canonical ATP</TableHead>
                <TableHead className="text-right">After share</TableHead>
                <TableHead className="text-right">After holdback</TableHead>
                <TableHead className="text-right">After cap</TableHead>
                <TableHead className="text-right">Published</TableHead>
                <TableHead>Source ATP</TableHead>
                <TableHead>Semantics</TableHead>
              </TableRow></TableHeader>
              <TableBody>{previewQuery.data.rows.map((row) => <TableRow key={row.productVariantId}>
                <TableCell>{row.sku ?? `Variant ${row.productVariantId}`}</TableCell>
                <TableCell className="text-right tabular-nums">{row.canonicalAtpUnits}</TableCell>
                <TableCell className="text-right tabular-nums">{row.sharedUnits}</TableCell>
                <TableCell className="text-right tabular-nums">{row.afterHoldbackUnits}</TableCell>
                <TableCell className="text-right tabular-nums">{row.cappedUnits}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{row.publishedUnits}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.sourceWarehouseBreakdown.length === 0
                    ? "none"
                    : row.sourceWarehouseBreakdown.map((source) =>
                      `${view.fulfillmentNodes.find((node) => node.warehouseId === source.warehouseId)
                        ?.warehouseCode ?? `warehouse ${source.warehouseId}`}: ${source.canonicalAtpUnits}`)
                      .join(" · ")}
                </TableCell>
                <TableCell>{row.policy?.allocationSemantics ?? "blocked"}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>}
        </CardContent>
      </Card>
    </div>
  );
}

function VariantMappingRow({ target, variant, view, canEdit }: {
  target: InventoryChannelExposureAdminView["publicationTargets"][number];
  variant: NonNullable<InventoryChannelExposureAdminView["selectedProduct"]>["variants"][number];
  view: InventoryChannelExposureAdminView;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const idempotencyKey = useRef<string | null>(null);
  const head = view.variantMappingHeads.find((item) =>
    item.publicationTargetId === target.id && item.productVariantId === variant.id) ?? null;
  const selected = head?.draftMapping ?? head?.activeMapping ?? null;
  const candidate = view.legacyMappingCandidates.find((item) =>
    item.channelId === target.channelId && item.productVariantId === variant.id) ?? null;
  const [externalInventoryItemId, setExternalInventoryItemId] = useState("");
  const [externalSku, setExternalSku] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    setExternalInventoryItemId(selected?.externalInventoryItemId
      ?? candidate?.externalInventoryItemId ?? "");
    setExternalSku(selected?.externalSku ?? candidate?.externalSku ?? variant.sku ?? "");
    setReason("");
    idempotencyKey.current = null;
  }, [candidate?.externalInventoryItemId, candidate?.externalSku, selected?.definitionHash,
    target.id, variant.id, variant.sku]);

  const save = useMutation({
    mutationFn: async () => {
      const requestKey = idempotencyKey.current ?? crypto.randomUUID();
      idempotencyKey.current = requestKey;
      const request = savePublicationVariantMappingDraftRequestSchema.parse({
        publicationTargetId: target.id,
        productVariantId: variant.id,
        externalInventoryItemId,
        externalSku: externalSku.trim() || null,
        expectedHeadRevision: head?.revision ?? "0",
        expectedDraftMappingId: head?.draftMapping?.mappingId ?? null,
        expectedDraftDefinitionHash: head?.draftMapping?.definitionHash ?? null,
        changeReason: reason,
        idempotencyKey: requestKey,
      });
      return requestJson(
        "/api/inventory-planning/admin/channel-exposure/variant-mapping-draft",
        channelExposureDraftSaveResultSchema,
        jsonRequest("PUT", request),
      );
    },
    onSuccess: async (result) => {
      idempotencyKey.current = null;
      setReason("");
      await refreshExposure(queryClient);
      toast({
        title: "Exact SKU mapping draft saved",
        description: `Draft v${result.version} was recorded without publishing inventory.`,
      });
    },
    onError: (error: Error) => toast({
      title: "Exact SKU mapping was not saved",
      description: error.message,
      variant: "destructive",
    }),
  });

  const resetIdempotency = () => { idempotencyKey.current = null; };
  return <div className="grid items-end gap-3 rounded-md border p-3 lg:grid-cols-[minmax(9rem,0.8fr)_1fr_1fr_1.3fr_auto]">
    <div className="text-sm">
      <div className="font-medium">{variant.sku ?? variant.name}</div>
      <div className="text-xs text-muted-foreground">
        {selected ? `${selected.lifecycleStatus} mapping v${selected.version}` : "mapping missing"}
        {candidate ? ` · legacy ${candidate.mappingState} suggestion` : " · no legacy suggestion"}
      </div>
    </div>
    <Field label="Provider inventory item ID">
      <Input value={externalInventoryItemId} disabled={!canEdit}
        onChange={(event) => { setExternalInventoryItemId(event.target.value); resetIdempotency(); }} />
    </Field>
    <Field label="External SKU">
      <Input value={externalSku} disabled={!canEdit}
        onChange={(event) => { setExternalSku(event.target.value); resetIdempotency(); }} />
    </Field>
    <Field label="Reason">
      <Input value={reason} disabled={!canEdit}
        onChange={(event) => { setReason(event.target.value); resetIdempotency(); }} />
    </Field>
    <Button disabled={!canEdit || externalInventoryItemId.trim().length === 0
      || reason.trim().length === 0 || save.isPending}
      onClick={() => save.mutate()}>
      Save mapping draft
    </Button>
  </div>;
}

function scopeKey(scope: ChannelExposurePolicyScope): string {
  if (scope.scopeType === "channel") return `channel:${scope.channelId}`;
  if (scope.scopeType === "product") return `channel:${scope.channelId}:product:${scope.productId}`;
  return `channel:${scope.channelId}:variant:${scope.productVariantId}`;
}

function policyToForm(value: ChannelExposurePolicyValue): PolicyForm {
  return {
    allocationSemantics: value.allocationSemantics ?? "inherit",
    eligible: value.eligible === null ? "inherit" : value.eligible ? "eligible" : "ineligible",
    shareBps: value.shareBps?.toString() ?? "",
    holdbackSellableUnits: value.holdbackSellableUnits ?? "",
    maxPublishMode: value.maxPublish?.mode ?? "inherit",
    maxPublishSellableUnits: value.maxPublish?.mode === "units" ? value.maxPublish.units : "",
    minPublishSellableUnits: value.minPublishSellableUnits ?? "",
  };
}

function parsePolicyForm(form: PolicyForm): ChannelExposurePolicyValue {
  const quantity = (value: string, label: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^(0|[1-9]\d*)$/.test(trimmed)) throw new Error(`${label} must be a nonnegative whole number.`);
    return BigInt(trimmed).toString();
  };
  const share = quantity(form.shareBps, "Share");
  if (share !== null && BigInt(share) > BigInt(10_000)) throw new Error("Share cannot exceed 10,000 basis points.");
  return {
    allocationSemantics: form.allocationSemantics === "inherit" ? null : form.allocationSemantics,
    eligible: form.eligible === "inherit" ? null : form.eligible === "eligible",
    shareBps: share === null ? null : Number(share),
    holdbackSellableUnits: quantity(form.holdbackSellableUnits, "Holdback"),
    maxPublish: form.maxPublishMode === "inherit" ? null
      : form.maxPublishMode === "unlimited" ? { mode: "unlimited" }
        : { mode: "units", units: quantity(form.maxPublishSellableUnits, "Maximum") ?? "" },
    minPublishSellableUnits: quantity(form.minPublishSellableUnits, "Minimum cutoff"),
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}

function InputField({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange(value: string): void;
}) {
  return <Field label={label}><Input inputMode="numeric" value={value} placeholder={placeholder}
    onChange={(event) => onChange(event.target.value)} /></Field>;
}

function SelectField({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: string[]; disabled?: boolean; onChange(value: string): void;
}) {
  return <Field label={label}><select className="h-10 w-full rounded-md border bg-background px-3 text-sm"
    value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
  </select></Field>;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) };
}

async function requestJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) throw new Error(String(body?.error?.message ?? response.statusText));
  return schema.parse(body);
}

async function refreshExposure(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/channel-exposure"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/channel-exposure/preview"] }),
  ]);
}

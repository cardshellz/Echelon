import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPromiseSafetyPolicyDraftAdminRequestSchema,
  promiseSafetyAdminViewSchema,
  promiseSafetyPolicyDraftAdminResultSchema,
  refreshDemandEvidenceAdminRequestSchema,
  refreshDemandEvidenceAdminResultSchema,
  updatePromiseSafetyPolicyDraftAdminRequestSchema,
  type PromiseSafetyAdminScope,
  type PromiseSafetyAdminView,
} from "@shared/types/inventory-promise-safety-admin";
import { z } from "zod";
import { RefreshCw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  formatPromiseSafetyPolicy,
  initialPromiseSafetyPolicyForm,
  parsePromiseSafetyPolicyForm,
  policyHeadForScope,
  promiseSafetyScopeKey,
  type PromiseSafetyPolicyForm,
} from "./promise-safety-policy-model";

type ScopeType = PromiseSafetyAdminScope["scopeType"];

export function PromiseSafetyPolicyPanel({
  productId,
  canEdit,
}: {
  productId: number;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const policyIdempotencyKey = useRef<string | null>(null);
  const refreshIdempotencyKey = useRef<string | null>(null);
  const [scopeType, setScopeType] = useState<ScopeType>("business");
  const [variantId, setVariantId] = useState<number | null>(null);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [form, setForm] = useState<PromiseSafetyPolicyForm>({
    policyMode: "fixed_units",
    fixedUnits: "0",
    daysOfCover: "1",
    untrustedDemandFallbackUnits: "0",
  });
  const [changeReason, setChangeReason] = useState("");
  const [refreshReason, setRefreshReason] = useState("");

  const viewQuery = useQuery<PromiseSafetyAdminView>({
    queryKey: ["/api/inventory-planning/admin/promise-safety", productId],
    queryFn: () => requestJson(
      `/api/inventory-planning/admin/promise-safety/${productId}`,
      promiseSafetyAdminViewSchema,
    ),
  });
  const view = viewQuery.data;

  useEffect(() => {
    if (!view) return;
    const firstVariantId = view.variants.find((variant) => variant.isActive)?.id
      ?? view.variants[0]?.id
      ?? null;
    const firstWarehouseId = view.warehouses[0]?.id ?? null;
    setVariantId((current) => current !== null && view.variants.some((item) => item.id === current)
      ? current
      : firstVariantId);
    setWarehouseId((current) => current !== null && view.warehouses.some((item) => item.id === current)
      ? current
      : firstWarehouseId);
  }, [view]);

  const scope = useMemo<PromiseSafetyAdminScope | null>(() => {
    if (scopeType === "business") return { scopeType: "business" };
    if (variantId === null) return null;
    if (scopeType === "network_variant") {
      return { scopeType: "network_variant", productVariantId: variantId };
    }
    if (warehouseId === null) return null;
    return { scopeType: "warehouse_variant", productVariantId: variantId, warehouseId };
  }, [scopeType, variantId, warehouseId]);
  const head = useMemo(
    () => view && scope ? policyHeadForScope(view.policyHeads, scope) : null,
    [scope, view],
  );
  const scopeKey = scope ? promiseSafetyScopeKey(scope) : null;

  useEffect(() => {
    if (!scope) return;
    setForm(initialPromiseSafetyPolicyForm(scope, head));
    setChangeReason("");
    policyIdempotencyKey.current = null;
  }, [head, scopeKey]);

  const parsedPolicy = scope ? parsePromiseSafetyPolicyForm(scope, form) : null;

  const savePolicy = useMutation({
    mutationFn: async () => {
      if (!scope || !parsedPolicy?.success) {
        throw new Error(parsedPolicy && !parsedPolicy.success
          ? parsedPolicy.message
          : "Select a complete policy scope.");
      }
      const idempotencyKey = policyIdempotencyKey.current ?? crypto.randomUUID();
      policyIdempotencyKey.current = idempotencyKey;
      if (head?.draftPolicy) {
        const request = updatePromiseSafetyPolicyDraftAdminRequestSchema.parse({
          expectedVersion: head.draftPolicy.version,
          expectedDefinitionHash: head.draftPolicy.definitionHash,
          expectedHeadRevision: head.revision,
          value: parsedPolicy.value,
          changeReason,
          idempotencyKey,
        });
        return requestJson(
          `/api/inventory-planning/admin/promise-safety-policies/drafts/${head.draftPolicy.policyId}`,
          promiseSafetyPolicyDraftAdminResultSchema,
          jsonRequest("PUT", request),
        );
      }
      const request = createPromiseSafetyPolicyDraftAdminRequestSchema.parse({
        scope,
        value: parsedPolicy.value,
        changeReason,
        idempotencyKey,
      });
      return requestJson(
        "/api/inventory-planning/admin/promise-safety-policies/drafts",
        promiseSafetyPolicyDraftAdminResultSchema,
        jsonRequest("POST", request),
      );
    },
    onSuccess: async (result) => {
      policyIdempotencyKey.current = null;
      setChangeReason("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/promise-safety", productId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/supply-transformations/shadow-runs/latest", productId],
        }),
      ]);
      toast({
        title: head?.draftPolicy ? "Safety draft updated" : "Safety draft created",
        description: `Draft v${result.version} was recorded. Runtime ATP is unchanged.`,
      });
    },
    onError: (error: Error) => toast({
      title: "Safety draft was not saved",
      description: error.message,
      variant: "destructive",
    }),
  });

  const refreshEvidence = useMutation({
    mutationFn: async () => {
      const idempotencyKey = refreshIdempotencyKey.current ?? crypto.randomUUID();
      refreshIdempotencyKey.current = idempotencyKey;
      const request = refreshDemandEvidenceAdminRequestSchema.parse({
        changeReason: refreshReason,
        idempotencyKey,
      });
      return requestJson(
        `/api/inventory-planning/admin/promise-safety/${productId}/demand-evidence/refresh`,
        refreshDemandEvidenceAdminResultSchema,
        jsonRequest("POST", request),
      );
    },
    onSuccess: async (result) => {
      refreshIdempotencyKey.current = null;
      setRefreshReason("");
      await queryClient.invalidateQueries({
        queryKey: ["/api/inventory-planning/admin/promise-safety", productId],
      });
      toast({
        title: "Demand evidence refreshed",
        description: `${result.trustedSnapshots} trusted and ${result.untrustedSnapshots} untrusted warehouse/SKU snapshots.`,
      });
    },
    onError: (error: Error) => toast({
      title: "Demand evidence was not refreshed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const updateForm = (patch: Partial<PromiseSafetyPolicyForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    policyIdempotencyKey.current = null;
  };

  if (viewQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading promise safety…</div>;
  }
  if (viewQuery.error || !view) {
    return (
      <div className="text-sm text-destructive">
        {(viewQuery.error as Error | null)?.message ?? "Promise-safety data is unavailable."}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Promise safety floor</CardTitle>
        <p className="text-sm text-muted-foreground">
          Protect inventory before channel dials are applied. The most specific policy wins:
          warehouse/SKU, then SKU, then the business default. Values saved here are drafts used by
          shadow planning only.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="safety-scope-type">Policy scope</Label>
              <select
                id="safety-scope-type"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={scopeType}
                onChange={(event) => setScopeType(event.target.value as ScopeType)}
              >
                <option value="business">Business default</option>
                <option value="network_variant">SKU override</option>
                <option value="warehouse_variant">Warehouse / SKU override</option>
              </select>
            </div>
            {scopeType !== "business" && (
              <div className="space-y-2">
                <Label htmlFor="safety-variant">SKU</Label>
                <select
                  id="safety-variant"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={variantId ?? ""}
                  onChange={(event) => setVariantId(event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">Choose a SKU</option>
                  {view.variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.sku ?? variant.name}{variant.isActive ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {scopeType === "warehouse_variant" && (
              <div className="space-y-2">
                <Label htmlFor="safety-warehouse">Warehouse</Label>
                <select
                  id="safety-warehouse"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={warehouseId ?? ""}
                  onChange={(event) => setWarehouseId(event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">Choose a warehouse</option>
                  {view.warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} — {warehouse.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="safety-policy-mode">Safety method</Label>
              <select
                id="safety-policy-mode"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={form.policyMode}
                onChange={(event) => updateForm({
                  policyMode: event.target.value as PromiseSafetyPolicyForm["policyMode"],
                })}
                disabled={!canEdit}
              >
                {scopeType !== "business" && <option value="inherit">Inherit broader policy</option>}
                <option value="off">Off for this scope</option>
                <option value="fixed_units">Fixed units</option>
                <option value="days_of_cover">Days of cover</option>
              </select>
            </div>
            {form.policyMode === "fixed_units" && (
              <div className="space-y-2">
                <Label htmlFor="safety-fixed-units">Safety units</Label>
                <Input
                  id="safety-fixed-units"
                  inputMode="numeric"
                  value={form.fixedUnits}
                  onChange={(event) => updateForm({ fixedUnits: event.target.value })}
                  disabled={!canEdit}
                />
              </div>
            )}
            {form.policyMode === "days_of_cover" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="safety-days">Days of cover</Label>
                  <Input
                    id="safety-days"
                    inputMode="decimal"
                    value={form.daysOfCover}
                    onChange={(event) => updateForm({ daysOfCover: event.target.value })}
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="safety-fallback-units">Fallback units when demand is untrusted</Label>
                  <Input
                    id="safety-fallback-units"
                    inputMode="numeric"
                    value={form.untrustedDemandFallbackUnits}
                    onChange={(event) => updateForm({
                      untrustedDemandFallbackUnits: event.target.value,
                    })}
                    disabled={!canEdit}
                  />
                </div>
              </>
            )}
          </div>
          {form.policyMode === "days_of_cover" && (
            <div className="text-xs text-muted-foreground">
              Trusted demand uses the calculated days-of-cover floor. Untrusted, stale, or missing
              demand uses the fixed fallback instead; the two values are never added or compared
              with a max function.
            </div>
          )}

          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={head?.draftPolicy ? "default" : "outline"}>
                {head?.draftPolicy ? `draft v${head.draftPolicy.version}` : "no draft"}
              </Badge>
              <span>{head?.draftPolicy
                ? formatPromiseSafetyPolicy(head.draftPolicy.value)
                : head?.activePolicy
                  ? `Active: ${formatPromiseSafetyPolicy(head.activePolicy.value)}`
                  : "No policy exists at this scope."}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Scope {scopeKey ?? "incomplete"} · head revision {head?.revision ?? "not created"}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="safety-change-reason">Change reason</Label>
            <Textarea
              id="safety-change-reason"
              value={changeReason}
              onChange={(event) => {
                setChangeReason(event.target.value);
                policyIdempotencyKey.current = null;
              }}
              placeholder="Why this safety floor is correct"
              disabled={!canEdit}
            />
          </div>
          {parsedPolicy && !parsedPolicy.success && (
            <div className="text-sm text-destructive">{parsedPolicy.message}</div>
          )}
          <Button
            type="button"
            disabled={!canEdit || !scope || !parsedPolicy?.success || !changeReason.trim() || savePolicy.isPending}
            onClick={() => savePolicy.mutate()}
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            {savePolicy.isPending ? "Saving draft…" : head?.draftPolicy ? "Update safety draft" : "Create safety draft"}
          </Button>
        </section>

        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="font-semibold">Demand evidence</h3>
            <p className="text-sm text-muted-foreground">
              The system classifies evidence; this is not an operator toggle. It uses the last
              {` ${view.demandMethod.observationDays} complete UTC days`} of irreversible outbound
              consumption and requires {view.demandMethod.minimumSourceEvents} source events,
              {` ${view.demandMethod.minimumObservedDays} complete observed days, ${view.demandMethod.minimumActiveDays} active days, ${view.demandMethod.minimumConsumptionUnits} units, `}
              and consumption within {view.demandMethod.recencyDays} days. Evidence older than
              {` ${view.demandMethod.maximumEvidenceAgeHours} hours`} falls back to configured units.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="demand-refresh-reason">Refresh reason</Label>
            <Textarea
              id="demand-refresh-reason"
              value={refreshReason}
              onChange={(event) => {
                setRefreshReason(event.target.value);
                refreshIdempotencyKey.current = null;
              }}
              placeholder="Why demand evidence is being recalculated"
              disabled={!canEdit}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!canEdit || !refreshReason.trim() || refreshEvidence.isPending}
            onClick={() => refreshEvidence.mutate()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {refreshEvidence.isPending ? "Refreshing evidence…" : "Refresh demand evidence"}
          </Button>

          <DemandEvidenceTable view={view} />
        </section>

        <section className="space-y-2 border-t pt-5">
          <h3 className="font-semibold">Recorded policy hierarchy</h3>
          {view.policyHeads.length === 0 ? (
            <div className="text-sm text-muted-foreground">No safety policies have been recorded.</div>
          ) : (
            <div className="space-y-2">
              {view.policyHeads.map((policyHead) => (
                <div key={policyHead.scopeKey} className="rounded-md border p-3 text-sm">
                  <div className="font-medium">{policyScopeLabel(policyHead, view)}</div>
                  <div className="text-xs text-muted-foreground">{policyHead.scopeKey}</div>
                  <div className="text-muted-foreground">
                    Active: {policyHead.activePolicy
                      ? formatPromiseSafetyPolicy(policyHead.activePolicy.value)
                      : "none"}
                  </div>
                  <div className="text-muted-foreground">
                    Draft: {policyHead.draftPolicy
                      ? formatPromiseSafetyPolicy(policyHead.draftPolicy.value)
                      : "none"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {!canEdit && (
          <div className="text-sm text-muted-foreground">
            You have view access only. The inventory planning edit ability is required to change
            safety drafts or refresh evidence.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function policyScopeLabel(
  head: PromiseSafetyAdminView["policyHeads"][number],
  view: PromiseSafetyAdminView,
): string {
  const scope = head.draftPolicy?.scope ?? head.activePolicy?.scope;
  if (!scope || scope.scopeType === "business") return "Business default";
  const variant = view.variants.find((item) => item.id === scope.productVariantId);
  const variantLabel = variant?.sku ?? variant?.name ?? `Variant ${scope.productVariantId}`;
  if (scope.scopeType === "network_variant") return `SKU override · ${variantLabel}`;
  const warehouse = view.warehouses.find((item) => item.id === scope.warehouseId);
  return `Warehouse / SKU override · ${warehouse?.code ?? `Warehouse ${scope.warehouseId}`} · ${variantLabel}`;
}

function DemandEvidenceTable({ view }: { view: PromiseSafetyAdminView }) {
  const evidenceByScope = new Map(view.demandEvidence.map((evidence) => [
    `${evidence.productVariantId}:${evidence.warehouseId}`,
    evidence,
  ]));
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SKU</TableHead>
            <TableHead>Warehouse</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">{view.demandMethod.observationDays}-day units</TableHead>
            <TableHead className="text-right">Daily demand</TableHead>
            <TableHead>Evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.variants.flatMap((variant) => view.warehouses.map((warehouse) => {
            const evidence = evidenceByScope.get(`${variant.id}:${warehouse.id}`);
            return (
              <TableRow key={`${variant.id}:${warehouse.id}`}>
                <TableCell>
                  <div className="font-medium">{variant.sku ?? variant.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {variant.unitsPerVariant} base unit{variant.unitsPerVariant === 1 ? "" : "s"}
                  </div>
                </TableCell>
                <TableCell>
                  <div>{warehouse.code}</div>
                  <div className="text-xs text-muted-foreground">{warehouse.inventorySourceType}</div>
                </TableCell>
                <TableCell>
                  {evidence ? (
                    <Badge variant={evidence.trustStatus === "untrusted" ? "destructive" : "default"}>
                      {evidence.trustStatus}
                    </Badge>
                  ) : <Badge variant="outline">not calculated</Badge>}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {evidence ? BigInt(evidence.irreversibleConsumptionUnits).toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {evidence ? formatMilliUnits(evidence.dailyDemandMilliUnits) : "—"}
                </TableCell>
                <TableCell className="max-w-[360px] text-xs text-muted-foreground">
                  {evidence
                    ? evidence.trustReasons.length > 0
                      ? `${evidence.observedDays} observed days · ${evidence.trustReasons.join(", ")}`
                      : `${evidence.observedDays} observed days · calculated ${new Date(evidence.calculatedAt).toLocaleString()}`
                    : "Refresh evidence to calculate this warehouse/SKU."}
                </TableCell>
              </TableRow>
            );
          }))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatMilliUnits(value: string): string {
  const milliUnits = BigInt(value);
  const whole = milliUnits / BigInt(1_000);
  const fraction = (milliUnits % BigInt(1_000)).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString();
}

function jsonRequest(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function requestJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(serverErrorMessage(body) ?? `Request failed (${response.status}).`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Server returned invalid data at ${issue?.path.join(".") || "response"}: ${issue?.message ?? "invalid response"}.`,
    );
  }
  return parsed.data;
}

function serverErrorMessage(body: unknown): string | null {
  const parsed = z.object({
    error: z.union([
      z.string(),
      z.object({ message: z.string().optional() }).passthrough(),
    ]),
  }).passthrough().safeParse(body);
  if (!parsed.success) return null;
  return typeof parsed.data.error === "string"
    ? parsed.data.error
    : parsed.data.error.message ?? null;
}

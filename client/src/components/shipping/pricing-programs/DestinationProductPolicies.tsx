import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Calculator,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useToast } from "@/hooks/use-toast";
import {
  GRAMS_PER_POUND,
  groupDisplayName,
  newId,
  usdFromCents,
  type RateGroup,
} from "../rate-table-model";
import {
  deleteJson,
  getJson,
  invalidateShippingAdmin,
  postJson,
  productPolicyRulesKey,
  putJson,
  type ProductPolicyRule,
  type ProductPolicyRulesResponse,
  type ProductPolicySelectorsResponse,
  type WarehouseOption,
} from "./api";

export type DestinationPolicyView = "exceptions" | "restrictions" | "test";

interface DestinationProductPoliciesProps {
  view: DestinationPolicyView;
  draftId: number | null;
  group: RateGroup;
  groupIndex: number;
  warehouses: WarehouseOption[];
  onSaveDraft: () => void;
  savingDraft: boolean;
}

export function DestinationProductPolicies({
  view,
  draftId,
  group,
  groupIndex,
  warehouses,
  onSaveDraft,
  savingDraft,
}: DestinationProductPoliciesProps) {
  if (draftId === null) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <p className="text-sm font-medium">Save the destination rates first</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Product rules belong to a specific rate-table revision. Saving creates that revision without affecting live checkout.
        </p>
        <Button className="mt-4" onClick={onSaveDraft} disabled={savingDraft}>
          {savingDraft && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save draft
        </Button>
      </div>
    );
  }
  if (view === "test") {
    return <PolicyPreview draftId={draftId} group={group} warehouses={warehouses} />;
  }
  return (
    <PolicyRuleList
      draftId={draftId}
      group={group}
      groupIndex={groupIndex}
      kind={view === "restrictions" ? "restriction" : "exception"}
    />
  );
}

function PolicyRuleList({
  draftId,
  group,
  groupIndex,
  kind,
}: {
  draftId: number;
  group: RateGroup;
  groupIndex: number;
  kind: "restriction" | "exception";
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ProductPolicyRule | "new" | null>(null);
  const queryKey = productPolicyRulesKey(draftId);
  const query = useQuery({
    queryKey: [queryKey],
    queryFn: () => getJson<ProductPolicyRulesResponse>(queryKey),
  });
  const rules = (query.data?.rules ?? []).filter((rule) =>
    sameScope(rule.destinationScope, group)
    && (kind === "restriction" ? rule.kind === "restriction" : rule.kind !== "restriction"));
  const deleteMutation = useMutation({
    mutationFn: (ruleId: number) => deleteJson(`${queryKey}/${ruleId}`),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      toast({ title: "Shipping rule removed" });
    },
    onError: (error: Error) => toast({
      title: "Could not remove the rule",
      description: error.message,
      variant: "destructive",
    }),
  });

  if (query.isLoading) {
    return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading rules...</div>;
  }
  if (query.isError) {
    return <p className="py-6 text-sm text-destructive">{query.error.message}</p>;
  }

  const title = kind === "restriction" ? "Shipping restrictions" : "Product pricing exceptions";
  const empty = kind === "restriction"
    ? "No products are blocked for this destination group."
    : "All products use this destination group's default pricing.";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">
            {kind === "restriction"
              ? "Blocked products suppress this shipping option before checkout can offer it."
              : "A variant can use only one base-price exception in the same destination."}
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add {kind === "restriction" ? "restriction" : "exception"}
        </Button>
      </div>

      {query.data?.validationErrors.length ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {query.data.validationErrors.map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}

      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{empty}</div>
      ) : (
        <div className="divide-y rounded-md border">
          {rules.map((rule) => (
            <div key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{rule.name}</span>
                  <Badge variant={rule.kind === "restriction" ? "destructive" : "outline"}>
                    {ruleActionLabel(rule)}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rule.productSetName ?? `${rule.memberVariantIds.length} selected variants`}
                  {" · "}{rule.memberVariantIds.length} variant{rule.memberVariantIds.length === 1 ? "" : "s"} frozen in this revision
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => setEditing(rule)} aria-label={`Edit ${rule.name}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                  onClick={() => deleteMutation.mutate(rule.id)}
                  aria-label={`Delete ${rule.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <RuleDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        draftId={draftId}
        group={group}
        groupName={groupDisplayName(group, groupIndex)}
        ruleKind={kind}
        editingRule={editing === "new" ? null : editing}
      />
    </div>
  );
}

type SelectorKind = "shipping_group" | "product_line" | "category" | "sioc" | "saved_set" | "manual";
type Behavior = "free" | "fixed" | "fixed_band" | "base_plus_per_started_pound" | "surcharge" | "free_threshold";

function RuleDialog({
  open,
  onOpenChange,
  draftId,
  group,
  groupName,
  ruleKind,
  editingRule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftId: number;
  group: RateGroup;
  groupName: string;
  ruleKind: "restriction" | "exception";
  editingRule: ProductPolicyRule | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [selectorKind, setSelectorKind] = useState<SelectorKind>("shipping_group");
  const [selectorRef, setSelectorRef] = useState("");
  const [selectedVariantIds, setSelectedVariantIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [behavior, setBehavior] = useState<Behavior>("fixed");
  const [measurementScope, setMeasurementScope] = useState<"matched_items" | "each_item">("matched_items");
  const [rateUsd, setRateUsd] = useState("");
  const [perPoundUsd, setPerPoundUsd] = useState("");
  const [thresholdUsd, setThresholdUsd] = useState("");
  const [bands, setBands] = useState<Array<{ maxLb: string; rateUsd: string; openEnded: boolean }>>([
    { maxLb: "1", rateUsd: "", openEnded: false },
    { maxLb: "5", rateUsd: "", openEnded: false },
    { maxLb: "", rateUsd: "", openEnded: true },
  ]);
  const [formError, setFormError] = useState<string | null>(null);
  const selectorsUrl = `/api/shipping/admin/product-policy-selectors?search=${encodeURIComponent(search.trim())}`;
  const selectors = useQuery({
    queryKey: [selectorsUrl],
    queryFn: () => getJson<ProductPolicySelectorsResponse>(selectorsUrl),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setName(editingRule?.name ?? "");
    setSelectorKind(editingRule?.sourceProductSetId ? "saved_set" : "shipping_group");
    setSelectorRef(editingRule?.sourceProductSetId ? String(editingRule.sourceProductSetId) : "");
    setSelectedVariantIds([]);
    setSearch("");
    setBehavior(editingRule?.action === "block" ? "fixed" : (editingRule?.action ?? "fixed") as Behavior);
    setMeasurementScope(editingRule?.measurementScope === "each_item" ? "each_item" : "matched_items");
    setRateUsd(editingRule?.rateCents == null ? "" : centsToInput(editingRule.rateCents));
    setPerPoundUsd(editingRule?.perStartedPoundCents == null ? "" : centsToInput(editingRule.perStartedPoundCents));
    setThresholdUsd(editingRule?.thresholdCents == null ? "" : centsToInput(editingRule.thresholdCents));
    setBands(editingRule?.bands.length
      ? editingRule.bands.map((band) => ({
          maxLb: band.maxMeasure === null ? "" : String(Number((band.maxMeasure / GRAMS_PER_POUND).toFixed(3))),
          rateUsd: centsToInput(band.rateCents),
          openEnded: band.maxMeasure === null,
        }))
      : [
          { maxLb: "1", rateUsd: "", openEnded: false },
          { maxLb: "5", rateUsd: "", openEnded: false },
          { maxLb: "", rateUsd: "", openEnded: true },
        ]);
    setFormError(null);
  }, [editingRule, open]);

  const saveMutation = useMutation({
    mutationFn: (payload: unknown) => editingRule
      ? putJson(`${productPolicyRulesKey(draftId)}/${editingRule.id}`, payload)
      : postJson(productPolicyRulesKey(draftId), payload),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      onOpenChange(false);
      toast({ title: editingRule ? "Shipping rule updated" : "Shipping rule added" });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const selectorOptions = useMemo(() => {
    const data = selectors.data;
    if (!data) return [];
    if (selectorKind === "shipping_group") return data.shippingGroups.map((item) => ({ value: item.code, label: item.name }));
    if (selectorKind === "product_line") return data.productLines.map((item) => ({ value: item.code, label: item.name }));
    if (selectorKind === "category") return data.categories.map((item) => ({ value: String(item.id), label: item.name }));
    if (selectorKind === "saved_set") return data.productSets.map((item) => ({ value: String(item.id), label: `${item.name} (${item.memberCount})` }));
    if (selectorKind === "sioc") return [{ value: "true", label: "All confirmed SIOC variants" }];
    return [];
  }, [selectorKind, selectors.data]);

  const submit = () => {
    if (name.trim() === "") return setFormError("Enter a rule name.");
    const selector = selectorKind === "manual"
      ? { kind: "manual" as const, variantIds: selectedVariantIds }
      : selectorKind === "saved_set"
        ? { kind: "saved_set" as const, productSetId: Number(selectorRef) }
        : { kind: selectorKind, ref: selectorRef };
    if ((selectorKind === "manual" && selectedVariantIds.length === 0) || (selectorKind !== "manual" && selectorRef === "")) {
      return setFormError("Select the products this rule applies to.");
    }
    const parsedRate = parseUsd(rateUsd);
    const parsedPerPound = parseUsd(perPoundUsd);
    const parsedThreshold = parseUsd(thresholdUsd);
    const emittedBands = behavior === "fixed_band" ? emitBands(bands) : [];
    if ((behavior === "fixed" || behavior === "surcharge") && parsedRate === null) return setFormError("Enter a valid shipping amount.");
    if (behavior === "base_plus_per_started_pound" && (parsedRate === null || parsedPerPound === null)) return setFormError("Enter valid base and per-pound amounts.");
    if (behavior === "free_threshold" && parsedThreshold === null) return setFormError("Enter a valid free-shipping threshold.");
    if (behavior === "fixed_band" && emittedBands === null) return setFormError("Complete gapless weight bands with an open-ended final row.");

    const action = ruleKind === "restriction" ? "block" : behavior;
    const kind = ruleKind === "restriction"
      ? "restriction"
      : behavior === "surcharge"
        ? "adjustment"
        : behavior === "free_threshold"
          ? "threshold"
          : "base_charge";
    setFormError(null);
    saveMutation.mutate({
      name: name.trim(),
      kind,
      action,
      measurementScope: ruleKind === "restriction" ? "matched_items" : measurementScope,
      destinationScope: scopeFromGroup(group),
      selector,
      rateCents: behavior === "fixed" || behavior === "surcharge" || behavior === "base_plus_per_started_pound" ? parsedRate : null,
      perStartedPoundCents: behavior === "base_plus_per_started_pound" ? parsedPerPound : null,
      thresholdCents: behavior === "free_threshold" ? parsedThreshold : null,
      bands: emittedBands ?? [],
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingRule ? "Edit" : "Add"} {ruleKind === "restriction" ? "shipping restriction" : "product exception"}</DialogTitle>
          <DialogDescription>Applies to {groupName}. Variant membership is frozen when saved.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="policy-name">Rule name</Label>
            <Input id="policy-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Storage box case pricing" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Choose products by</Label>
              <Select value={selectorKind} onValueChange={(value: SelectorKind) => { setSelectorKind(value); setSelectorRef(value === "sioc" ? "true" : ""); setSelectedVariantIds([]); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="shipping_group">Shipping group</SelectItem>
                  <SelectItem value="product_line">Product line</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="saved_set">Saved product set</SelectItem>
                  <SelectItem value="sioc">Confirmed SIOC</SelectItem>
                  <SelectItem value="manual">Exact variants</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {selectorKind !== "manual" && (
              <div className="space-y-1.5">
                <Label>Selection</Label>
                <Select value={selectorRef} onValueChange={setSelectorRef}>
                  <SelectTrigger><SelectValue placeholder="Choose one" /></SelectTrigger>
                  <SelectContent>{selectorOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
          </div>
          {selectorKind === "manual" && (
            <div className="space-y-2">
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SKU or product" />
              <div className="max-h-52 divide-y overflow-y-auto rounded-md border">
                {(selectors.data?.variants ?? []).map((variant) => (
                  <label key={variant.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                    <Checkbox checked={selectedVariantIds.includes(variant.id)} onCheckedChange={(checked) => setSelectedVariantIds((current) => checked ? [...current, variant.id] : current.filter((id) => id !== variant.id))} />
                    <span className="min-w-0"><span className="font-medium">{variant.sku ?? `Variant ${variant.id}`}</span><span className="ml-2 text-muted-foreground">{variant.productName} · {variant.name}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {ruleKind === "exception" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Behavior</Label>
                  <Select value={behavior} onValueChange={(value: Behavior) => setBehavior(value)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="free">Ship free</SelectItem>
                      <SelectItem value="fixed">Fixed charge</SelectItem>
                      <SelectItem value="fixed_band">Weight bands</SelectItem>
                      <SelectItem value="base_plus_per_started_pound">Base + per started lb</SelectItem>
                      <SelectItem value="surcharge">Add surcharge</SelectItem>
                      <SelectItem value="free_threshold">Free over item subtotal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {behavior !== "free" && behavior !== "free_threshold" && (
                  <div className="space-y-1.5">
                    <Label>Measure</Label>
                    <Select value={measurementScope} onValueChange={(value: "matched_items" | "each_item") => setMeasurementScope(value)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="matched_items">Matching items combined</SelectItem>
                        <SelectItem value="each_item">Each matching item</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {(behavior === "fixed" || behavior === "surcharge" || behavior === "base_plus_per_started_pound") && <MoneyInput label={behavior === "base_plus_per_started_pound" ? "Base charge" : "Amount"} value={rateUsd} onChange={setRateUsd} />}
              {behavior === "base_plus_per_started_pound" && <MoneyInput label="Per started lb" value={perPoundUsd} onChange={setPerPoundUsd} />}
              {behavior === "free_threshold" && <MoneyInput label="Matching-item subtotal threshold" value={thresholdUsd} onChange={setThresholdUsd} />}
              {behavior === "fixed_band" && (
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium text-muted-foreground"><span>Up to lb</span><span>Charge</span><span className="w-9" /></div>
                  {bands.map((band, index) => (
                    <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                      <Input disabled={band.openEnded} value={band.openEnded ? "No maximum" : band.maxLb} onChange={(event) => setBands((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, maxLb: event.target.value } : item))} />
                      <Input value={band.rateUsd} inputMode="decimal" placeholder="0.00" onChange={(event) => setBands((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, rateUsd: event.target.value } : item))} />
                      <Button variant="ghost" size="icon" disabled={band.openEnded || bands.length <= 1} onClick={() => setBands((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => setBands((current) => [...current.slice(0, -1), { maxLb: "", rateUsd: "", openEnded: false }, current[current.length - 1]])}><Plus className="mr-1.5 h-3.5 w-3.5" />Add band</Button>
                </div>
              )}
            </>
          )}
          {ruleKind === "restriction" && <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><Ban className="mt-0.5 h-4 w-4 shrink-0" />If any selected variant is in the cart, this shipping option will not be returned for this destination.</div>}
          {formError && <p className="text-sm text-destructive">{formError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saveMutation.isPending}>{saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save rule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PreviewLineDraft {
  id: string;
  variantId: string;
  quantity: string;
  priceUsd: string;
}

function newPreviewLine(): PreviewLineDraft {
  return { id: newId(), variantId: "", quantity: "1", priceUsd: "0.00" };
}

function PolicyPreview({ draftId, group, warehouses }: { draftId: number; group: RateGroup; warehouses: WarehouseOption[] }) {
  const availableRegions = useMemo(
    () => [...new Set([...group.regions, ...group.zipEntries.map((entry) => entry.state)])],
    [group.regions, group.zipEntries],
  );
  const [warehouseId, setWarehouseId] = useState(group.originWarehouseId ? String(group.originWarehouseId) : String(warehouses[0]?.id ?? ""));
  const [region, setRegion] = useState(availableRegions[0] ?? "");
  const [postalCode, setPostalCode] = useState("");
  const [lines, setLines] = useState<PreviewLineDraft[]>([newPreviewLine()]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!availableRegions.includes(region)) setRegion(availableRegions[0] ?? "");
  }, [availableRegions, region]);
  const selectorsUrl = `/api/shipping/admin/product-policy-selectors?search=${encodeURIComponent(search.trim())}`;
  const selectors = useQuery({ queryKey: [selectorsUrl], queryFn: () => getJson<ProductPolicySelectorsResponse>(selectorsUrl) });
  const preview = useMutation({
    mutationFn: (payload: unknown) => postJson<ProductPolicyPreviewResponse>(`${productPolicyRulesKey(draftId)}/preview`, payload),
    onError: (cause: Error) => setError(cause.message),
    onSuccess: () => setError(null),
  });
  const run = () => {
    const parsedWarehouse = Number(warehouseId);
    if (!Number.isSafeInteger(parsedWarehouse) || parsedWarehouse <= 0) return setError("Choose an origin warehouse.");
    if (!availableRegions.includes(region)) return setError("Choose a state in this destination group.");
    if (!/^\d{5}$/.test(postalCode)) return setError("Enter a five-digit ZIP code.");
    const parsedLines = lines.map((line, index) => ({
      index,
      productVariantId: Number(line.variantId),
      quantity: Number(line.quantity),
      unitPriceCents: parseUsd(line.priceUsd),
    }));
    const invalidVariant = parsedLines.find((line) => !Number.isSafeInteger(line.productVariantId) || line.productVariantId <= 0);
    if (invalidVariant) return setError(`Choose a catalog variant for item ${invalidVariant.index + 1}.`);
    const invalidQuantity = parsedLines.find((line) => !Number.isSafeInteger(line.quantity) || line.quantity <= 0);
    if (invalidQuantity) return setError(`Item ${invalidQuantity.index + 1} needs a positive whole-number quantity.`);
    const invalidPrice = parsedLines.find((line) => line.unitPriceCents === null);
    if (invalidPrice) return setError(`Item ${invalidPrice.index + 1} needs a valid unit price.`);
    if (new Set(parsedLines.map((line) => line.productVariantId)).size !== parsedLines.length) {
      return setError("Combine duplicate variants into one test-cart line.");
    }
    preview.mutate({
      originWarehouseId: parsedWarehouse,
      destination: { country: "US", region, postalCode },
      lines: parsedLines.map((line) => ({
        productVariantId: line.productVariantId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
      })),
    });
  };
  const result = preview.data;
  return (
    <div className="space-y-4">
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold"><Calculator className="h-4 w-4" />Test this draft</h4>
        <p className="text-xs text-muted-foreground">Uses this unpublished revision, catalog weight, destination default, and product rules. It does not affect checkout.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select value={warehouseId} onValueChange={setWarehouseId}><SelectTrigger><SelectValue placeholder="Warehouse" /></SelectTrigger><SelectContent>{warehouses.map((warehouse) => <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.name}</SelectItem>)}</SelectContent></Select>
        <Select value={region} onValueChange={setRegion}><SelectTrigger><SelectValue placeholder="State" /></SelectTrigger><SelectContent>{availableRegions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
        <Input value={postalCode} onChange={(event) => setPostalCode(event.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="ZIP code" />
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-64 flex-1 space-y-1.5"><Label>Find catalog variants</Label><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SKU or product" /></div>
          <Button variant="outline" size="sm" onClick={() => setLines((current) => [...current, newPreviewLine()])}><Plus className="mr-1.5 h-3.5 w-3.5" />Add item</Button>
        </div>
        <div className="space-y-2 rounded-md border p-2">
          {lines.map((line, index) => (
            <div key={line.id} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_90px_120px_36px]">
              <div className="space-y-1"><Label className="text-xs">Item {index + 1}</Label><Select value={line.variantId} onValueChange={(value) => setLines((current) => current.map((item) => item.id === line.id ? { ...item, variantId: value } : item))}><SelectTrigger><SelectValue placeholder="Choose a variant" /></SelectTrigger><SelectContent>{(selectors.data?.variants ?? []).map((variant) => <SelectItem key={variant.id} value={String(variant.id)}>{variant.sku ?? variant.id} / {variant.productName}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1"><Label className="text-xs">Quantity</Label><Input value={line.quantity} inputMode="numeric" onChange={(event) => setLines((current) => current.map((item) => item.id === line.id ? { ...item, quantity: event.target.value } : item))} /></div>
              <div className="space-y-1"><Label className="text-xs">Unit price</Label><Input value={line.priceUsd} inputMode="decimal" onChange={(event) => setLines((current) => current.map((item) => item.id === line.id ? { ...item, priceUsd: event.target.value } : item))} /></div>
              <Button className="mt-5" variant="ghost" size="icon" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} aria-label={`Remove item ${index + 1}`}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4" />{error}</p>}
      {result && (
        <div className="rounded-md border p-3">
          {result.ok ? <><div className="flex justify-between text-sm"><span>Whole cart before product rules</span><span>{usdFromCents(result.defaultTotalCents)}</span></div>{result.trace.map((step, index) => <div key={`${step.ruleId}-${index}`} className="mt-1 flex justify-between text-sm"><span>{step.label}<span className="ml-1 text-xs text-muted-foreground">{step.skus.join(", ")}</span></span><span>{usdFromCents(step.amountCents)}</span></div>)}<div className="mt-2 flex justify-between border-t pt-2 font-semibold"><span>Quoted shipping</span><span>{usdFromCents(result.totalCents)}</span></div></> : <p className="text-sm text-destructive">{result.message}</p>}
        </div>
      )}
      <Button onClick={run} disabled={preview.isPending}>{preview.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Run draft test</Button>
    </div>
  );
}

type ProductPolicyPreviewResponse =
  | {
      ok: true;
      currency: string;
      defaultTotalCents: number;
      totalCents: number;
      trace: Array<{
        kind: "restriction" | "base_charge" | "threshold" | "adjustment" | "default";
        ruleId: number | null;
        label: string;
        amountCents: number;
        skus: string[];
      }>;
    }
  | {
      ok: false;
      code: string;
      message: string;
      ruleId?: number | null;
      trace?: unknown[];
    };

function MoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="max-w-xs space-y-1.5"><Label>{label}</Label><div className="relative"><span className="absolute inset-y-0 left-3 flex items-center text-muted-foreground">$</span><Input className="pl-7" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="0.00" /></div></div>;
}

function scopeFromGroup(group: RateGroup) {
  return {
    country: "US",
    regions: [...group.regions],
    postalPrefixes: group.zipEntries.map((entry) => ({ region: entry.state, prefixes: [...entry.prefixes] })),
  };
}

function sameScope(scope: ProductPolicyRule["destinationScope"], group: RateGroup): boolean {
  return JSON.stringify(normalizeScope(scope)) === JSON.stringify(normalizeScope(scopeFromGroup(group)));
}

function normalizeScope(scope: ProductPolicyRule["destinationScope"]) {
  return {
    country: scope.country.toUpperCase(),
    regions: [...scope.regions].sort(),
    postalPrefixes: [...scope.postalPrefixes]
      .map((entry) => ({ region: entry.region, prefixes: [...entry.prefixes].sort() }))
      .sort((left, right) => left.region.localeCompare(right.region)),
  };
}

function ruleActionLabel(rule: ProductPolicyRule): string {
  if (rule.action === "block") return "Blocked";
  if (rule.action === "free") return "Free";
  if (rule.action === "fixed") return `${usdFromCents(rule.rateCents ?? 0)} fixed`;
  if (rule.action === "fixed_band") return `${rule.bands.length} weight bands`;
  if (rule.action === "base_plus_per_started_pound") return `${usdFromCents(rule.rateCents ?? 0)} + ${usdFromCents(rule.perStartedPoundCents ?? 0)}/lb`;
  if (rule.action === "surcharge") return `${usdFromCents(rule.rateCents ?? 0)} surcharge`;
  return `Free over ${usdFromCents(rule.thresholdCents ?? 0)}`;
}

function parseUsd(value: string): number | null {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function emitBands(bands: Array<{ maxLb: string; rateUsd: string; openEnded: boolean }>) {
  let minimum = 0;
  const emitted: Array<{ minMeasure: number; maxMeasure: number | null; rateCents: number }> = [];
  for (const [index, band] of bands.entries()) {
    const rateCents = parseUsd(band.rateUsd);
    if (rateCents === null) return null;
    if (band.openEnded) {
      if (index !== bands.length - 1) return null;
      emitted.push({ minMeasure: minimum, maxMeasure: null, rateCents });
      continue;
    }
    const maxLb = Number(band.maxLb);
    if (!Number.isFinite(maxLb) || maxLb <= 0) return null;
    const maximum = Math.round(maxLb * GRAMS_PER_POUND);
    if (maximum < minimum) return null;
    emitted.push({ minMeasure: minimum, maxMeasure: maximum, rateCents });
    minimum = maximum + 1;
  }
  return emitted;
}

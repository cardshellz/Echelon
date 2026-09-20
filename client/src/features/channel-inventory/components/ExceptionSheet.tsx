import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChannelExposurePolicyScope } from "@shared/types/inventory-channel-exposure";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";

import { buildPolicyDraftRequest, savePolicyDraft } from "../api";
import { describePackUnit } from "../format";
import { invalidateChannelInventory } from "../hooks";
import { useDraftEditor } from "../use-draft-editor";
import { useDraftNavigation } from "../DraftNavigation";
import { DraftSaveFeedback } from "./DraftSaveFeedback";
import {
  findPolicyHead,
  policyFormToValue,
  policyValueToForm,
  productLabel,
  resolveSavedFields,
  samePolicyForm,
  savedPolicy,
  sellableVariants,
  type Channel,
  type PolicyFormError,
  type View,
  EMPTY_POLICY_FORM,
  sameIdSet,
} from "../model";
import { NodeChecklist } from "./NodeChecklist";
import { Checkbox } from "@/components/ui/checkbox";
import { PolicyFields } from "./PolicyFields";
import { ProductPicker } from "./ProductPicker";
import { ActivePill, Callout, EvidenceNote, NoteField, PendingPill } from "./primitives";

export interface ExceptionSubject {
  productId: number;
  productVariantId: number | null;
}

/**
 * Editor for one product or SKU rule on a channel. Fields resolve
 * independently (SKU → product → channel default), so each shows the value
 * it would inherit right beside the option to override it.
 */
export function ExceptionSheet({ open, onOpenChange, view, channel, subject, canEdit, focusProductId, onFocusProduct, onReload, reloading }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  view: View;
  channel: Channel;
  /** Null opens the sheet in "new exception" mode. */
  subject: ExceptionSubject | null;
  canEdit: boolean;
  focusProductId: number | null;
  onFocusProduct(productId: number): void;
  onReload(): void;
  reloading: boolean;
}) {
  const [productId, setProductId] = useState<number | null>(subject?.productId ?? null);
  const [variantId, setVariantId] = useState<number | null>(subject?.productVariantId ?? null);
  const navigate = useDraftNavigation();

  // SKU lists live on the focused product; focusing here keeps one product in
  // focus across the Selling rules and Quantities tabs.
  useEffect(() => {
    if (productId !== null && productId !== focusProductId) onFocusProduct(productId);
  }, [productId, focusProductId, onFocusProduct]);

  const product = view.products.find((item) => item.id === productId) ?? null;
  const variants = view.selectedProduct?.id === productId ? sellableVariants(view.selectedProduct.variants) : null;
  const variant = variants?.find((item) => item.id === variantId) ?? null;
  const scope: ChannelExposurePolicyScope | null = productId === null
    ? null
    : variantId === null
      ? { scopeType: "product", channelId: channel.id, productId }
      : { scopeType: "variant", channelId: channel.id, productId, productVariantId: variantId };

  return (
    <Sheet open={open} onOpenChange={next => navigate(() => onOpenChange(next))}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>{subject ? "Exception" : "New exception"} on {channel.name}</SheetTitle>
          <SheetDescription>
            Override only the fields that should differ for this item. Everything else keeps
            following the product rule and the channel default.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 px-6 py-5">
          {!subject && (
            <div className="space-y-2">
              <Label htmlFor="exception-product">Product</Label>
              <ProductPicker
                id="exception-product"
                products={view.products}
                value={productId}
                onChange={(id) => navigate(() => { setProductId(id); setVariantId(null); })}
              />
            </div>
          )}
          {productId !== null && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{product ? productLabel(product) : `Product #${productId}`}</p>
              {subject === null || subject.productVariantId === null ? (
                <ScopeChoice
                  variants={variants}
                  value={variantId}
                  onChange={id => navigate(() => setVariantId(id))}
                  locked={subject !== null}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  SKU rule · {variant ? `${variant.sku ?? variant.name} · ${describePackUnit(variant.unitsPerVariant)}` : "loading SKU…"}
                </p>
              )}
            </div>
          )}
          {scope && (
            <RuleEditor
              key={scopeKey(scope)}
              view={view}
              channel={channel}
              scope={scope}
              unitNoun={variant ? `units (${describePackUnit(variant.unitsPerVariant)})` : "units of the exact SKU"}
              canEdit={canEdit}
              onSaved={() => onOpenChange(false)}
              onReload={onReload}
              reloading={reloading}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function scopeKey(scope: ChannelExposurePolicyScope): string {
  return scope.scopeType === "variant"
    ? `variant:${scope.productVariantId}`
    : scope.scopeType === "product" ? `product:${scope.productId}` : `channel:${scope.channelId}`;
}

function ScopeChoice({ variants, value, onChange, locked }: {
  variants: ReturnType<typeof sellableVariants> | null;
  value: number | null;
  onChange(variantId: number | null): void;
  locked: boolean;
}) {
  if (locked) return <p className="text-xs text-muted-foreground">Whole-product rule</p>;
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">Applies to</Label>
      {variants === null ? (
        <p className="text-xs text-muted-foreground">Loading SKUs…</p>
      ) : (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
          value={value === null ? "product" : String(value)}
          onValueChange={(next) => { if (next) onChange(next === "product" ? null : Number(next)); }}
        >
          <ToggleGroupItem value="product">Whole product</ToggleGroupItem>
          {variants.map((item) => (
            <ToggleGroupItem key={item.id} value={String(item.id)} title={describePackUnit(item.unitsPerVariant)}>
              {item.sku ?? item.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {variants !== null && variants.length === 0 && (
        <p className="text-xs text-muted-foreground">This product has no sellable, tracked SKUs.</p>
      )}
    </div>
  );
}

function RuleEditor({ view, channel, scope, unitNoun, canEdit, onSaved, onReload, reloading }: {
  view: View;
  channel: Channel;
  scope: ChannelExposurePolicyScope;
  unitNoun: string;
  canEdit: boolean;
  onSaved(): void;
  onReload(): void;
  reloading: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const head = findPolicyHead(view.policyHeads, scope);
  const saved = savedPolicy(head);
  const savedForm = useMemo(() => policyValueToForm(saved?.value ?? null), [saved?.value]);
  const inherited = useMemo(() => resolveSavedFields(view.policyHeads, scope), [view.policyHeads, scope]);
  const [errors, setErrors] = useState<PolicyFormError[]>([]);
  const fingerprint = `${head?.revision ?? "0"}:${head?.draftPolicy?.definitionHash ?? ""}:${head?.activePolicy?.definitionHash ?? ""}`;
  const editor = useDraftEditor({
    value: { form: savedForm, note: "", sources: saved?.value.sourceFulfillmentNodeIds ?? null }, baseline: head, fingerprint,
    equal: (left, right) => samePolicyForm(left.form, right.form) && left.note === right.note
      && ((left.sources === null && right.sources === null)
        || (left.sources !== null && right.sources !== null && sameIdSet(left.sources, right.sources))),
    build: (value, baseline, idempotencyKey) => {
      const parsed = policyFormToValue(value.form, { allowInheritAll: true, sourceFulfillmentNodeIds: value.sources });
      if (!parsed.ok) {
        setErrors(parsed.errors);
        throw new Error("Check the highlighted exception fields.");
      }
      setErrors([]);
      return buildPolicyDraftRequest({
        scope,
        value: parsed.value,
        head: baseline,
        note: value.note,
        idempotencyKey,
      });
    },
    send: savePolicyDraft,
    onSaved: async () => {
      await invalidateChannelInventory(queryClient);
      toast({
        title: "Exception saved",
        description: "Pending activation. Quantities on the marketplace are unchanged until it is activated.",
      });
      onSaved();
    },
  });
  const { form, note } = editor.value;
  const formError = errors.find((error) => error.field === "form")?.message ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {head?.activePolicy && <ActivePill>Active rule v{head.activePolicy.version}</ActivePill>}
        {head?.draftPolicy && <PendingPill>Saved draft v{head.draftPolicy.version}, pending activation</PendingPill>}
        {!saved && <span>No rule saved yet for this item on {channel.name}.</span>}
      </div>
      <DraftSaveFeedback {...editor} onReload={() => { editor.reset(); setErrors([]); onReload(); }} reloading={reloading} />
      <PolicyFields
        idPrefix={`exception-${scopeKey(scope)}`}
        form={form}
        onChange={(patch) => editor.setValue(current => ({ ...current, form: { ...current.form, ...patch } }))}
        scopeType={scope.scopeType}
        inherited={inherited}
        errors={errors}
        disabled={!canEdit || editor.locked || reloading}
        unitNoun={unitNoun}
      />
      <fieldset className="space-y-3 rounded-md border p-3" disabled={!canEdit || editor.locked || reloading}>
        <legend className="px-1 text-sm font-medium">Supply warehouses</legend>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={editor.value.sources === null} onCheckedChange={checked => editor.setValue(current => ({
            ...current, sources: checked === true ? null : [],
          }))} />Use inherited warehouses
        </label>
        <p className="text-xs text-muted-foreground">A SKU uses its own selection, otherwise the product selection, otherwise the destination's default warehouses. An override replaces that set; it does not add warehouses.</p>
        {editor.value.sources !== null && <NodeChecklist nodes={view.fulfillmentNodes.filter(node => node.lifecycleStatus !== "retired")}
          selectedIds={editor.value.sources} idPrefix={`exception-supply-${scopeKey(scope)}`}
          disabled={!canEdit || editor.locked || reloading}
          onToggle={(id, checked) => editor.setValue(current => ({ ...current, sources: checked
            ? [...(current.sources ?? []), id] : (current.sources ?? []).filter(existing => existing !== id) }))} />}
      </fieldset>
      {formError && <Callout tone="warning">{formError}</Callout>}
      <EvidenceNote>
        Setting a field back to Inherit follows future changes to the broader rule. Restoring
        all inheritance is saved as a draft and takes effect only after Review and Apply.
      </EvidenceNote>
      {canEdit && saved && <Button type="button" variant="outline" disabled={editor.locked || reloading}
        onClick={() => editor.setValue(current => ({ ...current, form: EMPTY_POLICY_FORM, sources: null }))}>
        Restore all inheritance
      </Button>}
      {canEdit && (
        <SheetFooter className="flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
          <NoteField id={`exception-note-${scopeKey(scope)}`} value={note} onChange={note => editor.setValue(current => ({ ...current, note }))} disabled={editor.locked} />
          <Button type="button" disabled={editor.pending || (!editor.uncertain && (!editor.dirty || editor.conflict || reloading))} onClick={() => void editor.save()}>
            {editor.pending ? "Saving…" : editor.uncertain ? "Retry same save" : "Save exception"}
          </Button>
        </SheetFooter>
      )}
    </div>
  );
}

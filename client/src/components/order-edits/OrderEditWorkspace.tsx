import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ORDER_EDIT_PREVIEW_TTL_MS,
  orderEditPreviewInputSchema,
  type OrderEditPreview,
} from "@shared/order-edits/order-edit-preview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  orderEditQuoteInputSchema,
  type OrderEditOperation,
  type OrderEditOrder,
  type OrderEditQuoteInput,
} from "@shared/order-edits/order-edit.contract";
import type { OrderEditCatalogVariant } from "@shared/order-edits/order-edit-catalog";
import type { OrderEditCodeMessageCatalog } from "@shared/order-edits/order-edit-code-errors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { OrderEditProductPicker } from "@/components/order-edits/OrderEditProductPicker";
import {
  OrderEditItems,
  OrderEditUnitPrice,
} from "@/components/order-edits/OrderEditItems";
import {
  exactOrderEditUnitPrice,
  groupOrderEditDisplayLines,
  orderEditItemSubtotal,
} from "@/lib/order-edit-display";
import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";
import { useOrderEditPreview } from "@/hooks/use-order-edit-preview";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  canConfirmOrderEditPreview,
  orderEditNeedsPreparation,
  orderEditMatchesInput,
} from "@/lib/order-edit-confirmation";
import { OrderEditCodeEntry } from "@/components/order-edits/OrderEditCodeEntry";
import {
  nextOrderEditPreviewInput,
  type OrderEditQuantityTarget,
} from "@/lib/order-edit-preview-cache";
import {
  readOrderEditItemPricing,
  readOrderEditPricingTargets,
} from "@/lib/order-edit-item-pricing";
import {
  OrderEditSummary,
  OrderEditCalculationDetails,
  OrderEditPaymentDetails,
} from "@/components/order-edits/OrderEditFinancials";
import {
  formatOrderEditMoney,
  orderEditCanCommit,
  orderEditStatusCopy,
  safeOrderEditPaymentUrl,
  OrderEditRequestError,
  ORDER_EDITS_API,
  savePendingOrderEditQuote,
  clearPendingOrderEditQuote,
  type OrderEditTransport,
} from "@/lib/order-edits";

const message = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";
const uncertain = (error: unknown): boolean =>
  error instanceof OrderEditRequestError && error.uncertain;

function ErrorMessage({ text }: { text: string | null }) {
  return text ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {text}
    </p>
  ) : null;
}

export function OrderDraft({
  order,
  api,
  enabled,
  staffId,
  onQuote,
  onLock,
  onConfigure,
  reviewBlocked = false,
  closedOperationId,
  active = true,
  audience = "staff",
  discountCodes: controlledCodes,
  onDiscountCodesChange,
  codeMessages,
  initialOperation,
  renderRewards,
  inline,
}: {
  order: OrderEditOrder;
  api: OrderEditTransport;
  enabled: boolean;
  staffId: string;
  onQuote(
    operation: OrderEditOperation,
    confirmDisplayedAmount?: boolean,
  ): void | Promise<void>;
  onLock(locked: boolean): void;
  onConfigure?: () => void;
  /** Keep item entry responsive while closing a prior quote; submission waits for confirmation. */
  reviewBlocked?: boolean;
  closedOperationId?: string;
  /** Retained drafts stay mounted during review, but do not keep requesting background calculations. */
  active?: boolean;
  audience?: "staff" | "customer";
  discountCodes?: string[];
  onDiscountCodesChange?: (codes: string[]) => void;
  codeMessages?: OrderEditCodeMessageCatalog;
  /** Hydrate an existing review from its persisted plan, never from baseline quantities. */
  initialOperation?: OrderEditOperation | null;
  renderRewards?: (input: {
    disabled: boolean;
    maxDiscountCents: number | null;
    appliedCodes: string[];
    onApply(code: string): Promise<void>;
    onRemove(code: string): void;
    onBusy(busy: boolean): void;
  }) => React.ReactNode;
  /** Customer confirmation stays in the editable form; staff retain their existing review. */
  inline?: {
    operation: OrderEditOperation | null;
    now: number;
    busy: boolean;
    uncertain: boolean;
    onCommit(): Promise<void>;
    onResume?(): Promise<void>;
    onChange(): void;
    onAbandon(): void;
    beforeBrowse(): Promise<boolean>;
  };
}) {
  const queryClient = useQueryClient();
  // Older action snapshots may still include removed Shopify lines. Keep them
  // out of both the editable controls and the submitted change plan.
  const currentLines = order.lines.filter((line) => line.quantity > 0);
  const [localCodes, setLocalCodes] = useState<string[]>([]);
  const [codeEditing, setCodeEditing] = useState(false);
  const [rewardBusy, setRewardBusy] = useState(false);
  const discountCodes = controlledCodes ?? localCodes;
  const changeCodes = onDiscountCodesChange ?? setLocalCodes;
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      currentLines.map((line) => [
        line.lineItemId,
        String(
          initialOperation?.requestedPlan?.changes.find(
            (change) => change.lineItemId === line.lineItemId,
          )?.quantity ?? line.quantity,
        ),
      ]),
    ),
  );
  const [additions, setAdditions] = useState<
    Array<{
      variant: Pick<
        OrderEditCatalogVariant,
        "variantId" | "title" | "variantTitle" | "sku"
      > & {
        priceCents: number | null;
        retailPriceCents?: number | null;
      };
      plan: MemberPlanPresentation | null;
      quantity: string;
    }>
  >(() =>
    (initialOperation?.requestedPlan?.additions ?? []).map((addition) => {
      const line = initialOperation?.lines.find(
        (item) => item.variantId === addition.variantId,
      );
      return {
        variant: {
          variantId: addition.variantId,
          title: line?.title ?? "Added product",
          variantTitle: line?.variantTitle ?? null,
          sku: null,
          priceCents: null,
        },
        plan: null,
        quantity: String(addition.quantity),
      };
    }),
  );
  const [quantityTarget, setQuantityTarget] =
    useState<OrderEditQuantityTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [reviewPreview, setReviewPreview] = useState<OrderEditPreview | null>(
    null,
  );
  const inflight = useRef(false);
  const command = useRef<OrderEditQuoteInput | null>(null);
  useEffect(() => {
    // Preserve quantities/additions, but never replay an abandoned quote's key.
    command.current = null;
    setLocked(false);
    setError(null);
  }, [closedOperationId]);
  const ownsUnsubmittedEdit =
    inline?.operation?.canAbandon === true &&
    order.activeOperationId === inline.operation.operationId;
  const canEdit =
    (order.eligibility.editable || ownsUnsubmittedEdit) && enabled;
  const mutable =
    canEdit && !pending && !locked && !inline?.busy && !inline?.uncertain;
  function updateQuantity(id: string, value: string) {
    inline?.onChange();
    setQuantityTarget({ kind: "line", id });
    command.current = null;
    setError(null);
    setQuantities((current) => ({ ...current, [id]: value }));
  }
  const changes = currentLines
    .filter((line) => quantities[line.lineItemId] !== String(line.quantity))
    .map((line) => ({
      lineItemId: line.lineItemId,
      quantity: quantities[line.lineItemId]?.trim()
        ? Number(quantities[line.lineItemId])
        : Number.NaN,
    }));
  const input = {
    ...(order.codeEntryAvailable ? { discountCodes } : {}),
    connectionId: order.connectionId,
    omsOrderId: order.omsOrderId,
    expectedRevision: order.revision,
    changes,
    additions: additions.map((item) => ({
      variantId: item.variant.variantId,
      quantity: item.quantity.trim() ? Number(item.quantity) : Number.NaN,
    })),
  };
  const validation = orderEditPreviewInputSchema.safeParse(input);
  const valid = validation.success;
  const prepared =
    inline?.operation && orderEditMatchesInput(inline.operation, input)
      ? inline.operation
      : null;
  const verified =
    prepared &&
    orderEditCanCommit(prepared, inline!.now) &&
    prepared.quoteAvailable &&
    prepared.financials?.quoted
      ? prepared
      : null;
  const needsPreparation = Boolean(
    inline?.operation &&
      inline.onResume &&
      orderEditNeedsPreparation(inline.operation, inline.now),
  );
  const validationMessage =
    !validation.success && changes.length + additions.length > 0
      ? `Check the item quantities: ${validation.error.issues[0]?.message ?? "Enter valid whole numbers."}`
      : null;
  const {
    currentPreview,
    displayPreview: backgroundDisplay,
    query: preview,
  } = useOrderEditPreview({
    api,
    actorId: staffId,
    scope: {
      connectionId: order.connectionId,
      omsOrderId: order.omsOrderId,
      expectedRevision: order.revision,
    },
    input: validation.success ? validation.data : null,
    nextInput:
      audience === "customer"
        ? nextOrderEditPreviewInput(order, input, quantityTarget)
        : null,
    active: active && mutable && !reviewBlocked && !inline?.operation,
  });
  const displayPreview = verified?.financials?.quoted
    ? { financials: verified.financials.quoted, lines: verified.lines }
    : backgroundDisplay;
  const displayedDifference = verified
    ? verified.balanceDueCents - verified.refundDueCents
    : currentPreview && order.settlement
      ? currentPreview.financials.totalCents - order.settlement.netPaidCents
      : null;
  const originalPricing = useQuery({
    queryKey: [
      ORDER_EDITS_API,
      staffId,
      "item-pricing",
      order.connectionId,
      order.omsOrderId,
      order.revision,
    ],
    queryFn: ({ signal }) => readOrderEditItemPricing(api, order, signal),
    enabled: audience === "customer" && active && mutable && !reviewBlocked,
    staleTime: ORDER_EDIT_PREVIEW_TTL_MS,
    retry: false,
  });
  useEffect(() => {
    if (originalPricing.error)
      console.warn(
        "order_edit_item_pricing_unavailable",
        originalPricing.error instanceof OrderEditRequestError
          ? originalPricing.error.code
          : "CATALOG_UNAVAILABLE",
      );
  }, [originalPricing.error]);
  const originalPriceByLine = useMemo(
    () => new Map(originalPricing.data ?? []),
    [originalPricing.data],
  );
  const unpricedAdditions = additions.filter(
    (item) => item.variant.priceCents === null,
  );
  const restoredPricing = useQuery({
    queryKey: [
      ORDER_EDITS_API,
      staffId,
      "restored-item-pricing",
      order.connectionId,
      order.omsOrderId,
      order.revision,
      unpricedAdditions.map((item) => item.variant.variantId),
    ],
    queryFn: ({ signal }) =>
      readOrderEditPricingTargets(
        api,
        order,
        unpricedAdditions.map((item) => ({
          key: item.variant.variantId,
          ...item.variant,
          quantity: 1,
        })),
        signal,
      ),
    enabled:
      audience === "customer" &&
      active &&
      mutable &&
      !reviewBlocked &&
      unpricedAdditions.length > 0,
    staleTime: ORDER_EDIT_PREVIEW_TTL_MS,
    retry: false,
  });
  useEffect(() => {
    if (!restoredPricing.data?.length) return;
    const prices = new Map(restoredPricing.data);
    setAdditions((current) =>
      current.map((item) => {
        const pricing = prices.get(item.variant.variantId);
        return pricing && item.variant.priceCents === null
          ? { ...item, variant: pricing.variant, plan: pricing.plan }
          : item;
      }),
    );
  }, [restoredPricing.data]);
  const previewLineGroups = useMemo(
    () =>
      new Map(
        groupOrderEditDisplayLines(
          (displayPreview?.lines ?? []).map((line) => ({
            ...line,
            totalCents: orderEditItemSubtotal(
              displayPreview?.financials,
              line.id,
              line.totalCents,
            ),
          })),
        ).map((line) => [line.key, line]),
      ),
    [displayPreview],
  );
  const previewRetailGroups = useMemo(
    () =>
      new Map(
        groupOrderEditDisplayLines(
          (displayPreview?.lines ?? []).map((line) => ({
            ...line,
            totalCents: displayPreview!.financials.lines.find(
              (financial) => financial.id === line.id,
            )!.grossCents,
          })),
        ).map((line) => [line.key, line]),
      ),
    [displayPreview],
  );
  async function quote() {
    if (!canEdit || !valid || reviewBlocked || codeEditing || rewardBusy || inflight.current)
      return;
    if (
      inline &&
      (inline.busy ||
        inline.uncertain ||
        (inline.operation
          ? !verified && !needsPreparation
          : !currentPreview && !locked))
    )
      return;
    inflight.current = true;
    setReviewPreview(currentPreview);
    setPending(true);
    setError(null);
    onLock(true);
    try {
      if (needsPreparation && inline?.onResume) {
        await inline.onResume();
        onLock(false);
        return;
      }
      if (inline && verified) {
        await inline.onCommit();
        onLock(false);
        return;
      }
      if (!command.current)
        command.current = orderEditQuoteInputSchema.parse({
          ...input,
          requestKey: crypto.randomUUID(),
        });
      savePendingOrderEditQuote(staffId, command.current, sessionStorage);
      // The initial click approves exactly the visible preview. A changed quote
      // stays in this form and requires another explicit confirmation.
      const approved = locked ? null : currentPreview;
      const result = await api.quote(command.current);
      await onQuote(
        result,
        Boolean(
          inline &&
            approved &&
            canConfirmOrderEditPreview(order, approved, result, Date.now()),
        ),
      );
    } catch (failure) {
      const unknown = uncertain(failure);
      setError(message(failure));
      setLocked(unknown);
      onLock(unknown);
      if (!unknown) {
        try {
          clearPendingOrderEditQuote(staffId, sessionStorage);
        } catch {
          setError(
            "The saved request could not be cleared. Retry this request before preparing another edit.",
          );
          setLocked(true);
          onLock(true);
        }
      }
    } finally {
      inflight.current = false;
      setPending(false);
    }
  }
  async function applyCode(code: string) {
    const next = orderEditPreviewInputSchema.parse({
      ...input,
      discountCodes: [...discountCodes, code],
      ...(inline?.operation
        ? { operationId: inline.operation.operationId }
        : {}),
    });
    const verified = await api.preview(next);
    queryClient.setQueryData(
      [ORDER_EDITS_API, staffId, "preview", canonicalJson(next)],
      verified,
    );
    command.current = null;
    inline?.onChange();
    changeCodes(next.discountCodes!);
  }
  function removeCode(code: string) {
    inline?.onChange();
    command.current = null;
    changeCodes(discountCodes.filter((existing) => existing.toUpperCase() !== code.toUpperCase()));
  }
  if (pending && !inline)
    return (
      <OrderEditPreviewReview
        order={order}
        preview={reviewPreview}
        audience={audience}
      />
    );
  return (
    <Card className="oe-order-surface">
      <CardHeader className="oe-order-heading">
        <CardTitle>
          <h2>Order {order.orderNumber}</h2>
        </CardTitle>
        {audience === "staff" && (
          <p className="text-sm text-muted-foreground">
            {order.customerName}
            {order.customerEmail ? ` · ${order.customerEmail}` : ""}
          </p>
        )}
        {audience === "staff" && (
          <div className="flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className={`oe-status ${order.financialStatus === "Paid" ? "oe-status--paid" : ""}`}
            >
              Payment: {order.financialStatus}
            </Badge>
            <Badge variant="outline" className="oe-status">
              Warehouse: {order.warehouseStatus}
            </Badge>
          </div>
        )}
      </CardHeader>
      <CardContent className="oe-order-content">
        {!enabled && (
          <div className="space-y-3 rounded-md border bg-muted/40 p-3">
            <p role="status" className="text-sm">
              {audience === "customer" ? (
                "Order editing is temporarily unavailable. Contact us if you need help with this order."
              ) : (
                <>
                  Staff order editing is disabled for this Shopify connection.{" "}
                  {onConfigure
                    ? "Choose a payment window and save enabled pilot settings to edit eligible orders."
                    : "Ask an administrator with settings permission to configure and enable staff edits."}
                </>
              )}
            </p>
            {onConfigure && (
              <Button type="button" variant="outline" onClick={onConfigure}>
                Configure staff editing
              </Button>
            )}
          </div>
        )}
        {!order.eligibility.editable && (
          <ErrorMessage
            text={
              order.eligibility.reasons.join(" ") ||
              "This order is not eligible for editing."
            }
          />
        )}
        <div className="oe-edit-layout">
          <section className="oe-edit-main">
            <div className="oe-items-heading">
              <div>
                <h3 className="text-sm font-medium">Items in your order</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Update quantities or add a product.
                </p>
              </div>
              {(canEdit || inline) && (
                <OrderEditProductPicker
                  beforeOpen={inline?.beforeBrowse}
                  api={api}
                  connectionId={order.connectionId}
                  staffId={staffId}
                  omsOrderId={order.omsOrderId}
                  expectedRevision={order.revision}
                  enabled={mutable && active}
                  includedVariantIds={
                    new Set([
                      ...currentLines
                        .map((line) => line.variantId)
                        .filter((id): id is string => id !== null),
                      ...additions.map((item) => item.variant.variantId),
                    ])
                  }
                  onAdd={(variant, plan) => {
                    setQuantityTarget({
                      kind: "addition",
                      id: variant.variantId,
                    });
                    if (
                      !mutable ||
                      !variant.available ||
                      currentLines.some(
                        (line) => line.variantId === variant.variantId,
                      )
                    )
                      return;
                    command.current = null;
                    inline?.onChange();
                    setError(null);
                    setAdditions((current) =>
                      current.some(
                        (item) => item.variant.variantId === variant.variantId,
                      )
                        ? current
                        : [...current, { variant, plan, quantity: "1" }],
                    );
                  }}
                />
              )}
            </div>
            <div className="oe-edit-items" aria-label="Editable order items">
              {currentLines.map((line) => {
                const previewGroup =
                  line.variantId &&
                  currentLines.filter(
                    (item) => item.variantId === line.variantId,
                  ).length === 1
                    ? previewLineGroups.get(`variant:${line.variantId}`)
                    : null;
                const previewLine =
                  previewGroup?.quantity === Number(quantities[line.lineItemId])
                    ? previewGroup
                    : null;
                const displayedTotal =
                  previewLine?.totalCents ??
                  orderEditItemSubtotal(
                    order.financials,
                    line.lineItemId,
                    line.totalCents,
                  );
                const displayedQuantity =
                  previewLine?.quantity ?? line.quantity;
                const unitNetCents = exactOrderEditUnitPrice(
                  displayedTotal,
                  displayedQuantity,
                );
                const catalogPrice = originalPriceByLine.get(line.lineItemId);
                const retail = line.variantId
                  ? previewRetailGroups.get(`variant:${line.variantId}`)
                  : null;
                const retailUnitCents =
                  previewLine && retail?.quantity === displayedQuantity
                    ? exactOrderEditUnitPrice(
                        retail.totalCents,
                        retail.quantity,
                      )
                    : exactOrderEditUnitPrice(
                        order.financials?.lines.find(
                          (item) => item.id === line.lineItemId,
                        )?.grossCents ?? line.totalCents,
                        line.quantity,
                      );
                return (
                  <div key={line.lineItemId} className="oe-edit-item">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{line.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {[line.variantTitle, line.sku]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <div className="oe-line-pricing">
                      <OrderEditUnitPrice
                        cents={unitNetCents}
                        currency={order.currency}
                        retailCents={retailUnitCents}
                        plan={catalogPrice?.plan ?? null}
                      />
                      <div className="oe-item-quantity">
                        <Label
                          htmlFor={`line-${line.lineItemId}`}
                          className="text-xs"
                        >
                          Quantity
                        </Label>
                        <Input
                          id={`line-${line.lineItemId}`}
                          aria-label={`Quantity for ${line.title}${line.variantTitle ? ` ${line.variantTitle}` : ""}`}
                          type="number"
                          min={0}
                          step={1}
                          value={quantities[line.lineItemId]}
                          disabled={!mutable}
                          onChange={(event) =>
                            updateQuantity(line.lineItemId, event.target.value)
                          }
                        />
                      </div>
                      <p
                        className="oe-item-total"
                        aria-label={`Line total for ${line.title}`}
                      >
                        {previewLine ||
                        Number(quantities[line.lineItemId]) ===
                          line.quantity ? (
                          formatOrderEditMoney(displayedTotal, order.currency)
                        ) : (
                          <span aria-label="Line total updating">—</span>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })}
              {additions.map((item, index) => {
                const group = previewLineGroups.get(
                  `variant:${item.variant.variantId}`,
                );
                const previewLine =
                  group?.quantity === Number(item.quantity) ? group : null;
                const unitNetCents = previewLine
                  ? exactOrderEditUnitPrice(
                      previewLine.totalCents,
                      previewLine.quantity,
                    )
                  : item.variant.priceCents;
                const retail = previewRetailGroups.get(
                  `variant:${item.variant.variantId}`,
                );
                const retailUnitCents =
                  previewLine && retail?.quantity === previewLine.quantity
                    ? exactOrderEditUnitPrice(
                        retail.totalCents,
                        retail.quantity,
                      )
                    : item.variant.retailPriceCents;
                return (
                  <div
                    key={item.variant.variantId}
                    className="oe-edit-item oe-added-item"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {item.variant.title}{" "}
                        <Badge variant="outline" className="oe-added-pill">
                          Added
                        </Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[item.variant.variantTitle, item.variant.sku]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="oe-item-remove"
                        disabled={!mutable}
                        onClick={() => {
                          inline?.onChange();
                          command.current = null;
                          setAdditions((current) =>
                            current.filter(
                              (row) =>
                                row.variant.variantId !==
                                item.variant.variantId,
                            ),
                          );
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                    <div className="oe-line-pricing">
                      <OrderEditUnitPrice
                        cents={unitNetCents}
                        currency={order.currency}
                        retailCents={retailUnitCents}
                        plan={item.plan}
                      />
                      <div className="oe-item-quantity">
                        <Label htmlFor={`added-${item.variant.variantId}`}>
                          Quantity
                        </Label>
                        <Input
                          id={`added-${item.variant.variantId}`}
                          type="number"
                          min={1}
                          step={1}
                          aria-label={`Quantity for added ${[item.variant.title, item.variant.variantTitle, item.variant.sku].filter(Boolean).join(" · ")}`}
                          value={item.quantity}
                          disabled={!mutable}
                          onChange={(event) => {
                            inline?.onChange();
                            setQuantityTarget({
                              kind: "addition",
                              id: item.variant.variantId,
                            });
                            command.current = null;
                            setAdditions((current) =>
                              current.map((row, position) =>
                                position === index
                                  ? { ...row, quantity: event.target.value }
                                  : row,
                              ),
                            );
                          }}
                        />
                      </div>
                      <p
                        className="oe-item-total"
                        aria-label={`Line total for added ${item.variant.title}`}
                      >
                        {previewLine ? (
                          formatOrderEditMoney(
                            previewLine.totalCents,
                            order.currency,
                          )
                        ) : (
                          <span aria-label="Line total updating">—</span>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            <OrderEditCodeEntry
              codes={discountCodes}
              applications={currentPreview?.appliedCodes ?? []}
              available={order.codeEntryAvailable === true}
              disabled={!mutable || reviewBlocked || rewardBusy}
              codeMessages={codeMessages}
              onEditing={setCodeEditing}
              onApply={applyCode}
              onRemove={removeCode}
            />
            {renderRewards?.({
              disabled: !mutable || reviewBlocked || codeEditing,
              maxDiscountCents:
                (verified?.financials?.quoted ?? currentPreview?.financials)?.itemsNetCents ??
                (changes.length === 0 && additions.length === 0 && discountCodes.length === 0
                  ? order.financials?.itemsNetCents ?? null
                  : null),
              appliedCodes: discountCodes,
              onApply: applyCode,
              onRemove: removeCode,
              onBusy: setRewardBusy,
            })}
            {audience === "staff" && <p className="text-xs text-muted-foreground">
              Shipping address changes are not supported in this pilot.
            </p>}
            <ErrorMessage text={validationMessage} />
            <ErrorMessage text={error} />
          </section>
          <aside className="oe-edit-sidebar">
            {valid && active && (
              <p role="status" className="text-xs text-muted-foreground">
                {pending
                  ? "Verifying your changes…"
                  : verified
                    ? "Verified total. Apply to confirm these changes."
                    : inline?.operation
                      ? "Your selections are saved."
                      : currentPreview
                        ? "Updated totals are ready."
                        : preview.isError
                          ? inline
                            ? "We couldn't calculate updated totals. Please retry."
                            : "Background totals are unavailable. Review will verify your changes."
                          : "Calculating updated shipping and tax…"}
              </p>
            )}
            <OrderEditSummary
              financials={displayPreview?.financials ?? order.financials}
              paidCents={
                audience === "customer"
                  ? order.settlement?.netPaidCents
                  : undefined
              }
              difference={
                audience === "customer" &&
                (currentPreview || verified) &&
                order.settlement &&
                displayedDifference !== null &&
                displayedDifference !== 0
                  ? {
                      label:
                        displayedDifference < 0
                          ? verified
                            ? "Refund:"
                            : "Estimated refund:"
                          : verified
                            ? "Payment due:"
                            : "Estimated payment due:",
                      amountCents: Math.abs(displayedDifference),
                    }
                  : undefined
              }
              totals={[
                ...(audience === "staff" || !displayPreview
                  ? [
                      {
                        label: "Current order total",
                        totalCents: order.totalCents,
                      },
                    ]
                  : []),
                ...(displayPreview
                  ? [
                      {
                        label:
                          currentPreview || verified
                            ? "Updated order total"
                            : "Last calculated total",
                        totalCents: displayPreview.financials.totalCents,
                      },
                    ]
                  : []),
              ]}
            />
          </aside>
        </div>
        <OrderEditCalculationDetails
          columns={[
            ...(order.financials
              ? [{ label: "Current order", financials: order.financials }]
              : []),
            ...(displayPreview && (currentPreview || verified)
              ? [
                  {
                    label: "With your changes",
                    financials: displayPreview.financials,
                  },
                ]
              : []),
          ]}
        />
        {audience === "staff" && order.settlement && (
          <OrderEditPaymentDetails settlement={order.settlement} />
        )}
        <div className="oe-editor-footer">
          {(!inline || pending) && <p className="text-xs text-muted-foreground">
            {inline
              ? "Verifying and applying your changes…"
              : "Review the updated total before applying changes."}
          </p>}
          {inline?.operation?.canAbandon && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || inline.busy || inline.uncertain}
              onClick={inline.onAbandon}
            >
              {inline.busy && reviewBlocked ? "Canceling edit…" : "Cancel edit"}
            </Button>
          )}
          {inline && !inline.operation && preview.isError && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || preview.isFetching}
              onClick={() => void preview.refetch()}
            >
              Retry calculation
            </Button>
          )}
          <Button
            type="button"
            disabled={
              !canEdit ||
              !valid ||
              pending ||
              reviewBlocked ||
              codeEditing ||
              rewardBusy ||
              Boolean(
                inline &&
                  (inline.busy ||
                    inline.uncertain ||
                    (inline.operation
                      ? !verified && !needsPreparation
                      : !currentPreview && !locked)),
              )
            }
            onClick={quote}
          >
            {pending
              ? inline && verified
                ? "Applying changes…"
                : "Verifying changes…"
              : locked
                ? "Retry same quote request"
                : needsPreparation
                  ? "Retry changes"
                  : inline
                    ? displayedDifference === null
                      ? "Apply changes"
                      : displayedDifference > 0
                        ? `Apply changes · ${formatOrderEditMoney(displayedDifference, order.currency)} due`
                        : displayedDifference < 0
                          ? `Apply changes · ${formatOrderEditMoney(-displayedDifference, order.currency)} refund`
                          : "Apply changes"
                    : "Review changes"}
          </Button>
        </div>
        {inline?.operation?.error && !inline.busy && (
          <ErrorMessage
            text={
              inline.operation.error.code === "ORDER_EDIT_UNAVAILABLE"
                ? "We couldn't calculate your changes. Your selections are saved. Retry changes to try again."
                : inline.operation.error.message
            }
          />
        )}
        {inline?.operation && (
          <p className="break-all text-xs text-muted-foreground">
            Edit reference {inline.operation.operationId}
          </p>
        )}
        {prepared?.status === "ready" &&
          prepared.expiresAt !== null &&
          Date.parse(prepared.expiresAt) <= inline!.now && (
            <ErrorMessage text="This total has expired. Retry changes to refresh it. Your selections are saved." />
          )}
      </CardContent>
    </Card>
  );
}

export function OrderEditPreviewReview({
  order,
  preview,
  audience = "staff",
}: {
  order: OrderEditOrder;
  preview: OrderEditPreview | null;
  audience?: "staff" | "customer";
}) {
  return (
    <Card className="oe-order-surface">
      <CardHeader className="oe-order-heading">
        <CardTitle>
          <h2>Order {order.orderNumber}</h2>
        </CardTitle>
        {audience === "staff" && (
          <div>
            <Badge variant="outline">Verifying changes</Badge>
          </div>
        )}
      </CardHeader>
      <CardContent className="oe-order-content" aria-busy="true">
        <p role="status" className="text-sm text-muted-foreground">
          {preview
            ? "Preview totals are shown below. Checking the current order, stock and shipping before changes can be applied."
            : "Checking your changes and calculating discounts, shipping and tax…"}
        </p>
        {preview && (
          <>
            <OrderEditItems
              lines={preview.lines}
              financials={preview.financials}
              showAdded
            />
            <OrderEditSummary
              financials={preview.financials}
              paidCents={
                audience === "customer"
                  ? order.settlement?.netPaidCents
                  : undefined
              }
              totals={[
                ...(audience === "staff"
                  ? [
                      {
                        label: "Current order total",
                        totalCents: order.totalCents,
                      },
                    ]
                  : []),
                {
                  label: "Preview total · verifying",
                  totalCents: preview.financials.totalCents,
                },
              ]}
            />
            <OrderEditCalculationDetails
              columns={[
                ...(order.financials
                  ? [{ label: "Before edit", financials: order.financials }]
                  : []),
                {
                  label: "Preview · verifying",
                  financials: preview.financials,
                },
              ]}
            />
          </>
        )}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button disabled>Verifying changes…</Button>
          <p className="self-center text-xs text-muted-foreground">
            Changes can be applied after verification finishes.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function OrderEditOperationView({
  operation,
  now,
  busy,
  busyAction,
  isUncertain,
  error,
  onCommit,
  onRefresh,
  onAbandon,
  audience = "staff",
  onCodesChange,
  codeMessages,
  onPaymentOpen,
  statusReadBusy = false,
  recoveringCommand = false,
}: {
  operation: OrderEditOperation;
  now: number;
  busy: boolean;
  busyAction?: "commit" | "reconcile" | "abandon";
  isUncertain: boolean;
  error: string | null;
  onCommit(): void;
  onRefresh(): void;
  onAbandon(): void;
  audience?: "staff" | "customer";
  onCodesChange?: (codes: string[]) => Promise<void>;
  codeMessages?: OrderEditCodeMessageCatalog;
  onPaymentOpen?: () => void;
  statusReadBusy?: boolean;
  recoveringCommand?: boolean;
}) {
  const [codeEditing, setCodeEditing] = useState(false);
  const copy = orderEditStatusCopy[operation.status];
  const title =
    audience === "customer" && operation.status === "review_required"
      ? "Review needed"
      : copy.title;
  const operationError =
    audience === "customer" && operation.error?.code === "ORDER_EDIT_PAYMENT_PENDING"
      ? null
      : operation.error;
  const description =
    recoveringCommand
      ? "Finishing your order update. This page will update automatically."
      : audience === "customer" && operation.status === "committing"
        ? "Applying your changes. This page will update automatically."
        : audience === "customer" && operation.status === "review_required"
          ? "We need to check these changes. Contact us with the edit reference below."
          : audience === "customer" && operation.status === "synchronizing"
            ? "We’re finishing your order update. This page will update automatically."
            : audience === "customer" && operation.status === "awaiting_payment"
              ? operation.error?.code === "ORDER_EDIT_PAYMENT_PENDING"
                ? "Your payment is processing. This page will update automatically."
                : "Complete your payment below to finish updating your order."
              : audience === "customer" && operation.status === "completed"
                ? "Your order has been updated."
                : copy.description;
  const payable = operation.balanceDueCents > 0;
  const refundable = operation.refundDueCents > 0;
  const paymentUrl =
    operation.status === "awaiting_payment" &&
    payable &&
    !recoveringCommand &&
    operation.commandInProgress !== true &&
    operation.error?.code !== "ORDER_EDIT_PAYMENT_PENDING"
      ? safeOrderEditPaymentUrl(operation.paymentUrl)
      : null;
  const money = (value: number) =>
    formatOrderEditMoney(value, operation.currency);
  const expired =
    operation.expiresAt !== null && Date.parse(operation.expiresAt) <= now;
  // Normal submitted progress is observed through read-only requests. Retain
  // explicit reconciliation only for a failed or uncertain customer command.
  const showStatusCheck = recoveringCommand
    ? error !== null
    : audience !== "customer" ||
      isUncertain ||
      error !== null ||
      (operation.status === "ready" && expired) ||
      operationError !== null;
  const financials = operation.financials;
  const showCurrent = ["completed", "recovered", "failed", "expired"].includes(
    operation.status,
  );
  const totalsColumns =
    financials?.before && financials.quoted && !showCurrent
      ? [
          { label: "Before edit", financials: financials.before },
          { label: "After changes", financials: financials.quoted },
        ]
      : financials?.before && financials.current && showCurrent
        ? [
            { label: "Before edit", financials: financials.before },
            { label: "Current order", financials: financials.current },
          ]
        : financials?.current
          ? [{ label: "Current order", financials: financials.current }]
          : [];
  const summaryTotals =
    totalsColumns.length > 0
      ? totalsColumns.map(({ label, financials: values }) => ({
          label,
          totalCents: values.totalCents,
        }))
      : operation.quoteAvailable === false
        ? [
            {
              label: "Current order total",
              totalCents: operation.updatedTotalCents,
            },
          ]
        : [
            {
              label: "Original total",
              totalCents: operation.previousTotalCents,
            },
            {
              label: showCurrent ? "Current order total" : "Quoted total",
              totalCents: operation.updatedTotalCents,
            },
          ];
  const difference = payable
    ? {
        label:
          operation.status === "ready"
            ? "Payment required for these changes:"
            : operation.status === "awaiting_payment"
              ? "Amount still due:"
              : "Payment difference:",
        amountCents: operation.balanceDueCents,
      }
    : refundable
      ? {
          label:
            operation.status === "ready"
              ? "Refund for these changes:"
              : "Refund difference:",
          amountCents: operation.refundDueCents,
        }
      : operation.status === "ready"
        ? { label: "No additional payment", amountCents: 0 }
        : undefined;
  return (
    <Card className="oe-order-surface">
      <CardHeader className="oe-order-heading">
        <CardTitle>
          <h2>Order {operation.orderNumber}</h2>
        </CardTitle>
        {audience === "staff" && (
          <div>
            <Badge variant="outline">{title}</Badge>
          </div>
        )}
      </CardHeader>
      <CardContent className="oe-order-content">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {operation.status === "review_required" && operation.canAbandon
            ? audience === "customer"
              ? "We could not verify these changes. You can cancel this edit and try again, or contact us for help."
              : "This edit needs review. You can cancel this unsubmitted edit, or keep its reference for investigation."
            : description}
        </p>
        {showCurrent && (
          <p className="text-xs text-muted-foreground">
            Items and totals below show the current order. Payments and refunds
            show their recorded status.
          </p>
        )}
        <OrderEditItems
          lines={operation.lines}
          financials={
            showCurrent
              ? financials?.current
              : (financials?.quoted ?? financials?.current)
          }
          showAdded={!showCurrent}
        />
        {operation.status === "ready" &&
          onCodesChange &&
          operation.requestedPlan?.discountCodes !== undefined && (
            <OrderEditCodeEntry
              codes={operation.requestedPlan.discountCodes}
              applications={operation.appliedCodes ?? []}
              available={operation.codeEntryAvailable === true}
              disabled={busy || expired || isUncertain}
              codeMessages={codeMessages}
              onEditing={setCodeEditing}
              onApply={(code) =>
                onCodesChange([
                  ...operation.requestedPlan!.discountCodes!,
                  code,
                ])
              }
              onRemove={(code) =>
                onCodesChange(
                  operation.requestedPlan!.discountCodes!.filter(
                    (existing) => existing !== code,
                  ),
                )
              }
            />
          )}
        <OrderEditSummary
          totals={
            audience === "customer" ? summaryTotals.slice(-1) : summaryTotals
          }
          difference={difference}
          paidCents={
            audience === "customer"
              ? operation.settlement?.netPaidCents
              : undefined
          }
          financials={
            showCurrent
              ? financials?.current
              : (financials?.quoted ?? financials?.current)
          }
        />
        <OrderEditCalculationDetails
          columns={totalsColumns}
          shipping={
            !showCurrent || operation.status === "completed"
              ? operation.shippingRepricing
              : null
          }
        />
        {audience === "staff" && operation.settlement && (
          <OrderEditPaymentDetails
            settlement={operation.settlement}
            pendingChanges={operation.status === "ready"}
          />
        )}
        {operation.paymentDeadline && (audience === "staff" || operation.status === "awaiting_payment") && (
          <p className="rounded-md bg-muted p-3 text-sm">
            Payment deadline:{" "}
            <time dateTime={operation.paymentDeadline}>
              {new Date(operation.paymentDeadline).toLocaleString()}
            </time>
          </p>
        )}
        {operation.warnings.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {operation.warnings
              .filter(
                (warning) =>
                  audience !== "customer" ||
                  !warning.startsWith("Private staff testing."),
              )
              .map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
          </ul>
        )}
        {operationError && <ErrorMessage text={operationError.message} />}
        <ErrorMessage text={error} />
        {isUncertain && !recoveringCommand && (
          <p role="status" className="text-sm">
            {audience === "customer"
              ? "We couldn’t confirm the last request. Try again to check its result."
              : "The last request may have completed. Check this operation’s status before continuing."}
          </p>
        )}
        {operation.status === "ready" && expired && (
          <p role="status" className="text-sm">
            {audience === "customer"
              ? "This total has expired. Try again to refresh it."
              : "This quote has expired. Check status before continuing."}
          </p>
        )}
        <div className="oe-editor-footer">
          {operation.status === "ready" && !recoveringCommand && (
            <>
              <Button
                type="button"
                disabled={
                  busy ||
                  isUncertain ||
                  codeEditing ||
                  !orderEditCanCommit(operation, now)
                }
                onClick={onCommit}
              >
                {payable
                  ? `Apply changes · ${money(operation.balanceDueCents)} payment due`
                  : refundable
                    ? `Apply changes and refund ${money(operation.refundDueCents)}`
                    : "Apply changes"}
              </Button>
            </>
          )}
          {operation.canAbandon && !recoveringCommand && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || isUncertain}
              onClick={onAbandon}
            >
              {busy && busyAction === "abandon"
                ? "Canceling edit…"
                : operation.status === "ready"
                  ? "Change items"
                  : "Cancel edit"}
            </Button>
          )}
          {paymentUrl && (
            <Button asChild variant="outline">
              <a
                href={paymentUrl}
                target={audience === "customer" ? "_self" : "_blank"}
                rel="noopener noreferrer"
                onClick={onPaymentOpen}
              >
                {audience === "customer"
                  ? "Pay the difference"
                  : "Open Shopify payment"}
              </a>
            </Button>
          )}
          {showStatusCheck && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || statusReadBusy}
              onClick={onRefresh}
            >
              {statusReadBusy || (busy && (!busyAction || busyAction === "reconcile"))
                ? "Checking…"
                : audience === "customer"
                  ? "Try again"
                  : "Check status"}
            </Button>
          )}
        </div>
        <p className="break-all text-xs text-muted-foreground">
          {audience === "customer" ? "Edit reference" : "Operation"}{" "}
          {operation.operationId}
        </p>
      </CardContent>
    </Card>
  );
}

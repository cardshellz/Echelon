import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ORDER_EDIT_PREVIEW_TTL_MS,
  orderEditPreviewInputSchema,
  type OrderEditPreview,
} from "@shared/order-edits/order-edit-preview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  orderEditQuoteInputSchema,
  orderEditSettingsInputSchema,
  type OrderEditConnection,
  type OrderEditOperation,
  type OrderEditOrder,
  type OrderEditQuoteInput,
  type OrderEditState,
} from "@shared/order-edits/order-edit.contract";
import type { OrderEditCatalogVariant } from "@shared/order-edits/order-edit-catalog";
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
import { useAuth } from "@/lib/auth";
import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";
import { useOrderEditPreview } from "@/hooks/use-order-edit-preview";
import { canonicalJson } from "@shared/utils/canonical-json";
import { OrderEditCodeEntry } from "@/components/order-edits/OrderEditCodeEntry";
import { useDebounce } from "@/hooks/use-debounce";
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
  MIN_ORDER_EDIT_PAYMENT_WINDOW_HOURS,
  MAX_ORDER_EDIT_PAYMENT_WINDOW_HOURS,
  parseOrderEditPaymentWindowHours,
  orderEditPaymentWindowHoursInput,
  formatOrderEditPaymentWindowHours,
} from "@/lib/order-edit-payment-window";
import {
  createOrderEditTransport,
  formatOrderEditMoney,
  orderEditCanCommit,
  orderEditOperationFromSearch,
  orderEditStatusCopy,
  safeOrderEditPaymentUrl,
  OrderEditRequestError,
  ORDER_EDITS_API,
  ORDER_EDITS_PATH,
  savePendingOrderEditQuote,
  loadPendingOrderEditQuote,
  clearPendingOrderEditQuote,
  type OrderEditTransport,
} from "@/lib/order-edits";

const message = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";
const uncertain = (error: unknown): boolean =>
  error instanceof OrderEditRequestError && error.uncertain;
const finished = new Set<OrderEditOperation["status"]>([
  "completed",
  "recovered",
  "failed",
  "expired",
  "review_required",
]);

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

export function ConnectionSettings({
  connection,
  api,
  onSaved,
  detailsRef,
}: {
  connection: OrderEditConnection;
  api: OrderEditTransport;
  onSaved(saved: OrderEditConnection): Promise<unknown>;
  detailsRef?: React.RefObject<HTMLDetailsElement | null>;
}) {
  const [expanded, setExpanded] = useState(!connection.enabled);
  const [hours, setHours] = useState(
    orderEditPaymentWindowHoursInput(connection.paymentWindowMinutes),
  );
  const [enabled, setEnabled] = useState(connection.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [locked, setLocked] = useState(false);
  const command = useRef<{ fingerprint: string; key: string } | null>(null);
  const inflight = useRef(false);
  const parsed = orderEditSettingsInputSchema.safeParse({
    paymentWindowMinutes: parseOrderEditPaymentWindowHours(hours),
    enabled,
  });
  const windowHelp = !hours.trim()
    ? "Enter a payment window before enabling staff edits."
    : !parsed.success
      ? `Enter a positive duration up to ${MAX_ORDER_EDIT_PAYMENT_WINDOW_HOURS} hours in whole-minute increments, such as 0.5 or 1.25.`
      : null;
  async function save() {
    if (!parsed.success || inflight.current) return;
    const fingerprint = JSON.stringify(parsed.data);
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, key: crypto.randomUUID() };
    inflight.current = true;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.saveSettings(
        connection.connectionId,
        parsed.data,
        command.current.key,
      );
      setHours(orderEditPaymentWindowHoursInput(result.paymentWindowMinutes));
      setEnabled(result.enabled);
      setLocked(false);
      await onSaved(result);
      setSaved(true);
      command.current = null;
    } catch (failure) {
      setError(message(failure));
      setLocked(uncertain(failure));
    } finally {
      inflight.current = false;
      setPending(false);
    }
  }
  return (
    <details
      id="order-edit-settings"
      ref={detailsRef}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded-lg border bg-card p-4"
    >
      <summary className="cursor-pointer text-sm font-medium">
        Pilot settings
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">
        Applies only to {connection.name} ({connection.shopDomain}).
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-2">
          <Label htmlFor="edit-payment-window">Payment window (hours)</Label>
          <Input
            id="edit-payment-window"
            type="number"
            min={MIN_ORDER_EDIT_PAYMENT_WINDOW_HOURS}
            max={MAX_ORDER_EDIT_PAYMENT_WINDOW_HOURS}
            step="any"
            placeholder="e.g. 0.5 or 24"
            required
            aria-describedby="edit-payment-window-help edit-payment-window-validation"
            aria-invalid={Boolean(hours.trim()) && !parsed.success}
            value={hours}
            disabled={pending || locked}
            onChange={(event) => {
              setHours(event.target.value);
              setSaved(false);
            }}
          />
          <p
            id="edit-payment-window-help"
            className="text-xs text-muted-foreground"
          >
            0.5 hours = 30 minutes. Unpaid changes enter automatic recovery when
            this window expires. Choose a window before enabling the pilot.
          </p>
          <p
            id="edit-payment-window-validation"
            className="text-xs text-muted-foreground"
          >
            {windowHelp}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={pending || locked}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setSaved(false);
              }}
            />
            Enable staff order edits for this Shopify connection
          </label>
        </div>
        <Button
          type="button"
          className="self-end"
          onClick={save}
          disabled={!parsed.success || pending}
        >
          {pending ? "Saving…" : locked ? "Retry same save" : "Save settings"}
        </Button>
      </div>
      <div className="mt-3">
        <ErrorMessage text={error} />
        {saved && (
          <p role="status" className="text-sm">
            Settings saved.
          </p>
        )}
      </div>
    </details>
  );
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
  initialOperation,
}: {
  order: OrderEditOrder;
  api: OrderEditTransport;
  enabled: boolean;
  staffId: string;
  onQuote(operation: OrderEditOperation): void;
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
  /** Hydrate an existing review from its persisted plan, never from baseline quantities. */
  initialOperation?: OrderEditOperation | null;
}) {
  const queryClient = useQueryClient();
  const [localCodes, setLocalCodes] = useState<string[]>([]);
  const [codeEditing, setCodeEditing] = useState(false);
  const discountCodes = controlledCodes ?? localCodes;
  const changeCodes = onDiscountCodesChange ?? setLocalCodes;
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      order.lines.map((line) => [
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
  const canEdit = order.eligibility.editable && enabled;
  const mutable = canEdit && !pending && !locked;
  function updateQuantity(id: string, value: string) {
    setQuantityTarget({ kind: "line", id });
    command.current = null;
    setError(null);
    setQuantities((current) => ({ ...current, [id]: value }));
  }
  const changes = order.lines
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
  const validationMessage =
    !validation.success && changes.length + additions.length > 0
      ? `Check the item quantities: ${validation.error.issues[0]?.message ?? "Enter valid whole numbers."}`
      : null;
  const {
    currentPreview,
    displayPreview,
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
    active: active && mutable && !reviewBlocked,
  });
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
    if (!canEdit || !valid || reviewBlocked || codeEditing || inflight.current)
      return;
    inflight.current = true;
    setReviewPreview(currentPreview);
    setPending(true);
    setError(null);
    onLock(true);
    try {
      if (!command.current)
        command.current = orderEditQuoteInputSchema.parse({
          ...input,
          requestKey: crypto.randomUUID(),
        });
      savePendingOrderEditQuote(staffId, command.current, sessionStorage);
      onQuote(await api.quote(command.current));
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
    });
    const verified = await api.preview(next);
    queryClient.setQueryData(
      [ORDER_EDITS_API, staffId, "preview", canonicalJson(next)],
      verified,
    );
    command.current = null;
    changeCodes(next.discountCodes!);
  }
  if (pending)
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
              {canEdit && (
                <OrderEditProductPicker
                  api={api}
                  connectionId={order.connectionId}
                  staffId={staffId}
                  omsOrderId={order.omsOrderId}
                  expectedRevision={order.revision}
                  enabled={mutable && active}
                  includedVariantIds={
                    new Set([
                      ...order.lines
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
                      order.lines.some(
                        (line) => line.variantId === variant.variantId,
                      )
                    )
                      return;
                    command.current = null;
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
              {order.lines.map((line) => {
                const previewGroup =
                  line.variantId &&
                  order.lines.filter(
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
            <p className="text-xs text-muted-foreground">
              Set quantity to 0 to remove an item. Discounts, shipping and tax
              are recalculated for your changes.
            </p>
            <OrderEditCodeEntry
              codes={discountCodes}
              applications={currentPreview?.appliedCodes ?? []}
              available={order.codeEntryAvailable === true}
              disabled={!mutable || reviewBlocked}
              onEditing={setCodeEditing}
              onApply={applyCode}
              onRemove={(code) => {
                command.current = null;
                changeCodes(
                  discountCodes.filter((existing) => existing !== code),
                );
              }}
            />
            <p className="text-xs text-muted-foreground">
              {audience === "customer"
                ? "To change the shipping address, use Change address on your order page."
                : "Shipping address changes are not supported in this pilot."}
            </p>
            <ErrorMessage text={validationMessage} />
            <ErrorMessage text={error} />
          </section>
          <aside className="oe-edit-sidebar">
            {valid && active && (
              <p role="status" className="text-xs text-muted-foreground">
                {currentPreview
                  ? "Updated totals are ready."
                  : preview.isError
                    ? "Background totals are unavailable. Review will verify your changes."
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
                currentPreview &&
                order.settlement &&
                currentPreview.financials.totalCents !==
                  order.settlement.netPaidCents
                  ? {
                      label:
                        currentPreview.financials.totalCents <
                        order.settlement.netPaidCents
                          ? "Estimated refund:"
                          : "Estimated payment due:",
                      amountCents: Math.abs(
                        currentPreview.financials.totalCents -
                          order.settlement.netPaidCents,
                      ),
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
                        label: currentPreview
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
            ...(currentPreview
              ? [
                  {
                    label: "With your changes",
                    financials: currentPreview.financials,
                  },
                ]
              : []),
          ]}
        />
        {audience === "staff" && order.settlement && (
          <OrderEditPaymentDetails settlement={order.settlement} />
        )}
        <div className="oe-editor-footer">
          <p className="text-xs text-muted-foreground">
            Review the updated total before applying changes.
          </p>
          <Button
            type="button"
            disabled={
              !canEdit || !valid || pending || reviewBlocked || codeEditing
            }
            onClick={quote}
          >
            {pending
              ? "Verifying changes…"
              : locked
                ? "Retry same quote request"
                : "Review changes"}
          </Button>
        </div>
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
  isUncertain,
  error,
  onCommit,
  onRefresh,
  onAbandon,
  audience = "staff",
  onCodesChange,
}: {
  operation: OrderEditOperation;
  now: number;
  busy: boolean;
  isUncertain: boolean;
  error: string | null;
  onCommit(): void;
  onRefresh(): void;
  onAbandon(): void;
  audience?: "staff" | "customer";
  onCodesChange?: (codes: string[]) => Promise<void>;
}) {
  const [codeEditing, setCodeEditing] = useState(false);
  const copy = orderEditStatusCopy[operation.status];
  const title =
    audience === "customer" && operation.status === "review_required"
      ? "Review needed"
      : copy.title;
  const description =
    audience === "customer" && operation.status === "review_required"
      ? "We need to check these changes. Contact us with the edit reference below."
      : audience === "customer" && operation.status === "synchronizing"
        ? "Your order is being updated. Check its status again shortly."
        : copy.description;
  const payable = operation.balanceDueCents > 0;
  const refundable = operation.refundDueCents > 0;
  const paymentUrl =
    operation.status === "awaiting_payment"
      ? safeOrderEditPaymentUrl(operation.paymentUrl)
      : null;
  const money = (value: number) =>
    formatOrderEditMoney(value, operation.currency);
  const expired =
    operation.expiresAt !== null && Date.parse(operation.expiresAt) <= now;
  // A fresh customer review needs only Apply and Change items. Retain the
  // existing recovery action when payment, expiry, or an uncertain reply needs
  // a status check; this action can reconcile the edit, so it is never automated.
  const showStatusCheck =
    audience !== "customer" ||
    operation.status !== "ready" ||
    expired ||
    isUncertain ||
    error !== null ||
    operation.error !== null;
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
        <p className="text-sm text-muted-foreground">
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
        {operation.paymentDeadline && (
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
        {operation.error && <ErrorMessage text={operation.error.message} />}
        <ErrorMessage text={error} />
        {isUncertain && (
          <p role="status" className="text-sm">
            The last request may have completed. Check this operation’s status
            before continuing.
          </p>
        )}
        {operation.status === "ready" && expired && (
          <p role="status" className="text-sm">
            This quote has expired. Check status before continuing.
          </p>
        )}
        <div className="oe-editor-footer">
          {operation.status === "ready" && (
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
          {operation.canAbandon && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || isUncertain}
              onClick={onAbandon}
            >
              {operation.status === "ready" ? "Change items" : "Cancel edit"}
            </Button>
          )}
          {paymentUrl && (
            <Button asChild variant="outline">
              <a href={paymentUrl} target="_blank" rel="noopener noreferrer">
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
              disabled={busy}
              onClick={onRefresh}
            >
              {busy ? "Checking…" : "Check status"}
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

export default function OrderEdits() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("orders", "edit");
  const canConfigure = hasPermission("settings", "edit");
  const api = useMemo(() => createOrderEditTransport(), []);
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const searchParams = useSearch();
  const operationId = orderEditOperationFromSearch(searchParams);
  const invalidLink =
    new URLSearchParams(searchParams).has("operationId") && !operationId;
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [orderId, setOrderId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [isUncertain, setIsUncertain] = useState(false);
  const [draftLocked, setDraftLocked] = useState(false);
  const [changingItems, setChangingItems] = useState(false);
  const [closedOperationId, setClosedOperationId] = useState<string>();
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const [savedQuote, setSavedQuote] = useState<OrderEditQuoteInput | null>(
    null,
  );
  const [savedQuoteError, setSavedQuoteError] = useState<string | null>(null);
  const [savedQuoteLoaded, setSavedQuoteLoaded] = useState(false);
  const [savedQuoteRejected, setSavedQuoteRejected] = useState(false);
  const inflight = useRef(false);
  const draftOperationId = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setSavedQuoteLoaded(false);
    setSavedQuote(null);
    setSavedQuoteError(null);
    setSavedQuoteRejected(false);
    draftOperationId.current = null;
    setChangingItems(false);
    if (!canEdit || !user) return;
    try {
      setSavedQuote(loadPendingOrderEditQuote(user.id, sessionStorage));
    } catch (failure) {
      setSavedQuoteError(message(failure));
    } finally {
      setSavedQuoteLoaded(true);
    }
  }, [canEdit, user?.id]);
  const state = useQuery({
    queryKey: [ORDER_EDITS_API, user?.id, "state"],
    enabled: canEdit,
    queryFn: ({ signal }) => {
      if (!canEdit) throw new Error("Order editing permission is required.");
      return api.state(signal);
    },
  });
  const connections = canEdit ? (state.data?.connections ?? []) : [];
  const selectedId =
    connectionId ??
    (connections.length === 1 ? connections[0].connectionId : null);
  const connection =
    connections.find((entry) => entry.connectionId === selectedId) ?? null;
  const orderSearch = useDebounce(search.trim(), 300);
  const orders = useQuery({
    queryKey: [ORDER_EDITS_API, user?.id, "orders", selectedId, orderSearch],
    enabled:
      canEdit &&
      !!connection &&
      orderSearch.length > 0 &&
      !operationId &&
      !invalidLink &&
      savedQuoteLoaded &&
      !savedQuote &&
      !savedQuoteError,
    queryFn: ({ signal }) => {
      if (!canEdit || !connection)
        throw new Error("Choose a Shopify connection.");
      return api.orders(connection.connectionId, orderSearch, signal);
    },
  });
  const detail = useQuery({
    queryKey: [ORDER_EDITS_API, user?.id, "order", selectedId, orderId],
    // Returning from a verified cancellation reuses the existing draft. Quote
    // and commit each revalidate its revision against Shopify independently.
    staleTime: Infinity,
    enabled:
      canEdit &&
      !!connection &&
      orderId !== null &&
      !operationId &&
      !invalidLink &&
      savedQuoteLoaded &&
      !savedQuote &&
      !savedQuoteError,
    queryFn: ({ signal }) => {
      if (!canEdit || !connection || orderId === null)
        throw new Error("Choose an order.");
      return api.order(connection.connectionId, orderId, signal);
    },
  });
  const operation = useQuery({
    queryKey: [ORDER_EDITS_API, user?.id, "operation", operationId],
    enabled: canEdit && operationId !== null,
    queryFn: ({ signal }) => {
      if (!canEdit || !operationId) throw new Error("Choose an operation.");
      return api.operation(operationId, signal);
    },
    refetchInterval: (query) =>
      query.state.data &&
      query.state.data.status !== "ready" &&
      !finished.has(query.state.data.status)
        ? 5_000
        : false,
  });
  function received(result: OrderEditOperation, resolvesQuote = false) {
    client.setQueryData(
      [ORDER_EDITS_API, user?.id, "operation", result.operationId],
      result,
    );
    setOperationError(null);
    setIsUncertain(false);
    navigate(
      `${ORDER_EDITS_PATH}?operationId=${encodeURIComponent(result.operationId)}`,
      { replace: true },
    );
    if (resolvesQuote) {
      draftOperationId.current = detail.data ? result.operationId : null;
      setDraftLocked(false);
      setSavedQuote(null);
    }
    // A separately opened operation must not discard another unresolved quote request.
    if (resolvesQuote && user) {
      try {
        clearPendingOrderEditQuote(user.id, sessionStorage);
        setSavedQuoteError(null);
      } catch {
        setSavedQuoteError(
          "The completed request reference could not be cleared from this browser.",
        );
      }
    }
  }
  async function resumeQuote() {
    if (!canEdit || !savedQuote || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setSavedQuoteError(null);
    try {
      received(await api.quote(savedQuote), true);
    } catch (failure) {
      setSavedQuoteError(message(failure));
      if (!uncertain(failure) && user) {
        try {
          clearPendingOrderEditQuote(user.id, sessionStorage);
          setSavedQuote(null);
          setSavedQuoteRejected(true);
        } catch {
          setSavedQuoteError(
            "The saved request could not be cleared. Retry this request before preparing another edit.",
          );
        }
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  async function progress(action: "commit" | "reconcile" | "abandon") {
    if (!canEdit || !operationId || !operation.data || inflight.current) return;
    if (
      action === "commit" &&
      (isUncertain ||
        operation.isFetching ||
        operation.isError ||
        !orderEditCanCommit(operation.data, Date.now()))
    )
      return;
    if (
      action === "abandon" &&
      (isUncertain ||
        operation.isFetching ||
        operation.isError ||
        !operation.data.canAbandon)
    )
      return;
    inflight.current = true;
    setBusy(true);
    setOperationError(null);
    if (
      action === "abandon" &&
      operation.data.status === "ready" &&
      draftOperationId.current === operationId &&
      detail.data &&
      detail.data.orderNumber === operation.data.orderNumber &&
      !detail.data.activeOperationId
    ) {
      // Show the still-mounted draft now; retain the operation URL until its
      // cancellation succeeds so a reload can reconcile an unknown outcome.
      setChangingItems(true);
    }
    try {
      const result = await api[action](operationId);
      received(result);
      if (
        action === "abandon" &&
        (result.status === "expired" || result.status === "recovered")
      ) {
        setClosedOperationId(result.operationId);
        setChangingItems(false);
        // Cancellation verified that the original order is unchanged. Reuse
        // the draft; the next quote checks its revision again server-side.
        setDraftLocked(false);
        if (draftOperationId.current !== result.operationId) setOrderId(null);
        navigate(ORDER_EDITS_PATH, { replace: true });
      }
    } catch (failure) {
      setOperationError(message(failure));
      setIsUncertain(uncertain(failure));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  if (!canEdit)
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Order editor pilot</h1>
        <p className="mt-2 text-sm">
          Order editing permission is required. No order data is shown.
        </p>
      </div>
    );
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">Order editor pilot</h1>
          <Badge variant="outline">Staff only</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Changes apply to the original Shopify order. Customer access is off.
          This pilot does not request order-update or refund emails.
        </p>
      </header>
      {invalidLink ? (
        <ErrorMessage text="This operation link is invalid. Use the exact saved operation link." />
      ) : operationId && !changingItems ? (
        <>
          {operation.isLoading && <p role="status">Loading order edit…</p>}
          <ErrorMessage
            text={operation.error ? message(operation.error) : null}
          />
          {operation.data && (
            <OrderEditOperationView
              operation={operation.data}
              now={now}
              busy={busy || operation.isFetching}
              isUncertain={isUncertain || operation.isError}
              error={operationError}
              onCommit={() => void progress("commit")}
              onRefresh={() => void progress("reconcile")}
              onAbandon={() => void progress("abandon")}
            />
          )}
          {operation.isError && (
            <Button variant="outline" onClick={() => void operation.refetch()}>
              Retry status
            </Button>
          )}
          {operation.data &&
            finished.has(operation.data.status) &&
            !["failed", "review_required"].includes(operation.data.status) && (
              <Button
                variant="outline"
                onClick={() => {
                  setOrderId(null);
                  navigate(ORDER_EDITS_PATH);
                }}
              >
                Choose another order
              </Button>
            )}
        </>
      ) : changingItems ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {busy
              ? "Closing the previous quote. You can change items while this finishes."
              : "The previous quote must be closed before reviewing new totals."}
          </p>
          <ErrorMessage
            text={operationError ?? operation.data?.error?.message ?? null}
          />
          {!busy && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={isUncertain}
                onClick={() => void progress("abandon")}
              >
                Retry closing quote
              </Button>
              <Button variant="outline" onClick={() => setChangingItems(false)}>
                Back to review
              </Button>
            </div>
          )}
        </div>
      ) : savedQuote || savedQuoteError ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Resume saved quote request</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              A quote request is already saved in this browser. Resolve it
              before creating another order edit.
            </p>
            <ErrorMessage text={savedQuoteError} />
            {savedQuote && (
              <Button disabled={busy} onClick={() => void resumeQuote()}>
                {busy ? "Checking saved request…" : "Resume saved request"}
              </Button>
            )}
            {savedQuoteRejected && (
              <Button
                variant="outline"
                onClick={() => {
                  setSavedQuoteError(null);
                  setSavedQuoteRejected(false);
                }}
              >
                Choose another order
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {state.isLoading && <p role="status">Loading Shopify connections…</p>}
          <ErrorMessage text={state.error ? message(state.error) : null} />
          {state.isError && (
            <Button variant="outline" onClick={() => void state.refetch()}>
              Retry connections
            </Button>
          )}
          {!state.isLoading && !state.isError && connections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No Shopify connections are available.
            </p>
          )}
          {connections.length > 0 && savedQuoteLoaded && (
            <Card>
              <CardContent className="space-y-4 pt-6">
                <div className="space-y-2">
                  <Label htmlFor="edit-shopify-connection">
                    Shopify connection
                  </Label>
                  <select
                    id="edit-shopify-connection"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={selectedId ?? ""}
                    disabled={draftLocked}
                    onChange={(event) => {
                      setConnectionId(
                        event.target.value ? Number(event.target.value) : null,
                      );
                      setOrderId(null);
                      setSearch("");
                    }}
                  >
                    <option value="">Choose a Shopify connection</option>
                    {connections.map((entry) => (
                      <option
                        key={entry.connectionId}
                        value={entry.connectionId}
                      >
                        {entry.name} · {entry.shopDomain}
                      </option>
                    ))}
                  </select>
                </div>
                {connection && (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant="outline">
                        {connection.enabled
                          ? "Staff edits enabled"
                          : "Staff edits disabled"}
                      </Badge>
                      <span className="text-muted-foreground">
                        Payment window:{" "}
                        {connection.paymentWindowMinutes === null
                          ? "Not configured"
                          : formatOrderEditPaymentWindowHours(
                              connection.paymentWindowMinutes,
                            )}
                      </span>
                    </div>
                    {canConfigure && !draftLocked && (
                      <ConnectionSettings
                        key={connection.connectionId}
                        connection={connection}
                        api={api}
                        detailsRef={settingsRef}
                        onSaved={async (saved) => {
                          const stateKey = [ORDER_EDITS_API, user?.id, "state"];
                          // A state read started before the save must not restore old enablement.
                          await client.cancelQueries({
                            queryKey: stateKey,
                            exact: true,
                          });
                          client.setQueryData<OrderEditState>(
                            stateKey,
                            (current) => ({
                              customerAccess: false,
                              connections: (
                                current?.connections ?? connections
                              ).map((item) =>
                                item.connectionId === saved.connectionId
                                  ? saved
                                  : item,
                              ),
                            }),
                          );
                          await client.invalidateQueries({
                            queryKey: [
                              ORDER_EDITS_API,
                              user?.id,
                              "order",
                              saved.connectionId,
                            ],
                          });
                        }}
                      />
                    )}
                    {!connection.enabled && (
                      <p className="text-sm text-muted-foreground">
                        Order edits are disabled for this connection.{" "}
                        {canConfigure
                          ? "Configure a payment window and enable staff edits above."
                          : "An administrator must configure and enable this pilot."}
                      </p>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="edit-order-search">Find an order</Label>
                      <Input
                        id="edit-order-search"
                        maxLength={100}
                        value={search}
                        disabled={draftLocked}
                        placeholder="Order number, customer name or email"
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                    {orders.isFetching && (
                      <p role="status" className="text-sm">
                        Searching orders…
                      </p>
                    )}
                    <ErrorMessage
                      text={orders.error ? message(orders.error) : null}
                    />
                    {!orders.isFetching &&
                      !orders.isError &&
                      orders.data?.orders.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No matching Shopify orders.
                        </p>
                      )}
                    <div className="divide-y">
                      {orders.data?.orders.map((order) => (
                        <button
                          key={order.omsOrderId}
                          type="button"
                          disabled={draftLocked}
                          className="flex w-full flex-wrap items-center justify-between gap-2 rounded-sm p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
                          onClick={() => {
                            if (order.activeOperationId) {
                              navigate(
                                `${ORDER_EDITS_PATH}?operationId=${encodeURIComponent(order.activeOperationId)}`,
                              );
                              return;
                            }
                            setOrderId(order.omsOrderId);
                          }}
                        >
                          <span className="text-sm font-medium">
                            {order.orderNumber}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {order.customerName}
                            {order.customerEmail
                              ? ` · ${order.customerEmail}`
                              : ""}
                          </span>
                          {order.activeOperationId && (
                            <span className="text-sm font-medium text-primary">
                              Resume edit
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}
          {detail.isLoading && orderId !== null && (
            <p role="status">Verifying order eligibility…</p>
          )}
          <ErrorMessage text={detail.error ? message(detail.error) : null} />
          {detail.isError && (
            <Button variant="outline" onClick={() => void detail.refetch()}>
              Retry order
            </Button>
          )}
          {detail.data?.activeOperationId && (
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <p className="text-sm">
                  {detail.data.orderNumber} already has an active edit. Resume
                  it to check its status or continue.
                </p>
                <Button
                  onClick={() => {
                    if (detail.data?.activeOperationId)
                      navigate(
                        `${ORDER_EDITS_PATH}?operationId=${encodeURIComponent(detail.data.activeOperationId)}`,
                      );
                  }}
                >
                  Resume edit
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}
      {detail.data &&
        !detail.data.activeOperationId &&
        connection &&
        user &&
        canEdit &&
        savedQuoteLoaded &&
        !invalidLink && (
          <div
            hidden={
              (!!operationId && !changingItems) ||
              !!savedQuote ||
              !!savedQuoteError
            }
          >
            <OrderDraft
              key={`${detail.data.omsOrderId}:${detail.data.revision}`}
              order={detail.data}
              api={api}
              enabled={connection.enabled}
              staffId={user.id}
              reviewBlocked={!!operationId || busy}
              closedOperationId={closedOperationId}
              active={!operationId && !savedQuote && !savedQuoteError}
              onLock={setDraftLocked}
              onConfigure={
                canConfigure && !draftLocked
                  ? () => {
                      const settings = settingsRef.current;
                      if (!settings) return;
                      settings.open = true;
                      settings.scrollIntoView({ block: "center" });
                      settings
                        .querySelector<HTMLInputElement>("#edit-payment-window")
                        ?.focus({ preventScroll: true });
                    }
                  : undefined
              }
              onQuote={(result) => received(result, true)}
            />
          </div>
        )}
    </div>
  );
}

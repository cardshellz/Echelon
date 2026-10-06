import React, { useEffect, useMemo, useRef, useState } from "react";
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
  type OrderEditVariant,
} from "@shared/order-edits/order-edit.contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { useDebounce } from "@/hooks/use-debounce";
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
}: {
  order: OrderEditOrder;
  api: OrderEditTransport;
  enabled: boolean;
  staffId: string;
  onQuote(operation: OrderEditOperation): void;
  onLock(locked: boolean): void;
  onConfigure?: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      order.lines.map((line) => [line.lineItemId, String(line.quantity)]),
    ),
  );
  const [additions, setAdditions] = useState<
    Array<{ variant: OrderEditVariant; quantity: string }>
  >([]);
  const [productSearch, setProductSearch] = useState("");
  const search = useDebounce(productSearch.trim(), 300);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const inflight = useRef(false);
  const command = useRef<OrderEditQuoteInput | null>(null);
  const canEdit = order.eligibility.editable && enabled;
  const variants = useQuery({
    queryKey: [
      ORDER_EDITS_API,
      staffId,
      "variants",
      order.connectionId,
      search,
    ],
    queryFn: ({ signal }) => api.variants(order.connectionId, search, signal),
    enabled: canEdit && search.length >= 2 && !locked,
  });
  const mutable = canEdit && !pending && !locked;
  function updateQuantity(id: string, value: string) {
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
    connectionId: order.connectionId,
    omsOrderId: order.omsOrderId,
    expectedRevision: order.revision,
    changes,
    additions: additions.map((item) => ({
      variantId: item.variant.variantId,
      quantity: item.quantity.trim() ? Number(item.quantity) : Number.NaN,
    })),
  };
  // The placeholder validates the draft without minting a new command identity during render.
  const validation = orderEditQuoteInputSchema.safeParse({
    ...input,
    requestKey: "00000000-0000-4000-8000-000000000000",
  });
  const valid = validation.success;
  const validationMessage =
    !validation.success && changes.length + additions.length > 0
      ? `Check the item quantities: ${validation.error.issues[0]?.message ?? "Enter valid whole numbers."}`
      : null;
  async function quote() {
    if (!canEdit || !valid || inflight.current) return;
    inflight.current = true;
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
  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle>
          <h2>Order {order.orderNumber}</h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {order.customerName}
          {order.customerEmail ? ` · ${order.customerEmail}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">Payment: {order.financialStatus}</Badge>
          <Badge variant="outline">Warehouse: {order.warehouseStatus}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!enabled && (
          <div className="space-y-3 rounded-md border bg-muted/40 p-3">
            <p role="status" className="text-sm">
              Staff order editing is disabled for this Shopify connection.{" "}
              {onConfigure
                ? "Choose a payment window and save enabled pilot settings to edit eligible orders."
                : "Ask an administrator with settings permission to configure and enable staff edits."}
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
        <div className="divide-y rounded-md border">
          {order.lines.map((line) => (
            <div
              key={line.lineItemId}
              className="flex flex-wrap items-center gap-3 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{line.title}</p>
                <p className="text-xs text-muted-foreground">
                  {[line.variantTitle, line.sku].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {line.quantity} originally ·{" "}
                  {formatOrderEditMoney(line.unitPriceCents, order.currency)}{" "}
                  each
                </p>
              </div>
              <div className="w-24 space-y-1">
                <Label htmlFor={`line-${line.lineItemId}`} className="text-xs">
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
            </div>
          ))}
          {additions.map((item, index) => (
            <div
              key={item.variant.variantId}
              className="flex flex-wrap items-center gap-3 bg-muted/30 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {item.variant.title} <Badge variant="outline">Added</Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  {[item.variant.variantTitle, item.variant.sku]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Input
                className="w-24"
                type="number"
                min={1}
                step={1}
                aria-label={`Quantity for added ${item.variant.title}`}
                value={item.quantity}
                disabled={!mutable}
                onChange={(event) => {
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!mutable}
                onClick={() => {
                  command.current = null;
                  setAdditions((current) =>
                    current.filter(
                      (row) => row.variant.variantId !== item.variant.variantId,
                    ),
                  );
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Set quantity to 0 to remove a line. Prices, discounts and tax are
          verified by the server. The original shipping charge stays the same
          during this pilot.
        </p>
        {canEdit && (
          <div className="space-y-2">
            <Label htmlFor="edit-add-products">Add products</Label>
            <Input
              id="edit-add-products"
              value={productSearch}
              maxLength={100}
              disabled={!mutable}
              placeholder="Search product name or SKU"
              onChange={(event) => setProductSearch(event.target.value)}
            />
            {search.length >= 2 && (
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {variants.isFetching && (
                  <p role="status" className="p-3 text-sm">
                    Searching Shopify products…
                  </p>
                )}
                <ErrorMessage
                  text={variants.error ? message(variants.error) : null}
                />
                {!variants.isFetching &&
                  !variants.isError &&
                  variants.data?.variants.length === 0 && (
                    <p className="p-3 text-sm text-muted-foreground">
                      No matching Shopify variants.
                    </p>
                  )}
                {variants.data?.variants.map((variant) => {
                  const included =
                    order.lines.some(
                      (line) => line.variantId === variant.variantId,
                    ) ||
                    additions.some(
                      (item) => item.variant.variantId === variant.variantId,
                    );
                  return (
                    <div
                      key={variant.variantId}
                      className="flex items-center gap-3 border-b p-3 last:border-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{variant.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {[variant.variantTitle, variant.sku]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!mutable || included || !variant.available}
                        onClick={() => {
                          command.current = null;
                          setAdditions((current) => [
                            ...current,
                            { variant, quantity: "1" },
                          ]);
                        }}
                      >
                        {included
                          ? "Already in order"
                          : !variant.available
                            ? "Cannot add"
                            : "Add"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Shipping address changes are not supported in this pilot.
        </p>
        <ErrorMessage text={validationMessage} />
        <ErrorMessage text={error} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm">
            Current order total{" "}
            <strong>
              {formatOrderEditMoney(order.totalCents, order.currency)}
            </strong>
          </p>
          <Button
            type="button"
            disabled={!canEdit || !valid || pending}
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

export function OrderEditOperationView({
  operation,
  now,
  busy,
  isUncertain,
  error,
  onCommit,
  onRefresh,
  onAbandon,
}: {
  operation: OrderEditOperation;
  now: number;
  busy: boolean;
  isUncertain: boolean;
  error: string | null;
  onCommit(): void;
  onRefresh(): void;
  onAbandon(): void;
}) {
  const copy = orderEditStatusCopy[operation.status];
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Order {operation.orderNumber}</h2>
        </CardTitle>
        <div>
          <Badge variant="outline">{copy.title}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {operation.status === "review_required" && operation.canAbandon
            ? "This edit needs review. You can cancel this unsubmitted edit, or keep its reference for investigation."
            : copy.description}
        </p>
        {["completed", "recovered", "expired"].includes(operation.status) && (
          <p className="text-xs text-muted-foreground">
            The reviewed changes below are retained for reference. Payment and
            refund amounts are the quoted differences.
          </p>
        )}
        <div className="divide-y rounded-md border">
          {operation.lines.map((line) => (
            <div key={line.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{line.title}</p>
                {line.variantTitle && (
                  <p className="text-xs text-muted-foreground">
                    {line.variantTitle}
                  </p>
                )}
              </div>
              <p className="text-sm">Qty {line.quantity}</p>
              <p className="text-sm tabular-nums">{money(line.totalCents)}</p>
            </div>
          ))}
        </div>
        <dl className="ml-auto grid max-w-sm grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt>Original total</dt>
          <dd className="text-right tabular-nums">
            {money(operation.previousTotalCents)}
          </dd>
          <dt>Quoted total</dt>
          <dd className="text-right tabular-nums">
            {money(operation.updatedTotalCents)}
          </dd>
          {payable && (
            <>
              <dt className="font-semibold">Payment difference</dt>
              <dd className="text-right font-semibold tabular-nums">
                {money(operation.balanceDueCents)}
              </dd>
            </>
          )}
          {refundable && (
            <>
              <dt className="font-semibold">Refund difference</dt>
              <dd className="text-right font-semibold tabular-nums">
                {money(operation.refundDueCents)}
              </dd>
            </>
          )}
        </dl>
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
            {operation.warnings.map((warning, index) => (
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
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {operation.status === "ready" && (
            <>
              <Button
                type="button"
                disabled={
                  busy || isUncertain || !orderEditCanCommit(operation, now)
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
                Open Shopify payment
              </a>
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onRefresh}
          >
            {busy ? "Checking…" : "Check status"}
          </Button>
        </div>
        <p className="break-all text-xs text-muted-foreground">
          Operation {operation.operationId}
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
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const [savedQuote, setSavedQuote] = useState<OrderEditQuoteInput | null>(
    null,
  );
  const [savedQuoteError, setSavedQuoteError] = useState<string | null>(null);
  const [savedQuoteLoaded, setSavedQuoteLoaded] = useState(false);
  const [savedQuoteRejected, setSavedQuoteRejected] = useState(false);
  const inflight = useRef(false);
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
      query.state.data && !finished.has(query.state.data.status)
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
    try {
      const result = await api[action](operationId);
      received(result);
      if (
        action === "abandon" &&
        (result.status === "expired" || result.status === "recovered")
      ) {
        await client.invalidateQueries({
          queryKey: [ORDER_EDITS_API, user?.id, "order"],
        });
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
      ) : operationId ? (
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
          {detail.data &&
            !detail.data.activeOperationId &&
            connection &&
            user &&
            savedQuoteLoaded && (
              <OrderDraft
                key={`${detail.data.omsOrderId}:${detail.data.revision}`}
                order={detail.data}
                api={api}
                enabled={connection.enabled}
                staffId={user.id}
                onLock={setDraftLocked}
                onConfigure={
                  canConfigure && !draftLocked
                    ? () => {
                        const settings = settingsRef.current;
                        if (!settings) return;
                        settings.open = true;
                        settings.scrollIntoView({ block: "center" });
                        settings
                          .querySelector<HTMLInputElement>(
                            "#edit-payment-window",
                          )
                          ?.focus({ preventScroll: true });
                      }
                    : undefined
                }
                onQuote={(result) => received(result, true)}
              />
            )}
        </>
      )}
    </div>
  );
}

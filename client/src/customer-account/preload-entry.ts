import { formatAccountUsdCents } from "./account-display-money";
import { z } from "zod";
import { knownCustomerOrderFulfillment } from "@shared/customer-account/order-fulfillment";
import {
  accountOverviewClient,
  type AccountOverviewHandoff,
  type AccountDisplay,
} from "./account-overview-client";
import { customerAccountPageConfigSchema } from "./account-page-config";
import {
  customerPaymentPresentation,
  orderDeliveryLabel,
  returnProgressLabel,
} from "./customer-order-progress-presentation";

const asset = z
  .string()
  .min(1)
  .max(2048)
  .transform((value) => new URL(value, location.origin).href)
  .refine((value) => {
    const url = new URL(value, location.origin);
    return (
      url.protocol === "https:" &&
      (url.origin === location.origin ||
        url.hostname === "cdn.shopify.com" ||
        url.hostname.endsWith(".myshopify.com"))
    );
  });
const schema = z
  .object({
    config: customerAccountPageConfigSchema,
    orders: z.array(z.unknown()).max(20),
    bundleUrl: asset,
    cssUrl: asset,
  })
  .strict();
const element = document.getElementById(
  "csz-customer-account-preload",
) as AccountOverviewHandoff | null;
const rows = Array.from(
  document.querySelectorAll<HTMLElement>("[data-csz-account-order]"),
);

function showLoadFailure(): void {
  const root = document.querySelector<HTMLElement>(
    "[data-csz-customer-account]",
  );
  if (!root) return;
  const history = root.querySelector<HTMLElement>(
    "[data-csz-order-history-content]",
  );
  root.querySelector("[data-csz-order-history-status]")?.replaceChildren();
  const target = root.querySelector("[data-csz-account-tools-status]");
  const notice = document.createElement("p");
  notice.setAttribute("role", "alert");
  notice.textContent = history
    ? "Your orders could not be loaded. Please refresh this page."
    : "Order options could not be loaded. Please refresh this page.";
  if (history) history.hidden = false;
  if (!history)
    root.querySelectorAll("[data-csz-order-financials]").forEach((node) => {
      node.textContent = "Order details could not be loaded.";
    });
  target?.replaceChildren(notice);
}

function paint(display: AccountDisplay): void {
  for (const row of rows) {
    const order = display.summaries.orders.find(
      (item) =>
        item.externalOrderId === row.dataset.externalOrderId &&
        item.orderReference === row.dataset.orderReference,
    );
    if (!order) continue;
    const text = (selector: string, value: string | null | undefined) => {
      const target = row.querySelector<HTMLElement>(selector);
      if (target) target.textContent = value ?? "";
    };
    text(
      "[data-csz-order-total]",
      `${formatAccountUsdCents(order.totalCents)} ${order.currency}`,
    );
    const payment = customerPaymentPresentation(
      order.financialStatus,
      order.progress,
    );
    text(
      "[data-csz-order-financial-status]",
      payment.label + (payment.detail ? ` · ${payment.detail}` : ""),
    );
    const delivery = orderDeliveryLabel(
      order.cancelled,
      order.fulfillment,
      order.progress,
      "Status unavailable",
      row.dataset.fulfillment,
    );
    const returned = returnProgressLabel(order.progress);
    const nativeDeliveryKnown = Boolean(
      knownCustomerOrderFulfillment(order.fulfillment) ||
        order.progress?.delivery,
    );
    text("[data-csz-order-fulfillment]", nativeDeliveryKnown ? delivery : null);
    text("[data-csz-order-return-status]", returned);
    for (const selector of [
      "[data-csz-order-financial-native]",
      "[data-csz-order-fulfillment-native]",
    ]) {
      const native = row.querySelector<HTMLElement>(selector);
      if (native)
        native.hidden =
          selector === "[data-csz-order-financial-native]" ||
          nativeDeliveryKnown;
    }
    const tracks: Array<[string, boolean]> = [
      ["[data-csz-order-order-track]", !order.cancelled],
      ["[data-csz-order-delivery-track]", !delivery],
      ["[data-csz-order-return-track]", !returned],
    ];
    for (const [selector, hidden] of tracks) {
      const target = row.querySelector<HTMLElement>(selector);
      if (target) target.hidden = hidden;
    }
  }
  const content = document.querySelector<HTMLElement>(
    "[data-csz-order-history-content]",
  );
  if (content && display.summaries.orders.length) {
    content.hidden = false;
    document
      .querySelector("[data-csz-order-history-status]")
      ?.replaceChildren();
  }
}

if (element) {
  try {
    const settings = schema.parse(
      JSON.parse(element.dataset.config ?? element.textContent ?? "null"),
    );
    const orders = rows.length
      ? rows.map((row) => ({
          externalOrderId: row.dataset.externalOrderId,
          orderReference: row.dataset.orderReference,
        }))
      : settings.orders;
    if (orders.length) {
      let storage: Storage | undefined;
      try {
        storage = sessionStorage;
      } catch {
        /* Private storage is optional. */
      }
      const client = accountOverviewClient(
        settings.config,
        { orders },
        { storage, now: Date.now, request: fetch, origin: location.origin },
      );
      const display = client.readCache();
      if (display) paint(display);
      if (!display || rows.length) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const request = client
          .read(controller.signal)
          .then((result) => {
            // React takes ownership of these targets once the full panel mounts.
            // Updating the handoff remains safe; do not overwrite its portal DOM.
            if (element.dataset.adopted !== "true") paint(result);
            if (element.accountOverview)
              element.accountOverview.display = result;
            return result;
          })
          .finally(() => clearTimeout(timer));
        element.accountOverview = { key: client.key, display, request };
        void request.catch(() => {
          /* The account UI owns actionable retry/sign-in notices. */
        });
      }
    }
    if (document.querySelector("[data-csz-customer-account]")) {
      // The order read starts before the large editor/returns UI downloads.
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = settings.cssUrl;
      const loadBundle = () => {
        const script = document.createElement("script");
        script.src = settings.bundleUrl;
        script.defer = true;
        script.onerror = showLoadFailure;
        document.body.append(script);
      };
      css.onload = loadBundle;
      css.onerror = loadBundle; // The existing UI reports failures; don't strand all controls on a CSS network error.
      document.head.append(css);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "account_preload_configuration_failed",
        code: "ACCOUNT_PRELOAD_INVALID",
        issues:
          error instanceof z.ZodError
            ? error.issues.map((issue) => ({
                path: issue.path.join("."),
                code: issue.code,
              }))
            : [],
      }),
    );
    // Invalid configuration must never initiate an unbound request or load code
    // from an arbitrary host. The server-rendered account links remain usable.
    element.dataset.failed = "true";
    showLoadFailure();
  }
}

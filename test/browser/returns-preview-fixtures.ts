import type { Page } from "@playwright/test";
import {
  CustomerReturnPreviewError,
  CustomerReturnPreviewService,
} from "../../server/modules/returns/application/customer-return-preview.service";
import { CUSTOMER_RETURN_PREVIEW_API_PATH } from "../../shared/returns/customer-return-portal-paths";
import {
  customerReturnLiveLookupInputSchema,
  customerReturnLiveReviewInputSchema,
} from "../../shared/returns/customer-return-live.contract";

export const PREVIEW_API = CUSTOMER_RETURN_PREVIEW_API_PATH;

interface ReturnPreviewFixtureOptions {
  role?: string | null;
  loginRole?: string | null;
  shops?: { channelId: number; name: string }[];
}

/** Browser rendering/interaction adapter only. Every API request is intercepted;
 * separate HTTP tests exercise the real authorization gate with injected session
 * and identity facts. */
export async function installReturnPreviewFixtures(
  page: Page,
  options: ReturnPreviewFixtureOptions | string | null = {},
) {
  const configured: ReturnPreviewFixtureOptions =
    typeof options === "string" || options === null
      ? { role: options }
      : options;
  let role = configured.role === undefined ? "admin" : configured.role;
  let loginRole =
    configured.loginRole === undefined ? "admin" : configured.loginRole;
  const service = new CustomerReturnPreviewService();
  const shops = configured.shops ?? [
    { channelId: 36, name: "Fixture Shopify shop" },
  ];
  // Browser-only fixtures for the live HTTP shape. They exercise rendering and
  // request binding, never real Shopify/provider reads or semantic revisions.
  function liveState() {
    return {
      mode: "admin_live",
      customerAccess: "disabled",
      effects: "none",
      shops,
    };
  }
  function liveOrder(channelId = 36) {
    const {
      mode: _mode,
      scenarioId: _scenario,
      ...fields
    } = service.lookup({
      scenarioId: "split_delivered",
      orderReference: "TEST-1001",
    });
    return {
      ...fields,
      mode: "admin_live",
      orderReference: "#LIVE-1001",
      sourceRevision: String(channelId).padStart(64, "0"),
    };
  }
  const failures: string[] = [];
  const previewRequests: { path: string; method: string; body: unknown }[] = [];
  // Record transport sequence without copying even fictional passwords into logs.
  const authRequests: { path: string; method: string }[] = [];
  await page.addInitScript(() => {
    const observedWindow = window as typeof window & {
      returnPreviewPwaRegistrations: string[];
    };
    observedWindow.returnPreviewPwaRegistrations = [];
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register = async (scriptUrl) => {
        observedWindow.returnPreviewPwaRegistrations.push(String(scriptUrl));
        throw new Error(
          "Service worker registration is disabled in this browser test.",
        );
      };
    }
  });
  function authBody(currentRole: string) {
    return {
      user: {
        id: `preview-test-${currentRole}`,
        username: "preview-test",
        role: currentRole,
        active: 1,
      },
      permissions: [],
      roles: currentRole === "admin" ? ["Administrator"] : [],
    };
  }

  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me" && request.method() === "GET") {
      authRequests.push({ path, method: request.method() });
      return role === null
        ? route.fulfill({
            status: 401,
            json: { error: "Authentication required" },
          })
        : route.fulfill({ json: authBody(role) });
    }
    if (path === "/api/auth/login" && request.method() === "POST") {
      authRequests.push({ path, method: request.method() });
      const body: unknown = request.postDataJSON();
      if (
        typeof body !== "object" ||
        body === null ||
        !("username" in body) ||
        !("password" in body) ||
        typeof body.username !== "string" ||
        typeof body.password !== "string" ||
        !body.username ||
        !body.password ||
        loginRole === null
      ) {
        return route.fulfill({
          status: 401,
          json: { error: "Invalid username or password" },
        });
      }
      role = loginRole;
      return route.fulfill({ json: authBody(role) });
    }
    if (path === PREVIEW_API || path.startsWith(`${PREVIEW_API}/`)) {
      const body: unknown =
        request.method() === "POST" || request.method() === "PUT"
          ? request.postDataJSON()
          : null;
      previewRequests.push({ path, method: request.method(), body });
      if (role !== "admin") {
        return route.fulfill({
          status: role === null ? 401 : 403,
          json: {
            error: {
              code: "ADMIN_REQUIRED",
              message: "Administrator access is required.",
            },
          },
        });
      }
      try {
        if (path === PREVIEW_API && request.method() === "GET")
          return route.fulfill({ json: service.getState() });
        if (path === `${PREVIEW_API}/live` && request.method() === "GET")
          return route.fulfill({ json: liveState() });
        const labelSettingsMatch = path.match(/\/live\/label-settings\/(\d+)$/);
        if (labelSettingsMatch && request.method() === "GET") {
          return route.fulfill({
            json: {
              channelId: Number(labelSettingsMatch[1]),
              providerConfigured: false,
              settings: null,
              warehouses: [],
              policies: [],
              carriers: [],
              message:
                "The shipping provider is not configured. Label creation is unavailable.",
            },
          });
        }
        if (
          (path === `${PREVIEW_API}/live/order` ||
            path === `${PREVIEW_API}/live/review`) &&
          request.method() === "POST"
        ) {
          const input = path.endsWith("/order")
            ? customerReturnLiveLookupInputSchema.parse(body)
            : customerReturnLiveReviewInputSchema.parse(body);
          if (!shops.some((shop) => shop.channelId === input.channelId)) {
            return route.fulfill({
              status: 400,
              json: { error: { message: "Choose a configured Shopify shop." } },
            });
          }
          if (
            input.orderReference.trim().replace(/^#\s*/, "") !== "LIVE-1001"
          ) {
            return route.fulfill({
              status: 404,
              json: { error: { message: "This order could not be found." } },
            });
          }
          const order = liveOrder(input.channelId);
          if (path.endsWith("/order")) return route.fulfill({ json: order });
          const reviewInput = customerReturnLiveReviewInputSchema.parse(input);
          if (reviewInput.sourceRevision !== order.sourceRevision) {
            return route.fulfill({
              status: 409,
              json: {
                error: {
                  code: "RETURN_LIVE_REVIEW_CHANGED",
                  message: "Order availability changed.",
                },
              },
            });
          }
          const { mode: _mode, ...review } = service.review({
            scenarioId: "split_delivered",
            orderReference: "TEST-1001",
            selections: reviewInput.selections,
            parcels: reviewInput.parcels,
          });
          return route.fulfill({
            json: {
              ...review,
              mode: "admin_live",
              orderReference: order.orderReference,
              sourceRevision: order.sourceRevision,
            },
          });
        }
        if (path === `${PREVIEW_API}/order` && request.method() === "POST")
          return route.fulfill({ json: service.lookup(body) });
        if (path === `${PREVIEW_API}/review` && request.method() === "POST")
          return route.fulfill({ json: service.review(body) });
      } catch (error) {
        if (error instanceof CustomerReturnPreviewError) {
          return route.fulfill({
            status: error.status,
            json: { error: { code: error.code, message: error.message } },
          });
        }
        throw error;
      }
      failures.push(`Unexpected preview request: ${request.method()} ${path}`);
      return route.abort();
    }
    if (request.method() !== "GET") {
      failures.push(
        `Unexpected mutation outside preview: ${request.method()} ${path}`,
      );
      return route.abort();
    }
    return route.fulfill({ json: [] });
  });
  return {
    service,
    liveState,
    liveOrder,
    failures,
    previewRequests,
    authRequests,
    setRole(nextRole: string | null) {
      role = nextRole;
    },
    setLoginRole(nextRole: string | null) {
      loginRole = nextRole;
    },
  };
}

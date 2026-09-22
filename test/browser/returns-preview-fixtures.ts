import type { Page } from "@playwright/test";
import {
  CustomerReturnPreviewError,
  CustomerReturnPreviewService,
} from "../../server/modules/returns/application/customer-return-preview.service";

export const PREVIEW_API = "/api/returns/admin/portal-preview";

/** Browser rendering/interaction test adapter, never an application server or
 * login bypass. The separate HTTP tests exercise the real authorization gate. */
export async function installReturnPreviewFixtures(page: Page, role: string | null = "admin") {
  const service = new CustomerReturnPreviewService();
  const failures: string[] = [];
  const previewRequests: { path: string; method: string; body: unknown }[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") {
      return role === null
        ? route.fulfill({ status: 401, json: { error: "Authentication required" } })
        : route.fulfill({ json: {
          user: { id: "preview-test-admin", username: "preview-test", role, active: 1 },
          permissions: [], roles: role === "admin" ? ["Administrator"] : [],
        } });
    }
    if (path === PREVIEW_API || path.startsWith(`${PREVIEW_API}/`)) {
      const body: unknown = request.method() === "POST" ? request.postDataJSON() : null;
      previewRequests.push({ path, method: request.method(), body });
      if (role !== "admin") return route.fulfill({ status: 403, json: { error: { code: "ADMIN_REQUIRED", message: "Administrator access is required." } } });
      try {
        if (path === PREVIEW_API && request.method() === "GET") return route.fulfill({ json: service.getState() });
        if (path === `${PREVIEW_API}/order` && request.method() === "POST") return route.fulfill({ json: service.lookup(body) });
        if (path === `${PREVIEW_API}/review` && request.method() === "POST") return route.fulfill({ json: service.review(body) });
      } catch (error) {
        if (error instanceof CustomerReturnPreviewError) {
          return route.fulfill({ status: error.status, json: { error: { code: error.code, message: error.message } } });
        }
        throw error;
      }
      failures.push(`Unexpected preview request: ${request.method()} ${path}`);
      return route.abort();
    }
    if (request.method() !== "GET") {
      failures.push(`Unexpected mutation outside preview: ${request.method()} ${path}`);
      return route.abort();
    }
    return route.fulfill({ json: [] });
  });
  return { service, failures, previewRequests };
}

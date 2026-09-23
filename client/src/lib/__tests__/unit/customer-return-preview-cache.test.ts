import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_RETURN_PORTAL_PATH, CUSTOMER_RETURN_PORTAL_ACCESS_PATH,
  CUSTOMER_RETURN_PORTAL_LEGACY_PATH, CUSTOMER_RETURN_PREVIEW_API_PATH, isCustomerReturnPortalPath,
} from "@shared/returns/customer-return-portal-paths";

const workerSource = readFileSync(new URL("../../../../public/sw.js", import.meta.url), "utf8");

function workerHarness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn();
  const match = vi.fn().mockResolvedValue({ cached: true });
  runInNewContext(workerSource, {
    URL,
    fetch,
    caches: { match },
    self: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
  });
  function request(path: string): Promise<unknown> {
    let response: Promise<unknown> | undefined;
    listeners.get("fetch")!({
      request: { url: `https://echelon.example${path}` },
      respondWith: (value: Promise<unknown>) => { response = value; },
    });
    if (!response) throw new Error("The worker did not handle the request.");
    return response;
  }
  return { fetch, match, request };
}

describe("admin return preview cache isolation", () => {
  it.each([
    CUSTOMER_RETURN_PORTAL_PATH, CUSTOMER_RETURN_PORTAL_ACCESS_PATH, `${CUSTOMER_RETURN_PORTAL_ACCESS_PATH}/hidden`,
    `${CUSTOMER_RETURN_PORTAL_PATH}/?returnTo=untrusted`, "/RETURN-PORTAL/ACCESS",
    CUSTOMER_RETURN_PORTAL_LEGACY_PATH, `${CUSTOMER_RETURN_PORTAL_LEGACY_PATH}/?scenario=split_delivered`,
    CUSTOMER_RETURN_PREVIEW_API_PATH, `${CUSTOMER_RETURN_PREVIEW_API_PATH}/order`,
    `${CUSTOMER_RETURN_PREVIEW_API_PATH}/review`, "/RETURNS/PORTAL-PREVIEW",
  ])("never restores %s from an earlier session while offline", async (path) => {
    const worker = workerHarness();
    worker.fetch.mockRejectedValue(new Error("Offline"));
    await expect(worker.request(path)).rejects.toThrow("Offline");
    expect(worker.match).not.toHaveBeenCalled();
    expect(worker.fetch).toHaveBeenCalledWith(expect.anything(), { cache: "no-store" });
  });

  it.each([CUSTOMER_RETURN_PORTAL_PATH, CUSTOMER_RETURN_PORTAL_ACCESS_PATH, CUSTOMER_RETURN_PORTAL_LEGACY_PATH])("passes current server denial through for %s without a cache fallback", async path => {
    const worker = workerHarness();
    const denied = { status: 403 };
    worker.fetch.mockResolvedValue(denied);
    await expect(worker.request(path)).resolves.toBe(denied);
    expect(worker.match).not.toHaveBeenCalled();
  });

  it("passes the fixed sign-in redirect through without restoring a cached portal", async () => {
    const worker = workerHarness();
    const redirect = { status: 303, location: CUSTOMER_RETURN_PORTAL_ACCESS_PATH };
    worker.fetch.mockResolvedValue(redirect);
    await expect(worker.request(CUSTOMER_RETURN_PORTAL_PATH)).resolves.toBe(redirect);
    expect(worker.match).not.toHaveBeenCalled();
  });

  it("isolates only portal page segments from the staff shell", () => {
    for (const path of [CUSTOMER_RETURN_PORTAL_PATH, CUSTOMER_RETURN_PORTAL_ACCESS_PATH,
      CUSTOMER_RETURN_PORTAL_LEGACY_PATH, `${CUSTOMER_RETURN_PORTAL_LEGACY_PATH}/hidden`,
      `${CUSTOMER_RETURN_PORTAL_PATH}/`, `${CUSTOMER_RETURN_PORTAL_ACCESS_PATH}/`,
      "/RETURN-PORTAL", "/RETURN-PORTAL/ACCESS/", "/RETURNS/PORTAL-PREVIEW/"]) {
      expect(isCustomerReturnPortalPath(path)).toBe(true);
    }
    for (const path of ["/return-portals", "/returns/portal-preview-extra", CUSTOMER_RETURN_PREVIEW_API_PATH, "/picking"]) {
      expect(isCustomerReturnPortalPath(path)).toBe(false);
    }
  });

  it("preserves existing offline behavior outside the preview", async () => {
    const worker = workerHarness();
    worker.fetch.mockRejectedValue(new Error("Offline"));
    await expect(worker.request("/picking")).resolves.toEqual({ cached: true });
    expect(worker.match).toHaveBeenCalledOnce();
  });
});

import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import expressSession from "express-session";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CustomerReturnCustomerAccessError,
  CustomerReturnCustomerAuthService,
  type ReturnCustomerAuthConfig,
  type ReturnLoginChallengeStore,
} from "../../application/customer-return-customer-auth.service";
import {
  registerCustomerReturnCustomerRoutes,
  type CustomerReturnCustomerRouteDependencies,
} from "../../interfaces/http/customer-return-customer.routes";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const SHOP = "returns-test.myshopify.com";
const OTHER_SHOP = "other-test.myshopify.com";
const CUSTOMER = "900719925474099312345";
const SHOPIFY_SECRET = "test-only-shopify-app-secret";
const OTHER_SECRET = "test-only-other-shopify-app-secret";
const STORAGE_SECRET = "test-only-returns-storage-secret-long-enough";
const ORIGIN = "https://returns.example.com";
const PROXY_PATH = "/api/returns/shopify/proxy";
const API = "/api/returns/customer";
const PAGE = "/customer-returns";
const COMMAND_HEADERS = {
  "Content-Type": "application/json",
  Origin: ORIGIN,
  "X-Return-Command": "1",
};

function signedQuery(
  overrides: Record<string, string | undefined> = {},
  secret = SHOPIFY_SECRET,
): string {
  const fields: Record<string, string | undefined> = {
    shop: SHOP,
    logged_in_customer_id: CUSTOMER,
    timestamp: String(NOW.getTime() / 1000),
    path_prefix: "/apps/returns",
    ...overrides,
  };
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const message = entries
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("");
  return `${new URLSearchParams(entries)}&signature=${createHmac("sha256", secret).update(message).digest("hex")}`;
}

function encodedProof(rawQuery: string): string {
  return Buffer.from(rawQuery, "utf8").toString("base64url");
}

type Requester = (path: string, options?: RequestInit) => Promise<Response>;
const servers: http.Server[] = [];

async function setup() {
  let now = NOW;
  let nextState = 0;
  const config: ReturnCustomerAuthConfig = {
    storageSecret: STORAGE_SECRET,
    publicOrigin: ORIGIN,
    shops: {
      [SHOP]: {
        proxyUrl: "https://store.example.com/apps/returns",
        shopifySecret: SHOPIFY_SECRET,
      },
      [OTHER_SHOP]: {
        proxyUrl: "https://other.example.com/apps/returns",
        shopifySecret: OTHER_SECRET,
      },
    },
  };
  const pending = new Map<
    string,
    {
      browserHash: string;
      shopDomain: string;
      expiresAt: Date;
      consumed: boolean;
    }
  >();
  const create = vi.fn<ReturnLoginChallengeStore["create"]>(async (input) => {
    if (pending.has(input.stateHash))
      throw new Error("Duplicate fixture challenge");
    pending.set(input.stateHash, { ...input, consumed: false });
  });
  const consume = vi.fn<ReturnLoginChallengeStore["consume"]>(async (input) => {
    const row = pending.get(input.stateHash);
    if (
      !row ||
      row.consumed ||
      row.browserHash !== input.browserHash ||
      row.shopDomain !== input.shopDomain ||
      row.expiresAt <= input.now
    )
      return null;
    row.consumed = true;
    return row.expiresAt;
  });
  const shops = vi.fn(async () => [
    {
      channelId: 36,
      connectionId: 4,
      shopDomain: SHOP,
      displayName: "Test shop",
    },
  ]);
  const auth = new CustomerReturnCustomerAuthService({
    config,
    challenges: { create, consume },
    shops,
    now: () => now,
    randomState: () => String.fromCharCode(97 + nextState++).repeat(43),
  });
  const context = vi.fn(async () => ({ config, auth }));
  const authorizeStaff = vi.fn(async (req: express.Request) => {
    if (req.get("X-Test-Staff") !== "allowed") {
      throw new CustomerReturnCustomerAccessError(
        "TEST_PRIVATE_GATE",
        "Private testing is restricted.",
        403,
      );
    }
  });
  const list = vi.fn(async () => ({
    orders: [],
    nextBeforeOmsOrderId: null,
    unavailableOrderCount: 0,
  }));
  const submit = vi.fn(async () => ({}));
  const progressLabels = vi.fn(async () => ({}));
  const services = vi.fn(async () => ({
    orders: { list, order: vi.fn(), review: vi.fn() },
    operations: {
      submit,
      progressLabels,
      listReturns: vi.fn(),
      labelStatus: vi.fn(),
      submissionStatus: vi.fn(),
      resumeSubmission: vi.fn(),
      artifact: vi.fn(),
    },
    download: vi.fn(),
  }));
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const infoLog = vi.spyOn(console, "info").mockImplementation(() => {});
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(
    expressSession({
      secret: "test-only-express-session-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true, httpOnly: true, sameSite: "lax" },
    }),
  );
  registerCustomerReturnCustomerRoutes(app, {
    context,
    privateTesting: () => true,
    authorizeStaff,
    services: services as unknown as NonNullable<
      CustomerReturnCustomerRouteDependencies["services"]
    >,
  });
  app.use((_req, res) => res.send("application shell"));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function browser(staff = true): { request: Requester; cookie: () => string } {
    let cookie = "";
    return {
      cookie: () => cookie,
      request: async (path, options = {}) => {
        const response = await fetch(base + path, {
          redirect: "manual",
          ...options,
          headers: {
            "X-Forwarded-Proto": "https",
            ...(staff ? { "X-Test-Staff": "allowed" } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...options.headers,
          },
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        return response;
      },
    };
  }
  async function start(request: Requester, requestedShop = SHOP) {
    const response = await request(`${PAGE}/start?shop=${requestedShop}`);
    expect(response.status).toBe(303);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe(
      config.shops[requestedShop].proxyUrl.split("/apps/")[0],
    );
    const state = destination.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return state!;
  }
  const redeem = (
    request: Requester,
    proof: string,
    headers: Record<string, string> = {},
  ) =>
    request(`${API}/session`, {
      method: "POST",
      headers: { ...COMMAND_HEADERS, ...headers },
      body: JSON.stringify({ proof }),
    });
  return {
    auth,
    browser,
    start,
    redeem,
    create,
    consume,
    shops,
    context,
    config,
    authorizeStaff,
    services,
    list,
    submit,
    progressLabels,
    errorLog,
    infoLog,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  vi.restoreAllMocks();
});

describe("direct Shopify returns proof HTTP lifecycle", () => {
  it("relays signed Shopify proof through the form and callback, then binds a regenerated session to the original browser", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const originalCookie = customer.cookie();
    const raw = signedQuery({ state });
    const proxy = await s.browser(false).request(`${PROXY_PATH}?${raw}`);
    expect(proxy.status).toBe(200);
    expect(proxy.headers.get("set-cookie")).toBeNull();
    expect(proxy.headers.get("cache-control")).toBe("private, no-store");
    expect(proxy.headers.get("content-security-policy")).toContain(
      `form-action ${ORIGIN}`,
    );
    const html = await proxy.text();
    const proof = html.match(/name="proof" value="([A-Za-z0-9_-]+)"/)?.[1];
    expect(proof).toBe(encodedProof(raw));
    expect(html).toContain(`action="${ORIGIN}${PAGE}/callback"`);
    expect(html).not.toContain("token=");
    const callback = await s.browser(false).request(`${PAGE}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ proof: proof! }).toString(),
    });
    expect(callback.status).toBe(200);
    const callbackHtml = await callback.text();
    expect(callbackHtml).toContain(`fetch("${API}/session"`);
    expect(callbackHtml).toContain('credentials:"same-origin"');
    expect(callbackHtml).toContain('"X-Return-Command":"1"');
    expect(callback.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(s.consume).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
    const accepted = await s.redeem(customer.request, proof!);
    expect(accepted.status).toBe(200);
    const session = await accepted.json();
    expect(session).toMatchObject({
      authenticated: true,
      privateTesting: true,
      sessionKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(customer.cookie()).not.toBe(originalCookie);
    expect(accepted.headers.get("set-cookie")).toContain("HttpOnly");
    expect(accepted.headers.get("set-cookie")).toContain("Secure");
    expect(s.consume).toHaveBeenCalledOnce();
    expect(s.services).not.toHaveBeenCalled();
    expect(
      (
        await customer.request(`${API}/orders`, {
          headers: { "X-Return-Session": session.sessionKey },
        })
      ).status,
    ).toBe(200);
    expect(s.services).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 36,
        externalCustomerId: CUSTOMER,
        shopDomain: SHOP,
      }),
    );
    expect(s.list).toHaveBeenCalledOnce();
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.progressLabels).not.toHaveBeenCalled();
  });

  it("cannot use a relayed proof in another browser and does not consume the legitimate challenge", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const proof = encodedProof(signedQuery({ state }));
    const otherBrowser = s.browser();
    await s.start(otherBrowser.request);
    expect((await s.redeem(otherBrowser.request, proof)).status).toBe(401);
    expect((await s.redeem(customer.request, proof)).status).toBe(200);
    expect(s.services).not.toHaveBeenCalled();
  });

  it("rejects replay after a successful session redemption", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const proof = encodedProof(signedQuery({ state }));
    expect((await s.redeem(customer.request, proof)).status).toBe(200);
    expect((await s.redeem(customer.request, proof)).status).toBe(401);
    expect(s.services).not.toHaveBeenCalled();
  });

  it("permits only one of two concurrent redemptions of the same browser challenge", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const proof = encodedProof(signedQuery({ state }));
    const responses = await Promise.all([
      s.redeem(customer.request, proof),
      s.redeem(customer.request, proof),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    expect(s.services).not.toHaveBeenCalled();
  });

  it("routes a signed storefront entry through Echelon start and a guest through the configured Shopify login", async () => {
    const s = await setup();
    const entry = await s
      .browser(false)
      .request(`${PROXY_PATH}?${signedQuery({ logged_in_customer_id: "" })}`);
    expect(entry.status).toBe(303);
    expect(entry.headers.get("location")).toBe(
      `${ORIGIN}${PAGE}/start?shop=${SHOP}`,
    );
    expect(s.create).not.toHaveBeenCalled();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const guest = await s
      .browser(false)
      .request(
        `${PROXY_PATH}?${signedQuery({ state, logged_in_customer_id: "", redirect: "https://untrusted.example/" })}`,
      );
    expect(guest.status).toBe(303);
    const login = new URL(guest.headers.get("location")!);
    expect(login.origin).toBe("https://store.example.com");
    expect(login.pathname).toBe("/account/login");
    expect(login.searchParams.get("return_url")).toBe(
      `/apps/returns?state=${state}`,
    );
    expect(login.href).not.toContain("untrusted");
    expect(
      (
        await s.redeem(
          customer.request,
          encodedProof(signedQuery({ state, logged_in_customer_id: "" })),
        )
      ).status,
    ).toBe(401);
    expect(s.consume).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
  });

  it("uses each configured shop's own key and cannot redeem one shop's challenge with another shop's proof", async () => {
    const s = await setup();
    s.shops.mockResolvedValue([
      {
        channelId: 36,
        connectionId: 4,
        shopDomain: SHOP,
        displayName: "Test shop",
      },
      {
        channelId: 37,
        connectionId: 5,
        shopDomain: OTHER_SHOP,
        displayName: "Other shop",
      },
    ]);
    const customer = s.browser();
    const state = await s.start(customer.request);
    const otherProof = encodedProof(
      signedQuery({ state, shop: OTHER_SHOP }, OTHER_SECRET),
    );
    expect((await s.redeem(customer.request, otherProof)).status).toBe(401);
    expect(
      (await s.redeem(customer.request, encodedProof(signedQuery({ state }))))
        .status,
    ).toBe(200);
    const other = s.browser();
    const otherState = await s.start(other.request, OTHER_SHOP);
    const otherRaw = signedQuery(
      { state: otherState, shop: OTHER_SHOP },
      OTHER_SECRET,
    );
    expect(
      (await s.browser(false).request(`${PROXY_PATH}?${otherRaw}`)).status,
    ).toBe(200);
    expect((await s.redeem(other.request, encodedProof(otherRaw))).status).toBe(
      200,
    );
    expect(s.services).not.toHaveBeenCalled();
  });

  it("requires private staff access at redemption even though cookie-free proxy and callback relays are public", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const proof = encodedProof(signedQuery({ state }));
    s.authorizeStaff.mockRejectedValue(
      new CustomerReturnCustomerAccessError(
        "TEST_PRIVATE_GATE",
        "Private testing is restricted.",
        403,
      ),
    );
    expect(
      (
        await s
          .browser(false)
          .request(`${PROXY_PATH}?${signedQuery({ state })}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await s
          .browser(false)
          .request(`${PAGE}/callback`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ proof }).toString(),
          })
      ).status,
    ).toBe(200);
    expect((await s.redeem(customer.request, proof)).status).toBe(403);
    expect((await customer.request(`${API}/orders`)).status).toBe(403);
    expect(s.consume).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
  });

  it.each([
    [
      "expired proof",
      { timestamp: String(NOW.getTime() / 1000 - 301) },
      SHOPIFY_SECRET,
    ],
    [
      "future proof",
      { timestamp: String(NOW.getTime() / 1000 + 31) },
      SHOPIFY_SECRET,
    ],
    ["wrong path", { path_prefix: "/apps/another-app" }, SHOPIFY_SECRET],
    ["wrong app key", {}, OTHER_SECRET],
    ["unknown shop", { shop: "unknown.myshopify.com" }, SHOPIFY_SECRET],
    ["shop signed by another app key", { shop: OTHER_SHOP }, SHOPIFY_SECRET],
  ] as const)(
    "rejects %s at both proxy and session boundaries without service access",
    async (_label, overrides, secret) => {
      const s = await setup();
      const customer = s.browser();
      const state = await s.start(customer.request);
      const raw = signedQuery({ state, ...overrides }, secret);
      const proxy = await s.browser(false).request(`${PROXY_PATH}?${raw}`);
      expect(proxy.status).toBeGreaterThanOrEqual(400);
      expect(
        (await s.redeem(customer.request, encodedProof(raw))).status,
      ).toBeGreaterThanOrEqual(400);
      expect(s.consume).not.toHaveBeenCalled();
      expect(s.services).not.toHaveBeenCalled();
      const logs = JSON.stringify(s.errorLog.mock.calls);
      expect(logs).not.toContain(state);
      expect(logs).not.toContain(CUSTOMER);
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(raw);
    },
  );

  it("rejects a changed customer ID with the original signature before session creation", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const altered = signedQuery({ state }).replace(CUSTOMER, "123");
    expect(
      (await s.browser(false).request(`${PROXY_PATH}?${altered}`)).status,
    ).toBe(401);
    expect(
      (await s.redeem(customer.request, encodedProof(altered))).status,
    ).toBe(401);
    expect(s.consume).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
  });

  it("rejects an expired browser challenge even when the Shopify proof is fresh", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    s.setNow(new Date(NOW.getTime() + 300_000));
    const proof = encodedProof(
      signedQuery({ state, timestamp: String(NOW.getTime() / 1000 + 300) }),
    );
    expect((await s.redeem(customer.request, proof)).status).toBe(401);
    expect(s.services).not.toHaveBeenCalled();
  });

  it("does not accept Club JWTs, token bodies, or callback query authority", async () => {
    const s = await setup();
    const customer = s.browser();
    const state = await s.start(customer.request);
    const clubToken = jwt.sign(
      {
        iss: "shellz-club-returns",
        aud: "echelon-customer-returns",
        shop: SHOP,
        customerId: CUSTOMER,
        state,
        iat: NOW.getTime() / 1000,
        exp: NOW.getTime() / 1000 + 90,
      },
      STORAGE_SECRET,
    );
    for (const body of [{ token: clubToken }, { proof: clubToken }]) {
      expect(
        (
          await customer.request(`${API}/session`, {
            method: "POST",
            headers: COMMAND_HEADERS,
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
      const form = new URLSearchParams(
        Object.entries(body).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      expect(
        (
          await customer.request(`${PAGE}/callback`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (await s.redeem(customer.request, encodedProof(clubToken))).status,
    ).toBe(401);
    expect(
      (
        await customer.request(
          `${PAGE}/callback?proof=${encodedProof(signedQuery({ state }))}`,
        )
      ).status,
    ).toBe(404);
    expect(s.consume).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
  });

  const invalidCommandHeaders: Record<string, string>[] = [
    { Origin: "https://wrong.example.com" },
    { "X-Return-Command": "0" },
    { "Content-Type": "text/plain" },
  ];
  it.each(invalidCommandHeaders)(
    "requires same-origin JSON and command header before proof consumption (%j)",
    async (headers) => {
      const s = await setup();
      const customer = s.browser();
      const state = await s.start(customer.request);
      expect(
        (
          await s.redeem(
            customer.request,
            encodedProof(signedQuery({ state })),
            headers,
          )
        ).status,
      ).toBe(403);
      expect(s.consume).not.toHaveBeenCalled();
      expect(s.services).not.toHaveBeenCalled();
    },
  );

  it("bounds proxy methods and unknown paths without invoking authentication or the application shell", async () => {
    const s = await setup();
    const request = s.browser(false).request;
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await request(PROXY_PATH, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "form-action 'none'",
      );
      expect(await response.text()).not.toContain("application shell");
    }
    expect((await request(`${PROXY_PATH}/unexpected`)).status).toBe(404);
    expect(s.context).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
  });

  it("HEAD verifies proof but returns no body or identity session", async () => {
    const s = await setup();
    const response = await s
      .browser(false)
      .request(`${PROXY_PATH}?${signedQuery({ state: "a".repeat(43) })}`, {
        method: "HEAD",
      });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(s.consume).not.toHaveBeenCalled();
    expect(s.services).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected errors without reflecting raw proof or configuration into logs or responses", async () => {
    const s = await setup();
    const raw = signedQuery({ state: "s".repeat(43) });
    s.context.mockRejectedValue(
      new Error(`secret=${SHOPIFY_SECRET}; raw=${raw}`),
    );
    const response = await s.browser(false).request(`${PROXY_PATH}?${raw}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "RETURN_CUSTOMER_UNAVAILABLE",
        message: "Returns are temporarily unavailable. Please try again.",
      },
    });
    expect(s.errorLog).toHaveBeenCalledWith(
      JSON.stringify({
        event: "customer_return_request_failed",
        code: "RETURN_CUSTOMER_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(s.errorLog.mock.calls)).not.toContain(SHOPIFY_SECRET);
    expect(s.services).not.toHaveBeenCalled();
  });
});

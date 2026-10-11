import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ORDER_EDIT_LINE_DISPLAY_HEADER,
  ORDER_EDIT_LINE_DISPLAY_VERSION,
  orderEditOperationSchema,
  type OrderEditOperation,
} from "@shared/order-edits/order-edit.contract";
import { registerOrderEditRoutes } from "../../interfaces/order-edit.routes";
import type { OrderEditService } from "../../application/order-edit.service";
import {
  previewInput,
  previewCalculation,
  PREVIEW_NOW,
} from "../fixtures/order-edit-preview.fixture";

const KEY = "22222222-2222-4222-8222-222222222222";
const displayOperation: OrderEditOperation = {
  operationId: KEY,
  orderNumber: "#100",
  currency: "USD",
  previousTotalCents: 2000,
  updatedTotalCents: 3000,
  balanceDueCents: 1000,
  refundDueCents: 0,
  lines: [{
    id: "gid://shopify/CalculatedLineItem/1",
    variantId: "gid://shopify/ProductVariant/10",
    added: false,
    title: "Product",
    variantTitle: "Pack",
    quantity: 3,
    totalCents: 3000,
  }],
  status: "ready",
  canAbandon: true,
  warnings: [],
  expiresAt: "2026-10-06T00:00:00.000Z",
  paymentDeadline: null,
  paymentUrl: null,
  error: null,
};
describe("order edit staff HTTP boundary", () => {
  let server: Server;
  let url: string;
  let loggedIn: boolean;
  const permission = vi.fn(async () => true);
  const state = vi.fn(async () => ({
    connections: [],
    customerAccess: false as const,
  }));
  const settings = vi.fn(async () => ({
    connectionId: 4,
    channelId: 36,
    name: "Shopify",
    shopDomain: "test.myshopify.com",
    paymentWindowMinutes: 30,
    enabled: true,
  }));
  const quote = vi.fn();
  const getOperation = vi.fn();
  const commit = vi.fn();
  const reconcile = vi.fn();
  const abandon = vi.fn();
  const preview = vi.fn();
  const warmPreview = vi.fn();
  const catalogCategories = vi.fn();
  const catalogProducts = vi.fn();
  const catalogVariants = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    permission.mockResolvedValue(true);
    loggedIn = true;
    catalogCategories.mockImplementation(async (connectionId, input) => ({
      connectionId,
      input,
      categories: ["Toploaders"],
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    catalogProducts.mockImplementation(async (connectionId, input) => ({
      connectionId,
      input,
      products: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    catalogVariants.mockImplementation(async (connectionId, input) => ({
      connectionId,
      input,
      product: {
        productId: input.productId,
        title: "Toploader",
        category: "Toploaders",
        imageUrl: null,
      },
      variants: [],
      memberPlan: null,
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    preview.mockImplementation(async (input) => ({
      phase: "preview",
      input,
      calculatedAt: new Date(PREVIEW_NOW).toISOString(),
      expiresAt: new Date(PREVIEW_NOW + 60000).toISOString(),
      ...previewCalculation(),
    }));
    warmPreview.mockImplementation(async (scope) => ({
      scope,
      expiresAt: new Date(PREVIEW_NOW + 60000).toISOString(),
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (loggedIn)
        req.session = { user: { id: "staff" } } as typeof req.session;
      next();
    });
    registerOrderEditRoutes(app, {
      service: {
        state,
        settings,
        quote,
        get: getOperation,
        commit,
        reconcile,
        abandon,
        preview,
        warmPreview,
        catalogCategories,
        catalogProducts,
        catalogVariants,
      } as unknown as OrderEditService,
      hasPermission: permission,
      report: vi.fn(),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const save = () => ({
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": KEY,
      Origin: url,
    },
    body: JSON.stringify({ paymentWindowMinutes: 30, enabled: true }),
  });
  it.each(["", "/commit", "/reconcile", "/abandon"])(
    "preserves strict legacy operation responses and opts new clients into SKU display metadata for %s",
    async (action) => {
      for (const handler of [getOperation, commit, reconcile, abandon])
        handler.mockResolvedValue(displayOperation);
      const legacyLineSchema = orderEditOperationSchema.shape.lines.element
        .omit({ variantId: true, added: true });
      for (const version of [undefined, "unsupported-version", ORDER_EDIT_LINE_DISPLAY_VERSION]) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Origin: url,
          "Idempotency-Key": KEY,
        };
        if (version !== undefined) headers[ORDER_EDIT_LINE_DISPLAY_HEADER] = version;
        const response = await fetch(`${url}/api/order-edits/admin/operations/${KEY}${action}`, {
          method: action ? "POST" : "GET",
          headers,
          ...(action ? { body: "{}" } : {}),
        });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.updatedTotalCents).toBe(3000);
        expect(result.balanceDueCents).toBe(1000);
        expect(result.lines[0].id).toBe(displayOperation.lines[0].id);
        if (version === ORDER_EDIT_LINE_DISPLAY_VERSION) {
          expect(result.lines).toEqual(displayOperation.lines);
        } else {
          expect(legacyLineSchema.safeParse(result.lines[0]).success).toBe(true);
          expect(result.lines[0]).not.toHaveProperty("variantId");
          expect(result.lines[0]).not.toHaveProperty("added");
        }
      }
      expect(displayOperation.lines[0]).toHaveProperty("variantId");
    },
  );

  it.each([false, true])("negotiates quote and preview line metadata without changing amounts, opt-in=%s", async (optIn) => {
    quote.mockResolvedValue(displayOperation);
    const calculation = previewCalculation();
    preview.mockImplementationOnce(async (input) => ({
      phase: "preview",
      input,
      calculatedAt: new Date(PREVIEW_NOW).toISOString(),
      expiresAt: new Date(PREVIEW_NOW + 60000).toISOString(),
      ...calculation,
      lines: calculation.lines.map((line) => ({
        ...line, variantId: "gid://shopify/ProductVariant/10", added: false,
      })),
    }));
    const headers: Record<string, string> = {
      "Content-Type": "application/json", Origin: url, "Idempotency-Key": KEY,
    };
    if (optIn) headers[ORDER_EDIT_LINE_DISPLAY_HEADER] = ORDER_EDIT_LINE_DISPLAY_VERSION;
    for (const [path, body] of [
      ["quotes", { ...previewInput(), requestKey: KEY }],
      ["previews", previewInput()],
    ] as const) {
      const response = await fetch(`${url}/api/order-edits/admin/${path}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.lines[0].variantId).toBe(optIn ? "gid://shopify/ProductVariant/10" : undefined);
      expect(result.lines[0].added).toBe(optIn ? false : undefined);
      expect(result.lines[0].totalCents).toBe(path === "quotes" ? 3000 : calculation.lines[0].totalCents);
    }
  });
  it("uses staff permissions for every catalog read and does not stage a financial command", async () => {
    const paths = [
      "categories?connectionId=4",
      "products?connectionId=4&search=toploader",
      `variants?connectionId=4&productId=${encodeURIComponent("gid://shopify/Product/10")}`,
    ];
    for (const path of paths) {
      loggedIn = false;
      expect(
        (await fetch(`${url}/api/order-edits/admin/catalog/${path}`)).status,
      ).toBe(401);
      loggedIn = true;
      permission.mockResolvedValue(false);
      expect(
        (await fetch(`${url}/api/order-edits/admin/catalog/${path}`)).status,
      ).toBe(403);
      permission.mockResolvedValue(true);
      const result = await fetch(
        `${url}/api/order-edits/admin/catalog/${path}`,
      );
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect((await result.json()).connectionId).toBe(4);
    }
    expect(catalogCategories).toHaveBeenCalledTimes(1);
    expect(catalogProducts).toHaveBeenCalledWith(4, {
      search: "toploader",
      category: null,
      after: null,
    });
    expect(catalogVariants).toHaveBeenCalledWith(
      4,
      {
        productId: "gid://shopify/Product/10",
        after: null,
        omsOrderId: null,
        expectedRevision: null,
      },
      "staff",
    );
    expect(quote).not.toHaveBeenCalled();
  });
  it.each([
    "products?connectionId=0",
    "products?connectionId=4&priceCents=1",
    "products?connectionId=4&search=toploader&search=other",
    "products?connectionId=4&search=*",
    "products?connectionId=4&category=",
    "categories?connectionId=4&after=",
    "variants?connectionId=4&productId=123",
    "variants?connectionId=4&productId=gid%3A%2F%2Fshopify%2FOrder%2F10",
    "variants?connectionId=4&productId=gid%3A%2F%2Fshopify%2FProduct%2F10&omsOrderId=1",
    "variants?connectionId=4&productId=gid%3A%2F%2Fshopify%2FProduct%2F10&expectedRevision=baseline",
    "variants?connectionId=4&productId=gid%3A%2F%2Fshopify%2FProduct%2F10&customerId=8",
    "variants?connectionId=4&productId=gid%3A%2F%2Fshopify%2FProduct%2F10&memberPlan=club",
  ])(
    "rejects invalid catalog input before calling a reader: %s",
    async (path) => {
      expect(
        (await fetch(`${url}/api/order-edits/admin/catalog/${path}`)).status,
      ).toBe(400);
      expect(catalogProducts).not.toHaveBeenCalled();
      expect(catalogCategories).not.toHaveBeenCalled();
      expect(catalogVariants).not.toHaveBeenCalled();
    },
  );
  it("passes only the order/revision scope and authenticated actor to customer-priced discovery", async () => {
    const parent = "gid://shopify/Product/10";
    const params = new URLSearchParams({
      connectionId: "4",
      productId: parent,
      omsOrderId: "1",
      expectedRevision: "baseline",
    });
    const result = await fetch(
      `${url}/api/order-edits/admin/catalog/variants?${params}`,
    );
    expect(result.status).toBe(200);
    expect(catalogVariants).toHaveBeenCalledExactlyOnceWith(
      4,
      {
        productId: parent,
        after: null,
        omsOrderId: 1,
        expectedRevision: "baseline",
      },
      "staff",
    );
    expect(quote).not.toHaveBeenCalled();
  });
  it("denies customers/anonymous sessions and current staff without orders:edit", async () => {
    loggedIn = false;
    expect((await fetch(`${url}/api/order-edits/admin/state`)).status).toBe(
      401,
    );
    loggedIn = true;
    permission.mockResolvedValue(false);
    expect((await fetch(`${url}/api/order-edits/admin/state`)).status).toBe(
      403,
    );
    expect(state).not.toHaveBeenCalled();
  });
  it("requires settings:edit as well as orders:edit to change the payment window", async () => {
    permission.mockImplementation(
      async (_actor?: string, resource?: string) => resource !== "settings",
    );
    expect(
      (await fetch(`${url}/api/order-edits/admin/settings/4`, save())).status,
    ).toBe(403);
    expect(settings).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "https://evil.example",
    "null",
    "http://127.0.0.1.evil.example",
  ])("rejects unsafe mutation origin %s", async (origin) => {
    const input = save();
    const headers: Record<string, string> = { ...input.headers };
    if (origin === undefined) delete headers.Origin;
    else headers.Origin = origin;
    expect(
      (
        await fetch(`${url}/api/order-edits/admin/settings/4`, {
          ...input,
          headers,
        })
      ).status,
    ).toBe(403);
    expect(settings).not.toHaveBeenCalled();
  });
  it("validates configured window and rejects unknown JSON fields without saving", async () => {
    for (const body of [
      { paymentWindowMinutes: 0, enabled: true },
      { paymentWindowMinutes: 30, enabled: true, customerAccess: true },
    ]) {
      expect(
        (
          await fetch(`${url}/api/order-edits/admin/settings/4`, {
            ...save(),
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(settings).not.toHaveBeenCalled();
  });
  it("returns a verified connection DTO, never caching financial responses", async () => {
    const result = await fetch(
      `${url}/api/order-edits/admin/settings/4`,
      save(),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect((await result.json()).connectionId).toBe(4);
    expect(settings).toHaveBeenCalledWith(
      4,
      { paymentWindowMinutes: 30, enabled: true },
      "staff",
    );
  });
  it("requires an identical body/header quote key before staging", async () => {
    const result = await fetch(`${url}/api/order-edits/admin/quotes`, {
      ...save(),
      method: "POST",
      body: JSON.stringify({
        connectionId: 4,
        omsOrderId: 1,
        expectedRevision: "fingerprint",
        requestKey: "33333333-3333-4333-8333-333333333333",
        changes: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 3 }],
        additions: [],
      }),
    });
    expect(result.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });
  it("allows only authenticated same-origin calculation input without an edit command key", async () => {
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify(previewInput()),
    };
    const result = await fetch(
      `${url}/api/order-edits/admin/previews`,
      request,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect((await result.json()).phase).toBe("preview");
    expect(preview).toHaveBeenCalledWith(previewInput(), "staff");
    expect(quote).not.toHaveBeenCalled();
    preview.mockClear();
    for (const changed of [
      {
        ...request,
        headers: { ...request.headers, Origin: "https://evil.example" },
      },
      {
        ...request,
        body: JSON.stringify({ ...previewInput(), totalCents: 1 }),
      },
    ])
      expect(
        (await fetch(`${url}/api/order-edits/admin/previews`, changed)).ok,
      ).toBe(false);
    permission.mockResolvedValue(false);
    expect(
      (await fetch(`${url}/api/order-edits/admin/previews`, request)).status,
    ).toBe(403);
    permission.mockResolvedValue(true);
    loggedIn = false;
    expect(
      (await fetch(`${url}/api/order-edits/admin/previews`, request)).status,
    ).toBe(401);
    expect(preview).not.toHaveBeenCalled();
  });
});

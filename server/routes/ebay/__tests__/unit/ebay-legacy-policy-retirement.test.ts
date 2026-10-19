import express from "express";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EbayBusinessPolicyError } from "@shared/ebay-business-policies";

const ports = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  resolvePolicies: vi.fn(),
}));
vi.mock("../../../../db", () => ({
  db: { select: ports.select, insert: ports.insert, update: ports.update },
  pool: {},
}));
vi.mock("../../../middleware", () => ({
  requireAuth: vi.fn(),
  requirePermission: () => vi.fn(),
}));
vi.mock("../../../../modules/channels/ebay-business-policies", () => ({
  ebayBusinessPolicies: { resolveProductPolicies: ports.resolvePolicies },
}));
import { registerEbayListingRulesRoutes } from "../../../ebay-listing-rules.routes";

const app = express();
registerEbayListingRulesRoutes(app);
function handler(method: string, path: string) {
  const route = app._router.stack.find(
    (entry: { route?: { path: string; methods: Record<string, boolean> } }) =>
      entry.route?.path === path && entry.route?.methods[method],
  )?.route;
  if (!route) throw new Error(`Missing registered ${method} ${path}`);
  return route.stack.at(-1).handle as (
    req: Request,
    res: Response,
  ) => Promise<void>;
}
function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}
function selectedRows(rows: unknown[]) {
  const selection = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    orderBy: vi.fn(),
    then: (fulfilled: (value: unknown[]) => unknown) =>
      Promise.resolve(rows).then(fulfilled),
  };
  for (const key of ["from", "innerJoin", "where", "limit", "orderBy"] as const)
    selection[key].mockReturnValue(selection);
  return selection;
}
const currentPolicies = {
  fulfillmentPolicyId: "current-shipping",
  returnPolicyId: "current-return",
  paymentPolicyId: "current-payment",
};

describe("legacy listing rules cannot become another policy owner", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"])(
    "rejects legacy %s writes before any insert or update",
    async (field) => {
      for (const method of ["post", "put"] as const) {
        const res = response();
        await handler(
          method,
          method === "post"
            ? "/api/ebay/listing-rules"
            : "/api/ebay/listing-rules/:id",
        )(
          {
            params: { id: "7" },
            body: { scopeType: "default", [field]: "old-source" },
          } as unknown as Request,
          res as unknown as Response,
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ code: "EBAY_POLICY_OWNER_REQUIRED" }),
        );
        expect(ports.insert).not.toHaveBeenCalled();
        expect(ports.update).not.toHaveBeenCalled();
      }
    },
  );

  it("does not expose historical rule policy columns as editable settings", async () => {
    ports.select.mockReturnValue(
      selectedRows([
        {
          id: 7,
          scopeType: "default",
          fulfillmentPolicyId: "stale",
          returnPolicyId: "stale",
          paymentPolicyId: "stale",
        },
      ]),
    );
    const res = response();
    await handler("get", "/api/ebay/listing-rules")(
      {} as Request,
      res as unknown as Response,
    );
    expect(res.json).toHaveBeenCalledWith([
      {
        id: 7,
        scopeType: "default",
        policySettingsUrl: "/channels/ebay#business-policies",
      },
    ]);
  });

  it("uses the canonical variant policies when resolving a SKU, ignoring historical rule policy values", async () => {
    ports.select
      .mockReturnValueOnce(
        selectedRows([
          {
            variantId: 101,
            productId: 20,
            productName: "Pack",
            productType: "packs",
          },
        ]),
      )
      .mockReturnValueOnce(
        selectedRows([
          {
            scopeType: "default",
            ebayCategoryId: "category",
            fulfillmentPolicyId: "stale",
            returnPolicyId: "stale",
            paymentPolicyId: "stale",
          },
        ]),
      );
    ports.resolvePolicies.mockResolvedValue({
      byVariantId: new Map([[101, currentPolicies]]),
    });
    const res = response();
    await handler("get", "/api/ebay/listing-rules/resolve/:sku")(
      { params: { sku: "PACK" } } as unknown as Request,
      res as unknown as Response,
    );
    expect(ports.resolvePolicies).toHaveBeenCalledWith({
      productId: 20,
      variantIds: [101],
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: {
          ebayCategoryId: "category",
          ebayStoreCategoryId: null,
          ...currentPolicies,
        },
      }),
    );
  });

  it("returns the canonical unavailable policy failure instead of falling back to legacy rules", async () => {
    ports.select
      .mockReturnValueOnce(
        selectedRows([{ variantId: 101, productId: 20, productType: "packs" }]),
      )
      .mockReturnValueOnce(selectedRows([]));
    ports.resolvePolicies.mockRejectedValue(
      new EbayBusinessPolicyError(
        "EBAY_POLICY_UNAVAILABLE",
        "Choose a current shipping policy",
        422,
      ),
    );
    const res = response();
    await handler("get", "/api/ebay/listing-rules/resolve/:sku")(
      { params: { sku: "PACK" } } as unknown as Request,
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EBAY_POLICY_UNAVAILABLE" }),
    );
  });
});

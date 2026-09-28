import type { Page } from "@playwright/test";
import { customerReturnPolicyShippingInputSchema } from "../../shared/returns/return-policy-shipping.contract";

/** Isolated browser transport fixture; no provider or application database calls. */
export async function installPolicyShippingFixtures(
  page: Page,
  options: {
    shipping?: boolean;
    uncertainFirstSave?: boolean;
    staleFirstSave?: boolean;
  } = {},
) {
  const address = {
    name: "Fixture receiving",
    addressLine1: "100 Test Street",
    city: "Test City",
    state: "NY",
    postalCode: "10001",
    countryCode: "US" as const,
  };
  const shipping = {
    enabled: true,
    warehouseId: 1,
    selectionMode: "fixed_service" as const,
    carrierId: "se-fixture",
    serviceCode: "ground_return",
    carrierRules: [],
    contactName: "Fixture receiving",
    contactPhone: null,
    destinationAddress: address,
    policyId: 3,
    version: 3,
  };
  const initial = {
    id: 3,
    name: "Shopify returns",
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    version: 2,
    status: "active",
    returnWindowDays: 45,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "card_shellz",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
    shipping: options.shipping === false ? null : shipping,
  };
  let policies: Record<string, unknown>[] = [initial];
  const catalog = {
    providerConfigured: true,
    warehouses: [
      { id: 1, name: "Fixture warehouse", address },
      {
        id: 2,
        name: "Second warehouse",
        address: { ...address, addressLine1: "200 Test Street" },
      },
    ],
    carriers: [
      {
        id: "se-fixture",
        name: "Fixture carrier",
        code: "ups",
        services: [{ code: "ground_return", name: "Fixture tracked return" }],
      },
      {
        id: "se-postal",
        name: "Fixture USPS",
        code: "stamps_com",
        services: [
          { code: "usps_ground", name: "USPS Ground" },
          { code: "usps_priority", name: "USPS Priority" },
        ],
      },
    ],
    message: null,
  };
  const writes: Record<string, unknown>[] = [];
  const keys: string[] = [];
  const failures: string[] = [];
  const commands = new Map<
    string,
    { hash: string; policy: Record<string, unknown> }
  >();
  let accepted = 0;
  let reads = 0;
  let denied = false;
  await page.route("**/api/returns/admin/policies**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (denied)
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: "ADMIN_REQUIRED",
            message: "Admin access is required.",
          },
        },
      });
    if (request.method() === "GET" && path.endsWith("/shipping-catalog"))
      return route.fulfill({ json: catalog });
    if (request.method() === "POST" && path.endsWith("/resolve")) {
      const { channelId } = request.postDataJSON();
      const winner = policies.find(
        (policy) =>
          policy.status === "active" && policy.channelId === channelId,
      );
      return winner
        ? route.fulfill({
            json: {
              winner,
              matched: [{ policy: winner, reason: "Channel policy" }],
            },
          })
        : route.fulfill({
            status: 404,
            json: {
              error: {
                code: "RETURN_POLICY_NOT_CONFIGURED",
                message: "No policy applies.",
              },
            },
          });
    }
    if (request.method() === "GET" && path === "/api/returns/admin/policies") {
      reads++;
      return route.fulfill({
        json: {
          policies,
          channels: [
            {
              id: 36,
              name: "Fixture Shopify shop",
              type: "internal",
              provider: "shopify",
              status: "active",
            },
            {
              id: 37,
              name: "Second Shopify shop",
              type: "internal",
              provider: "shopify",
              status: "active",
            },
          ],
          referencedVendors: [],
          referencedStores: [],
          dropshipOmsChannelId: 99,
        },
      });
    }
    if (request.method() === "POST" && path.endsWith("/versions")) {
      const input = request.postDataJSON() as Record<string, unknown>;
      const key = request.headers()["idempotency-key"];
      if (!key) failures.push("Missing policy command key");
      writes.push(input);
      keys.push(key ?? "");
      const hash = JSON.stringify(input);
      const previous = commands.get(key);
      if (previous && previous.hash !== hash)
        throw new Error("Retry changed an accepted policy intent");
      if (previous)
        return route.fulfill({
          json: { policy: previous.policy, replayed: true },
        });
      if (options.staleFirstSave && writes.length === 1)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "RETURN_POLICY_CHANGED",
              message:
                "Another administrator changed this policy. Reload the current version before saving.",
            },
          },
        });
      const parsed =
        input.shipping === null
          ? null
          : customerReturnPolicyShippingInputSchema.parse(input.shipping);
      const id = 4 + accepted;
      const saved = {
        ...initial,
        ...input,
        id,
        version: initial.version + 1 + accepted,
        scopeKey:
          input.appliesTo === "all_orders"
            ? "global"
            : `context:retail:channel:${input.channelId}`,
        supersedesPolicyId: input.expectedPolicyId,
        shipping: parsed
          ? {
              ...parsed,
              policyId: id,
              version: id,
              destinationAddress: catalog.warehouses.find(
                (w) => w.id === parsed.warehouseId,
              )!.address,
            }
          : null,
      };
      commands.set(key, { hash, policy: saved });
      policies = [
        ...policies.map((policy) =>
          policy.channelId === input.channelId
            ? { ...policy, status: "retired" }
            : policy,
        ),
        saved,
      ];
      accepted++;
      if (options.uncertainFirstSave && writes.length === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "UNAVAILABLE",
              message: "Save confirmation was interrupted.",
            },
          },
        });
      return route.fulfill({ json: { policy: saved, replayed: false } });
    }
    failures.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: { message: "Unhandled fixture route" } },
    });
  });
  return {
    writes,
    keys,
    failures,
    catalog,
    get accepted() {
      return accepted;
    },
    get reads() {
      return reads;
    },
    get policies() {
      return structuredClone(policies);
    },
    deny() {
      denied = true;
    },
  };
}

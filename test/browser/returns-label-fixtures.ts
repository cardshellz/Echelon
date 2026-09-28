import type { Page } from "@playwright/test";
import {
  CUSTOMER_RETURN_LABEL_API,
  customerReturnLabelSettingsInputSchema,
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSettingsState,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSubmitInput,
} from "../../shared/returns/customer-return-label.contract";

/** Fictional HTTP responses only; this fixture never contacts a provider or creates a return. */
export async function installReturnLabelFixtures(
  page: Page,
  options: {
    failFirstSubmit?: boolean;
    uncertainBox?: number;
    enabled?: boolean;
    unconfigured?: boolean;
    resolvedPolicy?: CustomerReturnLabelSettingsState["resolvedPolicy"];
    policyIssue?: CustomerReturnLabelSettingsState["policyIssue"];
  } = {},
) {
  const address = {
    name: "Fixture returns",
    addressLine1: "100 Test Street",
    city: "Test City",
    state: "NY",
    postalCode: "10001",
    countryCode: "US" as const,
  };
  let settings: CustomerReturnLabelSettingsState = {
    channelId: 36,
    control: { paused: false, version: 0 },
    providerConfigured: true,
    settings: options.unconfigured
      ? null
      : {
          enabled: options.enabled ?? true,
          warehouseId: 1,
          carrierId: "se-fixture",
          serviceCode: "ground_return",
          selectionMode: "fixed_service",
          carrierRules: [],
          contactName: "Fixture returns",
          contactPhone: null,
          version: 2,
          policyId: 2,
          destinationAddress: address,
        },
    warehouses: [{ id: 1, name: "Fixture warehouse", address }],
    resolvedPolicy:
      options.resolvedPolicy === undefined
        ? {
            id: 2,
            name: "Fixture policy",
            version: 1,
            returnWindowDays: 45,
            scopeKind: "channel_context",
          }
        : options.resolvedPolicy,
    policyIssue: options.policyIssue ?? null,
    carriers: [
      {
        id: "se-fixture",
        name: "Fixture carrier",
        code: "ups",
        services: [{ code: "ground_return", name: "Fixture tracked return" }],
      },
      {
        id: "se-postal",
        code: "stamps_com",
        name: "Fixture USPS",
        services: [
          { code: "usps_ground", name: "USPS Ground" },
          { code: "usps_priority", name: "USPS Priority" },
        ],
      },
    ],
    message: null,
  };
  let status: CustomerReturnLabelStatus | null = null;
  let denied = false;
  let progressCalls = 0;
  let accepted = 0;
  let settingsReads = 0;
  const submissions: CustomerReturnLabelSubmitInput[] = [];
  const settingsWrites: unknown[] = [];
  const failures: string[] = [];
  await page.route(`**${CUSTOMER_RETURN_LABEL_API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const settingRoute =
      path === `${CUSTOMER_RETURN_LABEL_API}/label-settings/36`;
    const controlRoute = path === `${CUSTOMER_RETURN_LABEL_API}/label-settings/36/control`;
    const labelsRoute = path.startsWith(`${CUSTOMER_RETURN_LABEL_API}/labels`);
    if (!settingRoute && !controlRoute && !labelsRoute) return route.fallback();
    if (settingRoute && request.method() === "GET") settingsReads++;
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
    if (request.method() === "POST" || request.method() === "PUT") {
      if (request.headers()["x-return-command"] !== "1")
        failures.push("Missing command header");
    }
    if (settingRoute && request.method() === "GET")
      return route.fulfill({ json: settings });
    if (controlRoute && request.method() === "POST") {
      const input = request.postDataJSON();
      if (input.expectedVersion !== settings.control.version) return route.fulfill({
        status: 409, json: { error: { code: "RETURN_LABEL_CONTROL_CHANGED", message: "Label controls changed. Refresh before continuing." } },
      });
      settingsWrites.push(input);
      settings = {
        ...settings,
        control: { paused: input.paused, version: settings.control.version + 1 },
        settings: settings.settings ? { ...settings.settings, enabled: !input.paused } : null,
      };
      return route.fulfill({ json: settings });
    }
    if (settingRoute && request.method() === "PUT") {
      const input = customerReturnLabelSettingsInputSchema.parse(
        request.postDataJSON(),
      );
      settingsWrites.push(input);
      if (input.expectedVersion !== (settings.settings?.version ?? 0))
        return route.fulfill({
          status: 409,
          json: { error: { code: "SETTINGS_CHANGED" } },
        });
      const { expectedVersion, ...fields } = input;
      settings = {
        ...settings,
        settings: {
          ...fields,
          version: expectedVersion + 1,
          destinationAddress: address,
        },
      };
      return route.fulfill({ json: settings });
    }
    if (
      path === `${CUSTOMER_RETURN_LABEL_API}/labels` &&
      request.method() === "POST"
    ) {
      const input = customerReturnLabelSubmitInputSchema.parse(
        request.postDataJSON(),
      );
      submissions.push(input);
      if (
        submissions.length > 1 &&
        JSON.stringify(input) !== JSON.stringify(submissions[0])
      )
        failures.push("Retry changed the submitted intent");
      if (!status) {
        accepted++;
        status = {
          channelId: 36,
          authorizationId: 501,
          authorizationNumber: "RMA-FIXTURE-501",
          canProgress: true,
          parcels: input.parcels.map((_, index) => ({
            parcelId: 901 + index,
            number: index + 1,
            status: "pending",
            trackingNumber: null,
            downloadPath: null,
          })),
        };
      }
      if (options.failFirstSubmit && submissions.length === 1)
        return route.abort("failed");
      return route.fulfill({ json: status });
    }
    if (path.endsWith("/download") && status)
      return route.fulfill({
        contentType: "application/pdf",
        body: "%PDF-1.4\n% Fictional label fixture\n%%EOF",
      });
    if (path.endsWith("/progress") && request.method() === "POST" && status) {
      progressCalls++;
      const next =
        status.parcels.find(
          (item) =>
            item.status === "processing" || item.status === "needs_review",
        ) ?? status.parcels.find((item) => item.status === "pending");
      if (next) {
        const uncertain =
          next.status === "pending" && next.number === options.uncertainBox;
        status = {
          ...status,
          parcels: status.parcels.map((item) =>
            item.parcelId === next.parcelId
              ? {
                  ...item,
                  status: uncertain ? "needs_review" : "ready",
                  trackingNumber: uncertain
                    ? null
                    : `FIXTURE-TRACK-${item.number}`,
                  downloadPath: uncertain
                    ? null
                    : `${CUSTOMER_RETURN_LABEL_API}/labels/36/501/parcels/${item.parcelId}/download`,
                }
              : item,
          ),
        };
        status.canProgress = status.parcels.some(
          (item) => item.status !== "ready",
        );
      }
      return route.fulfill({ json: status });
    }
    if (status && (request.method() === "GET" || path.endsWith("/resume")))
      return route.fulfill({ json: status });
    return route.fulfill({
      status: 404,
      json: { error: { code: "RETURN_LABEL_SUBMISSION_NOT_FOUND" } },
    });
  });
  return {
    submissions,
    settingsWrites,
    failures,
    updateCatalog(
      catalog: Partial<
        Pick<
          CustomerReturnLabelSettingsState,
          "resolvedPolicy" | "policyIssue" | "carriers" | "warehouses"
        >
      >,
    ) {
      settings = { ...settings, ...structuredClone(catalog) };
    },
    changeSavedSettings(patch: { contactName: string; enabled: boolean }) {
      if (!settings.settings)
        throw new Error("The fixture has no saved settings to change.");
      settings = {
        ...settings,
        settings: {
          ...settings.settings,
          ...patch,
          version: settings.settings.version + 1,
        },
      };
    },
    get progressCalls() {
      return progressCalls;
    },
    get accepted() {
      return accepted;
    },
    get settingsReads() {
      return settingsReads;
    },
    deny() {
      denied = true;
    },
  };
}

/** Fictional policy lifecycle responses; never contacts production. */
export async function installReturnPolicyFixtures(
  page: Page,
  options: {
    fallback?: boolean;
    failFirstArchive?: boolean;
    staleFirstArchive?: boolean;
    invalidPreview?: boolean;
    deniedArchive?: boolean;
  } = {},
) {
  const policy = {
    id: 3,
    name: "Fixture channel returns",
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
  };
  const fallback = {
    ...policy,
    id: 1,
    name: "Fixture all-orders returns",
    scopeKind: "global",
    scopeKey: "global",
    channelId: null,
    businessContext: null,
    version: 1,
    returnWindowDays: 90,
  };
  let policies = options.fallback ? [policy, fallback] : [policy];
  let revision = "a".repeat(64);
  const writes: unknown[] = [];
  const keys: string[] = [];
  const failures: string[] = [];
  let accepted = 0;
  let previewReads = 0;
  const acceptedCommands = new Set<string>();
  await page.route("**/api/returns/admin/policies**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/returns/admin/policies")
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
          ],
          referencedVendors: [],
          referencedStores: [],
          dropshipOmsChannelId: 100,
        },
      });
    if (
      request.method() === "GET" &&
      path === "/api/returns/admin/policies/3/archive-preview"
    ) {
      previewReads++;
      return route.fulfill({
        json: options.invalidPreview
          ? { policy }
          : {
              policy,
              revision,
              effects: [
                {
                  contextLabel: "Retail · Channel 36",
                  before: policy,
                  after: options.fallback ? fallback : null,
                },
              ],
              unaffectedMoreSpecificPolicies: [],
              historicalReferences: { returnCases: 7, portalIntakes: 3 },
            },
      });
    }
    if (
      request.method() === "POST" &&
      path === "/api/returns/admin/policies/3/archive"
    ) {
      const input = request.postDataJSON();
      writes.push(input);
      const key = request.headers()["idempotency-key"] ?? "";
      keys.push(key);
      if (!/^[0-9a-f-]{36}$/i.test(key))
        failures.push("Missing archive idempotency key");
      if (options.deniedArchive)
        return route.fulfill({
          status: 403,
          json: { error: { code: "ADMIN_REQUIRED" } },
        });
      if (options.staleFirstArchive && writes.length === 1) {
        revision = "b".repeat(64);
        return route.fulfill({
          status: 409,
          json: { error: { code: "RETURN_POLICY_ARCHIVE_CHANGED" } },
        });
      }
      if (!acceptedCommands.has(key)) {
        if (
          input.expectedVersion !== policy.version ||
          input.previewRevision !== revision
        )
          return route.fulfill({
            status: 409,
            json: { error: { code: "RETURN_POLICY_ARCHIVE_CHANGED" } },
          });
        acceptedCommands.add(key);
        accepted++;
        policies = policies.map((row) =>
          row.id === policy.id ? { ...row, status: "retired" } : row,
        );
      }
      if (options.failFirstArchive && writes.length === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "RESPONSE_LOST" } },
        });
      return route.fulfill({
        json: {
          policy: { ...policy, status: "retired" },
          replayed: writes.length > accepted,
        },
      });
    }
    failures.push(request.method() + " " + path);
    return route.abort();
  });
  return {
    writes,
    keys,
    failures,
    get accepted() {
      return accepted;
    },
    get previewReads() {
      return previewReads;
    },
  };
}

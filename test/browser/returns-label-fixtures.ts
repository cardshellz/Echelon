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
    providerConfigured: true,
    settings: {
      enabled: options.enabled ?? true,
      warehouseId: 1,
      policyId: 2,
      carrierId: "se-fixture",
      serviceCode: "ground_return",
      contactName: "Fixture returns",
      contactPhone: null,
      version: 1,
      destinationAddress: address,
    },
    warehouses: [{ id: 1, name: "Fixture warehouse", address }],
    policies: [{ id: 2, name: "Fixture policy", version: 1 }],
    carriers: [
      {
        id: "se-fixture",
        name: "Fixture carrier",
        services: [{ code: "ground_return", name: "Fixture tracked return" }],
      },
    ],
    message: null,
  };
  let status: CustomerReturnLabelStatus | null = null;
  let denied = false;
  let progressCalls = 0;
  let accepted = 0;
  const submissions: CustomerReturnLabelSubmitInput[] = [];
  const settingsWrites: unknown[] = [];
  const failures: string[] = [];
  await page.route(`**${CUSTOMER_RETURN_LABEL_API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const settingRoute =
      path === `${CUSTOMER_RETURN_LABEL_API}/label-settings/36`;
    const labelsRoute = path.startsWith(`${CUSTOMER_RETURN_LABEL_API}/labels`);
    if (!settingRoute && !labelsRoute) return route.fallback();
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
    if (settingRoute && request.method() === "PUT") {
      const input = customerReturnLabelSettingsInputSchema.parse(
        request.postDataJSON(),
      );
      settingsWrites.push(input);
      if (input.expectedVersion !== settings.settings!.version)
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
    get progressCalls() {
      return progressCalls;
    },
    get accepted() {
      return accepted;
    },
    deny() {
      denied = true;
    },
  };
}

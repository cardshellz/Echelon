import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_RETURN_LABEL_API,
  type CustomerReturnLabelSettingsState,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { CustomerReturnIntakeError } from "../../application/customer-return-intake.ports";
import { CustomerReturnLiveError } from "../../application/customer-return-live-error";
import { CustomerReturnLabelSettingsService } from "../../application/customer-return-label-settings.service";
import { CustomerReturnLabelsService } from "../../application/customer-return-labels.service";
import { CustomerReturnSubmissionService } from "../../application/customer-return-submission.service";
import {
  registerCustomerReturnPreviewRoutes,
  type CustomerReturnPreviewRouteDependencies,
} from "../../interfaces/http/customer-return-preview.routes";
import type { CustomerReturnLabelRouteServices } from "../../interfaces/http/customer-return-label.routes";
import { LABEL_KEY, labelSettings } from "../support/label-fixtures";

const BASE = CUSTOMER_RETURN_LABEL_API;
const SETTINGS = `${BASE}/label-settings/36`;
const SUBMIT = `${BASE}/labels`;
const STATUS = `${BASE}/labels/36/51`;
const COMMAND = `${BASE}/labels/36/by-command/${LABEL_KEY}`;
const DOWNLOAD = `${STATUS}/parcels/81/download`;
const PDF = Buffer.from("%PDF-1.7\nsynthetic private label\n%%EOF");
const admin = () => ({
  id: "admin-1",
  active: 1,
  role: "admin",
  roles: [{ name: "Administrator", isSystem: 1 }],
});
type IdentityReader = NonNullable<
  CustomerReturnPreviewRouteDependencies["identityReader"]
>;

function status(): CustomerReturnLabelStatus {
  return {
    channelId: 36,
    authorizationId: 51,
    authorizationNumber: "RMA-51",
    parcels: [
      {
        parcelId: 81,
        number: 1,
        status: "ready",
        trackingNumber: "TEST-TRACKING",
        downloadPath: DOWNLOAD,
      },
    ],
    canProgress: false,
  };
}

function settings(): CustomerReturnLabelSettingsState {
  return {
    channelId: 36,
    providerConfigured: true,
    settings: structuredClone(labelSettings),
    warehouses: [],
    policies: [],
    carriers: [],
    message: null,
  };
}

function settingsInput() {
  const { version, destinationAddress: _address, ...fields } = labelSettings;
  return { ...fields, expectedVersion: version };
}

function submission(): CustomerReturnLabelSubmitInput {
  return {
    channelId: 36,
    orderReference: "0012-A",
    sourceRevision: "a".repeat(64),
    idempotencyKey: LABEL_KEY,
    settingsVersion: 1,
    selections: [{ lineId: "line-1", quantity: 1, reasonCode: null }],
    parcels: [
      {
        dimensions: { lengthMm: 300, widthMm: 200, heightMm: 100 },
        originalBoxId: null,
        items: [{ lineId: "line-1", quantity: 1 }],
      },
    ],
  };
}

describe("private customer return label HTTP boundaries", () => {
  let server: http.Server;
  let baseUrl: string;
  let session: unknown;
  let identity: unknown;
  let identityReader: ReturnType<typeof vi.fn<IdentityReader>>;
  let services: CustomerReturnLabelRouteServices;
  let resolveServices: ReturnType<
    typeof vi.fn<() => Promise<CustomerReturnLabelRouteServices>>
  >;
  let report: ReturnType<
    typeof vi.fn<(event: { operation: string; code: string }) => void>
  >;
  let fallback: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    session = { user: { id: "admin-1", role: "admin", active: 1 } };
    identity = admin();
    identityReader = vi.fn(async () => identity);
    services = {
      settings: {
        get: vi.fn(async () => settings()),
        save: vi.fn(async () => settings()),
      },
      labels: {
        status: vi.fn(async () => status()),
        progress: vi.fn(async () => status()),
        artifact: vi.fn(async () => ({
          labelId: "se-91",
          shipmentId: "se-92",
          externalShipmentId: "rma-51-box-1",
          trackingNumber: "TEST-TRACKING",
          carrierId: "se-123",
          serviceCode: "ups_ground",
          amountCents: 100,
          currency: "USD" as const,
          downloadUrl: "https://api.shipstation.com/v2/downloads/test-label",
          labelFormat: "pdf" as const,
          createdAt: "2026-09-26T12:00:00Z",
        })),
      },
      submissions: {
        submit: vi.fn(async () => status()),
        resume: vi.fn(async () => status()),
        status: vi.fn(async () => status()),
      },
      download: vi.fn(async () => PDF),
    };
    resolveServices = vi.fn(async () => services);
    report = vi.fn();
    fallback = vi.fn();
    const app = express();
    // Exercise the real authorization gate with injected session and identity facts.
    app.use(express.json({ limit: "100kb" }));
    app.use((req, _res, next) => {
      req.session = session as typeof req.session;
      next();
    });
    registerCustomerReturnPreviewRoutes(app, {
      identityReader,
      reportFailure: report,
      labelDependencies: { services: resolveServices, report },
    });
    app.use((_req, res) => {
      fallback();
      res.type("html").send("application shell");
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(baseUrl + path, {
      method,
      redirect: "manual",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      body:
        response.headers.get("content-type")?.includes("application/json") &&
        text
          ? JSON.parse(text)
          : undefined,
    };
  }

  function commandHeaders() {
    return {
      Origin: baseUrl,
      "X-Return-Command": "1",
      "Sec-Fetch-Site": "same-origin",
    };
  }
  function expectPrivate(response: { headers: Headers }) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("vary")).toContain("Cookie");
  }
  function expectNoOperations() {
    for (const group of [
      services.settings,
      services.labels,
      services.submissions,
    ]) {
      for (const operation of Object.values(group))
        expect(operation).not.toHaveBeenCalled();
    }
    expect(services.download).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  }

  const endpoints = [
    { path: SETTINGS, method: "GET" },
    { path: SETTINGS, method: "PUT", body: settingsInput() },
    { path: SUBMIT, method: "POST", body: submission() },
    { path: STATUS, method: "GET" },
    { path: `${STATUS}/progress`, method: "POST", body: {} },
    { path: COMMAND, method: "GET" },
    { path: `${COMMAND}/resume`, method: "POST", body: {} },
    { path: DOWNLOAD, method: "GET" },
  ];

  it.each([
    "anonymous",
    "customer",
    "inactive",
    "demoted",
    "non-system-admin",
    "wrong-identity",
  ])(
    "blocks every label endpoint for %s before constructing any effect service",
    async (kind) => {
      if (kind === "anonymous") session = {};
      else if (kind === "customer") session = { customer: { id: "admin-1" } };
      else if (kind === "inactive") identity = { ...admin(), active: 0 };
      else if (kind === "demoted") identity = { ...admin(), role: "picker" };
      else if (kind === "non-system-admin")
        identity = {
          ...admin(),
          roles: [{ name: "Administrator", isSystem: 0 }],
        };
      else identity = { ...admin(), id: "another-admin" };
      for (const endpoint of endpoints) {
        const response = await request(
          endpoint.path,
          endpoint.method,
          endpoint.body,
          commandHeaders(),
        );
        expect(response.status).toBe(
          kind === "anonymous" || kind === "customer" ? 401 : 403,
        );
        expectPrivate(response);
      }
      expect(resolveServices).not.toHaveBeenCalled();
      expectNoOperations();
    },
  );

  it("rereads current administrator identity on status, progress, and private downloads", async () => {
    // Cached roles cannot grant or remove authority; only the session ID is trusted.
    session = { user: { id: "admin-1", active: 0, role: "picker" } };
    expect((await request(STATUS)).status).toBe(200);
    identity = { ...admin(), roles: [] };
    expect(
      (await request(`${STATUS}/progress`, "POST", {}, commandHeaders()))
        .status,
    ).toBe(403);
    expect((await request(DOWNLOAD)).status).toBe(403);
    expect(identityReader.mock.calls).toEqual([
      ["admin-1"],
      ["admin-1"],
      ["admin-1"],
    ]);
    expect(services.labels.status).toHaveBeenCalledTimes(1);
    expect(services.labels.progress).not.toHaveBeenCalled();
    expect(services.labels.artifact).not.toHaveBeenCalled();
    expect(services.download).not.toHaveBeenCalled();
  });

  it("sanitizes failed fresh identity reads before any label service is reached", async () => {
    identityReader.mockRejectedValue(
      new Error("database-password customer@example.test"),
    );
    const response = await request(DOWNLOAD);
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(response.text).not.toMatch(/password|customer@/);
    expect(resolveServices).not.toHaveBeenCalled();
  });

  it.each([
    "missing-origin",
    "foreign-origin",
    "null-origin",
    "missing-command",
    "wrong-command",
    "cross-site",
  ])(
    "rejects %s on every mutation before effect service construction",
    async (kind) => {
      const headers: Record<string, string> = commandHeaders();
      if (kind === "missing-origin") delete headers.Origin;
      if (kind === "foreign-origin")
        headers.Origin = "https://untrusted.example.test";
      if (kind === "null-origin") headers.Origin = "null";
      if (kind === "missing-command") delete headers["X-Return-Command"];
      if (kind === "wrong-command") headers["X-Return-Command"] = "true";
      if (kind === "cross-site") headers["Sec-Fetch-Site"] = "cross-site";
      for (const endpoint of endpoints.filter(
        (value) => value.method !== "GET",
      )) {
        const response = await request(
          endpoint.path,
          endpoint.method,
          endpoint.body,
          headers,
        );
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("RETURN_LABEL_COMMAND_FORBIDDEN");
        expectPrivate(response);
      }
      expect(resolveServices).not.toHaveBeenCalled();
      expectNoOperations();
    },
  );

  it("delegates exact channel, command identity, and session actor for submit, retry, resume, and progress", async () => {
    const input = submission();
    expect(
      (await request(SUBMIT, "POST", input, commandHeaders())).body,
    ).toEqual(status());
    expect(
      (await request(SUBMIT, "POST", input, commandHeaders())).body,
    ).toEqual(status());
    expect(services.submissions.submit).toHaveBeenNthCalledWith(
      1,
      input,
      "admin-1",
    );
    expect(services.submissions.submit).toHaveBeenNthCalledWith(
      2,
      input,
      "admin-1",
    );
    expect((await request(COMMAND)).body).toEqual(status());
    expect(services.submissions.status).toHaveBeenCalledWith(36, LABEL_KEY);
    expect(services.labels.status).not.toHaveBeenCalled();
    expect(
      (await request(`${COMMAND}/resume`, "POST", {}, commandHeaders())).status,
    ).toBe(200);
    expect(services.submissions.resume).toHaveBeenCalledWith(
      36,
      LABEL_KEY,
      "admin-1",
    );
    expect(
      (await request(`${STATUS}/progress`, "POST", {}, commandHeaders()))
        .status,
    ).toBe(200);
    expect(services.labels.progress).toHaveBeenCalledWith(36, 51, "admin-1");
    expect((await request(STATUS)).body).toEqual(status());
    expect(services.labels.status).toHaveBeenCalledWith(36, 51);
    expect(
      (await request(SETTINGS, "PUT", settingsInput(), commandHeaders())).body,
    ).toEqual(settings());
    expect(services.settings.save).toHaveBeenCalledWith(
      36,
      settingsInput(),
      "admin-1",
    );
  });

  it.each(endpoints)(
    "preserves shop denial for $method $path with no downstream read/write",
    async (endpoint) => {
      const deny = vi.fn(async () => {
        throw new CustomerReturnLiveError(
          "RETURN_LIVE_SHOP_UNAVAILABLE",
          "This shop is unavailable.",
          403,
        );
      });
      const downstream = vi.fn(async (): Promise<never> => {
        throw new Error("must not be reached");
      });
      services.settings = new CustomerReturnLabelSettingsService({
        authorizeChannel: deny,
        now: () => new Date(0),
        capabilities: downstream,
        store: { read: downstream, catalog: downstream, save: downstream },
      });
      services.labels = new CustomerReturnLabelsService({
        authorizeChannel: deny,
        now: () => new Date(0),
        requirePurchaseConfiguration: downstream,
        store: { read: downstream, begin: downstream, finish: downstream },
        provider: { purchase: downstream, recover: downstream },
      });
      services.submissions = new CustomerReturnSubmissionService({
        authorizeChannel: deny,
        now: () => new Date(0),
        newToken: () => "unused",
        commands: { read: downstream, acquire: downstream, reject: downstream },
        intake: { find: downstream, persist: downstream },
        settings: { requireEnabled: downstream },
        labels: { status: downstream },
        live: { inspectForIntake: downstream },
      });
      const response = await request(
        endpoint.path,
        endpoint.method,
        endpoint.body,
        commandHeaders(),
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("RETURN_LIVE_SHOP_UNAVAILABLE");
      expectPrivate(response);
      expect(deny).toHaveBeenCalledExactlyOnceWith(36);
      expect(downstream).not.toHaveBeenCalled();
      expect(services.download).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "1.5", "036", "9007199254740992", "not-an-id"])(
    "rejects malformed path identifiers %s",
    async (value) => {
      for (const path of [
        `${BASE}/label-settings/${value}`,
        `${BASE}/labels/36/${value}`,
        `${STATUS}/parcels/${value}/download`,
        `${BASE}/labels/${value}/by-command/${LABEL_KEY}`,
      ]) {
        const response = await request(path);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("RETURN_LABEL_INPUT_INVALID");
        expectPrivate(response);
      }
      expectNoOperations();
    },
  );

  it.each([
    {},
    { ...submission(), actor: "another-admin" },
    { ...submission(), channelId: 0 },
    { ...submission(), idempotencyKey: "not-a-uuid" },
    { ...submission(), settingsVersion: 0 },
    { ...submission(), sourceRevision: "stale" },
    { ...submission(), selections: [] },
    {
      ...submission(),
      parcels: [{ ...submission().parcels[0], weightGrams: 1 }],
    },
  ])(
    "rejects malformed submission or authority/weight override %#",
    async (body) => {
      const response = await request(SUBMIT, "POST", body, commandHeaders());
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("RETURN_LABEL_INPUT_INVALID");
      expectPrivate(response);
      expectNoOperations();
    },
  );

  it("rejects malformed settings, recovery commands, and query overrides before operations", async () => {
    expect(
      (
        await request(
          SETTINGS,
          "PUT",
          { ...settingsInput(), expectedVersion: -1 },
          commandHeaders(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `${COMMAND}/resume`,
          "POST",
          { actor: "override" },
          commandHeaders(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `${STATUS}/progress`,
          "POST",
          { parcelId: 99 },
          commandHeaders(),
        )
      ).status,
    ).toBe(400);
    expect(
      (await request(`${BASE}/labels/36/by-command/not-a-uuid`)).status,
    ).toBe(400);
    for (const endpoint of endpoints) {
      const response = await request(
        `${endpoint.path}?channelId=104`,
        endpoint.method,
        endpoint.body,
        commandHeaders(),
      );
      expect(response.status).toBe(400);
      expectPrivate(response);
    }
    expectNoOperations();
  });

  it("handles malformed JSON through the private parser-error boundary", async () => {
    const response = await fetch(baseUrl + SUBMIT, {
      method: "POST",
      headers: { ...commandHeaders(), "Content-Type": "application/json" },
      body: '{"secret":"must-not-be-returned",',
    });
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.text()).not.toContain("must-not-be-returned");
    expectNoOperations();
  });

  it.each([
    ["RETURN_LABEL_SUBMISSION_PROCESSING", 409],
    ["RETURN_LABEL_SUBMISSION_NOT_FOUND", 404],
    ["RETURN_LABEL_SUBMISSION_REJECTED", 410],
  ] as const)(
    "preserves classified %s recovery results without a fallback submit",
    async (code, errorStatus) => {
      vi.mocked(services.submissions.resume).mockRejectedValue(
        new CustomerReturnIntakeError(
          code,
          "Check the saved request.",
          errorStatus,
        ),
      );
      const response = await request(
        `${COMMAND}/resume`,
        "POST",
        {},
        commandHeaders(),
      );
      expect(response.status).toBe(errorStatus);
      expect(response.body).toEqual({
        error: { code, message: "Check the saved request." },
      });
      expectPrivate(response);
      expect(services.submissions.submit).not.toHaveBeenCalled();
      expect(services.labels.progress).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith({
        operation: "return_label_submission_resume",
        code,
      });
    },
  );

  it("sanitizes unknown errors and logs only the classified operation/code", async () => {
    vi.mocked(services.labels.progress).mockRejectedValue(
      new Error(
        "https://secret-provider.example.test/token customer@example.test",
      ),
    );
    const response = await request(
      `${STATUS}/progress`,
      "POST",
      {},
      commandHeaders(),
    );
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("RETURN_LABEL_UNAVAILABLE");
    expect(response.text).not.toMatch(/secret-provider|customer@/);
    expectPrivate(response);
    expect(report.mock.calls).toEqual([
      [
        {
          operation: "return_label_progress",
          code: "RETURN_LABEL_UNAVAILABLE",
        },
      ],
    ]);
  });

  it.each(["settings", "status"])(
    "rejects malformed %s output without leaking internal fields",
    async (kind) => {
      if (kind === "settings")
        vi.mocked(services.settings.get).mockResolvedValue({
          ...settings(),
          secret: "must-not-leak",
        } as CustomerReturnLabelSettingsState);
      else
        vi.mocked(services.labels.status).mockResolvedValue({
          ...status(),
          providerUrl: "https://must-not-leak.example.test",
        } as CustomerReturnLabelStatus);
      const response = await request(kind === "settings" ? SETTINGS : STATUS);
      expect(response.status).toBe(503);
      expect(response.text).not.toContain("must-not-leak");
      expectPrivate(response);
    },
  );

  it("proxies an authorized PDF privately instead of redirecting to its provider URL", async () => {
    const response = await request(DOWNLOAD);
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="return-51-box-81.pdf"',
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.text).toBe(PDF.toString());
    expect(services.labels.artifact).toHaveBeenCalledWith(36, 51, 81);
    expect(services.download).toHaveBeenCalledWith(
      "https://api.shipstation.com/v2/downloads/test-label",
    );
  });

  it("never fetches an artifact that the authorized status service reports not ready", async () => {
    vi.mocked(services.labels.artifact).mockRejectedValue(
      new CustomerReturnIntakeError(
        "RETURN_LABEL_NOT_READY",
        "This box's label is not ready.",
        409,
      ),
    );
    const response = await request(DOWNLOAD);
    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(services.download).not.toHaveBeenCalled();
  });

  it("sanitizes a failed artifact proxy without exposing its URL", async () => {
    vi.mocked(services.download).mockRejectedValue(
      new Error(
        "private URL https://api.shipstation.com/v2/downloads/test-label",
      ),
    );
    const response = await request(DOWNLOAD);
    expect(response.status).toBe(503);
    expect(response.text).not.toContain("test-label");
    expectPrivate(response);
  });

  it("blocks unsupported methods and unknown label paths without falling through to the app shell", async () => {
    for (const path of [
      SETTINGS,
      SUBMIT,
      STATUS,
      COMMAND,
      `${STATUS}/progress`,
      `${COMMAND}/resume`,
      DOWNLOAD,
    ]) {
      const response = await request(path, "DELETE");
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBeTruthy();
      expectPrivate(response);
    }
    const unknown = await request(`${BASE}/labels/36/51/unavailable`);
    expect(unknown.status).toBe(404);
    expectPrivate(unknown);
    expectNoOperations();
  });
});

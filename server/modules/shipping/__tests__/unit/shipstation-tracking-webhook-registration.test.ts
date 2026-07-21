import { describe, expect, it, vi } from "vitest";
import { parseFlags } from "../../../../../scripts/configure-shipstation-tracking-webhook";
import {
  configureShipStationTrackingWebhook,
  normalizeTrackingWebhookTargetUrl,
} from "../../shipstation-tracking-webhook-registration";
import {
  createShipStationTrackingWebhooksClient,
  ShipStationTrackingWebhooksClientError,
  type ShipStationTrackingWebhook,
  type ShipStationTrackingWebhooksClient,
} from "../../shipstation-tracking-webhooks.client";

const TARGET = "https://echelon.example.com/api/shipping/webhooks/shipstation/track";

function webhook(overrides: Partial<ShipStationTrackingWebhook> = {}): ShipStationTrackingWebhook {
  return {
    webhook_id: "se-123",
    name: "Echelon carrier tracking",
    event: "track",
    url: TARGET,
    ...overrides,
  };
}

function client(existing: ShipStationTrackingWebhook[] = []): ShipStationTrackingWebhooksClient & {
  listWebhooks: ReturnType<typeof vi.fn>;
  createWebhook: ReturnType<typeof vi.fn>;
} {
  return {
    listWebhooks: vi.fn().mockResolvedValue(existing),
    createWebhook: vi.fn().mockImplementation(async (input) => webhook({
      webhook_id: "se-created",
      ...input,
    })),
  };
}

describe("ShipStation tracking webhook registration", () => {
  it("parses flags with a non-mutating default", () => {
    expect(parseFlags([])).toEqual({ help: false, execute: false, targetUrl: null });
    expect(parseFlags(["--execute", `--target-url=${TARGET}`])).toEqual({
      help: false,
      execute: true,
      targetUrl: TARGET,
    });
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/either/);
    expect(() => parseFlags(["--replace-existing"])).toThrow(/Unknown flag/);
  });

  it("requires a credential-free HTTPS endpoint without query or fragment data", () => {
    expect(normalizeTrackingWebhookTargetUrl(`${TARGET}/`)).toBe(TARGET);
    expect(() => normalizeTrackingWebhookTargetUrl("http://example.com/track")).toThrow(/HTTPS/);
    expect(() => normalizeTrackingWebhookTargetUrl("https://user:pass@example.com/track")).toThrow(/credentials/);
    expect(() => normalizeTrackingWebhookTargetUrl("https://example.com/track?token=secret")).toThrow(/query/);
  });

  it("is idempotent when exactly one matching tracking subscription exists", async () => {
    const api = client([webhook()]);
    const result = await configureShipStationTrackingWebhook({
      client: api,
      targetUrl: `${TARGET}/`,
      execute: true,
    });

    expect(result.status).toBe("already_configured");
    expect(api.createWebhook).not.toHaveBeenCalled();
  });

  it("plans creation in dry-run and creates exactly once in execute mode", async () => {
    const dryRunApi = client();
    await expect(configureShipStationTrackingWebhook({
      client: dryRunApi,
      targetUrl: TARGET,
      execute: false,
    })).resolves.toEqual({ status: "create_planned", targetUrl: TARGET });
    expect(dryRunApi.createWebhook).not.toHaveBeenCalled();

    const executeApi = client();
    const result = await configureShipStationTrackingWebhook({
      client: executeApi,
      targetUrl: TARGET,
      execute: true,
    });
    expect(result.status).toBe("created");
    expect(executeApi.createWebhook).toHaveBeenCalledOnce();
    expect(executeApi.createWebhook).toHaveBeenCalledWith({
      name: "Echelon carrier tracking",
      event: "track",
      url: TARGET,
    });
  });

  it("refuses to overwrite a different or duplicate tracking subscription", async () => {
    const different = client([webhook({ url: "https://other.example.com/track" })]);
    const differentResult = await configureShipStationTrackingWebhook({
      client: different,
      targetUrl: TARGET,
      execute: true,
    });
    expect(differentResult.status).toBe("conflict");
    expect(different.createWebhook).not.toHaveBeenCalled();

    const duplicate = client([
      webhook({ webhook_id: "se-1" }),
      webhook({ webhook_id: "se-2" }),
    ]);
    const duplicateResult = await configureShipStationTrackingWebhook({
      client: duplicate,
      targetUrl: TARGET,
      execute: true,
    });
    expect(duplicateResult.status).toBe("conflict");
    expect(duplicate.createWebhook).not.toHaveBeenCalled();
  });

  it("converges when another actor creates the exact subscription during registration", async () => {
    const api = client();
    api.listWebhooks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([webhook({ webhook_id: "se-raced" })]);
    api.createWebhook.mockRejectedValueOnce(new ShipStationTrackingWebhooksClientError(
      "HTTP",
      "ShipStation tracking webhook POST /environment/webhooks returned HTTP 409",
      { status: 409 },
    ));

    await expect(configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      execute: true,
    })).resolves.toMatchObject({
      status: "already_configured",
      webhook: { webhook_id: "se-raced" },
    });
    expect(api.listWebhooks).toHaveBeenCalledTimes(2);
    expect(api.createWebhook).toHaveBeenCalledOnce();
  });

  it("fails closed when a create conflict cannot be reconciled to one exact subscription", async () => {
    const api = client();
    api.listWebhooks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([webhook({
        webhook_id: "se-other",
        url: "https://other.example.com/track",
      })]);
    api.createWebhook.mockRejectedValueOnce(new ShipStationTrackingWebhooksClientError(
      "HTTP",
      "ShipStation tracking webhook POST /environment/webhooks returned HTTP 409",
      { status: 409 },
    ));

    await expect(configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      execute: true,
    })).resolves.toMatchObject({
      status: "conflict",
      trackingWebhooks: [{ webhook_id: "se-other" }],
    });
  });
});

describe("ShipStation tracking webhooks client", () => {
  it("uses the documented ShipEngine V1 API-Key contract and validates list responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify([webhook()]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const api = createShipStationTrackingWebhooksClient({
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(api.listWebhooks()).resolves.toEqual([webhook()]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.shipengine.com/v1/environment/webhooks",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "API-Key": "test-key" }),
      }),
    );
  });

  it("fails closed when the tracking key is missing or the provider response is malformed", async () => {
    expect(() => createShipStationTrackingWebhooksClient({ apiKey: "" })).toThrow(
      ShipStationTrackingWebhooksClientError,
    );

    const api = createShipStationTrackingWebhooksClient({
      apiKey: "test-key",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ webhooks: [] }), {
        status: 200,
      })) as typeof fetch,
    });
    await expect(api.listWebhooks()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("refuses an insecure provider API base URL before sending credentials", () => {
    expect(() => createShipStationTrackingWebhooksClient({
      apiKey: "test-key",
      baseUrl: "http://api.shipengine.test/v1",
    })).toThrow(/HTTPS/);
  });
});

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
const WEBHOOK_SECRET = "w".repeat(32);

function webhook(overrides: Partial<ShipStationTrackingWebhook> = {}): ShipStationTrackingWebhook {
  return {
    webhook_id: "se-123",
    name: "Echelon carrier tracking",
    event: "track",
    url: TARGET,
    headers: [{
      key: "x-echelon-shipstation-tracking-secret",
      value: WEBHOOK_SECRET,
    }],
    ...overrides,
  };
}

function client(existing: ShipStationTrackingWebhook[] = []): ShipStationTrackingWebhooksClient & {
  listWebhooks: ReturnType<typeof vi.fn>;
  createWebhook: ReturnType<typeof vi.fn>;
  updateWebhook: ReturnType<typeof vi.fn>;
} {
  return {
    listWebhooks: vi.fn().mockResolvedValue(existing),
    createWebhook: vi.fn().mockImplementation(async (input) => webhook({
      webhook_id: "se-created",
      ...input,
    })),
    updateWebhook: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ShipStation tracking webhook registration", () => {
  it("parses flags with a non-mutating default", () => {
    expect(parseFlags([])).toEqual({
      help: false,
      execute: false,
      targetUrl: null,
      replaceWebhookId: null,
      expectedCurrentUrl: null,
    });
    expect(parseFlags(["--execute", `--target-url=${TARGET}`])).toEqual({
      help: false,
      execute: true,
      targetUrl: TARGET,
      replaceWebhookId: null,
      expectedCurrentUrl: null,
    });
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/either/);
    expect(() => parseFlags(["--replace-existing"])).toThrow(/Unknown flag/);
    expect(() => parseFlags(["--replace-webhook-id=43350"])).toThrow(/provided together/);
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
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    });

    expect(result.status).toBe("already_configured");
    expect(result).toMatchObject({
      webhook: { authenticationReadback: "verified" },
    });
    expect(api.createWebhook).not.toHaveBeenCalled();
  });

  it("accepts ShipStation's masked persisted secret readback without claiming value verification", async () => {
    const api = client([webhook({
      headers: [{
        key: "x-echelon-shipstation-tracking-secret",
        value: "*****",
      }],
    })]);

    await expect(configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    })).resolves.toMatchObject({
      status: "already_configured",
      webhook: {
        headerNames: ["x-echelon-shipstation-tracking-secret"],
        authenticationReadback: "masked_unverifiable",
      },
    });
    expect(api.createWebhook).not.toHaveBeenCalled();
  });

  it("rejects a readable authentication value that does not match the configured secret", async () => {
    const api = client([webhook({
      headers: [{
        key: "x-echelon-shipstation-tracking-secret",
        value: "different-readable-secret-value",
      }],
    })]);

    await expect(configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    })).resolves.toMatchObject({
      status: "conflict",
      trackingWebhooks: [{ authenticationReadback: "mismatched" }],
    });
  });

  it("plans creation in dry-run and creates exactly once in execute mode", async () => {
    const dryRunApi = client();
    await expect(configureShipStationTrackingWebhook({
      client: dryRunApi,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: false,
    })).resolves.toEqual({ status: "create_planned", targetUrl: TARGET });
    expect(dryRunApi.createWebhook).not.toHaveBeenCalled();

    const executeApi = client();
    const result = await configureShipStationTrackingWebhook({
      client: executeApi,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    });
    expect(result.status).toBe("created");
    expect(executeApi.createWebhook).toHaveBeenCalledOnce();
    expect(executeApi.createWebhook).toHaveBeenCalledWith({
      name: "Echelon carrier tracking",
      event: "track",
      url: TARGET,
      headers: [{
        key: "x-echelon-shipstation-tracking-secret",
        value: WEBHOOK_SECRET,
      }],
    });
  });

  it("refuses to overwrite a different or duplicate tracking subscription", async () => {
    const different = client([webhook({ url: "https://other.example.com/track" })]);
    const differentResult = await configureShipStationTrackingWebhook({
      client: different,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
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
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    });
    expect(duplicateResult.status).toBe("conflict");
    expect(duplicate.createWebhook).not.toHaveBeenCalled();
  });

  it("plans and executes an in-place guarded takeover without deleting the webhook", async () => {
    const legacyUrl = "https://archon.example.com/api/shipstation/tracking-webhook";
    const existing = webhook({
      webhook_id: "43350",
      name: null,
      url: legacyUrl,
      headers: [],
    });
    const dryRunApi = client([existing]);
    await expect(configureShipStationTrackingWebhook({
      client: dryRunApi,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: false,
      takeover: { webhookId: "43350", currentUrl: legacyUrl },
    })).resolves.toMatchObject({
      status: "takeover_planned",
      webhook: { webhookId: "43350", url: legacyUrl },
    });
    expect(dryRunApi.updateWebhook).not.toHaveBeenCalled();

    const executeApi = client([existing]);
    executeApi.listWebhooks
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([webhook({
        webhook_id: "43350",
        headers: [{
          key: "x-echelon-shipstation-tracking-secret",
          value: "*****",
        }],
      })]);
    await expect(configureShipStationTrackingWebhook({
      client: executeApi,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
      takeover: { webhookId: "43350", currentUrl: legacyUrl },
    })).resolves.toMatchObject({
      status: "taken_over",
      webhook: {
        webhookId: "43350",
        url: TARGET,
        authenticationReadback: "masked_unverifiable",
      },
    });
    expect(executeApi.updateWebhook).toHaveBeenCalledWith("43350", {
      name: "Echelon carrier tracking",
      url: TARGET,
      headers: [{
        key: "x-echelon-shipstation-tracking-secret",
        value: WEBHOOK_SECRET,
      }],
    });
  });

  it("refuses takeover when identity, URL, cardinality, or headers drift", async () => {
    const legacyUrl = "https://archon.example.com/api/shipstation/tracking-webhook";
    for (const existing of [
      [webhook({ webhook_id: "different", url: legacyUrl, headers: [] })],
      [webhook({ webhook_id: "43350", url: "https://other.example.com/track", headers: [] })],
      [webhook({ webhook_id: "43350", url: legacyUrl, headers: [{ key: "x-owner", value: "set" }] })],
      [
        webhook({ webhook_id: "43350", url: legacyUrl, headers: [] }),
        webhook({ webhook_id: "second", url: legacyUrl, headers: [] }),
      ],
    ]) {
      const api = client(existing);
      await expect(configureShipStationTrackingWebhook({
        client: api,
        targetUrl: TARGET,
        webhookSecret: WEBHOOK_SECRET,
        execute: true,
        takeover: { webhookId: "43350", currentUrl: legacyUrl },
      })).resolves.toMatchObject({ status: "conflict", reason: expect.any(String) });
      expect(api.updateWebhook).not.toHaveBeenCalled();
    }
  });

  it("fails closed when ShipStation does not retain the takeover state", async () => {
    const legacyUrl = "https://archon.example.com/api/shipstation/tracking-webhook";
    const existing = webhook({ webhook_id: "43350", url: legacyUrl, headers: [] });
    const api = client([existing]);
    api.listWebhooks.mockResolvedValueOnce([existing]).mockResolvedValueOnce([existing]);

    await expect(configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
      takeover: { webhookId: "43350", currentUrl: legacyUrl },
    })).rejects.toThrow(/could not be verified/);
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
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    })).resolves.toMatchObject({
      status: "already_configured",
      webhook: { webhookId: "se-raced" },
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
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    })).resolves.toMatchObject({
      status: "conflict",
      trackingWebhooks: [{ webhookId: "se-other" }],
    });
  });

  it("treats a matching URL without the required secret header as a conflict", async () => {
    const api = client([webhook({ headers: [] })]);

    await expect(configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    })).resolves.toMatchObject({ status: "conflict" });
    expect(api.createWebhook).not.toHaveBeenCalled();
  });

  it("never exposes webhook header values in registration results", async () => {
    const api = client([webhook()]);

    const result = await configureShipStationTrackingWebhook({
      client: api,
      targetUrl: TARGET,
      webhookSecret: WEBHOOK_SECRET,
      execute: true,
    });

    expect(JSON.stringify(result)).not.toContain(WEBHOOK_SECRET);
    expect(result).toMatchObject({
      status: "already_configured",
      webhook: { headerNames: ["x-echelon-shipstation-tracking-secret"] },
    });
  });
});

describe("ShipStation tracking webhooks client", () => {
  it("uses the documented ShipStation V2 API-Key contract and validates list responses", async () => {
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
      "https://api.shipstation.com/v2/environment/webhooks",
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

  it("updates a webhook in place using the documented PUT contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = createShipStationTrackingWebhooksClient({
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(api.updateWebhook("43350", {
      name: "Echelon carrier tracking",
      url: TARGET,
      headers: [{ key: "x-test", value: "secret" }],
    })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.shipstation.com/v2/environment/webhooks/43350",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("refuses an insecure provider API base URL before sending credentials", () => {
    expect(() => createShipStationTrackingWebhooksClient({
      apiKey: "test-key",
      baseUrl: "http://api.shipstation.test/v2",
    })).toThrow(/HTTPS/);
  });
});

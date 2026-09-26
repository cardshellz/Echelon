import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_RETURN_LABEL_API,
  type CustomerReturnLabelSettingsInput,
  type CustomerReturnLabelSettingsState,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import {
  assertReturnLabelStatus,
  createReturnLabelTransport,
  downloadReturnLabel,
  loadReturnLabelSettings,
  returnLabelsEnabled,
  ReturnLabelRequestError,
  saveReturnLabelSettings,
} from "../../customer-return-labels";
import { PreviewAccessError } from "../../customer-return-preview";

const channelId = 7;
const authorizationId = 123;
const commandKey = "dc9b329b-b250-46a1-9b20-3d3149a2846d";
type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function submission(): CustomerReturnLabelSubmitInput {
  return {
    channelId,
    idempotencyKey: commandKey,
    settingsVersion: 2,
    sourceRevision: "a".repeat(64),
    orderReference: "#1001",
    selections: [{ lineId: "line-a", quantity: 2, reasonCode: null }],
    parcels: [1, 2].map(() => ({
      dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 152.4 },
      originalBoxId: null,
      items: [{ lineId: "line-a", quantity: 1 }],
    })),
  };
}

function status(): CustomerReturnLabelStatus {
  return {
    channelId,
    authorizationId,
    authorizationNumber: "RMA-123",
    canProgress: true,
    parcels: [31, 32].map((parcelId, index) => ({
      parcelId,
      number: index + 1,
      status: index === 0 ? "ready" : "pending",
      trackingNumber: index === 0 ? "TRACK-31" : null,
      downloadPath:
        index === 0
          ? `${CUSTOMER_RETURN_LABEL_API}/labels/${channelId}/${authorizationId}/parcels/${parcelId}/download`
          : null,
    })),
  };
}

function settings(): CustomerReturnLabelSettingsState {
  const address = {
    name: "Returns",
    addressLine1: "100 Warehouse Road",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    countryCode: "US" as const,
  };
  return {
    channelId,
    providerConfigured: true,
    settings: {
      enabled: true,
      warehouseId: 10,
      policyId: 20,
      carrierId: "se-123",
      serviceCode: "usps_ground_advantage",
      contactName: "Returns",
      contactPhone: null,
      version: 2,
      destinationAddress: address,
    },
    warehouses: [{ id: 10, name: "Main", address }],
    policies: [{ id: 20, name: "Standard returns", version: 1 }],
    carriers: [
      {
        id: "se-123",
        name: "USPS",
        services: [{ code: "usps_ground_advantage", name: "Ground Advantage" }],
      },
    ],
    message: null,
  };
}

function settingsInput(): CustomerReturnLabelSettingsInput {
  return {
    expectedVersion: 2,
    enabled: true,
    warehouseId: 10,
    policyId: 20,
    carrierId: "se-123",
    serviceCode: "usps_ground_advantage",
    contactName: "Returns",
    contactPhone: null,
  };
}

function response(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

describe("return label transport", () => {
  it("uses authenticated noncached GETs for settings, status, and command recovery", async () => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValueOnce(response(settings()))
      .mockResolvedValueOnce(response(status()))
      .mockResolvedValueOnce(response(status()));
    const signal = new AbortController().signal;
    const api = createReturnLabelTransport(channelId, request);

    await loadReturnLabelSettings(channelId, signal, request);
    await api.status(authorizationId, signal);
    await api.byCommand(commandKey, signal);

    expect(request.mock.calls).toEqual([
      [
        `${CUSTOMER_RETURN_LABEL_API}/label-settings/7`,
        { method: "GET", credentials: "include", cache: "no-store", signal },
      ],
      [
        `${CUSTOMER_RETURN_LABEL_API}/labels/7/123`,
        { method: "GET", credentials: "include", cache: "no-store", signal },
      ],
      [
        `${CUSTOMER_RETURN_LABEL_API}/labels/7/by-command/${commandKey}`,
        { method: "GET", credentials: "include", cache: "no-store", signal },
      ],
    ]);
  });

  it("marks every command and settings write, sends exact validated bodies, and forwards abort", async () => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValueOnce(response(status()))
      .mockResolvedValueOnce(response(status()))
      .mockResolvedValueOnce(response(status()))
      .mockResolvedValueOnce(response(settings()));
    const signal = new AbortController().signal;
    const api = createReturnLabelTransport(channelId, request);
    const input = submission();
    const config = settingsInput();

    await api.submit(input, signal);
    await api.resume(commandKey, signal);
    await api.progress(authorizationId, signal);
    await saveReturnLabelSettings(channelId, config, signal, request);

    const commandOptions = {
      credentials: "include",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", "X-Return-Command": "1" },
    };
    expect(
      request.mock.calls.map(([url, options]) => [
        url,
        {
          ...options,
          body: JSON.parse(options?.body as string),
        },
      ]),
    ).toEqual([
      [
        `${CUSTOMER_RETURN_LABEL_API}/labels`,
        { ...commandOptions, method: "POST", body: input },
      ],
      [
        `${CUSTOMER_RETURN_LABEL_API}/labels/7/by-command/${commandKey}/resume`,
        { ...commandOptions, method: "POST", body: {} },
      ],
      [
        `${CUSTOMER_RETURN_LABEL_API}/labels/7/123/progress`,
        { ...commandOptions, method: "POST", body: {} },
      ],
      [
        `${CUSTOMER_RETURN_LABEL_API}/label-settings/7`,
        { ...commandOptions, method: "PUT", body: config },
      ],
    ]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    "rejects unsafe channel ID %s before transport",
    (id) => {
      const request = vi.fn<FetchRequest>();
      expect(() => createReturnLabelTransport(id, request)).toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid command identifiers, authorization IDs, and foreign-channel input without HTTP", async () => {
    const request = vi.fn<FetchRequest>();
    const api = createReturnLabelTransport(channelId, request);
    const signal = new AbortController().signal;
    expect(() => api.status(0, signal)).toThrow();
    expect(() => api.progress(1.5, signal)).toThrow();
    expect(() => api.byCommand("../../other-return", signal)).toThrow();
    expect(() => api.resume("not-a-uuid", signal)).toThrow();
    await expect(
      api.submit({ ...submission(), channelId: 8 }, signal),
    ).rejects.toThrow("Shopify shop changed");
    await expect(loadReturnLabelSettings(0, signal, request)).rejects.toThrow();
    await expect(
      saveReturnLabelSettings(0, settingsInput(), signal, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      "extra root field",
      (input: CustomerReturnLabelSubmitInput) => ({
        ...input,
        providerUrl: "https://untrusted.invalid",
      }),
    ],
    [
      "extra parcel field",
      (input: CustomerReturnLabelSubmitInput) => ({
        ...input,
        parcels: [{ ...input.parcels[0], shippingCost: 1 }],
      }),
    ],
    [
      "fractional quantity",
      (input: CustomerReturnLabelSubmitInput) => ({
        ...input,
        selections: [{ ...input.selections[0], quantity: 1.5 }],
      }),
    ],
    [
      "missing source revision",
      (input: CustomerReturnLabelSubmitInput) => ({
        ...input,
        sourceRevision: null,
      }),
    ],
  ])("rejects submit DTO with %s before transport", async (_name, mutate) => {
    const request = vi.fn<FetchRequest>();
    await expect(
      createReturnLabelTransport(channelId, request).submit(
        mutate(submission()) as CustomerReturnLabelSubmitInput,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unknown settings input fields before a configuration write", async () => {
    const request = vi.fn<FetchRequest>();
    const input = { ...settingsInput(), apiKey: "must-not-send" };
    await expect(
      saveReturnLabelSettings(
        channelId,
        input,
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      "extra root field",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        providerUrl: "https://untrusted.invalid",
      }),
    ],
    [
      "extra parcel field",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          { ...value.parcels[0], labelUrl: "https://untrusted.invalid" },
        ],
      }),
    ],
    [
      "unknown parcel state",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [{ ...value.parcels[0], status: "shipped" }],
      }),
    ],
    [
      "unsafe parcel ID",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          { ...value.parcels[0], parcelId: Number.MAX_SAFE_INTEGER + 1 },
        ],
      }),
    ],
    [
      "external download URL",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            downloadPath: "https://untrusted.invalid/label.pdf",
          },
        ],
      }),
    ],
  ])("rejects status DTO with %s", async (_name, mutate) => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValue(response(mutate(status())));
    await expect(
      createReturnLabelTransport(channelId, request).status(
        authorizationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("could not be verified");
  });

  it.each([
    [
      "foreign channel",
      (value: CustomerReturnLabelStatus) => ({ ...value, channelId: 8 }),
    ],
    [
      "foreign authorization",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        authorizationId: 124,
      }),
    ],
    [
      "duplicate parcel ID",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [value.parcels[0], { ...value.parcels[1], parcelId: 31 }],
      }),
    ],
    [
      "duplicate parcel number",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [value.parcels[0], { ...value.parcels[1], number: 1 }],
      }),
    ],
    [
      "noncontiguous parcel numbers",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [value.parcels[0], { ...value.parcels[1], number: 3 }],
      }),
    ],
    [
      "wrong download parcel",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            downloadPath: `${CUSTOMER_RETURN_LABEL_API}/labels/7/123/parcels/32/download`,
          },
          value.parcels[1],
        ],
      }),
    ],
    [
      "wrong download channel",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            downloadPath: `${CUSTOMER_RETURN_LABEL_API}/labels/8/123/parcels/31/download`,
          },
          value.parcels[1],
        ],
      }),
    ],
    [
      "wrong download authorization",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          {
            ...value.parcels[0],
            downloadPath: `${CUSTOMER_RETURN_LABEL_API}/labels/7/124/parcels/31/download`,
          },
          value.parcels[1],
        ],
      }),
    ],
    [
      "download for a pending purchase",
      (value: CustomerReturnLabelStatus) => ({
        ...value,
        parcels: [
          { ...value.parcels[0], status: "pending" as const },
          value.parcels[1],
        ],
      }),
    ],
  ])("rejects %s before presenting a return", async (_name, mutate) => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValue(response(mutate(status())));
    await expect(
      createReturnLabelTransport(channelId, request).status(
        authorizationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("could not be matched");
  });

  it("requires submit response parcel count to equal the reviewed packing plan", async () => {
    const value = status();
    value.parcels = [value.parcels[0]];
    const request = vi.fn<FetchRequest>().mockResolvedValue(response(value));
    await expect(
      createReturnLabelTransport(channelId, request).submit(
        submission(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("could not be matched");
  });

  it("allows unordered response parcels when their identities, numbers, and artifact paths agree", () => {
    const value = status();
    value.parcels.reverse();
    expect(assertReturnLabelStatus(value, channelId, authorizationId, 2)).toBe(
      value,
    );
  });

  it.each([401, 403])(
    "reports HTTP %s as access loss without displaying the server body",
    async (code) => {
      const request = vi
        .fn<FetchRequest>()
        .mockResolvedValue(response({ secret: "private server detail" }, code));
      await expect(
        createReturnLabelTransport(channelId, request).status(
          authorizationId,
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(PreviewAccessError);
    },
  );

  it.each([
    [404, "RETURN_LABEL_SUBMISSION_NOT_FOUND"],
    [409, "RETURN_LABEL_SUBMISSION_PROCESSING"],
    [410, "RETURN_LABEL_SUBMISSION_REJECTED"],
  ])(
    "preserves the recovery classification for HTTP %s",
    async (httpStatus, code) => {
      const request = vi
        .fn<FetchRequest>()
        .mockResolvedValue(
          response(
            { error: { code, message: "private provider detail" } },
            httpStatus,
          ),
        );
      const operation = createReturnLabelTransport(
        channelId,
        request,
      ).byCommand(commandKey, new AbortController().signal);
      await expect(operation).rejects.toMatchObject({
        name: "ReturnLabelRequestError",
        code,
      });
      await expect(operation).rejects.not.toThrow("private provider detail");
    },
  );

  it("handles malformed JSON and failure bodies without trusting server messages", async () => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValueOnce(new Response("{broken", { status: 200 }))
      .mockResolvedValueOnce(
        new Response("private backend failure", { status: 503 }),
      );
    const api = createReturnLabelTransport(channelId, request);
    const signal = new AbortController().signal;
    await expect(api.status(authorizationId, signal)).rejects.toThrow(
      "could not be verified",
    );
    await expect(api.status(authorizationId, signal)).rejects.toEqual(
      expect.objectContaining<Partial<ReturnLabelRequestError>>({
        code: "RETURN_LABEL_REQUEST_FAILED",
      }),
    );
  });
});

describe("return label settings capability", () => {
  it("enables only a fully resolved, configured capability", () => {
    expect(returnLabelsEnabled(settings())).toBe(true);
    expect(returnLabelsEnabled(null)).toBe(false);
  });

  it.each([
    [
      "no provider",
      (value: CustomerReturnLabelSettingsState) => {
        value.providerConfigured = false;
      },
    ],
    [
      "no settings",
      (value: CustomerReturnLabelSettingsState) => {
        value.settings = null;
      },
    ],
    [
      "disabled settings",
      (value: CustomerReturnLabelSettingsState) => {
        value.settings!.enabled = false;
      },
    ],
    [
      "missing warehouse",
      (value: CustomerReturnLabelSettingsState) => {
        value.warehouses = [];
      },
    ],
    [
      "unresolved warehouse address",
      (value: CustomerReturnLabelSettingsState) => {
        value.warehouses[0].address = null;
      },
    ],
    [
      "missing policy",
      (value: CustomerReturnLabelSettingsState) => {
        value.policies = [];
      },
    ],
    [
      "missing carrier",
      (value: CustomerReturnLabelSettingsState) => {
        value.carriers = [];
      },
    ],
    [
      "missing service",
      (value: CustomerReturnLabelSettingsState) => {
        value.carriers[0].services = [];
      },
    ],
  ])("keeps label creation disabled with %s", (_name, mutate) => {
    const value = settings();
    mutate(value);
    expect(returnLabelsEnabled(value)).toBe(false);
  });

  it.each([
    [
      "channel mismatch",
      (value: CustomerReturnLabelSettingsState) => {
        value.channelId = 8;
      },
    ],
    [
      "duplicate warehouse",
      (value: CustomerReturnLabelSettingsState) => {
        value.warehouses.push(value.warehouses[0]);
      },
    ],
    [
      "duplicate policy",
      (value: CustomerReturnLabelSettingsState) => {
        value.policies.push(value.policies[0]);
      },
    ],
    [
      "duplicate carrier",
      (value: CustomerReturnLabelSettingsState) => {
        value.carriers.push(value.carriers[0]);
      },
    ],
    [
      "duplicate service",
      (value: CustomerReturnLabelSettingsState) => {
        value.carriers[0].services.push(value.carriers[0].services[0]);
      },
    ],
  ])(
    "rejects a settings response with %s on both read and save",
    async (_name, mutate) => {
      const value = settings();
      mutate(value);
      const request = vi
        .fn<FetchRequest>()
        .mockImplementation(async () => response(value));
      const signal = new AbortController().signal;
      await expect(
        loadReturnLabelSettings(channelId, signal, request),
      ).rejects.toThrow("configuration could not be verified");
      await expect(
        saveReturnLabelSettings(channelId, settingsInput(), signal, request),
      ).rejects.toThrow("configuration could not be verified");
    },
  );

  it("rejects provider secrets and unknown fields in settings responses", async () => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValue(
        response({ ...settings(), apiKey: "must-not-render" }),
      );
    await expect(
      loadReturnLabelSettings(channelId, new AbortController().signal, request),
    ).rejects.toThrow("could not be verified");
  });
});

describe("return label downloads", () => {
  it("downloads only the verified parcel path with fresh authenticated, uncached access", async () => {
    const signal = new AbortController().signal;
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValue(
        new Response("%PDF-1.7\nverified label", {
          headers: { "Content-Type": "application/pdf; charset=binary" },
        }),
      );
    const value = status();
    const blob = await downloadReturnLabel(value, 31, signal, request);
    expect(await blob.text()).toBe("%PDF-1.7\nverified label");
    expect(request).toHaveBeenCalledExactlyOnceWith(
      value.parcels[0].downloadPath,
      { credentials: "include", cache: "no-store", signal },
    );
  });

  it("rejects unready, unknown, or mismatched parcel downloads before HTTP", async () => {
    const request = vi.fn<FetchRequest>();
    const signal = new AbortController().signal;
    await expect(
      downloadReturnLabel(status(), 32, signal, request),
    ).rejects.toThrow("not ready");
    await expect(
      downloadReturnLabel(status(), 99, signal, request),
    ).rejects.toThrow("not ready");
    const changed = status();
    changed.parcels[0].downloadPath = `${CUSTOMER_RETURN_LABEL_API}/labels/8/123/parcels/31/download`;
    await expect(
      downloadReturnLabel(changed, 31, signal, request),
    ).rejects.toThrow("could not be matched");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "rechecks access for HTTP %s even when the label was ready",
    async (code) => {
      const request = vi
        .fn<FetchRequest>()
        .mockResolvedValue(response({}, code));
      await expect(
        downloadReturnLabel(
          status(),
          31,
          new AbortController().signal,
          request,
        ),
      ).rejects.toBeInstanceOf(PreviewAccessError);
    },
  );

  it.each([
    ["wrong MIME", "%PDF-1.7", "text/html"],
    ["empty PDF", "", "application/pdf"],
    ["incorrect file signature", "<html>Sign in</html>", "application/pdf"],
  ])("rejects a %s response", async (_name, body, contentType) => {
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValue(
        new Response(body, { headers: { "Content-Type": contentType } }),
      );
    await expect(
      downloadReturnLabel(status(), 31, new AbortController().signal, request),
    ).rejects.toThrow("file could not be verified");
  });

  it("rejects oversized declared content before reading and checks actual blob size independently", async () => {
    const declared = new Response("%PDF-1.7", {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(10 * 1024 * 1024 + 1),
      },
    });
    const read = vi.spyOn(declared, "blob");
    const actual = new Response(
      new Blob(["%PDF-", new Uint8Array(10 * 1024 * 1024)]),
      { headers: { "Content-Type": "application/pdf" } },
    );
    const request = vi
      .fn<FetchRequest>()
      .mockResolvedValueOnce(declared)
      .mockResolvedValueOnce(actual);
    const signal = new AbortController().signal;
    await expect(
      downloadReturnLabel(status(), 31, signal, request),
    ).rejects.toThrow("file could not be verified");
    expect(read).not.toHaveBeenCalled();
    await expect(
      downloadReturnLabel(status(), 31, signal, request),
    ).rejects.toThrow("file could not be verified");
  });
});

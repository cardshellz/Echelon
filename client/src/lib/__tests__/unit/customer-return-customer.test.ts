import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnCommandSession,
  CustomerReturnRequestError,
  assertCustomerReturnStatus,
  createCustomerReturnTransport,
  customerReturnSavedRequestSchema,
  downloadCustomerReturnLabel,
  type CustomerReturnTransport,
} from "../../customer-return-customer";
import { PreviewAccessError } from "../../customer-return-preview";
import type {
  CustomerReturnCustomerLabelStatus,
  CustomerReturnCustomerSubmitInput,
} from "@shared/returns/customer-return-customer.contract";

const identity = "a".repeat(43);
const commandKey = "dc9b329b-b250-46a1-9b20-3d3149a2846d";
const storageKey = `customer-return-request:${identity}`;
function input(): CustomerReturnCustomerSubmitInput {
  return {
    idempotencyKey: commandKey,
    settingsVersion: 2,
    sourceRevision: "a".repeat(64),
    selections: [{ lineId: "line-1", quantity: 1, reasonCode: null }],
    parcels: [
      {
        dimensions: { lengthMm: 100, widthMm: 100, heightMm: 100 },
        originalBoxId: null,
        items: [{ lineId: "line-1", quantity: 1 }],
      },
    ],
  };
}
function status(): CustomerReturnCustomerLabelStatus {
  return {
    authorizationId: 20,
    authorizationNumber: "RMA-20",
    canProgress: false,
    parcels: [
      {
        parcelId: 30,
        number: 1,
        status: "ready",
        trackingNumber: "TRACK-30",
        downloadPath: "/api/returns/customer/returns/20/parcels/30/download",
      },
    ],
  };
}
function storage() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: vi.fn((key: string) => rows.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      rows.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      rows.delete(key);
    }),
  };
}
function setup(saved = storage()) {
  const api = {
    submit: vi.fn(async () => status()),
    byCommand: vi.fn(async () => status()),
    status: vi.fn(async () => status()),
    resume: vi.fn(async () => status()),
    progress: vi.fn(async () => status()),
  };
  const denied = vi.fn();
  const newKey = vi.fn(() => commandKey);
  const session = new CustomerReturnCommandSession(
    identity,
    saved,
    api as unknown as CustomerReturnTransport,
    denied,
    newKey,
  );
  return { session, saved, api, denied, newKey };
}
function begin(s: ReturnType<typeof setup>) {
  const { idempotencyKey: _key, ...body } = input();
  return s.session.begin(10, body);
}

describe("customer return transport", () => {
  it("uses customer-only routes and explicit JSON command protection", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(status()), { status: 200 }),
      );
    await createCustomerReturnTransport(request, identity).submit(
      10,
      input(),
      new AbortController().signal,
    );
    expect(request).toHaveBeenCalledWith(
      "/api/returns/customer/orders/10/returns",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Return-Command": "1",
          "X-Return-Session": identity,
        },
      }),
    );
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual(input());
  });
  it("strictly rejects browser-supplied channel/customer/reference authority", async () => {
    const request = vi.fn<typeof fetch>();
    const api = createCustomerReturnTransport(request, identity);
    for (const field of [
      { channelId: 36 },
      { externalCustomerId: "other" },
      { orderReference: "#123" },
    ]) {
      await expect(
        api.submit(10, { ...input(), ...field }, new AbortController().signal),
      ).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("requires a bound session for workspace requests but permits sign-in discovery", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            authenticated: false,
            privateTesting: true,
            sessionKey: null,
          }),
        ),
      );
    const api = createCustomerReturnTransport(request);
    await api.session(new AbortController().signal);
    await expect(
      api.orders(null, new AbortController().signal),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("requires new sign-in on status %i", async (code) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: code }));
    await expect(
      createCustomerReturnTransport(request, identity).status(
        20,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PreviewAccessError);
  });
  it("sanitizes unknown server details while retaining the ambiguous 404 classification", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "CUSTOMER_RETURN_UNAVAILABLE",
              message: "private-sql-secret",
            },
          }),
          { status: 404 },
        ),
      );
    await expect(
      createCustomerReturnTransport(request, identity).byCommand(
        commandKey,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "CUSTOMER_RETURN_UNAVAILABLE",
      status: 404,
      message: expect.not.stringContaining("private-sql-secret"),
    });
  });
  it.each(["authorization", "box", "download", "duplicate", "private"])(
    "rejects mismatched status %s",
    (change) => {
      const value = status();
      if (change === "authorization") value.authorizationId = 21;
      if (change === "box") value.parcels[0].number = 2;
      if (change === "download")
        value.parcels[0].downloadPath =
          "/api/returns/customer/returns/20/parcels/31/download";
      if (change === "duplicate") value.parcels.push({ ...value.parcels[0] });
      if (change === "private")
        value.parcels[0].downloadPath =
          "/api/returns/admin/portal-preview/live/labels/36/20/parcels/30/download";
      expect(() => assertCustomerReturnStatus(value, 20)).toThrow();
    },
  );
  it("keeps status and history reads free of command effects", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(status())))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ returns: [], nextBeforeAuthorizationId: null }),
        ),
      );
    const api = createCustomerReturnTransport(request, identity);
    const signal = new AbortController().signal;
    await api.status(20, signal);
    await api.history(10, signal);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "/api/returns/customer/returns/20",
      "/api/returns/customer/returns?before=10",
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });
  it("downloads only a verified customer PDF", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("%PDF-test", {
          headers: { "Content-Type": "application/pdf" },
        }),
      );
    expect(
      (
        await downloadCustomerReturnLabel(
          status(),
          30,
          identity,
          new AbortController().signal,
          request,
        )
      ).size,
    ).toBe(9);
    request.mockResolvedValue(
      new Response("private HTML", {
        headers: { "Content-Type": "text/html" },
      }),
    );
    await expect(
      downloadCustomerReturnLabel(
        status(),
        30,
        identity,
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow("could not be verified");
  });
});

describe("durable customer return commands", () => {
  it("saves validated exact intent before the first write and never auto-progresses", async () => {
    const s = setup();
    s.api.submit.mockImplementation(async () => {
      expect(
        customerReturnSavedRequestSchema.parse(
          JSON.parse(s.saved.rows.get(storageKey)!),
        ),
      ).toMatchObject({
        omsOrderId: 10,
        input: input(),
        authorizationId: null,
      });
      return status();
    });
    await begin(s);
    expect(s.session.getSnapshot().status?.authorizationId).toBe(20);
    expect(s.api.progress).not.toHaveBeenCalled();
  });
  it("prepares pending boxes from the explicit initial action and stops at uncertainty", async () => {
    const s = setup();
    const pending = {
      ...status(),
      canProgress: true,
      parcels: [
        {
          ...status().parcels[0],
          status: "pending" as const,
          trackingNumber: null,
          downloadPath: null,
        },
      ],
    };
    s.api.submit.mockResolvedValue(pending);
    s.api.progress.mockResolvedValue({
      ...pending,
      parcels: [{ ...pending.parcels[0], status: "processing" }],
    });
    await begin(s);
    expect(s.api.progress).toHaveBeenCalledExactlyOnceWith(
      20,
      expect.any(AbortSignal),
    );
    expect(s.session.getSnapshot().status?.parcels[0].status).toBe(
      "processing",
    );
    const resumed = setup(s.saved);
    await resumed.session.check();
    expect(resumed.api.progress).not.toHaveBeenCalled();
  });
  it("retains exact intent/key through timeout, reload, absent command and explicit retry", async () => {
    const first = setup();
    first.api.submit.mockRejectedValue(new Error("Network response lost"));
    await begin(first);
    const record = first.saved.rows.get(storageKey);
    first.session.finish();
    expect(first.saved.rows.get(storageKey)).toBe(record);
    const resumed = setup(first.saved);
    resumed.api.byCommand.mockRejectedValue(
      new CustomerReturnRequestError(
        "CUSTOMER_RETURN_UNAVAILABLE",
        "Unknown",
        404,
      ),
    );
    await resumed.session.check();
    expect(resumed.api.submit).not.toHaveBeenCalled();
    expect(resumed.api.resume).not.toHaveBeenCalled();
    expect(resumed.session.getSnapshot().record?.input).toEqual(input());
    resumed.api.resume.mockRejectedValue(
      new CustomerReturnRequestError(
        "CUSTOMER_RETURN_UNAVAILABLE",
        "Unknown",
        404,
      ),
    );
    await resumed.session.retry();
    expect(resumed.api.submit).toHaveBeenCalledExactlyOnceWith(
      10,
      input(),
      expect.any(AbortSignal),
    );
    expect(resumed.newKey).not.toHaveBeenCalled();
  });
  it("never resubmits when a known command resumes successfully or when its outcome is still uncertain", async () => {
    const first = setup();
    first.api.submit.mockRejectedValue(new Error("Network"));
    await begin(first);
    const s = setup(first.saved);
    s.api.resume.mockRejectedValueOnce(
      new CustomerReturnRequestError(
        "RETURN_LABEL_SUBMISSION_PROCESSING",
        "Still checking",
        409,
      ),
    );
    await s.session.retry();
    expect(s.api.submit).not.toHaveBeenCalled();
    await s.session.retry();
    expect(s.session.getSnapshot().status).toEqual(status());
    expect(s.api.submit).not.toHaveBeenCalled();
  });
  it("allows explicit reset only after definitive rejection or all labels are ready", async () => {
    const s = setup();
    s.api.submit.mockRejectedValue(
      new CustomerReturnRequestError(
        "RETURN_LABEL_SUBMISSION_REJECTED",
        "Rejected",
        410,
      ),
    );
    await begin(s);
    expect(s.session.getSnapshot().rejected).toBe(true);
    expect(s.saved.rows.has(storageKey)).toBe(true);
    s.session.finish();
    expect(s.session.getSnapshot().record).toBeNull();
    expect(s.saved.rows.has(storageKey)).toBe(false);
  });
  it("allows leaving a known terminal failed return without losing its server history", async () => {
    const s = setup();
    s.api.submit.mockResolvedValue({
      ...status(),
      parcels: [
        {
          ...status().parcels[0],
          status: "failed",
          trackingNumber: null,
          downloadPath: null,
        },
      ],
    });
    await begin(s);
    s.session.finish();
    expect(s.session.getSnapshot().record).toBeNull();
    expect(s.api.progress).not.toHaveBeenCalled();
  });
  it("prevents concurrent clicks from creating another command key", async () => {
    const s = setup();
    let resolve!: (value: CustomerReturnCustomerLabelStatus) => void;
    s.api.submit.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = begin(s);
    await begin(s);
    expect(s.api.submit).toHaveBeenCalledOnce();
    expect(s.newKey).toHaveBeenCalledOnce();
    resolve(status());
    await pending;
  });
  it("does not submit if recovery storage is unavailable", async () => {
    const s = setup();
    s.saved.setItem.mockImplementation(() => {
      throw new Error("Quota");
    });
    await begin(s);
    expect(s.api.submit).not.toHaveBeenCalled();
    expect(s.session.getSnapshot().storageBlocked).toBe(true);
  });
  it("does not overwrite malformed or differently scoped saved intent", async () => {
    const saved = storage();
    saved.rows.set(storageKey, JSON.stringify({ untrusted: true }));
    const s = setup(saved);
    await begin(s);
    expect(s.api.submit).not.toHaveBeenCalled();
    expect(saved.setItem).not.toHaveBeenCalled();
    expect(s.session.getSnapshot().storageBlocked).toBe(true);
  });
  it("isolates browser recovery by the verified session key", async () => {
    const s = setup();
    s.api.submit.mockRejectedValue(new Error("Network"));
    await begin(s);
    const next = new CustomerReturnCommandSession(
      "b".repeat(43),
      s.saved,
      s.api as unknown as CustomerReturnTransport,
      s.denied,
    );
    await next.check();
    expect(next.getSnapshot().record).toBeNull();
    expect(s.api.byCommand).not.toHaveBeenCalled();
  });
  it("ignores a response after disposal and keeps the recovery key", async () => {
    const s = setup();
    let resolve!: (value: CustomerReturnCustomerLabelStatus) => void;
    s.api.submit.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = begin(s);
    s.session.dispose();
    resolve(status());
    await pending;
    expect(s.session.getSnapshot().status).toBeNull();
    expect(s.saved.rows.has(storageKey)).toBe(true);
  });
  it("keeps the prior accepted identity when a later status claims different boxes", async () => {
    const s = setup();
    await begin(s);
    s.api.status.mockResolvedValue({
      ...status(),
      parcels: [
        {
          ...status().parcels[0],
          parcelId: 31,
          downloadPath: "/api/returns/customer/returns/20/parcels/31/download",
        },
      ],
    });
    await s.session.check();
    expect(s.session.getSnapshot().status?.parcels[0].parcelId).toBe(30);
    expect(s.session.getSnapshot().error).toContain("box identities changed");
  });
  it("clears authenticated UI on access denial without erasing uncertain recovery", async () => {
    const s = setup();
    s.api.submit.mockRejectedValue(new PreviewAccessError("Sign in again"));
    await begin(s);
    expect(s.denied).toHaveBeenCalledWith("Sign in again");
    expect(s.saved.rows.has(storageKey)).toBe(true);
  });
});

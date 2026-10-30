import type { CustomerReturnWorkflowStatus } from "@shared/returns/customer-return-workflow.contract";
import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnCommandSession,
  CUSTOMER_RETURN_REQUEST_TIMEOUT_MS,
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
function workflow(phase: CustomerReturnWorkflowStatus["phase"] = "queued", labels?: CustomerReturnCustomerLabelStatus): CustomerReturnWorkflowStatus {
  return { requestKey: commandKey, omsOrderId: 10, phase, updatedAt: "2026-10-30T12:00:00.000Z",
    reason: phase === "needs_input" ? "RETURN_DETAILS_CHANGED" : phase === "needs_help" ? "RETURN_LABEL_RECONCILIATION_REQUIRED"
      : phase === "retryable_failure" ? "RETURN_WORKFLOW_TEMPORARY_FAILURE" : null,
    labels: labels ?? (phase === "ready" ? status() : phase === "labels" ? { ...status(), canProgress: true,
      parcels: [{ ...status().parcels[0], status: "pending", trackingNumber: null, downloadPath: null }] } : null) };
}
function setup(saved = storage()) {
  const api = {
    orderWorkflow: vi.fn(async () => ({ workflow: workflow("labels"), input: input() })),
    enqueue: vi.fn(async () => workflow()),
    workflow: vi.fn(async () => workflow("ready")),
    retryWorkflow: vi.fn(async () => workflow()),
    queueExistingLabels: vi.fn(async () => workflow("labels")),
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
  it("bounds a stalled observation without issuing any command", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>(async (_target, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
      const result = expect(createCustomerReturnTransport(request, identity).workflow(commandKey, new AbortController().signal))
        .rejects.toMatchObject({ code: "CUSTOMER_RETURN_REQUEST_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(CUSTOMER_RETURN_REQUEST_TIMEOUT_MS);
      await result;
      expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][1]?.method).toBe("GET");
    } finally { vi.useRealTimers(); }
  });

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

describe("durable customer return workflow observation", () => {
  it("saves exact intent before enqueue and leaves all label continuation to the backend", async () => {
    const s = setup();
    s.api.enqueue.mockImplementationOnce(async () => {
      expect(customerReturnSavedRequestSchema.parse(JSON.parse(s.saved.rows.get(storageKey)!)).input).toEqual(input());
      return workflow();
    });
    await begin(s);
    expect(s.api.enqueue).toHaveBeenCalledExactlyOnceWith(10, input(), expect.any(AbortSignal));
    expect(s.session.getSnapshot().workflow?.phase).toBe("queued");
    expect(s.api.progress).not.toHaveBeenCalled(); expect(s.api.submit).not.toHaveBeenCalled(); expect(s.api.resume).not.toHaveBeenCalled();
  });
  it("observes completed downloads through GET only", async () => {
    const s = setup(); await begin(s); await s.session.check();
    expect(s.session.getSnapshot().workflow?.phase).toBe("ready");
    expect(s.session.getSnapshot().status).toEqual(status());
    expect(s.api.workflow).toHaveBeenCalledExactlyOnceWith(commandKey, expect.any(AbortSignal));
    expect(s.api.progress).not.toHaveBeenCalled(); expect(s.api.retryWorkflow).not.toHaveBeenCalled();
  });
  it("retains the same key through a lost enqueue response, reload and explicit retry", async () => {
    const s = setup(); s.api.enqueue.mockRejectedValueOnce(new TypeError("lost response")); await begin(s);
    const resumed = setup(s.saved);
    resumed.api.workflow.mockRejectedValueOnce(new CustomerReturnRequestError("RETURN_WORKFLOW_NOT_FOUND", "missing", 404));
    resumed.api.byCommand.mockRejectedValueOnce(new CustomerReturnRequestError("RETURN_LABEL_SUBMISSION_NOT_FOUND", "missing", 404));
    await resumed.session.check(); expect(resumed.api.enqueue).not.toHaveBeenCalled();
    resumed.api.retryWorkflow.mockRejectedValueOnce(new CustomerReturnRequestError("RETURN_WORKFLOW_NOT_FOUND", "missing", 404));
    await resumed.session.retry();
    expect(resumed.api.enqueue).toHaveBeenCalledExactlyOnceWith(10, input(), expect.any(AbortSignal));
    expect(resumed.newKey).not.toHaveBeenCalled();
  });
  it("restores an active server request after browser storage is gone without enqueueing or purchasing", async () => {
    const s = setup();
    expect(await s.session.restore(10, new AbortController().signal)).toBe(true);
    expect(s.session.getSnapshot().record?.input).toEqual(input());
    expect(s.session.getSnapshot().workflow?.phase).toBe("labels");
    expect(s.api.enqueue).not.toHaveBeenCalled(); expect(s.api.progress).not.toHaveBeenCalled();
    expect(JSON.parse(s.saved.rows.get(storageKey)!).input.idempotencyKey).toBe(commandKey);
  });
  it("permits a new selection only when the owned server lookup confirms no active request", async () => {
    const s = setup(); s.api.orderWorkflow.mockRejectedValueOnce(new CustomerReturnRequestError("RETURN_WORKFLOW_NOT_FOUND", "missing", 404));
    expect(await s.session.restore(10, new AbortController().signal)).toBe(false);
    expect(s.session.getSnapshot().record).toBeNull();
  });
  it("reads old accepted receipts without commands and adopts only on an explicit retry", async () => {
    const s = setup(); await begin(s);
    s.api.workflow.mockRejectedValueOnce(new CustomerReturnRequestError("RETURN_WORKFLOW_NOT_FOUND", "missing", 404));
    await s.session.check();
    expect(s.api.byCommand).toHaveBeenCalledTimes(1);
    expect(s.api.queueExistingLabels).not.toHaveBeenCalled();
    s.api.retryWorkflow.mockRejectedValueOnce(new CustomerReturnRequestError("RETURN_WORKFLOW_NOT_FOUND", "missing", 404));
    await s.session.retry();
    expect(s.api.queueExistingLabels).toHaveBeenCalledExactlyOnceWith(20, expect.any(AbortSignal));
    expect(s.api.resume).not.toHaveBeenCalled(); expect(s.api.progress).not.toHaveBeenCalled();
  });
  it("keeps unresolved carrier outcomes on the original workflow and never progresses postage in the browser", async () => {
    const s = setup(); await begin(s);
    const uncertain = { ...status(), canProgress: true, parcels: [{ ...status().parcels[0], status: "needs_review" as const, downloadPath: null, trackingNumber: null }] };
    s.api.workflow.mockResolvedValueOnce(workflow("needs_help", uncertain));
    await s.session.check();
    expect(s.session.getSnapshot().error).toContain("couldn't confirm");
    s.api.retryWorkflow.mockResolvedValueOnce(workflow("labels", uncertain));
    await s.session.retry();
    expect(s.api.retryWorkflow).toHaveBeenCalledExactlyOnceWith(commandKey, expect.any(AbortSignal));
    expect(s.api.progress).not.toHaveBeenCalled(); expect(s.api.enqueue).toHaveBeenCalledTimes(1);
  });
  it("permits fresh item review only after an authoritative pre-authorization rejection", async () => {
    const s = setup(); await begin(s); s.session.finish();
    expect(s.session.getSnapshot().record).not.toBeNull();
    s.api.workflow.mockResolvedValueOnce(workflow("needs_input")); await s.session.check();
    expect(s.session.getSnapshot().rejected).toBe(true); s.session.finish();
    expect(s.session.getSnapshot().record).toBeNull(); expect(s.saved.rows.has(storageKey)).toBe(false);
  });
  it.each(["key", "order", "authorization", "box"])("rejects a changed %s without overwriting the original identity", async mismatch => {
    const s = setup(); await begin(s); await s.session.check();
    const changed = workflow("ready");
    if (mismatch === "key") changed.requestKey = "00000000-0000-4000-8000-000000000009";
    if (mismatch === "order") changed.omsOrderId = 11;
    if (mismatch === "authorization") changed.labels!.authorizationId = 21;
    if (mismatch === "box") changed.labels!.parcels[0].parcelId = 31;
    s.api.workflow.mockResolvedValueOnce(changed); await s.session.check();
    expect(s.session.getSnapshot().error).not.toBeNull();
    expect(s.session.getSnapshot().status).toEqual(status());
    expect(s.session.getSnapshot().record!.authorizationId).toBe(20);
    expect(s.api.progress).not.toHaveBeenCalled();
  });
  it("coalesces duplicate initial clicks and retry clicks", async () => {
    const s = setup(); let release!: (value: CustomerReturnWorkflowStatus) => void;
    s.api.enqueue.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = begin(s); await begin(s); expect(s.newKey).toHaveBeenCalledTimes(1);
    release(workflow()); await pending;
    s.api.retryWorkflow.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const retry = s.session.retry(); await s.session.retry();
    expect(s.api.retryWorkflow).toHaveBeenCalledTimes(1); release(workflow()); await retry;
  });
  it("does not enqueue if recovery storage is unavailable", async () => {
    const s = setup(); s.saved.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    await begin(s); expect(s.api.enqueue).not.toHaveBeenCalled(); expect(s.session.getSnapshot().storageBlocked).toBe(true);
  });
  it("preserves the original key and warns if an accepted identity cannot be saved", async () => {
    const s = setup(); await begin(s); s.saved.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    await s.session.check(); expect(s.session.getSnapshot().error).toContain("Keep this page open");
    expect(JSON.parse(s.saved.rows.get(storageKey)!).input.idempotencyKey).toBe(commandKey);
  });
  it("does not overwrite a malformed or differently scoped saved receipt", async () => {
    for (const raw of ["{bad", JSON.stringify({ ...customerReturnSavedRequestSchema.parse({ version: 1, sessionKey: identity,
      omsOrderId: 10, authorizationId: null, input: input() }), sessionKey: "b".repeat(43) })]) {
      const saved = storage(); saved.rows.set(storageKey, raw); const s = setup(saved);
      await begin(s); expect(s.api.enqueue).not.toHaveBeenCalled(); expect(saved.rows.get(storageKey)).toBe(raw);
    }
  });
  it("isolates recovery by the verified session", async () => {
    const s = setup(); await begin(s);
    const denied = vi.fn(); const other = new CustomerReturnCommandSession("b".repeat(43), s.saved, s.api as unknown as CustomerReturnTransport, denied);
    expect(other.getSnapshot().record).toBeNull();
  });
  it("ignores a late response after disposal and resumes by observation", async () => {
    const s = setup(); let release!: (value: CustomerReturnWorkflowStatus) => void;
    s.api.enqueue.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = begin(s); s.session.dispose(); release(workflow("ready")); await pending;
    expect(s.session.getSnapshot().status).toBeNull();
    const reopened = setup(s.saved); await reopened.session.check();
    expect(reopened.session.getSnapshot().status).toEqual(status()); expect(reopened.api.enqueue).not.toHaveBeenCalled();
  });
  it("clears the authenticated surface on access denial and retains the uncertain recovery key", async () => {
    const s = setup(); await begin(s); s.api.workflow.mockRejectedValueOnce(new PreviewAccessError("Sign in again"));
    await s.session.check(); expect(s.denied).toHaveBeenCalledWith("Sign in again"); expect(s.saved.rows.has(storageKey)).toBe(true);
  });
  it("keeps the receipt when local clearing fails", async () => {
    const s = setup(); await begin(s); await s.session.check(); s.saved.removeItem.mockImplementationOnce(() => { throw new Error("blocked"); });
    s.session.finish(); expect(s.session.getSnapshot().record).not.toBeNull(); expect(s.session.getSnapshot().error).toContain("could not be cleared");
  });
});

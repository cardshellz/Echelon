import { describe, expect, it, vi } from "vitest";
import {
  archiveReturnPolicy,
  formatReturnPolicyArchiveContext,
  loadReturnPolicyArchivePreview,
  ReturnPolicyArchiveError,
} from "../../return-policy-archive";

const policy = {
  id: 3,
  name: "Channel returns",
  version: 2,
  scopeKind: "channel_context",
  scopeKey: "retail:36",
  businessContext: "retail",
  channelId: 36,
  vendorId: null,
  storeConnectionId: null,
  status: "active",
  returnWindowDays: 45,
};
const input = { expectedVersion: 2, previewRevision: "a".repeat(64) };
const key = "06b5ce45-7103-48aa-a405-a0c5b60bc940";
const signal = new AbortController().signal;
const preview = () => ({
  policy: { ...policy },
  revision: input.previewRevision,
  effects: [
    { contextLabel: "Retail · Channel 36", before: { ...policy }, after: null },
  ],
  unaffectedMoreSpecificPolicies: [],
  historicalReferences: { returnCases: 7, portalIntakes: 3 },
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
type Request = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

describe("return policy archive transport", () => {
  it("reads uncached impact with exact identity, history, and abort scope", async () => {
    const request = vi.fn<Request>().mockResolvedValue(response(preview()));
    expect(await loadReturnPolicyArchivePreview(3, signal, request)).toEqual(
      preview(),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/api/returns/admin/policies/3/archive-preview",
      { credentials: "include", cache: "no-store", signal },
    );
  });

  it("reuses the caller's immutable command and validates the retired result", async () => {
    const result = { policy: { ...policy, status: "retired" }, replayed: true };
    const request = vi
      .fn<Request>()
      .mockImplementation(async () => response(result));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await archiveReturnPolicy(3, input, key, signal, request)).toEqual(
        result,
      );
    }
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(request.mock.calls[0]).toEqual([
      "/api/returns/admin/policies/3/archive",
      {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal,
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(input),
      },
    ]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid ID %s before any request",
    async (id) => {
      const request = vi.fn<Request>();
      await expect(
        loadReturnPolicyArchivePreview(id, signal, request),
      ).rejects.toThrow();
      await expect(
        archiveReturnPolicy(id, input, key, signal, request),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid keys, revisions and unknown intent fields before a write", async () => {
    const request = vi.fn<Request>();
    await expect(
      archiveReturnPolicy(3, input, "not-a-key", signal, request),
    ).rejects.toThrow();
    await expect(
      archiveReturnPolicy(
        3,
        { ...input, previewRevision: "x".repeat(64) },
        key,
        signal,
        request,
      ),
    ).rejects.toThrow();
    await expect(
      archiveReturnPolicy(
        3,
        { ...input, ignored: true } as typeof input,
        key,
        signal,
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong policy", { id: 4 }],
    ["already retired", { status: "retired" }],
  ])("rejects preview for %s", async (_label, patch) => {
    const body = preview();
    const request = vi
      .fn<Request>()
      .mockResolvedValue(
        response({ ...body, policy: { ...body.policy, ...patch } }),
      );
    await expect(
      loadReturnPolicyArchivePreview(3, signal, request),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_RESPONSE_INVALID" });
  });

  it.each([{ id: 4 }, { version: 3 }, { status: "active" }])(
    "rejects mismatched success %j",
    async (patch) => {
      const request = vi
        .fn<Request>()
        .mockResolvedValue(
          response({
            policy: { ...policy, status: "retired", ...patch },
            replayed: false,
          }),
        );
      await expect(
        archiveReturnPolicy(3, input, key, signal, request),
      ).rejects.toMatchObject({ code: "RETURN_POLICY_RESPONSE_INVALID" });
    },
  );

  it.each([
    [401, "IGNORED", "RETURN_POLICY_ACCESS_REQUIRED"],
    [403, "IGNORED", "RETURN_POLICY_ACCESS_REQUIRED"],
    [409, "RETURN_POLICY_ARCHIVE_CHANGED", "RETURN_POLICY_ARCHIVE_CHANGED"],
    [409, "RETURN_POLICY_NOT_ACTIVE", "RETURN_POLICY_NOT_ACTIVE"],
    [503, "PROVIDER_PRIVATE", "PROVIDER_PRIVATE"],
  ])(
    "classifies HTTP %s without showing private server detail",
    async (status, code, expected) => {
      const request = vi
        .fn<Request>()
        .mockResolvedValue(
          response(
            { error: { code, message: "private failure detail" } },
            status as number,
          ),
        );
      const operation = archiveReturnPolicy(3, input, key, signal, request);
      await expect(operation).rejects.toBeInstanceOf(ReturnPolicyArchiveError);
      await expect(operation).rejects.toMatchObject({ code: expected });
      await expect(operation).rejects.not.toThrow("private failure detail");
    },
  );

  it("does not accept malformed JSON or a success that omits impact", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(new Response("{invalid"))
      .mockResolvedValueOnce(response({ policy }));
    await expect(
      loadReturnPolicyArchivePreview(3, signal, request),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_RESPONSE_INVALID" });
    await expect(
      loadReturnPolicyArchivePreview(3, signal, request),
    ).rejects.toMatchObject({ code: "RETURN_POLICY_RESPONSE_INVALID" });
  });
});

describe("readable archive scope labels", () => {
  const references = {
    channels: [
      { id: 36, name: "Shopify" },
      { id: 42, name: "Shopify" },
    ],
    vendors: [{ id: 12, name: "Vendor A" }],
    stores: [{ id: 55, name: "Store A" }],
  };
  it("names known exact scopes while keeping duplicate identities distinct", () => {
    expect(
      formatReturnPolicyArchiveContext(
        "Dropship · Channel 36 · Vendor 12 · Store 55",
        references,
      ),
    ).toBe(
      "Dropship · Channel Shopify (#36) · Vendor Vendor A (#12) · Store Store A (#55)",
    );
  });
  it("preserves every residual exclusion and unassigned qualifier", () => {
    const raw =
      "Dropship · Other channels (excluding 36, 42, 99) · Other vendors (excluding 12), including unassigned · Other stores (excluding 55), including unassigned";
    expect(formatReturnPolicyArchiveContext(raw, references)).toBe(
      "Dropship · Other channels (excluding Shopify (#36), Shopify (#42), 99) · Other vendors (excluding Vendor A (#12)), including unassigned · Other stores (excluding Store A (#55)), including unassigned",
    );
  });
  it.each([
    "Retail · All channels",
    "Dropship · Channel 99 · All vendors, including unassigned",
    "Future grammar Channel 36 except Store 55",
  ])("retains unmatched scope grammar verbatim: %s", (raw) => {
    expect(formatReturnPolicyArchiveContext(raw, references)).toBe(raw);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  loadReturnPolicyShippingCatalog,
  readReturnPolicySaveResponse,
  requestedReturnPolicy,
  returnPolicyEditorPath,
} from "../../return-policy-shipping";

describe("return policy shipping boundaries", () => {
  it("links one exact policy without accepting duplicate or malformed identifiers", () => {
    expect(returnPolicyEditorPath(7)).toBe(
      "/return-policies?policyId=7&section=shipping",
    );
    expect(requestedReturnPolicy("?policyId=7&section=shipping")).toEqual({
      policyId: 7,
      shipping: true,
    });
    expect(requestedReturnPolicy("")).toBeNull();
    for (const search of [
      "?policyId=0",
      "?policyId=01",
      "?policyId=1.5",
      "?policyId=1&policyId=2",
      "?policyId=9007199254740992",
      "?policyId=1&section=shipping&section=shipping",
      "?policyId=1&section=unknown",
    ]) {
      expect(() => requestedReturnPolicy(search)).toThrow();
    }
    expect(() => returnPolicyEditorPath(-1)).toThrow();
  });

  it("requires fresh authenticated shipping choices and rejects ambiguous carrier identities", async () => {
    const signal = new AbortController().signal;
    const catalog = {
      providerConfigured: true,
      warehouses: [],
      carriers: [],
      message: null,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    expect(await loadReturnPolicyShippingCatalog(signal, request)).toEqual(
      catalog,
    );
    expect(request).toHaveBeenCalledWith(
      "/api/returns/admin/policies/shipping-catalog",
      { credentials: "include", cache: "no-store", signal },
    );
    const carrier = {
      id: "se-test",
      name: "Test",
      code: "ups",
      services: [{ code: "ground", name: "Ground" }],
    };
    request.mockResolvedValue(
      new Response(
        JSON.stringify({ ...catalog, carriers: [carrier, carrier] }),
      ),
    );
    await expect(
      loadReturnPolicyShippingCatalog(signal, request),
    ).rejects.toThrow("could not be verified");
    request.mockResolvedValue(new Response("{}", { status: 403 }));
    await expect(
      loadReturnPolicyShippingCatalog(signal, request),
    ).rejects.toThrow("Administrator access");
  });

  it("distinguishes definitive conflicts from unconfirmed writes so retry identity remains protected", async () => {
    const response = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status });
    await expect(
      readReturnPolicySaveResponse(
        response(409, {
          error: {
            code: "RETURN_POLICY_CHANGED",
            message: "Reload the policy.",
          },
        }),
      ),
    ).rejects.toMatchObject({
      definitive: true,
      code: "RETURN_POLICY_CHANGED",
    });
    await expect(
      readReturnPolicySaveResponse(
        response(503, {
          error: { code: "UNAVAILABLE", message: "Unknown outcome." },
        }),
      ),
    ).rejects.toMatchObject({ definitive: false });
    await expect(
      readReturnPolicySaveResponse(
        response(200, {
          policy: { id: 2, version: 1, status: "active" },
          replayed: false,
        }),
      ),
    ).rejects.toMatchObject({ definitive: false });
    expect(
      await readReturnPolicySaveResponse(
        response(200, {
          policy: { id: 2, version: 1, status: "active", shipping: null },
          replayed: true,
        }),
      ),
    ).toMatchObject({ replayed: true });
  });
});

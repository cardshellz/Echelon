import { describe, expect, it } from "vitest";
import { z } from "zod";
import { orderEditDiagnosticError } from "../../application/order-edit-diagnostics";
import { serviceHarness } from "../fixtures/order-edit-service.fixture";

describe("order edit preparation diagnostics", () => {
  it.each(["hold", "quote", "persist"])(
    "records the original %s failure with phase and operation identity",
    async (phase) => {
      const h = serviceHarness();
      const original = Object.assign(new Error("connection timed out"), {
        code: "ETIMEDOUT",
      });
      if (phase === "hold") h.warehouse.acquire.mockRejectedValueOnce(original);
      if (phase === "quote") h.provider.quote.mockRejectedValueOnce(original);
      if (phase === "persist") {
        const save = h.store.save;
        h.store.save = async (...args) => {
          if (args[3] === "quoted") throw original;
          return save(...args);
        };
      }
      const result = await h.service.quote(
        h.input,
        "customer:private-identity",
      );
      expect(h.report).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: result.operationId,
          omsOrderId: 1,
          connectionId: 4,
          phase: {
            hold: "warehouse_hold",
            quote: "shopify_quote",
            persist: "quote_persist",
          }[phase],
          error: expect.objectContaining({
            code: "ETIMEDOUT",
            message: "connection timed out",
          }),
          actorFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      );
      expect(JSON.stringify(h.report.mock.calls)).not.toContain(
        "customer:private-identity",
      );
      expect(result.error?.message).toContain("Cancel this attempt");
      expect(result.error?.message).not.toContain("timed out");
      expect(h.provider.commit).not.toHaveBeenCalled();
      expect(h.provider.refund).not.toHaveBeenCalled();
    },
  );
  it("redacts credentials and email and never serializes driver SQL or row detail", () => {
    const database = Object.assign(
      new Error("duplicate row customer@example.com"),
      { code: "23505", detail: "private row", query: "SELECT secret" },
    );
    const outer = new Error(
      'fetch https://example.com/private?token=abc authorization=secret password="private value" shpat_123456 customer@example.com',
      { cause: database },
    );
    const output = JSON.stringify(orderEditDiagnosticError(outer));
    for (const secret of [
      "token=abc",
      "authorization=secret",
      "private value",
      "shpat_123456",
      "customer@example.com",
      "private row",
      "SELECT secret",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("23505");
    expect(output).toContain("redacted-url");
  });
  it("keeps schema paths without validation input and bounds cyclic causes", () => {
    const parsed = z
      .object({ tax: z.number() })
      .safeParse({ tax: "private input" });
    if (parsed.success) throw new Error("Expected fixture validation failure");
    const info = orderEditDiagnosticError(parsed.error);
    expect(info.validation).toEqual([{ path: "tax", code: "invalid_type" }]);
    expect(JSON.stringify(info)).not.toContain("private input");
    const cyclic = new Error("failure");
    cyclic.cause = cyclic;
    expect(
      JSON.stringify(orderEditDiagnosticError(cyclic)).length,
    ).toBeLessThan(10000);
    expect(orderEditDiagnosticError({ secret: "value" }).name).toBe(
      "NonErrorThrown",
    );
  });
});

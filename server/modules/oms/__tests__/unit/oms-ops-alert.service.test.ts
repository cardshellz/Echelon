import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOmsOpsAlertPayload,
  buildOmsOpsAlertSignature,
  evaluateOmsOpsAlert,
  resetOmsOpsAlertStateForTests,
  sendOmsOpsAlert,
} from "../../oms-ops-alert.service";
import type { OmsOpsHealthSummary } from "../../ops-health.service";

function health(overrides: Partial<OmsOpsHealthSummary> = {}): OmsOpsHealthSummary {
  return {
    generatedAt: "2026-05-06T00:00:00.000Z",
    status: "critical",
    counts: { critical: 2, warning: 1, info: 0 },
    issues: [
      {
        code: "WEBHOOK_RETRY_DEAD",
        severity: "critical",
        count: 1,
        message: "Dead retry rows need action.",
        sample: [{ id: 10 }],
      },
      {
        code: "OMS_FINAL_WMS_ACTIVE",
        severity: "critical",
        count: 1,
        message: "OMS and WMS are divergent.",
        sample: [{ oms_order_id: 20 }],
      },
      {
        code: "WEBHOOK_RETRY_DUE",
        severity: "warning",
        count: 1,
        message: "Retry row is due.",
        sample: [],
      },
    ],
    ...overrides,
  };
}

describe("oms-ops-alert.service", () => {
  beforeEach(() => {
    resetOmsOpsAlertStateForTests();
  });

  it("builds a stable signature from critical issue codes and counts", () => {
    expect(buildOmsOpsAlertSignature(health())).toBe("OMS_FINAL_WMS_ACTIVE:1|WEBHOOK_RETRY_DEAD:1");
  });

  it("does not alert when there are no critical issues", () => {
    const decision = evaluateOmsOpsAlert(health({
      status: "degraded",
      counts: { critical: 0, warning: 1, info: 0 },
      issues: [{
        code: "WEBHOOK_RETRY_DUE",
        severity: "warning",
        count: 1,
        message: "Retry row is due.",
        sample: [],
      }],
    }));

    expect(decision).toMatchObject({ shouldAlert: false, reason: "not_critical" });
  });

  it("throttles the same critical signature inside the cooldown window", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 })) as unknown as typeof fetch;

    const first = await sendOmsOpsAlert(health(), {
      webhookUrl: "https://example.test/webhook",
      fetchImpl,
      nowMs: 1000,
      cooldownMs: 60_000,
    });
    const second = await sendOmsOpsAlert(health(), {
      webhookUrl: "https://example.test/webhook",
      fetchImpl,
      nowMs: 2000,
      cooldownMs: 60_000,
    });

    expect(first.sent).toBe(true);
    expect(second).toMatchObject({ sent: false, reason: "cooldown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends a Discord-compatible payload for critical health", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 })) as unknown as typeof fetch;

    const result = await sendOmsOpsAlert(health(), {
      webhookUrl: "https://example.test/webhook",
      fetchImpl,
      nowMs: 1000,
    });

    expect(result.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/webhook",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(String((fetchImpl as any).mock.calls[0][1].body));
    expect(body.content).toContain("CRITICAL: OMS/WMS flow health is critical");
    expect(body.content).toContain("WEBHOOK_RETRY_DEAD");
  });

  it("does not consume cooldown when webhook configuration is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = await sendOmsOpsAlert(health(), {
      webhookUrl: null,
      nowMs: 1000,
      cooldownMs: 60_000,
    });
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 })) as unknown as typeof fetch;
    const configured = await sendOmsOpsAlert(health(), {
      webhookUrl: "https://example.test/webhook",
      fetchImpl,
      nowMs: 2000,
      cooldownMs: 60_000,
    });

    expect(missing).toMatchObject({ sent: false, reason: "webhook_not_configured" });
    expect(configured.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WEBHOOK_RETRY_DEAD"));
    warn.mockRestore();
  });

  it("includes a compact critical issue summary in the payload", () => {
    const payload = buildOmsOpsAlertPayload(health(), health().issues.filter((issue) => issue.severity === "critical"));

    expect(payload.content).toContain("Critical count: 2");
    expect(payload.content).toContain("Sample:");
  });
});

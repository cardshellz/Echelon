import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../../db", () => ({
  db: {},
}));

const auditMocks = vi.hoisted(() => ({
  persistAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("../../../infrastructure/transactional-audit", () => ({
  persistAuditEvent: auditMocks.persistAuditEvent,
}));

import {
  enrichContext,
  installStructuredConsoleBridge,
  isStructuredConsoleBridgeInstalled,
  logger,
  runWithContext,
  setLogLevel,
  uninstallStructuredConsoleBridge,
} from "../../observability";
import { AuditLogger } from "../../../infrastructure/auditLogger";
import { createDropshipPlatformLogger } from "../../../modules/dropship/application/dropship-platform-logger";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("P4.2 Structured Logger, Correlation Propagation & Logger Unification", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLogLevel("debug");
    auditMocks.persistAuditEvent.mockClear();
  });

  afterEach(() => {
    uninstallStructuredConsoleBridge();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setLogLevel("info");
  });

  it("emits canonical snake_case and camelCase correlation fields ({ oms_order_id, wms_order_id, shipment_id, channel_event_id, engine_ref })", () => {
    runWithContext(
      {
        correlationId: "corr-99",
        channelEventId: "evt_shopify_1",
      },
      () => {
        enrichContext({
          omsOrderId: 1001,
          wmsOrderId: 2002,
          shipmentId: 3003,
          engineRef: "shipstation:99001",
        });
        logger.info("order.shipment_pushed", { outcome: "ok" });
      },
    );

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]![0]));
    expect(parsed).toMatchObject({
      level: "info",
      action: "order.shipment_pushed",
      outcome: "ok",
      correlationId: "corr-99",
      correlation_id: "corr-99",
      omsOrderId: 1001,
      oms_order_id: 1001,
      wmsOrderId: 2002,
      wms_order_id: 2002,
      shipmentId: 3003,
      shipment_id: 3003,
      channelEventId: "evt_shopify_1",
      channel_event_id: "evt_shopify_1",
      engineRef: "shipstation:99001",
      engine_ref: "shipstation:99001",
    });
  });

  it("routes legacy console.* calls through structured redacted JSON with correlation fields when console bridge is installed", () => {
    installStructuredConsoleBridge();
    expect(isStructuredConsoleBridgeInstalled()).toBe(true);

    runWithContext(
      {
        correlationId: "corr-bridge",
        omsOrderId: 42,
        shipmentId: 77,
      },
      () => {
        console.log("[WMS Sync] Pushed shipment 77", { access_token: "secret-tok", ok: true });
        console.error(JSON.stringify({ code: "SS_PUSH_FAILED", message: "boom" }));
      },
    );

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const infoLine = JSON.parse(String(stdoutSpy.mock.calls[0]![0]));
    expect(infoLine).toMatchObject({
      level: "info",
      action: "console.log",
      message: "[WMS Sync] Pushed shipment 77",
      detail: { access_token: "[REDACTED]", ok: true },
      correlation_id: "corr-bridge",
      oms_order_id: 42,
      shipment_id: 77,
    });

    // Pre-serialized JSON string is unwrapped (not double-encoded) and enriched with correlation fields
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const errLine = JSON.parse(String(stderrSpy.mock.calls[0]![0]));
    expect(errLine).toMatchObject({
      level: "error",
      action: "SS_PUSH_FAILED",
      message: "boom",
      correlation_id: "corr-bridge",
      oms_order_id: 42,
      shipment_id: 77,
    });
  });

  it("folds AuditLogger onto platform structured logger and logs persistence failures as structured errors", async () => {
    auditMocks.persistAuditEvent.mockRejectedValueOnce(new Error("audit db unavailable"));

    runWithContext({ correlationId: "corr-audit", wmsOrderId: 500 }, () => {
      AuditLogger.log({
        actor: "staff:1",
        action: "pick_override",
        target: "wms_order:500",
        changes: {
          before: { status: "picking" },
          after: { status: "ready" },
        },
      });
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const infoLine = JSON.parse(String(stdoutSpy.mock.calls[0]![0]));
    expect(infoLine).toMatchObject({
      level: "info",
      action: "audit.event_recorded",
      actor: "staff:1",
      audit_action: "pick_override",
      correlation_id: "corr-audit",
      wms_order_id: 500,
    });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const errLine = JSON.parse(String(stderrSpy.mock.calls[0]![0]));
    expect(errLine).toMatchObject({
      level: "error",
      action: "audit.persist_failed",
      audit_action: "pick_override",
    });
  });

  it("unifies all Dropship application logger factories onto createDropshipPlatformLogger with correlation & redaction", () => {
    installStructuredConsoleBridge();
    const dsLogger = createDropshipPlatformLogger("dropship.wallet");

    runWithContext({ correlationId: "corr-ds", omsOrderId: 888 }, () => {
      dsLogger.warn({
        code: "DROPSHIP_WALLET_RETRY",
        message: "retrying charge",
        context: { vendorId: 7, client_secret: "sk_live_secret" },
      });
    });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const warnLine = JSON.parse(String(stderrSpy.mock.calls[0]![0]));
    expect(warnLine).toMatchObject({
      level: "warn",
      action: "dropship.wallet",
      code: "DROPSHIP_WALLET_RETRY",
      event_code: "DROPSHIP_WALLET_RETRY",
      correlation_id: "corr-ds",
      oms_order_id: 888,
      context: { vendorId: 7, client_secret: "[REDACTED]" },
    });

    // Structural check: zero bespoke logDropship*Event helpers remain in dropship/application
    const appDir = resolve(ROOT, "server/modules/dropship/application");
    const offenders: string[] = [];
    for (const file of readdirSync(appDir)) {
      if (!file.endsWith(".ts") || file === "dropship-platform-logger.ts") continue;
      const src = readFileSync(join(appDir, file), "utf8");
      if (/function\s+logDropship[A-Za-z0-9_]*Event\s*\(/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

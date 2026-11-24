import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, runWithContext, setLogLevel } from "../../platform/observability";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER_ROOT = path.join(REPO_ROOT, "server");

const EXEMPT_EXACT = new Set([
  "server/instrumentation/metrics.ts",
]);

function isExemptServerPath(relPath: string): boolean {
  if (relPath.includes("/__tests__/") || /\.test\.tsx?$|\.spec\.tsx?$/.test(relPath)) {
    return true;
  }
  if (relPath.startsWith("server/platform/observability/")) {
    return true;
  }
  if (relPath.startsWith("server/scripts/")) {
    return true;
  }
  return EXEMPT_EXACT.has(relPath);
}

function walkServerTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkServerTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const BANNED_CONSOLE_METHODS = new Set(["debug", "log", "info", "warn", "error"]);

describe("R-6 / P4.2 — Structured Logger Rollout & Console Ratchet", () => {
  it("forbids raw console.{debug,log,info,warn,error} in production server/ files outside observability/metrics boundaries", () => {
    const violations: string[] = [];

    for (const absPath of walkServerTsFiles(SERVER_ROOT)) {
      const rel = path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
      if (isExemptServerPath(rel)) continue;

      const src = fs.readFileSync(absPath, "utf8");
      if (!src.includes("console")) continue;

      const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "console" &&
          BANNED_CONSOLE_METHODS.has(node.name.text)
        ) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(`${rel}:${pos.line + 1}:${pos.character + 1} -> console.${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(violations).toEqual([]);
  });

  describe("canonical correlation envelope on logger.* calls (CLAUDE.md §10)", () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      setLogLevel("debug");
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      setLogLevel("info");
    });

    it("stamps oms_order_id, wms_order_id, shipment_id, channel_event_id, and engine_ref onto emitted JSON lines", () => {
      runWithContext(
        {
          correlationId: "corr-r6-1",
          omsOrderId: 101,
          wmsOrderId: 202,
          shipmentId: 303,
          channelEventId: "evt-shopify-404",
          engineRef: "ss-505",
        },
        () => {
          logger.info("oms.webhooks", { message: "Order webhook processed" });
          logger.error("shipping.shipstation_adapter", { message: "Push retry scheduled", error: new Error("timeout") });
        },
      );

      expect(stdoutSpy).toHaveBeenCalledOnce();
      expect(stderrSpy).toHaveBeenCalledOnce();

      const infoLine = JSON.parse(String(stdoutSpy.mock.calls[0][0]));
      expect(infoLine).toMatchObject({
        level: "info",
        action: "oms.webhooks",
        message: "Order webhook processed",
        correlation_id: "corr-r6-1",
        oms_order_id: 101,
        wms_order_id: 202,
        shipment_id: 303,
        channel_event_id: "evt-shopify-404",
        engine_ref: "ss-505",
      });

      const errorLine = JSON.parse(String(stderrSpy.mock.calls[0][0]));
      expect(errorLine).toMatchObject({
        level: "error",
        action: "shipping.shipstation_adapter",
        message: "Push retry scheduled",
        correlation_id: "corr-r6-1",
        oms_order_id: 101,
        wms_order_id: 202,
        shipment_id: 303,
        channel_event_id: "evt-shopify-404",
        engine_ref: "ss-505",
        error: expect.objectContaining({ message: "timeout" }),
      });
    });
  });
});

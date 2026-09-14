import { missionControlConnection } from "./mc-push";
import { randomUUID } from "node:crypto";
import { pool } from "../../db";
import { logger } from "../../platform/observability/logger";
import { createArchonOrderDelivery } from "./archon-order-delivery";
/** Existing Echelon-to-Archon configuration; no new provider setup. */
export function startArchonOrderDelivery() {
  const { url, secret } = missionControlConnection();
  if (!url || !secret) {
    logger.error("oms.archon_delivery.start", {
      error_code: "ARCHON_DELIVERY_CONFIG_MISSING",
      outcome: "not_started",
    });
    return;
  }
  const target = new URL("/api/orders/ingest", url);
  if (target.protocol !== "https:" || target.username || target.password)
    throw new Error("ARCHON_DELIVERY_URL_INVALID");
  let busy = false;
  const tick = createArchonOrderDelivery({
    pool,
    clock: () => new Date(),
    leaseId: randomUUID,
    log: (code, orderId) =>
      logger.error("oms.archon_delivery", {
        error_code: code,
        oms_order_id: orderId,
        outcome: "retry_scheduled",
      }),
    send: async (payload) => {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": secret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 400)
        throw new Error(
          body?.code === "INVALID_COMMERCE_SNAPSHOT"
            ? "ARCHON_SNAPSHOT_INVALID"
            : "ARCHON_RECEIVER_UPGRADE_REQUIRED",
        );
      if (response.status === 409) throw new Error("ARCHON_IDENTITY_CONFLICT");
      if (!response.ok) throw new Error("ARCHON_HTTP_REJECTED");
      if (body?.status !== "ok" || body?.snapshotAccepted !== true)
        throw new Error("ARCHON_SNAPSHOT_NOT_ACKNOWLEDGED");
    },
  });
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch {
      logger.error("oms.archon_delivery.tick", {
        error_code: "ARCHON_OUTBOX_UNAVAILABLE",
        outcome: "retry_next_tick",
      });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void run(), 30000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

import type { Pool, PoolClient } from "pg";

/** Channel raised by migration 900000059000020450001 when publication work is committed. */
export const PUBLICATION_WAKE_CHANNEL = "inventory_publication_work";
/** Wait before re-opening a dropped listener connection. The worker timer covers the gap. */
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

type Log = (entry: Readonly<Record<string, unknown>>) => void;
export interface PublicationWakeListenerHandle { stop(): Promise<void> }

/**
 * Holds one dedicated connection in LISTEN and calls `onWake` for every
 * notification. It carries no work itself: the worker re-reads durable rows, so a
 * missed notification only delays a send until the worker's timer. `onWake` also
 * runs after each (re)connect, because notifications sent while disconnected are lost.
 */
export function startPublicationWakeListener(
  pool: Pick<Pool, "connect">,
  onWake: () => void,
  options: { reconnectDelayMs?: number; log?: Log } = {},
): PublicationWakeListenerHandle {
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 1) {
    throw new Error("Publication wake listener reconnect delay must be a positive integer.");
  }
  const log: Log = options.log ?? (entry => console.info(JSON.stringify(entry)));
  let stopped = false;
  let client: PoolClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connecting: Promise<void> | null = null;

  const discard = (held: PoolClient): void => {
    held.removeAllListeners("notification");
    held.removeAllListeners("error");
    held.removeAllListeners("end");
    // A LISTEN session must not return to the pool for reuse.
    held.release(true);
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelayMs);
  };
  const drop = (lost: PoolClient): void => {
    if (client !== lost) return;
    client = null;
    discard(lost);
    if (stopped) return;
    log({ level: "warn", action: "publication_wake_listen", outcome: "disconnected", error_code: "PUBLICATION_WAKE_LISTENER_LOST" });
    scheduleReconnect();
  };
  const connect = (): void => {
    if (stopped || client || connecting) return;
    connecting = (async () => {
      let acquired: PoolClient | null = null;
      try {
        acquired = await pool.connect();
        const current = acquired;
        // Channel name is a module constant, not input.
        await current.query(`LISTEN ${PUBLICATION_WAKE_CHANNEL}`);
        if (stopped) { discard(current); return; }
        current.on("notification", message => { if (message.channel === PUBLICATION_WAKE_CHANNEL) onWake(); });
        current.on("error", () => drop(current));
        current.on("end", () => drop(current));
        client = current;
        log({ level: "info", action: "publication_wake_listen", outcome: "listening", error_code: null });
        onWake();
      } catch {
        // Transient by nature (database restart, pool exhaustion): retry on a fixed delay.
        if (acquired) discard(acquired);
        log({ level: "warn", action: "publication_wake_listen", outcome: "connect_failed", error_code: "PUBLICATION_WAKE_LISTENER_CONNECT_FAILED" });
        scheduleReconnect();
      }
    })().finally(() => { connecting = null; });
  };

  connect();
  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      await connecting;
      const held = client;
      client = null;
      if (held) discard(held);
    },
  };
}

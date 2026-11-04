import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  auth: {
    user: { id: "staff-one" } as { id: string } | null,
    assignedRoles: [{ id: 4, name: "Custom reader", isSystem: false }],
    accessStatus: "authenticated" as "authenticated" | "anonymous" | "unverified" | "loading",
    refetch: vi.fn(),
  },
  refs: [] as Array<{ current: unknown }>, refIndex: 0,
  effects: [] as Array<() => void | (() => void)>,
  queries: [] as Array<{ enabled: boolean; queryKey: unknown[]; queryFn: (context: { signal: AbortSignal }) => Promise<unknown> }>,
  client: { invalidateQueries: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => fixture.auth }));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  useRef: (initial: unknown) => {
    const index = fixture.refIndex++;
    return fixture.refs[index] ??= { current: initial };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof fixture.queries[number]) => {
    fixture.queries.push(options);
    return { data: { count: 7 } };
  },
  useQueryClient: () => fixture.client,
  useMutation: vi.fn(),
}));
import { useNotificationPreferences, useNotifications, useUnreadCount } from "../../use-notifications";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static failConstruction = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => Promise<void> | void) | null = null;
  readyState = 0;
  close = vi.fn(() => { this.readyState = 3; void this.onclose?.({ code: 1000 }); });
  constructor(readonly url: string) {
    if (FakeWebSocket.failConstruction) throw new Error("Synthetic construction failure");
    FakeWebSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: string) { this.onmessage?.({ data }); }
  async serverClose(code: number) { this.readyState = 3; await this.onclose?.({ code }); }
}

let cleanup: (() => void) | undefined;
function mountCount() {
  fixture.refIndex = 0;
  fixture.effects = [];
  const count = useUnreadCount();
  cleanup = fixture.effects[0]?.() || undefined;
  return count;
}
const invalidatedKeys = () => fixture.client.invalidateQueries.mock.calls.map(([options]) => options.queryKey);
function expectReload() {
  expect(invalidatedKeys()).toContainEqual(["/api/notifications"]);
  expect(invalidatedKeys()).toContainEqual(["/api/notifications/unread-count"]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.auth.user = { id: "staff-one" };
  fixture.auth.assignedRoles = [{ id: 4, name: "Custom reader", isSystem: false }];
  fixture.auth.accessStatus = "authenticated";
  fixture.auth.refetch.mockResolvedValue(undefined);
  fixture.client.invalidateQueries.mockResolvedValue(undefined);
  fixture.refs = []; fixture.queries = []; fixture.effects = []; fixture.refIndex = 0;
  FakeWebSocket.instances = []; FakeWebSocket.failConstruction = false;
  cleanup = undefined;
  vi.stubGlobal("window", { location: { protocol: "https:", host: "synthetic.invalid" } });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("notification transport uses current assigned staff authority", () => {
  it.each(["anonymous", "unverified", "loading"] as const)("does not read or connect while %s", (status) => {
    fixture.auth.accessStatus = status;
    expect(mountCount()).toBe(0);
    useNotifications(); useNotificationPreferences();
    expect(fixture.queries.every(query => !query.enabled)).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("keeps a zero-role identity out of notification reads and sockets", () => {
    fixture.auth.assignedRoles = [];
    expect(mountCount()).toBe(0);
    useNotifications(); useNotificationPreferences();
    expect(fixture.queries.every(query => !query.enabled)).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("connects an assigned custom role and reloads persisted data on open and notification", () => {
    expect(mountCount()).toBe(7);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("wss://synthetic.invalid/ws");
    expect(fixture.queries[0].enabled).toBe(true);
    ws.open(); expectReload();
    fixture.client.invalidateQueries.mockClear();
    ws.message(JSON.stringify({ type: "notification" })); expectReload();
    fixture.client.invalidateQueries.mockClear();
    ws.message(JSON.stringify({ type: "version", version: "synthetic" }));
    expect(fixture.client.invalidateQueries).not.toHaveBeenCalled();
  });

  it.each([1011, 1013, 1001])("reloads after close %i and reconnects without a tight loop", async (code) => {
    mountCount();
    const ws = FakeWebSocket.instances[0]; ws.open();
    fixture.client.invalidateQueries.mockClear();
    await ws.serverClose(code); expectReload();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    fixture.client.invalidateQueries.mockClear();
    FakeWebSocket.instances[1].open(); expectReload();
    expect(fixture.auth.refetch).not.toHaveBeenCalled();
  });

  it("refreshes revoked authority exactly once and never reconnects that generation", async () => {
    mountCount(); const ws = FakeWebSocket.instances[0];
    await ws.serverClose(1008);
    expect(fixture.auth.refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await ws.serverClose(1008);
    expect(fixture.auth.refetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes authority after an opaque rejected upgrade and cancels retry when access disappears", async () => {
    mountCount();
    let resolve!: () => void;
    fixture.auth.refetch.mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
    const closed = FakeWebSocket.instances[0].serverClose(1006);
    expect(fixture.auth.refetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    cleanup?.();
    fixture.auth.assignedRoles = [];
    mountCount();
    resolve(); await closed;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects after opaque transport failure when authority refresh completes", async () => {
    mountCount(); await FakeWebSocket.instances[0].serverClose(1006);
    expect(fixture.auth.refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off short-lived connections up to 30 seconds and resets only after stability", async () => {
    mountCount();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = FakeWebSocket.instances.length;
      const ws = FakeWebSocket.instances.at(-1)!; ws.open(); await ws.serverClose(1011);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
    }
    const ws = FakeWebSocket.instances.at(-1)!; ws.open();
    await vi.advanceTimersByTimeAsync(30_000);
    await ws.serverClose(1013);
    const count = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
  });

  it("uses close as the sole retry trigger after an error and recovers malformed hints", async () => {
    mountCount(); const ws = FakeWebSocket.instances[0];
    ws.onerror?.(); expectReload();
    expect(vi.getTimerCount()).toBe(0);
    await ws.serverClose(1011);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    fixture.client.invalidateQueries.mockClear();
    FakeWebSocket.instances[1].message("not json"); expectReload();
  });

  it("cancels pending reconnects on unmount", async () => {
    mountCount(); await FakeWebSocket.instances[0].serverClose(1013);
    expect(vi.getTimerCount()).toBe(1);
    cleanup?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences stale socket events when the signed-in identity changes", async () => {
    mountCount(); const old = FakeWebSocket.instances[0];
    cleanup?.();
    fixture.auth.user = { id: "staff-two" };
    mountCount();
    expect(old.close).toHaveBeenCalledOnce();
    fixture.client.invalidateQueries.mockClear();
    old.message(JSON.stringify({ type: "notification" }));
    old.open(); await old.serverClose(1008);
    expect(fixture.client.invalidateQueries).not.toHaveBeenCalled();
    expect(fixture.auth.refetch).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].message(JSON.stringify({ type: "notification" })); expectReload();
  });

  it("retries a constructor failure with the same backoff and allows cleanup", async () => {
    FakeWebSocket.failConstruction = true; mountCount(); expectReload();
    expect(vi.getTimerCount()).toBe(1);
    FakeWebSocket.failConstruction = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    cleanup?.();
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledOnce();
  });

  it("passes query cancellation signals through to notification HTTP reads", async () => {
    mountCount(); useNotifications({ unreadOnly: true, limit: 3 }); useNotificationPreferences();
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 1 }) });
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    for (const query of fixture.queries) await query.queryFn({ signal });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/notifications/unread-count", "/api/notifications?unreadOnly=true&limit=3", "/api/notification-preferences",
    ]);
    expect(fetch.mock.calls.every(([, options]) => options.signal === signal)).toBe(true);
  });
});

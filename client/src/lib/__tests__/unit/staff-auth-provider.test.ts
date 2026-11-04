import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
  effects: [] as Array<() => void | (() => void)>, cancelQueries: vi.fn(), clear: vi.fn(),
}));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = fixture.stateIndex++;
      if (!(index in fixture.states)) fixture.states[index] = initial;
      return [fixture.states[index], (value: unknown) => {
        fixture.states[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(fixture.states[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = fixture.refIndex++;
      return fixture.refs[index] ??= { current: initial };
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  };
});
vi.mock("@/lib/queryClient", () => ({ queryClient: { cancelQueries: fixture.cancelQueries, clear: fixture.clear } }));
import { AuthProvider, useAuth } from "../../auth";
type AuthValue = ReturnType<typeof useAuth>;
function render(): AuthValue {
  fixture.stateIndex = 0; fixture.refIndex = 0; fixture.effects = [];
  return (AuthProvider({ children: null }) as unknown as { props: { value: AuthValue } }).props.value;
}
const user = { id: "one", username: "one", role: "picker", active: 1, displayName: null,
  createdAt: "2026-11-04T00:00:00Z", lastLoginAt: null };
const authority = { user, roles: ["Administrator"], assignedRoles: [{ id: 1, name: "Administrator", isSystem: true }],
  systemRoles: ["admin"], permissions: ["users:view"] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.clearAllMocks(); fixture.states = []; fixture.refs = []; fixture.effects = [];
  fixture.cancelQueries.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("staff authentication state transitions", () => {
  it("does not clear independent portal queries for an anonymous staff probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    await render().refetch();
    expect(render().accessStatus).toBe("anonymous");
    expect(fixture.clear).not.toHaveBeenCalled();
    expect(fixture.cancelQueries).not.toHaveBeenCalled();
  });
  it("uses explicit metadata and clears cached authority when assignments change", async () => {
    const fetch = vi.fn().mockResolvedValue(response(authority)); vi.stubGlobal("fetch", fetch);
    await render().refetch();
    expect(render().hasSystemRole("admin")).toBe(true);
    expect(render().hasPermission("users", "view")).toBe(true);
    const clearCount = fixture.clear.mock.calls.length;
    fetch.mockResolvedValue(response({ user: { ...user, role: "admin" }, roles: [], assignedRoles: [], systemRoles: [], permissions: [] }));
    await render().refetch();
    expect(render().user?.id).toBe("one");
    expect(render().accessStatus).toBe("authenticated");
    expect(render().hasSystemRole("admin")).toBe(false);
    expect(render().hasPermission("users", "view")).toBe(false);
    expect(fixture.clear.mock.calls.length).toBeGreaterThan(clearCount);
  });
  it("fails closed on an old response without assignment metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ user: { ...user, role: "admin" }, roles: ["Administrator"], permissions: ["users:view"] })));
    await render().refetch();
    expect(render().accessStatus).toBe("unverified");
    expect(render().hasPermission("users", "view")).toBe(false);
  });
  it("clears cached capabilities and query data when a role permission changes without an assignment change", async () => {
    const fetch = vi.fn().mockResolvedValue(response(authority)); vi.stubGlobal("fetch", fetch);
    await render().refetch();
    expect(render().hasPermission("users", "view")).toBe(true);
    fixture.clear.mockClear(); fixture.cancelQueries.mockClear();
    fetch.mockResolvedValue(response({ ...authority, permissions: [] }));
    await render().refetch();
    expect(render().assignedRoles).toEqual(authority.assignedRoles);
    expect(render().hasSystemRole("admin")).toBe(true);
    expect(render().hasPermission("users", "view")).toBe(false);
    expect(fixture.cancelQueries).toHaveBeenCalledOnce();
    expect(fixture.clear).toHaveBeenCalledOnce();
  });
  it("prevents a late earlier read from restoring revoked authority", async () => {
    const oldRead = deferred<Response>(); const newerRead = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newerRead.promise));
    const first = render().refetch(); const second = render().refetch();
    newerRead.resolve(response({ user, roles: [], assignedRoles: [], systemRoles: [], permissions: [] })); await second;
    oldRead.resolve(response(authority)); await first;
    expect(render().assignedRoles).toEqual([]);
    expect(render().hasSystemRole("admin")).toBe(false);
  });
  it("blocks manual and focus reads during logout and cannot resurrect a destroyed session", async () => {
    const logoutResponse = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(authority)).mockReturnValueOnce(logoutResponse.promise); vi.stubGlobal("fetch", fetch);
    const events = new Map<string, () => void>();
    vi.stubGlobal("window", { addEventListener: (name: string, handler: () => void) => events.set(name, handler), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await render().refetch();
    const auth = render();
    // Install the real focus listener. Its initial read is deliberately replaced
    // by the pending logout generation before it can affect authority.
    const initialRead = deferred<Response>();
    fetch.mockReset().mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(logoutResponse.promise);
    const cleanup = fixture.effects[0]();
    const logout = auth.logout();
    await render().refetch(); events.get("focus")?.();
    expect(fetch).toHaveBeenCalledTimes(2);
    logoutResponse.resolve(response({ success: true })); await logout;
    initialRead.resolve(response(authority)); await Promise.resolve(); await Promise.resolve();
    expect(render().accessStatus).toBe("anonymous");
    expect(render().user).toBeNull();
    cleanup?.();
  });
  it("does not claim logout succeeded when the server rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(authority)).mockResolvedValueOnce(response({}, 500)));
    await render().refetch();
    await expect(render().logout()).rejects.toThrow();
    expect(render().accessStatus).toBe("unverified");
    expect(render().accessError).toContain("Sign-out could not be confirmed");
    expect(render().hasSystemRole("admin")).toBe(false);
  });
  it("valid zero-role login remains an authenticated identity for the no-access screen", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ user })).mockResolvedValueOnce(response({ user, roles: [], assignedRoles: [], systemRoles: [], permissions: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(await render().login("one", "synthetic-only")).toEqual({ success: true });
    expect(render().accessStatus).toBe("authenticated");
    expect(render().assignedRoles).toEqual([]);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/auth/login", "/api/auth/me"]);
  });
  it("does not report a usable login when the following session check returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ user })).mockResolvedValueOnce(response({}, 401)));
    expect(await render().login("one", "synthetic-only")).toEqual({ success: false, error: "Your session could not be verified. Sign in again." });
    expect(render().accessStatus).toBe("anonymous");
  });
});

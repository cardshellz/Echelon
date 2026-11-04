import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryOptions = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };
type UpdateInput = { roleId: number; permissionIds: number[] };
type UpdateOptions = {
  retry: boolean;
  mutationFn: (data: UpdateInput) => Promise<unknown>;
  onError: (error: Error, data: UpdateInput) => Promise<void>;
  onSuccess: () => Promise<void>;
};
type DeleteOptions = {
  retry: boolean;
  mutationFn: (roleId: number) => Promise<unknown>;
  onError: (error: Error) => Promise<void>;
};
type CheckboxProps = { checked: boolean; disabled: boolean; onCheckedChange: () => void; "data-testid": string };

const fixture = vi.hoisted(() => ({
  stateIndex: 0,
  queries: [] as QueryOptions[],
  mutations: [] as unknown[],
  checkboxes: [] as CheckboxProps[],
  rolePermissions: undefined as unknown,
  fetching: false,
  error: false,
  pending: false,
  canEdit: true,
  mutate: vi.fn(),
  invalidateQueries: vi.fn(),
  refetchAuthority: vi.fn(),
  toast: vi.fn(),
  role: { id: 7, name: "Example role", description: null, isSystem: 0, createdAt: "2026-11-04T00:00:00Z" },
  permission: { id: 11, resource: "dashboard", action: "view", description: "View dashboard", category: "dashboard" },
}));

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    // Select the existing role without adding test-only props to the page.
    if (fixture.stateIndex++ === 0) return [fixture.role, vi.fn()];
    return actual.useState(initial);
  } };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    fixture.queries.push(options);
    if (options.queryKey[0] === "/api/permissions") return { data: [fixture.permission], isLoading: false };
    if (options.queryKey.length === 1) return { data: [fixture.role], isLoading: false };
    return { data: fixture.rolePermissions, isFetching: fixture.fetching, isError: fixture.error };
  },
  useMutation: (options: unknown) => {
    fixture.mutations.push(options);
    return { mutate: fixture.mutate, isPending: fixture.pending };
  },
  useQueryClient: () => ({ invalidateQueries: fixture.invalidateQueries }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ hasPermission: (_resource: string, action: string) => action !== "edit" || fixture.canEdit, refetch: fixture.refetchAuthority }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: (props: CheckboxProps) => {
  fixture.checkboxes.push(props);
  return createElement("button", { role: "checkbox", "aria-checked": props.checked, disabled: props.disabled, "data-testid": props["data-testid"] });
} }));

import Roles from "../../Roles";

function render() {
  fixture.stateIndex = 0;
  fixture.queries = [];
  fixture.mutations = [];
  fixture.checkboxes = [];
  return renderToStaticMarkup(createElement(Roles));
}
function editorCheckbox() {
  const checkbox = fixture.checkboxes.find(item => item["data-testid"] === "checkbox-perm-11");
  if (!checkbox) throw new Error("Editor permission control was not rendered");
  return checkbox;
}
function query() { return fixture.queries.find(item => item.queryKey.length === 3)!; }
function update() { return fixture.mutations[1] as UpdateOptions; }

beforeEach(() => {
  vi.clearAllMocks();
  // Vitest's existing base transform uses classic JSX; the app build uses its
  // React plugin. Supply that rendering global without changing application code.
  vi.stubGlobal("React", React);
  fixture.rolePermissions = [{ ...fixture.permission, isRestricted: false }];
  fixture.fetching = false;
  fixture.error = false;
  fixture.pending = false;
  fixture.canEdit = true;
  fixture.refetchAuthority.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("role permissions editor restriction containment", () => {
  it("keeps unrestricted role editing and its existing full-list payload", () => {
    const html = render();
    expect(html).not.toContain("permissions are read-only in this editor");
    expect(editorCheckbox()).toMatchObject({ checked: true, disabled: false });
    editorCheckbox().onCheckedChange();
    expect(fixture.mutate).toHaveBeenCalledExactlyOnceWith({ roleId: 7, permissionIds: [] });
  });

  it("renders a restricted role read-only and cannot submit even if its handler is invoked", () => {
    fixture.rolePermissions = [{ ...fixture.permission, isRestricted: true }];
    const html = render();
    expect(html).toContain("This role&#x27;s permissions are read-only in this editor because some grants contain restrictions.");
    expect(editorCheckbox()).toMatchObject({ checked: true, disabled: true });
    editorCheckbox().onCheckedChange();
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(html).toContain("button-create-role");
    expect(html).toContain("button-delete-role");
  });

  it("blocks the entire role when another permission is restricted", () => {
    fixture.rolePermissions = [{ ...fixture.permission, isRestricted: false }, { ...fixture.permission, id: 12, action: "edit", isRestricted: true }];
    render();
    expect(editorCheckbox().disabled).toBe(true);
    editorCheckbox().onCheckedChange();
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it.each(["initial load", "refresh", "read error", "old cached metadata", "save pending", "no edit permission"])("prevents updates during %s", state => {
    if (state === "initial load") fixture.rolePermissions = undefined;
    if (state === "refresh") fixture.fetching = true;
    if (state === "read error") fixture.error = true;
    if (state === "old cached metadata") fixture.rolePermissions = [fixture.permission];
    if (state === "save pending") fixture.pending = true;
    if (state === "no edit permission") fixture.canEdit = false;
    const html = render();
    expect(editorCheckbox().disabled).toBe(true);
    editorCheckbox().onCheckedChange();
    expect(fixture.mutate).not.toHaveBeenCalled();
    if (state === "read error" || state === "old cached metadata") expect(html).toContain("Permissions could not be verified");
  });

  it.each([{}, { isRestricted: null }, { isRestricted: "false" }, { isRestricted: 0 }])("rejects missing or malformed server restriction evidence: %j", evidence => {
    render();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ...fixture.permission, ...evidence }]), { status: 200 })));
    return expect(query().queryFn()).rejects.toThrow();
  });

  it.each([false, true])("accepts verified boolean restriction evidence %s without exposing scope details", async isRestricted => {
    render();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{ ...fixture.permission, isRestricted, constraints: { privateWarehouse: 9 } }]), { status: 200 })));
    expect(await query().queryFn()).toEqual([{ ...fixture.permission, isRestricted }]);
  });

  it("refreshes the rejected role and gives safe feedback after a newly restricted role returns 409", async () => {
    render();
    const options = update();
    const input = { roleId: 7, permissionIds: [] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "IDENTITY_ROLE_RESTRICTIONS_UNSUPPORTED", error: "untrusted diagnostic" }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const error = await options.mutationFn(input).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    await options.onError(error as Error, input);
    expect(fixture.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["/api/roles", 7, "permissions"], exact: true });
    expect(fixture.toast).toHaveBeenCalledWith({ title: "This role's permissions are read-only in this editor because some grants contain restrictions.", variant: "destructive" });
    expect(options.retry).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.refetchAuthority).toHaveBeenCalledOnce();
  });

  it("does not render arbitrary failed-write diagnostics and keeps successful invalidation", async () => {
    render();
    const options = update();
    const input = { roleId: 7, permissionIds: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "private provider details" }), { status: 500 })));
    const error = await options.mutationFn(input).catch(value => value as Error);
    await options.onError(error as Error, input);
    expect(fixture.toast).toHaveBeenCalledWith({ title: "Failed to update permissions. Reload the role before trying again.", variant: "destructive" });
    fixture.invalidateQueries.mockClear();
    await options.onSuccess();
    expect(fixture.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["/api/roles"] });
  });

  it.each(["permissions", "delete"] as const)("rereads current authority after %s commits but its response is lost, without repeating the write", async action => {
    render();
    let serverCanEdit = true;
    fixture.refetchAuthority.mockImplementation(async () => { fixture.canEdit = serverCanEdit; });
    const fetch = vi.fn().mockImplementation(async () => {
      serverCanEdit = false;
      throw new TypeError("Network response lost");
    });
    vi.stubGlobal("fetch", fetch);
    if (action === "permissions") {
      const options = update();
      const input = { roleId: 7, permissionIds: [] };
      const error = await options.mutationFn(input).catch(value => value as Error);
      await options.onError(error as Error, input);
      expect(options.retry).toBe(false);
      expect(fixture.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["/api/roles", 7, "permissions"], exact: true });
      expect(fetch).toHaveBeenCalledWith("/api/roles/7/permissions", expect.objectContaining({ method: "PUT" }));
    } else {
      const options = fixture.mutations[2] as DeleteOptions;
      const error = await options.mutationFn(7).catch(value => value as Error);
      await options.onError(error as Error);
      expect(options.retry).toBe(false);
      expect(fixture.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["/api/roles"] });
      expect(fetch).toHaveBeenCalledWith("/api/roles/7", expect.objectContaining({ method: "DELETE" }));
    }
    expect(fixture.refetchAuthority).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    render();
    expect(editorCheckbox().disabled).toBe(true);
    editorCheckbox().onCheckedChange();
    expect(fixture.mutate).not.toHaveBeenCalled();
  });
});

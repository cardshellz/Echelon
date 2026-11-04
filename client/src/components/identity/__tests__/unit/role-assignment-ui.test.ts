import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Control = { children?: ReactNode; disabled?: boolean; checked?: boolean; value?: unknown; onClick?: () => void; onCheckedChange?: (checked: boolean) => void; onChange?: (event: { target: { value: string } }) => void; "data-testid"?: string };
type Query = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown>; enabled: boolean };
type Mutation = { onSuccess: () => Promise<void> | void; onError: (error: Error) => Promise<void> | void; retry: boolean };
const state = vi.hoisted(() => {
  const assigned = [{ id: 11, name: "Warehouse reader", isSystem: 0 }];
  const available = [...assigned, { id: 12, name: "Custom purchasing", isSystem: 0 }];
  const response = (data: unknown) => ({ data, isSuccess: true, isFetching: false, isError: false, isStale: false, refetch: vi.fn().mockResolvedValue({ isError: false }) });
  return {
    stateValues: [] as unknown[], index: 0,
    assigned: response(assigned), available: response(available),
    permissions: [] as string[], pending: false,
    buttons: [] as Control[], checks: [] as Control[], inputs: [] as Control[], queries: [] as Query[], mutations: [] as Mutation[],
    mutate: vi.fn(), invalidate: vi.fn().mockResolvedValue(undefined), refreshAccess: vi.fn().mockResolvedValue(undefined),
    user: { id: "user-7", username: "operator", displayName: "Example Operator", role: "unknown-legacy-label", active: 1,
      createdAt: new Date("2026-11-04T00:00:00Z"), lastLoginAt: null },
  };
});
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = state.index++;
    if (!(index in state.stateValues)) state.stateValues[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.stateValues[index], (value: unknown) => {
      state.stateValues[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(state.stateValues[index]) : value;
    }];
  } };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Query) => {
    state.queries.push(options);
    if (options.queryKey[0] === "users") return { data: [state.user], isLoading: false, isError: false, refetch: vi.fn() };
    return options.queryKey[0] === "/api/users" ? state.assigned : state.available;
  },
  useMutation: (options: Mutation) => { state.mutations.push(options); return { mutate: state.mutate, isPending: state.pending }; },
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ hasPermission: (resource: string, action: string) => state.permissions.includes(`${resource}:${action}`), refetch: state.refreshAccess }) }));
vi.mock("@/components/ui/dialog", () => {
  const part = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => open ? part({ children }) : null,
    DialogContent: part, DialogHeader: part, DialogDescription: part, DialogTitle: part, DialogFooter: part };
});
vi.mock("@/components/ui/button", () => ({ Button: (props: Control) => {
  state.buttons.push(props); return createElement("button", { disabled: props.disabled, "data-testid": props["data-testid"] }, props.children);
} }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: (props: Control) => {
  state.checks.push(props); return createElement("input", { type: "checkbox", checked: props.checked, disabled: props.disabled, readOnly: true, "data-testid": props["data-testid"] });
} }));
vi.mock("@/components/ui/input", () => ({ Input: (props: Control) => {
  state.inputs.push(props); return createElement("input", { value: String(props.value ?? ""), readOnly: true, "data-testid": props["data-testid"] });
} }));

import { RoleAssignmentDialog, readAssignmentRoles, replaceUserRoleAssignments } from "../../RoleAssignmentDialog";
import Users, { usersApi } from "@/pages/Users";

function render(component: "assignments" | "users" = "assignments", id = state.user.id) {
  state.index = 0; state.buttons = []; state.checks = []; state.inputs = []; state.queries = []; state.mutations = [];
  return renderToStaticMarkup(component === "users" ? createElement(Users) : createElement(RoleAssignmentDialog, { user: { ...state.user, id }, onClose: vi.fn() }));
}
function button(id: string) {
  const value = state.buttons.find(item => item["data-testid"] === id);
  if (!value) throw new Error(`Missing button ${id}`); return value;
}
function check(id: string) {
  const value = state.checks.find(item => item["data-testid"] === id);
  if (!value) throw new Error(`Missing checkbox ${id}`); return value;
}
function input(id: string, value: string) {
  const control = state.inputs.find(item => item["data-testid"] === id);
  if (!control?.onChange) throw new Error(`Missing input ${id}`); control.onChange({ target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks(); state.stateValues = []; state.pending = false;
  state.permissions = ["users:view", "users:create", "users:edit", "users:manage_roles", "roles:view"];
  const assigned = [{ id: 11, name: "Warehouse reader", isSystem: 0 }];
  Object.assign(state.assigned, { data: assigned, isSuccess: true, isFetching: false, isError: false, isStale: false });
  Object.assign(state.available, { data: [...assigned, { id: 12, name: "Custom purchasing", isSystem: 0 }], isSuccess: true, isFetching: false, isError: false, isStale: false });
  state.refreshAccess.mockResolvedValue(undefined); state.invalidate.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("explicit role assignment dialog", () => {
  it("loads only the selected user and keeps a multiple-custom-role selection until explicit Save", () => {
    render();
    expect(state.queries.map(query => query.queryKey)).toEqual([["/api/users", "user-7", "roles"], ["/api/roles", "assignment-options"]]);
    expect(button("button-save-assignments").disabled).toBe(true);
    check("checkbox-assigned-role-12").onCheckedChange!(true);
    expect(state.mutate).not.toHaveBeenCalled();
    render();
    expect(check("checkbox-assigned-role-11").checked).toBe(true);
    expect(check("checkbox-assigned-role-12").checked).toBe(true);
    button("button-save-assignments").onClick!();
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith([11, 12]);
  });

  it("requires a deliberate confirmation before submitting explicit zero roles", () => {
    render(); check("checkbox-assigned-role-11").onCheckedChange!(false);
    const html = render();
    expect(html).toContain("removes all operational access for @operator");
    expect(button("button-save-assignments").disabled).toBe(true);
    button("button-save-assignments").onClick!();
    expect(state.mutate).not.toHaveBeenCalled();
    check("checkbox-confirm-remove-all-roles").onCheckedChange!(true);
    render(); button("button-save-assignments").onClick!();
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith([]);
  });

  it.each(["missing", "loading", "error", "stale", "pending", "malformed", "no manage", "no role read", "no user read"])("blocks assignment changes with %s evidence", condition => {
    render(); check("checkbox-assigned-role-12").onCheckedChange!(true);
    if (condition === "missing") state.assigned.data = undefined;
    if (condition === "loading") state.assigned.isFetching = true;
    if (condition === "error") state.assigned.isError = true;
    if (condition === "stale") state.assigned.isStale = true;
    if (condition === "pending") state.pending = true;
    if (condition === "malformed") state.assigned.data = [{ id: 11, name: "Old metadata" }];
    if (condition === "no manage") state.permissions = ["users:view", "roles:view"];
    if (condition === "no role read") state.permissions = ["users:view", "users:manage_roles"];
    if (condition === "no user read") state.permissions = ["roles:view", "users:manage_roles"];
    render();
    expect(button("button-save-assignments").disabled).toBe(true);
    button("button-save-assignments").onClick!();
    expect(state.mutate).not.toHaveBeenCalled();
    if (condition.startsWith("no ")) expect(state.queries.every(query => query.enabled === false)).toBe(true);
  });

  it("does not discard an assignment missing from the role picker", () => {
    state.assigned.data = [{ id: 99, name: "Unknown assigned role", isSystem: 0 }];
    expect(render()).toContain("An assigned role is missing");
    expect(button("button-save-assignments").disabled).toBe(true);
  });

  it.each(["user switch", "changed assignments", "changed available roles"])("blocks a draft after %s", change => {
    render(); check("checkbox-assigned-role-12").onCheckedChange!(true);
    if (change === "changed assignments") state.assigned.data = [{ id: 12, name: "Custom purchasing", isSystem: 0 }];
    if (change === "changed available roles") state.available.data = [{ id: 11, name: "Renamed", isSystem: 0 }, { id: 12, name: "Custom purchasing", isSystem: 0 }];
    expect(render("assignments", change === "user switch" ? "another-user" : state.user.id)).toContain("Role data changed");
    expect(button("button-save-assignments").disabled).toBe(true);
  });

  it("treats a verified empty assignment as no access without selecting a default", () => {
    state.assigned.data = [];
    expect(render()).toContain("no roles selected");
    expect(state.checks.every(control => control.checked === false)).toBe(true);
    expect(button("button-save-assignments").disabled).toBe(true);
  });

  it("refreshes target data and current authority after an uncertain write without automatic replay", async () => {
    render(); const mutation = state.mutations[0];
    await mutation.onError(new Error("lost response"));
    expect(state.invalidate.mock.calls.map(call => call[0])).toEqual([
      { queryKey: ["/api/users", "user-7", "roles"], exact: true }, { queryKey: ["/api/roles", "assignment-options"], exact: true },
    ]);
    expect(state.refreshAccess).toHaveBeenCalledOnce();
    expect(mutation.retry).toBe(false); expect(state.mutate).not.toHaveBeenCalled();
    expect(render()).toContain("could not be confirmed");
  });

  it("reports saved-but-unverified access distinctly after successful persistence", async () => {
    render(); state.refreshAccess.mockRejectedValueOnce(new Error("offline"));
    await expect(state.mutations[0].onSuccess()).resolves.toBeUndefined();
    expect(render()).toContain("were saved, but access could not be refreshed");
  });
});

describe("assignment transport contract", () => {
  it.each([{ ids: [] }, { ids: [11, 12] }])("sends the explicit ID selection unchanged: $ids", async ({ ids }) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal("fetch", fetch);
    await replaceUserRoleAssignments("user-7", ids);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/users/user-7/roles", expect.objectContaining({ method: "PUT", body: JSON.stringify({ roleIds: ids }) }));
  });
  it.each([
    { data: [{ id: 11, name: "Role", isSystem: false }] },
    { data: [{ id: 11, name: "Role" }] },
    { data: [{ id: 11, name: "Role", isSystem: 0 }, { id: 11, name: "Role", isSystem: 0 }] },
  ])("rejects malformed management role metadata", async ({ data }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data))));
    await expect(readAssignmentRoles("/api/roles")).rejects.toThrow();
  });
  it("reads numeric system flags and custom roles without retaining extra diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: 11, name: "System role", isSystem: 1, secret: "ignored" }, { id: 12, name: "Custom role", isSystem: 0 },
    ]))));
    expect(await readAssignmentRoles("/api/roles")).toEqual([
      { id: 11, name: "System role", isSystem: 1 }, { id: 12, name: "Custom role", isSystem: 0 },
    ]);
  });
  it("does not expose arbitrary rejection diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "private provider trace" }), { status: 409 })));
    await expect(replaceUserRoleAssignments("user-7", [])).rejects.toThrow("The role update could not be confirmed.");
  });
  it("maps only the verified last-manager code to actionable safe wording", async () => {
    render();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: "IDENTITY_LAST_ACCESS_MANAGER", error: "untrusted diagnostic" }), { status: 409 }))));
    const failure = await replaceUserRoleAssignments("user-7", []).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    await state.mutations[0].onError(failure as Error);
    expect(render()).toContain("Assign an appropriate replacement first");
    expect(render()).not.toContain("untrusted diagnostic");
    await expect(usersApi.update("user-7", { active: 0 })).rejects.toThrow("last active access manager");
  });
});

describe("account/profile separation", () => {
  it("does not fetch memberships for every row and gates actions independently", () => {
    state.permissions = ["users:view"];
    const html = render("users");
    expect(state.queries.map(query => query.queryKey)).toEqual([["users"]]);
    expect(html).toContain("Total accounts"); expect(html).toContain("Legacy label");
    expect(html).not.toContain("button-add-user"); expect(html).not.toContain("button-edit-user-"); expect(html).not.toContain("button-manage-roles-");
    expect(html).not.toContain(">Picker<");
  });
  it("requires the role-list read permission before opening assignment", () => {
    state.permissions = ["users:view", "users:manage_roles"];
    render("users"); expect(button("button-manage-roles-user-7").disabled).toBe(true);
    button("button-manage-roles-user-7").onClick!(); render("users");
    expect(state.queries).toHaveLength(1);
  });
  it("creates an account without a legacy role or implicit membership", () => {
    render("users"); button("button-add-user").onClick!(); render("users");
    input("input-username", "new-user"); input("input-password", "synthetic-password"); input("input-displayname", "New operator");
    const html = render("users");
    expect(html).toContain("without operational access"); expect(html).not.toContain("select-role");
    button("button-create-user").onClick!();
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({ username: "new-user", password: "synthetic-password", displayName: "New operator" });
  });
  it("profile saving sends no assigned roles or legacy label and refreshes authority", async () => {
    render("users"); button("button-edit-user-user-7").onClick!(); render("users");
    input("input-edit-displayname", "Updated operator"); render("users");
    button("button-save-user").onClick!();
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({ id: "user-7", data: { displayName: "Updated operator", active: 1 } });
    await state.mutations[1].onSuccess(); expect(state.refreshAccess).toHaveBeenCalledOnce();
  });
  it("transport allowlists profile/create fields even if an old caller supplies a role", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(state.user))));
    vi.stubGlobal("fetch", fetch);
    const create = { username: "new", password: "synthetic", displayName: "New", role: "admin", roleIds: [1] };
    await usersApi.create(create);
    const patch = { displayName: "Updated", active: 1, role: "admin", roleIds: [1] };
    await usersApi.update("user-7", patch);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ username: "new", password: "synthetic", displayName: "New" });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ displayName: "Updated", active: 1 });
  });
});

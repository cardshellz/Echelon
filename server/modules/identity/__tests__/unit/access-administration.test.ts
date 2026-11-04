import { describe, expect, it } from "vitest";
import { assertAccessManagersPreserved, parseAdministrationActor, parseAdministrationInput,
  userProfileEditSchema } from "../../domain/access-administration";

describe("Identity administration command context", () => {
  it.each([undefined, null, {}, { actorId: "" }, { actorId: "   " }, { actorId: 1 },
    { actorId: "employee", operationId: "not-a-uuid" }, { actorId: "employee", attemptId: "" },
  ])("rejects malformed actor context %#", value => {
    expect(() => parseAdministrationActor(value)).toThrow(expect.objectContaining({ code: "IDENTITY_ADMINISTRATION_INVALID", statusCode: 400 }));
  });
  it("preserves exact opaque identity and caller operation/attempt IDs", () => {
    const input = { actorId: " employee ", operationId: "e909d54c-cfa8-419b-bfd1-d3311968f82f", attemptId: "eb009188-9a3b-482a-81bd-06b99a472caf" };
    expect(parseAdministrationActor(input)).toEqual(input);
  });
  it("generates correlation identifiers without modifying caller input", () => {
    const input = Object.freeze({ actorId: "employee" });
    const first = parseAdministrationActor(input);
    const second = parseAdministrationActor(input);
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(input).toEqual({ actorId: "employee" });
  });
});

describe("minimum existing access management coverage", () => {
  it.each([
    [{ "users:manage_roles": 1, "roles:edit": 1 }, { "users:manage_roles": 0, "roles:edit": 1 }],
    [{ "users:manage_roles": 1, "roles:edit": 1 }, { "users:manage_roles": 1, "roles:edit": 0 }],
    [{ "users:manage_roles": 5, "roles:edit": 3 }, { "users:manage_roles": 0, "roles:edit": 0 }],
  ])("rejects loss of an existing final manager %#", (before, after) => {
    expect(() => assertAccessManagersPreserved(before, after)).toThrow(expect.objectContaining({ code: "IDENTITY_LAST_ACCESS_MANAGER", statusCode: 409 }));
  });
  it.each([
    [{ "users:manage_roles": 2, "roles:edit": 2 }, { "users:manage_roles": 1, "roles:edit": 1 }],
    [{ "users:manage_roles": 0, "roles:edit": 0 }, { "users:manage_roles": 0, "roles:edit": 0 }],
    [{ "users:manage_roles": 0, "roles:edit": 1 }, { "users:manage_roles": 0, "roles:edit": 1 }],
    [{ "users:manage_roles": 1, "roles:edit": 0 }, { "users:manage_roles": 1, "roles:edit": 0 }],
    [{ "users:manage_roles": 0, "roles:edit": 0 }, { "users:manage_roles": 1, "roles:edit": 1 }],
  ])("preserves existing coverage without inventing a combined administrator %#", (before, after) => {
    expect(() => assertAccessManagersPreserved(before, after)).not.toThrow();
  });
});

describe("account edit contract", () => {
  it.each([{}, null, { active: true }, { active: "0" }, { active: 2 }, { active: -1 },
    { roleIds: [] }, { permissions: ["roles:edit"] }, { displayName: null },
  ])("rejects malformed or out-of-contract account data %#", raw => {
    expect(() => parseAdministrationInput(userProfileEditSchema, raw)).toThrow(expect.objectContaining({ code: "IDENTITY_ADMINISTRATION_INVALID" }));
  });
  it("allows explicit deactivation without coercion", () => {
    expect(parseAdministrationInput(userProfileEditSchema, { active: 0 })).toEqual({ active: 0 });
  });
  it("retains a legacy label only as data with no assignment side channel", () => {
    expect(parseAdministrationInput(userProfileEditSchema, { role: "admin" })).toEqual({ role: "admin" });
  });
});

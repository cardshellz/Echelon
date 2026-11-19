import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ db: { transaction: vi.fn() } }));

import {
  createStaffPasswordRecoveryToken,
  resetStaffPasswordWithToken,
  resolveStaffRecoveryEmail,
} from "../../application/staff-credentials";
import { onStaffAuthorityChanged, notifyStaffAuthorityChanged } from "../../authority-events";
import { parseBreakGlassCliArgs, runBreakGlassCli } from "../../../../../scripts/identity/recover-admin-password";
import { STAFF_PASSWORD_RESET_TTL_MS } from "@shared/staff-credentials";

describe("staff password recovery and authority event unit contracts", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "unit-test-session-secret-for-staff-recovery");
    vi.stubEnv("STAFF_RECOVERY_TOKEN_SECRET", "");
    vi.stubEnv("STAFF_RECOVERY_EMAILS_JSON", "");
    vi.stubEnv("STAFF_ADMIN_RECOVERY_EMAIL", "");
    vi.stubEnv("STAFF_ADMIN_RECOVERY_USERNAME", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("mints a 3-part state-bound recovery token with 15-minute TTL and rejects expired or tampered tokens before DB work", async () => {
    const credentialVersion = randomUUID();
    const nowMs = 1_762_000_000_000;
    const { token, expiresAt } = createStaffPasswordRecoveryToken({
      userId: "admin-1",
      credentialVersion,
      passwordHash: "$2b$10$syntheticHashValueForBindingTest12345678901234567890",
      nowMs,
    });

    expect(expiresAt).toBe(nowMs + STAFF_PASSWORD_RESET_TTL_MS);
    expect(token.split(".")).toHaveLength(3);

    await expect(
      resetStaffPasswordWithToken(
        {
          token,
          password: "ValidNewPassword!123",
          operationId: randomUUID(),
        },
        { nowMs: nowMs + STAFF_PASSWORD_RESET_TTL_MS + 1 },
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_CREDENTIAL_STALE", statusCode: 403 });

    const [payloadPart, outerPart, statePart] = token.split(".");
    const tamperedToken = `${payloadPart}.${outerPart}x.${statePart}`;
    await expect(
      resetStaffPasswordWithToken(
        {
          token: tamperedToken,
          password: "ValidNewPassword!123",
          operationId: randomUUID(),
        },
        { nowMs },
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_CREDENTIAL_STALE", statusCode: 403 });
  });

  it("fails closed when neither STAFF_RECOVERY_TOKEN_SECRET nor SESSION_SECRET is configured", () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("STAFF_RECOVERY_TOKEN_SECRET", "");

    expect(() =>
      createStaffPasswordRecoveryToken({
        userId: "admin-1",
        credentialVersion: randomUUID(),
        passwordHash: "$2b$10$syntheticHash",
      }),
    ).toThrow(/Password recovery is not configured/);
  });

  it("resolves verified recovery emails from STAFF_RECOVERY_EMAILS_JSON, STAFF_ADMIN_RECOVERY_EMAIL, or email usernames", () => {
    expect(resolveStaffRecoveryEmail({ id: "u-1", username: "picker_one" })).toBeNull();
    expect(resolveStaffRecoveryEmail({ id: "u-2", username: "Ops.Lead@CardShellz.com" })).toBe(
      "ops.lead@cardshellz.com",
    );

    vi.stubEnv("STAFF_ADMIN_RECOVERY_EMAIL", "owner@cardshellz.com");
    expect(resolveStaffRecoveryEmail({ id: "u-admin", username: "admin" })).toBe("owner@cardshellz.com");

    vi.stubEnv(
      "STAFF_RECOVERY_EMAILS_JSON",
      JSON.stringify({
        admin: "override-admin@cardshellz.com",
        "u-custom": "custom-id@cardshellz.com",
      }),
    );
    expect(resolveStaffRecoveryEmail({ id: "u-admin", username: "admin" })).toBe(
      "override-admin@cardshellz.com",
    );
    expect(resolveStaffRecoveryEmail({ id: "u-custom", username: "non_email_handle" })).toBe(
      "custom-id@cardshellz.com",
    );
  });

  it("validates CLI break-glass recovery flags, 72-byte password boundary, and delegates to Identity public command", async () => {
    expect(() => parseBreakGlassCliArgs([], {})).toThrow(/Specify --username/);
    expect(() => parseBreakGlassCliArgs(["--username", "admin", "--reason", "too short"], {})).toThrow(
      /at least 10 characters/,
    );
    expect(() =>
      parseBreakGlassCliArgs(
        ["--username", "admin", "--reason", "Break-glass lockout test"],
        { ECHELON_RECOVERY_TEMP_PASSWORD: "x".repeat(73) },
      ),
    ).toThrow(/72 UTF-8 bytes/);

    const execute = vi.fn().mockResolvedValue({
      userId: "admin-1",
      username: "admin",
      credentialVersion: "7d444840-9dc0-11d1-b245-5ffdce74fad2",
      mustChangePassword: true as const,
      protectedTarget: true,
      operationId: "8d444840-9dc0-11d1-b245-5ffdce74fad2",
    });

    const outcome = await runBreakGlassCli(
      [
        "--username",
        "admin",
        "--reason",
        "Emergency admin recovery after credential loss",
        "--operator",
        "brett-cli",
        "--generate-password",
      ],
      {},
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "admin",
        reason: "Emergency admin recovery after credential loss",
        operator: "brett-cli",
      }),
    );
    expect(typeof outcome.temporaryPassword).toBe("string");
    expect(outcome.temporaryPassword!.length).toBeGreaterThanOrEqual(20);
    expect(outcome.mustChangePassword).toBe(true);
  });

  it("notifies subscribed authority listeners with deduplicated user IDs and isolates listener errors", async () => {
    const received: Array<ReadonlyArray<string> | undefined> = [];
    const unsubscribeFailing = onStaffAuthorityChanged(() => {
      throw new Error("Synthetic listener failure");
    });
    const unsubscribeWorking = onStaffAuthorityChanged((ids) => {
      received.push(ids);
    });

    try {
      await notifyStaffAuthorityChanged(["user-a", "user-b", "user-a"]);
      await notifyStaffAuthorityChanged();
      expect(received).toEqual([["user-a", "user-b"], undefined]);
    } finally {
      unsubscribeFailing();
      unsubscribeWorking();
    }
  });
});

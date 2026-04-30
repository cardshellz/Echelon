import { beforeEach, describe, expect, it } from "vitest";
import { DropshipAuthService, type DropshipAuthChallengeCreateResult, type DropshipAuthChallengeConsumeResult, type DropshipAuthIdentityRecord, type DropshipAuthIdentityRepository, type DropshipAuthServiceDependencies } from "../../application/dropship-auth-service";
import type { DropshipEntitlementSnapshot, DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipSensitiveAction } from "../../domain/auth";
import { DropshipError } from "../../domain/errors";

const now = new Date("2026-04-30T12:00:00.000Z");

describe("DropshipAuthService", () => {
  let deps: FakeAuthDeps;
  let service: DropshipAuthService;

  beforeEach(() => {
    deps = new FakeAuthDeps();
    service = new DropshipAuthService(deps.build());
  });

  it("starts account bootstrap only for an entitled Card Shellz member", async () => {
    await expect(service.startAccountBootstrap({
      email: " Vendor@CardShellz.test ",
      idempotencyKey: "bootstrap-key-0001",
    })).resolves.toEqual({ accepted: true });

    expect(deps.sentEmails).toEqual([{
      toEmail: "vendor@cardshellz.test",
      code: "123456",
      action: "account_bootstrap",
      expiresAt: new Date("2026-04-30T12:10:00.000Z"),
    }]);
    expect(deps.challenges[0]).toMatchObject({
      memberId: "member-1",
      action: "account_bootstrap",
      idempotencyKey: "bootstrap-key-0001",
    });
  });

  it("does not reveal unknown Card Shellz emails during bootstrap", async () => {
    await service.startAccountBootstrap({
      email: "missing@cardshellz.test",
      idempotencyKey: "bootstrap-key-0002",
    });

    expect(deps.sentEmails).toEqual([]);
    expect(deps.logs.warn[0]).toMatchObject({
      code: "DROPSHIP_BOOTSTRAP_MEMBER_NOT_FOUND",
    });
  });

  it("completes bootstrap after email proof and creates a password identity", async () => {
    await service.startAccountBootstrap({
      email: "vendor@cardshellz.test",
      idempotencyKey: "bootstrap-key-0003",
    });

    const principal = await service.completeAccountBootstrap({
      email: "vendor@cardshellz.test",
      verificationCode: "123456",
      password: "StrongPassword123",
    });

    expect(principal).toMatchObject({
      authIdentityId: 101,
      memberId: "member-1",
      cardShellzEmail: "vendor@cardshellz.test",
      authMethod: "password",
      hasPasskey: false,
      entitlementStatus: "active",
    });
    expect(deps.identitiesByEmail.get("vendor@cardshellz.test")?.passwordHash).toBe("hashed:StrongPassword123");
  });

  it("rejects bootstrap completion when the email code is wrong", async () => {
    await service.startAccountBootstrap({
      email: "vendor@cardshellz.test",
      idempotencyKey: "bootstrap-key-0004",
    });

    await expect(service.completeAccountBootstrap({
      email: "vendor@cardshellz.test",
      verificationCode: "000000",
      password: "StrongPassword123",
    })).rejects.toMatchObject({
      code: "DROPSHIP_INVALID_EMAIL_CHALLENGE",
    });
  });

  it("logs in with password and marks sensitive actions for email MFA when no passkey exists", async () => {
    await service.startAccountBootstrap({
      email: "vendor@cardshellz.test",
      idempotencyKey: "bootstrap-key-0005",
    });
    await service.completeAccountBootstrap({
      email: "vendor@cardshellz.test",
      verificationCode: "123456",
      password: "StrongPassword123",
    });

    const principal = await service.loginWithPassword({
      email: "vendor@cardshellz.test",
      password: "StrongPassword123",
    });
    const challenge = await service.startSensitiveActionChallenge(principal, {
      action: "add_funding_method",
      idempotencyKey: "sensitive-key-0001",
    });

    expect(principal.hasPasskey).toBe(false);
    expect(challenge.method).toBe("email_mfa");
    expect(deps.lastLoginTouchedAt).toEqual(now);
    expect(deps.sentEmails.at(-1)).toMatchObject({
      toEmail: "vendor@cardshellz.test",
      code: "123456",
      action: "add_funding_method",
    });
  });

  it("does not issue email MFA for sensitive actions when passkey confirmation is required", async () => {
    deps.identitiesByEmail.set("vendor@cardshellz.test", {
      authIdentityId: 202,
      memberId: "member-1",
      primaryEmail: "vendor@cardshellz.test",
      passwordHash: "hashed:StrongPassword123",
      passwordHashAlgorithm: "test",
      status: "active",
      passkeyEnrolledAt: now,
    });

    const principal = await service.loginWithPassword({
      email: "vendor@cardshellz.test",
      password: "StrongPassword123",
    });
    const challenge = await service.startSensitiveActionChallenge(principal, {
      action: "connect_store",
      idempotencyKey: "sensitive-key-0002",
    });

    expect(challenge).toEqual({ method: "passkey" });
    expect(deps.sentEmails).toEqual([]);
  });

  it("blocks password login when the .ops entitlement has lapsed", async () => {
    deps.entitlement.status = "lapsed";
    deps.identitiesByEmail.set("vendor@cardshellz.test", {
      authIdentityId: 303,
      memberId: "member-1",
      primaryEmail: "vendor@cardshellz.test",
      passwordHash: "hashed:StrongPassword123",
      passwordHashAlgorithm: "test",
      status: "active",
      passkeyEnrolledAt: null,
    });

    await expect(service.loginWithPassword({
      email: "vendor@cardshellz.test",
      password: "StrongPassword123",
    })).rejects.toBeInstanceOf(DropshipError);
  });
});

class FakeAuthDeps {
  readonly identitiesByEmail = new Map<string, DropshipAuthIdentityRecord>();
  readonly challenges: Array<{
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    idempotencyKey: string;
    expiresAt: Date;
    consumed: boolean;
    attempts: number;
  }> = [];
  readonly sentEmails: Array<{
    toEmail: string;
    code: string;
    action: DropshipSensitiveAction;
    expiresAt: Date;
  }> = [];
  readonly logs: Record<"info" | "warn" | "error", DropshipLogEvent[]> = {
    info: [],
    warn: [],
    error: [],
  };
  entitlement: DropshipEntitlementSnapshot = {
    memberId: "member-1",
    cardShellzEmail: "vendor@cardshellz.test",
    planId: "ops-plan",
    planName: ".ops",
    subscriptionId: "sub-1",
    includesDropship: true,
    status: "active",
    reasonCode: "ENTITLED",
  };
  lastLoginTouchedAt: Date | null = null;

  build(): DropshipAuthServiceDependencies {
    return {
      identity: {
        resolveMemberByCardShellzEmail: async (email) => {
          if (email.toLowerCase().trim() !== "vendor@cardshellz.test") return null;
          return {
            memberId: "member-1",
            cardShellzEmail: "vendor@cardshellz.test",
            memberStatus: "active",
          };
        },
      },
      entitlement: {
        getEntitlementByMemberId: async () => this.entitlement,
      },
      authIdentities: new FakeAuthIdentityRepository(this),
      passwordHasher: {
        algorithm: "test",
        hash: async (password) => `hashed:${password}`,
        verify: async (password, passwordHash) => passwordHash === `hashed:${password}`,
      },
      emailSender: {
        sendVerificationCode: async (input) => {
          this.sentEmails.push(input);
        },
      },
      codeGenerator: {
        generateCode: () => "123456",
      },
      clock: {
        now: () => now,
      },
      logger: {
        info: (event) => this.logs.info.push(event),
        warn: (event) => this.logs.warn.push(event),
        error: (event) => this.logs.error.push(event),
      },
      challengeSecret: "test-secret",
    };
  }
}

class FakeAuthIdentityRepository implements DropshipAuthIdentityRepository {
  constructor(private readonly deps: FakeAuthDeps) {}

  async findAuthIdentityByMemberId(memberId: string): Promise<DropshipAuthIdentityRecord | null> {
    return [...this.deps.identitiesByEmail.values()].find((identity) => identity.memberId === memberId) ?? null;
  }

  async findAuthIdentityByPrimaryEmail(email: string): Promise<DropshipAuthIdentityRecord | null> {
    return this.deps.identitiesByEmail.get(email.toLowerCase().trim()) ?? null;
  }

  async upsertPasswordIdentity(input: {
    memberId: string;
    cardShellzEmail: string;
    passwordHash: string;
    passwordHashAlgorithm: string;
    verifiedAt: Date;
  }): Promise<DropshipAuthIdentityRecord> {
    const identity: DropshipAuthIdentityRecord = {
      authIdentityId: 101,
      memberId: input.memberId,
      primaryEmail: input.cardShellzEmail,
      passwordHash: input.passwordHash,
      passwordHashAlgorithm: input.passwordHashAlgorithm,
      status: "active",
      passkeyEnrolledAt: null,
    };
    this.deps.identitiesByEmail.set(input.cardShellzEmail, identity);
    return identity;
  }

  async touchLastLogin(_authIdentityId: number, loggedInAt: Date): Promise<void> {
    this.deps.lastLoginTouchedAt = loggedInAt;
  }

  async createEmailChallenge(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    idempotencyKey: string;
    expiresAt: Date;
  }): Promise<DropshipAuthChallengeCreateResult> {
    const existing = this.deps.challenges.find((challenge) => challenge.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return {
        challengeId: this.deps.challenges.indexOf(existing) + 1,
        expiresAt: existing.expiresAt,
        created: false,
      };
    }

    this.deps.challenges.push({
      ...input,
      consumed: false,
      attempts: 0,
    });
    return {
      challengeId: this.deps.challenges.length,
      expiresAt: input.expiresAt,
      created: true,
    };
  }

  async consumeLatestEmailChallenge(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    now: Date;
    maxAttempts: number;
  }): Promise<DropshipAuthChallengeConsumeResult> {
    const challenge = this.deps.challenges
      .filter((candidate) => (
        candidate.memberId === input.memberId &&
        candidate.action === input.action &&
        !candidate.consumed
      ))
      .at(-1);

    if (!challenge) return { consumed: false, failureReason: "not_found" };
    if (challenge.expiresAt.getTime() <= input.now.getTime()) {
      return { consumed: false, failureReason: "expired" };
    }
    if (challenge.attempts >= input.maxAttempts) {
      return { consumed: false, failureReason: "too_many_attempts" };
    }
    if (challenge.challengeHash !== input.challengeHash) {
      challenge.attempts += 1;
      return { consumed: false, failureReason: "invalid_code" };
    }

    challenge.consumed = true;
    return { consumed: true };
  }
}

import { createHmac, timingSafeEqual } from "crypto";
import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_EMAIL_CHALLENGE_MAX_ATTEMPTS,
  DROPSHIP_EMAIL_MFA_TTL_MINUTES,
  DROPSHIP_SENSITIVE_ACTION_PROOF_TTL_MINUTES,
  assertDropshipPasswordPolicy,
  normalizeCardShellzEmail,
  resolveSensitiveActionStepUp,
  type DropshipSensitiveAction,
  type DropshipSessionPrincipal,
  type DropshipStepUpMethod,
} from "../domain/auth";
import type {
  DropshipClock,
  DropshipEntitlementPort,
  DropshipIdentityPort,
  DropshipLogger,
} from "./dropship-ports";
import type {
  CompleteDropshipAccountBootstrapInput,
  DropshipPasswordLoginInput,
  StartDropshipAccountBootstrapInput,
  StartDropshipSensitiveActionChallengeInput,
  VerifyDropshipSensitiveActionChallengeInput,
} from "./dropship-auth-dtos";

export interface DropshipAuthIdentityRecord {
  authIdentityId: number;
  memberId: string;
  primaryEmail: string;
  passwordHash: string | null;
  passwordHashAlgorithm: string | null;
  status: "active" | "locked" | "disabled" | string;
  passkeyEnrolledAt: Date | null;
}

export interface DropshipAuthChallengeCreateResult {
  challengeId: number;
  expiresAt: Date;
  created: boolean;
}

export interface DropshipAuthChallengeConsumeResult {
  consumed: boolean;
  challengeId?: number;
  failureReason?: "not_found" | "expired" | "too_many_attempts" | "invalid_code";
}

export interface DropshipAuthIdentityRepository {
  findAuthIdentityByMemberId(memberId: string): Promise<DropshipAuthIdentityRecord | null>;
  findAuthIdentityByPrimaryEmail(email: string): Promise<DropshipAuthIdentityRecord | null>;
  upsertPasswordIdentity(input: {
    memberId: string;
    cardShellzEmail: string;
    passwordHash: string;
    passwordHashAlgorithm: string;
    verifiedAt: Date;
  }): Promise<DropshipAuthIdentityRecord>;
  touchLastLogin(authIdentityId: number, loggedInAt: Date): Promise<void>;
  createEmailChallenge(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    idempotencyKey: string;
    expiresAt: Date;
    createdAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<DropshipAuthChallengeCreateResult>;
  consumeLatestEmailChallenge(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    now: Date;
    maxAttempts: number;
  }): Promise<DropshipAuthChallengeConsumeResult>;
}

export interface DropshipPasswordHasher {
  readonly algorithm: string;
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
}

export interface DropshipAuthEmailSender {
  sendVerificationCode(input: {
    toEmail: string;
    code: string;
    action: DropshipSensitiveAction;
    expiresAt: Date;
  }): Promise<void>;
}

export interface DropshipAuthCodeGenerator {
  generateCode(): string;
}

export interface DropshipAuthServiceDependencies {
  identity: DropshipIdentityPort;
  entitlement: DropshipEntitlementPort;
  authIdentities: DropshipAuthIdentityRepository;
  passwordHasher: DropshipPasswordHasher;
  emailSender: DropshipAuthEmailSender;
  codeGenerator: DropshipAuthCodeGenerator;
  clock: DropshipClock;
  logger: DropshipLogger;
  challengeSecret: string;
}

export class DropshipAuthService {
  constructor(private readonly deps: DropshipAuthServiceDependencies) {
    if (!deps.challengeSecret.trim()) {
      throw new DropshipError(
        "DROPSHIP_AUTH_CHALLENGE_SECRET_REQUIRED",
        "Dropship auth challenge secret is required.",
      );
    }
  }

  async startAccountBootstrap(input: StartDropshipAccountBootstrapInput): Promise<{ accepted: true }> {
    const email = normalizeCardShellzEmail(input.email);
    const member = await this.deps.identity.resolveMemberByCardShellzEmail(email);
    if (!member) {
      this.deps.logger.warn({
        code: "DROPSHIP_BOOTSTRAP_MEMBER_NOT_FOUND",
        message: "Dropship account bootstrap requested for an unknown Card Shellz email.",
      });
      return { accepted: true };
    }

    const entitlement = await this.deps.entitlement.getEntitlementByMemberId(member.memberId);
    if (!entitlement || !isLoginEntitled(entitlement.status)) {
      this.deps.logger.warn({
        code: "DROPSHIP_BOOTSTRAP_NOT_ENTITLED",
        message: "Dropship account bootstrap requested by a member without active dropship entitlement.",
        context: {
          memberId: member.memberId,
          entitlementStatus: entitlement?.status ?? "missing",
          reasonCode: entitlement?.reasonCode ?? "ENTITLEMENT_NOT_FOUND",
        },
      });
      return { accepted: true };
    }

    await this.createAndSendEmailChallenge({
      memberId: member.memberId,
      email,
      action: "account_bootstrap",
      idempotencyKey: input.idempotencyKey,
      metadata: { source: "account_bootstrap" },
    });

    return { accepted: true };
  }

  async completeAccountBootstrap(
    input: CompleteDropshipAccountBootstrapInput,
  ): Promise<DropshipSessionPrincipal> {
    const email = normalizeCardShellzEmail(input.email);
    assertDropshipPasswordPolicy(input.password);

    const member = await this.requireMemberByEmail(email);
    const entitlementStatus = await this.requireLoginEntitlement(member.memberId);

    const challengeHash = this.hashEmailCode({
      memberId: member.memberId,
      action: "account_bootstrap",
      code: input.verificationCode,
    });

    const consumed = await this.deps.authIdentities.consumeLatestEmailChallenge({
      memberId: member.memberId,
      action: "account_bootstrap",
      challengeHash,
      now: this.deps.clock.now(),
      maxAttempts: DROPSHIP_EMAIL_CHALLENGE_MAX_ATTEMPTS,
    });
    if (!consumed.consumed) {
      throw new DropshipError(
        "DROPSHIP_INVALID_EMAIL_CHALLENGE",
        "Verification code is invalid or expired.",
        { reason: consumed.failureReason ?? "unknown" },
      );
    }

    const passwordHash = await this.deps.passwordHasher.hash(input.password);
    const identity = await this.deps.authIdentities.upsertPasswordIdentity({
      memberId: member.memberId,
      cardShellzEmail: member.cardShellzEmail,
      passwordHash,
      passwordHashAlgorithm: this.deps.passwordHasher.algorithm,
      verifiedAt: this.deps.clock.now(),
    });

    return this.buildSessionPrincipal(identity, entitlementStatus, "password");
  }

  async loginWithPassword(input: DropshipPasswordLoginInput): Promise<DropshipSessionPrincipal> {
    const email = normalizeCardShellzEmail(input.email);
    const identity = await this.deps.authIdentities.findAuthIdentityByPrimaryEmail(email);
    if (!identity || !identity.passwordHash || identity.status !== "active") {
      throw new DropshipError("DROPSHIP_INVALID_LOGIN", "Invalid dropship login credentials.");
    }

    const passwordValid = await this.deps.passwordHasher.verify(input.password, identity.passwordHash);
    if (!passwordValid) {
      throw new DropshipError("DROPSHIP_INVALID_LOGIN", "Invalid dropship login credentials.");
    }

    const member = await this.deps.identity.resolveMemberByCardShellzEmail(identity.primaryEmail);
    if (!member || member.memberId !== identity.memberId) {
      throw new DropshipError(
        "DROPSHIP_AUTH_IDENTITY_MEMBER_MISMATCH",
        "Dropship auth identity no longer maps to the Card Shellz member.",
        { memberId: identity.memberId },
      );
    }

    const entitlementStatus = await this.requireLoginEntitlement(identity.memberId);
    await this.deps.authIdentities.touchLastLogin(identity.authIdentityId, this.deps.clock.now());
    return this.buildSessionPrincipal(identity, entitlementStatus, "password");
  }

  async startSensitiveActionChallenge(
    principal: DropshipSessionPrincipal,
    input: StartDropshipSensitiveActionChallengeInput,
  ): Promise<{
    method: DropshipStepUpMethod;
    challengeId?: number;
    expiresAt?: Date;
  }> {
    const method = resolveSensitiveActionStepUp(principal, input.action);
    if (method === "passkey") {
      return { method };
    }

    const result = await this.createAndSendEmailChallenge({
      memberId: principal.memberId,
      email: principal.cardShellzEmail,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      metadata: { source: "sensitive_action" },
    });

    return {
      method,
      challengeId: result.challengeId,
      expiresAt: result.expiresAt,
    };
  }

  async verifySensitiveActionChallenge(
    principal: DropshipSessionPrincipal,
    input: VerifyDropshipSensitiveActionChallengeInput,
  ): Promise<{
    action: DropshipSensitiveAction;
    method: "email_mfa";
    verifiedAt: Date;
    expiresAt: Date;
  }> {
    const method = resolveSensitiveActionStepUp(principal, input.action);
    if (method !== "email_mfa") {
      throw new DropshipError(
        "DROPSHIP_PASSKEY_STEP_UP_REQUIRED",
        "Passkey confirmation is required for this sensitive action.",
        { action: input.action },
      );
    }

    const now = this.deps.clock.now();
    const challengeHash = this.hashEmailCode({
      memberId: principal.memberId,
      action: input.action,
      code: input.verificationCode,
    });
    const consumed = await this.deps.authIdentities.consumeLatestEmailChallenge({
      memberId: principal.memberId,
      action: input.action,
      challengeHash,
      now,
      maxAttempts: DROPSHIP_EMAIL_CHALLENGE_MAX_ATTEMPTS,
    });
    if (!consumed.consumed) {
      throw new DropshipError(
        "DROPSHIP_INVALID_EMAIL_CHALLENGE",
        "Verification code is invalid or expired.",
        { action: input.action, reason: consumed.failureReason ?? "unknown" },
      );
    }

    return {
      action: input.action,
      method,
      verifiedAt: now,
      expiresAt: addMinutes(now, DROPSHIP_SENSITIVE_ACTION_PROOF_TTL_MINUTES),
    };
  }

  private async requireMemberByEmail(email: string): Promise<{ memberId: string; cardShellzEmail: string }> {
    const member = await this.deps.identity.resolveMemberByCardShellzEmail(email);
    if (!member) {
      throw new DropshipError("DROPSHIP_MEMBER_NOT_FOUND", "Card Shellz member was not found.");
    }

    return {
      memberId: member.memberId,
      cardShellzEmail: member.cardShellzEmail,
    };
  }

  private async requireLoginEntitlement(
    memberId: string,
  ): Promise<"active" | "grace"> {
    const entitlement = await this.deps.entitlement.getEntitlementByMemberId(memberId);
    if (!entitlement || !isLoginEntitled(entitlement.status)) {
      throw new DropshipError(
        "DROPSHIP_ENTITLEMENT_REQUIRED",
        "Active .ops dropship entitlement is required.",
        {
          memberId,
          entitlementStatus: entitlement?.status ?? "missing",
          reasonCode: entitlement?.reasonCode ?? "ENTITLEMENT_NOT_FOUND",
        },
      );
    }

    return entitlement.status;
  }

  private buildSessionPrincipal(
    identity: DropshipAuthIdentityRecord,
    entitlementStatus: "active" | "grace",
    authMethod: "password" | "passkey",
  ): DropshipSessionPrincipal {
    return {
      authIdentityId: identity.authIdentityId,
      memberId: identity.memberId,
      cardShellzEmail: normalizeCardShellzEmail(identity.primaryEmail),
      hasPasskey: !!identity.passkeyEnrolledAt,
      authMethod,
      entitlementStatus,
      authenticatedAt: this.deps.clock.now().toISOString(),
    };
  }

  private async createAndSendEmailChallenge(input: {
    memberId: string;
    email: string;
    action: DropshipSensitiveAction;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<DropshipAuthChallengeCreateResult> {
    const now = this.deps.clock.now();
    const code = this.deps.codeGenerator.generateCode();
    const challenge = await this.deps.authIdentities.createEmailChallenge({
      memberId: input.memberId,
      action: input.action,
      challengeHash: this.hashEmailCode({
        memberId: input.memberId,
        action: input.action,
        code,
      }),
      idempotencyKey: input.idempotencyKey,
      expiresAt: addMinutes(now, DROPSHIP_EMAIL_MFA_TTL_MINUTES),
      createdAt: now,
      metadata: input.metadata,
    });

    if (challenge.created) {
      try {
        await this.deps.emailSender.sendVerificationCode({
          toEmail: input.email,
          code,
          action: input.action,
          expiresAt: challenge.expiresAt,
        });
      } catch (error) {
        throw new DropshipError(
          "DROPSHIP_AUTH_EMAIL_DELIVERY_FAILED",
          "Dropship auth verification email could not be sent.",
          {
            action: input.action,
            memberId: input.memberId,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    return challenge;
  }

  private hashEmailCode(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    code: string;
  }): string {
    return createHmac("sha256", this.deps.challengeSecret)
      .update(`${input.memberId}:${input.action}:email_mfa:${input.code}`)
      .digest("hex");
  }
}

export function emailChallengeHashMatches(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function isLoginEntitled(status: string): status is "active" | "grace" {
  return status === "active" || status === "grace";
}

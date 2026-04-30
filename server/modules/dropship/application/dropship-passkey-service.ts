import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_SENSITIVE_ACTION_PROOF_TTL_MINUTES,
  normalizeCardShellzEmail,
  resolveSensitiveActionStepUp,
  type DropshipSensitiveAction,
  type DropshipSessionPrincipal,
} from "../domain/auth";
import type {
  DropshipClock,
  DropshipEntitlementPort,
  DropshipIdentityPort,
} from "./dropship-ports";
import { addMinutes, type DropshipAuthIdentityRecord } from "./dropship-auth-service";
import type {
  CompleteDropshipPasskeyLoginInput,
  CompleteDropshipPasskeyRegistrationInput,
  StartDropshipPasskeyLoginInput,
  StartDropshipSensitiveActionPasskeyInput,
  VerifyDropshipSensitiveActionPasskeyInput,
} from "./dropship-auth-dtos";

export const DROPSHIP_PASSKEY_CHALLENGE_TTL_MINUTES = 5;

export interface DropshipPasskeyCredentialRecord {
  id: number;
  authIdentityId: number;
  memberId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
  aaguid: string | null;
  backupEligible: boolean | null;
  backupState: boolean | null;
}

export interface DropshipStoredPasskeyRegistration {
  challenge: string;
  memberId: string;
  expiresAt: Date;
}

export interface DropshipStoredPasskeyAuthentication {
  challenge: string;
  memberId: string | null;
  action: DropshipSensitiveAction | null;
  expiresAt: Date;
}

export interface DropshipPasskeyOptions {
  challenge: string;
  [key: string]: unknown;
}

export interface DropshipVerifiedPasskeyRegistration {
  verified: boolean;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
  aaguid: string | null;
  backupEligible: boolean;
  backupState: boolean;
}

export interface DropshipVerifiedPasskeyAuthentication {
  verified: boolean;
  credentialId: string;
  newSignCount: number;
  backupState: boolean;
}

export interface DropshipPasskeyRepository {
  findAuthIdentityByMemberId(memberId: string): Promise<DropshipAuthIdentityRecord | null>;
  findPasskeyCredentialByCredentialId(credentialId: string): Promise<DropshipPasskeyCredentialRecord | null>;
  listPasskeyCredentialsByMemberId(memberId: string): Promise<DropshipPasskeyCredentialRecord[]>;
  createPasskeyCredential(input: {
    authIdentityId: number;
    memberId: string;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[];
    aaguid: string | null;
    backupEligible: boolean;
    backupState: boolean;
    createdAt: Date;
  }): Promise<DropshipPasskeyCredentialRecord>;
  updatePasskeyCredentialAfterAuthentication(input: {
    credentialId: string;
    newSignCount: number;
    backupState: boolean;
    usedAt: Date;
  }): Promise<void>;
  markPasskeyEnrolled(input: {
    authIdentityId: number;
    enrolledAt: Date;
  }): Promise<DropshipAuthIdentityRecord>;
}

export interface DropshipWebAuthnProvider {
  generateRegistrationOptions(input: {
    rpName: string;
    rpId: string;
    userId: string;
    userName: string;
    userDisplayName: string;
    excludeCredentials: DropshipPasskeyCredentialRecord[];
  }): Promise<DropshipPasskeyOptions>;
  verifyRegistrationResponse(input: {
    response: CompleteDropshipPasskeyRegistrationInput["response"];
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<DropshipVerifiedPasskeyRegistration>;
  generateAuthenticationOptions(input: {
    rpId: string;
    allowCredentials: DropshipPasskeyCredentialRecord[];
  }): Promise<DropshipPasskeyOptions>;
  verifyAuthenticationResponse(input: {
    response: CompleteDropshipPasskeyLoginInput["response"];
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: DropshipPasskeyCredentialRecord;
  }): Promise<DropshipVerifiedPasskeyAuthentication>;
}

export interface DropshipPasskeyConfig {
  rpName: string;
  rpId: string;
  origin: string;
}

export interface DropshipPasskeyServiceDependencies {
  identity: DropshipIdentityPort;
  entitlement: DropshipEntitlementPort;
  repository: DropshipPasskeyRepository;
  webAuthn: DropshipWebAuthnProvider;
  clock: DropshipClock;
  config: DropshipPasskeyConfig;
}

export class DropshipPasskeyService {
  constructor(private readonly deps: DropshipPasskeyServiceDependencies) {
    assertPasskeyConfig(deps.config);
  }

  async startRegistration(
    principal: DropshipSessionPrincipal,
  ): Promise<{
    options: DropshipPasskeyOptions;
    challenge: DropshipStoredPasskeyRegistration;
  }> {
    const identity = await this.requireActiveAuthIdentity(principal.memberId);
    const credentials = await this.deps.repository.listPasskeyCredentialsByMemberId(principal.memberId);
    const options = await this.deps.webAuthn.generateRegistrationOptions({
      rpName: this.deps.config.rpName,
      rpId: this.deps.config.rpId,
      userId: principal.memberId,
      userName: principal.cardShellzEmail,
      userDisplayName: principal.cardShellzEmail,
      excludeCredentials: credentials,
    });

    return {
      options,
      challenge: {
        challenge: options.challenge,
        memberId: identity.memberId,
        expiresAt: addMinutes(this.deps.clock.now(), DROPSHIP_PASSKEY_CHALLENGE_TTL_MINUTES),
      },
    };
  }

  async completeRegistration(
    principal: DropshipSessionPrincipal,
    storedChallenge: DropshipStoredPasskeyRegistration,
    input: CompleteDropshipPasskeyRegistrationInput,
  ): Promise<DropshipSessionPrincipal> {
    this.assertRegistrationChallenge(principal, storedChallenge);
    const identity = await this.requireActiveAuthIdentity(principal.memberId);
    const verification = await this.deps.webAuthn.verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: this.deps.config.origin,
      expectedRpId: this.deps.config.rpId,
    });

    if (!verification.verified) {
      throw new DropshipError("DROPSHIP_PASSKEY_REGISTRATION_FAILED", "Passkey registration could not be verified.");
    }

    const existing = await this.deps.repository.findPasskeyCredentialByCredentialId(verification.credentialId);
    if (existing) {
      throw new DropshipError(
        "DROPSHIP_PASSKEY_ALREADY_REGISTERED",
        "This passkey is already registered.",
        { credentialId: verification.credentialId },
      );
    }

    await this.deps.repository.createPasskeyCredential({
      authIdentityId: identity.authIdentityId,
      memberId: identity.memberId,
      credentialId: verification.credentialId,
      publicKey: verification.publicKey,
      signCount: verification.signCount,
      transports: verification.transports,
      aaguid: verification.aaguid,
      backupEligible: verification.backupEligible,
      backupState: verification.backupState,
      createdAt: this.deps.clock.now(),
    });
    const updatedIdentity = await this.deps.repository.markPasskeyEnrolled({
      authIdentityId: identity.authIdentityId,
      enrolledAt: this.deps.clock.now(),
    });

    const entitlementStatus = await this.requireLoginEntitlement(updatedIdentity.memberId);
    return this.buildSessionPrincipal(updatedIdentity, entitlementStatus, principal.authMethod);
  }

  async startLogin(input: StartDropshipPasskeyLoginInput): Promise<{
    options: DropshipPasskeyOptions;
    challenge: DropshipStoredPasskeyAuthentication;
  }> {
    const memberId = input.email ? await this.findLoginMemberId(input.email) : null;
    const credentials = memberId
      ? await this.deps.repository.listPasskeyCredentialsByMemberId(memberId)
      : [];
    const options = await this.deps.webAuthn.generateAuthenticationOptions({
      rpId: this.deps.config.rpId,
      allowCredentials: credentials,
    });

    return {
      options,
      challenge: {
        challenge: options.challenge,
        memberId,
        action: null,
        expiresAt: addMinutes(this.deps.clock.now(), DROPSHIP_PASSKEY_CHALLENGE_TTL_MINUTES),
      },
    };
  }

  async completeLogin(
    storedChallenge: DropshipStoredPasskeyAuthentication,
    input: CompleteDropshipPasskeyLoginInput,
  ): Promise<DropshipSessionPrincipal> {
    this.assertAuthenticationChallenge(storedChallenge, null);
    const credential = await this.requireCredentialForAuthentication(input.response.id, storedChallenge.memberId);
    const verification = await this.deps.webAuthn.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: this.deps.config.origin,
      expectedRpId: this.deps.config.rpId,
      credential,
    });
    if (!verification.verified) {
      throw new DropshipError("DROPSHIP_PASSKEY_AUTHENTICATION_FAILED", "Passkey login could not be verified.");
    }

    await this.deps.repository.updatePasskeyCredentialAfterAuthentication({
      credentialId: credential.credentialId,
      newSignCount: verification.newSignCount,
      backupState: verification.backupState,
      usedAt: this.deps.clock.now(),
    });

    let identity = await this.requireActiveAuthIdentity(credential.memberId);
    if (!identity.passkeyEnrolledAt) {
      identity = await this.deps.repository.markPasskeyEnrolled({
        authIdentityId: identity.authIdentityId,
        enrolledAt: this.deps.clock.now(),
      });
    }
    const entitlementStatus = await this.requireLoginEntitlement(identity.memberId);
    return this.buildSessionPrincipal(identity, entitlementStatus, "passkey");
  }

  async startSensitiveActionChallenge(
    principal: DropshipSessionPrincipal,
    input: StartDropshipSensitiveActionPasskeyInput,
  ): Promise<{
    options: DropshipPasskeyOptions;
    challenge: DropshipStoredPasskeyAuthentication;
  }> {
    const method = resolveSensitiveActionStepUp(principal, input.action);
    if (method !== "passkey") {
      throw new DropshipError(
        "DROPSHIP_EMAIL_MFA_STEP_UP_REQUIRED",
        "Email MFA is required for this sensitive action.",
        { action: input.action },
      );
    }

    const credentials = await this.deps.repository.listPasskeyCredentialsByMemberId(principal.memberId);
    if (credentials.length === 0) {
      throw new DropshipError(
        "DROPSHIP_PASSKEY_REQUIRED",
        "No passkey is registered for this dropship account.",
      );
    }

    const options = await this.deps.webAuthn.generateAuthenticationOptions({
      rpId: this.deps.config.rpId,
      allowCredentials: credentials,
    });

    return {
      options,
      challenge: {
        challenge: options.challenge,
        memberId: principal.memberId,
        action: input.action,
        expiresAt: addMinutes(this.deps.clock.now(), DROPSHIP_PASSKEY_CHALLENGE_TTL_MINUTES),
      },
    };
  }

  async verifySensitiveActionChallenge(
    principal: DropshipSessionPrincipal,
    storedChallenge: DropshipStoredPasskeyAuthentication,
    input: VerifyDropshipSensitiveActionPasskeyInput,
  ): Promise<{
    action: DropshipSensitiveAction;
    method: "passkey";
    verifiedAt: Date;
    expiresAt: Date;
  }> {
    this.assertAuthenticationChallenge(storedChallenge, input.action);
    if (storedChallenge.memberId !== principal.memberId) {
      throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_MEMBER_MISMATCH", "Passkey challenge member mismatch.");
    }

    const credential = await this.requireCredentialForAuthentication(input.response.id, principal.memberId);
    const verification = await this.deps.webAuthn.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: this.deps.config.origin,
      expectedRpId: this.deps.config.rpId,
      credential,
    });
    if (!verification.verified) {
      throw new DropshipError(
        "DROPSHIP_PASSKEY_AUTHENTICATION_FAILED",
        "Passkey confirmation could not be verified.",
      );
    }

    const now = this.deps.clock.now();
    await this.deps.repository.updatePasskeyCredentialAfterAuthentication({
      credentialId: credential.credentialId,
      newSignCount: verification.newSignCount,
      backupState: verification.backupState,
      usedAt: now,
    });

    return {
      action: input.action,
      method: "passkey",
      verifiedAt: now,
      expiresAt: addMinutes(now, DROPSHIP_SENSITIVE_ACTION_PROOF_TTL_MINUTES),
    };
  }

  private async findLoginMemberId(email: string): Promise<string | null> {
    const member = await this.deps.identity.resolveMemberByCardShellzEmail(normalizeCardShellzEmail(email));
    if (!member) return null;

    const identity = await this.deps.repository.findAuthIdentityByMemberId(member.memberId);
    if (!identity || identity.status !== "active") return null;

    const entitlement = await this.deps.entitlement.getEntitlementByMemberId(member.memberId);
    if (!entitlement || !isLoginEntitled(entitlement.status)) return null;

    return member.memberId;
  }

  private async requireActiveAuthIdentity(memberId: string): Promise<DropshipAuthIdentityRecord> {
    const identity = await this.deps.repository.findAuthIdentityByMemberId(memberId);
    if (!identity || identity.status !== "active") {
      throw new DropshipError(
        "DROPSHIP_AUTH_IDENTITY_REQUIRED",
        "Active dropship auth identity is required.",
        { memberId },
      );
    }

    return identity;
  }

  private async requireLoginEntitlement(memberId: string): Promise<"active" | "grace"> {
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

  private async requireCredentialForAuthentication(
    credentialId: string,
    expectedMemberId: string | null,
  ): Promise<DropshipPasskeyCredentialRecord> {
    const credential = await this.deps.repository.findPasskeyCredentialByCredentialId(credentialId);
    if (!credential) {
      throw new DropshipError("DROPSHIP_PASSKEY_NOT_FOUND", "Passkey credential was not found.");
    }
    if (expectedMemberId && credential.memberId !== expectedMemberId) {
      throw new DropshipError("DROPSHIP_PASSKEY_MEMBER_MISMATCH", "Passkey does not belong to this member.");
    }
    return credential;
  }

  private assertRegistrationChallenge(
    principal: DropshipSessionPrincipal,
    challenge: DropshipStoredPasskeyRegistration,
  ): void {
    if (challenge.memberId !== principal.memberId) {
      throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_MEMBER_MISMATCH", "Passkey challenge member mismatch.");
    }
    if (challenge.expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_EXPIRED", "Passkey challenge expired.");
    }
  }

  private assertAuthenticationChallenge(
    challenge: DropshipStoredPasskeyAuthentication,
    expectedAction: DropshipSensitiveAction | null,
  ): void {
    if (challenge.action !== expectedAction) {
      throw new DropshipError(
        "DROPSHIP_PASSKEY_CHALLENGE_ACTION_MISMATCH",
        "Passkey challenge action mismatch.",
        { expectedAction, actualAction: challenge.action },
      );
    }
    if (challenge.expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_EXPIRED", "Passkey challenge expired.");
    }
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
}

function isLoginEntitled(status: string): status is "active" | "grace" {
  return status === "active" || status === "grace";
}

function assertPasskeyConfig(config: DropshipPasskeyConfig): void {
  if (!config.rpName.trim() || !config.rpId.trim() || !config.origin.trim()) {
    throw new DropshipError("DROPSHIP_PASSKEY_CONFIG_REQUIRED", "Passkey relying-party configuration is required.");
  }
}

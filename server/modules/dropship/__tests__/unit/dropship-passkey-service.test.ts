import { beforeEach, describe, expect, it } from "vitest";
import {
  DROPSHIP_PASSKEY_CHALLENGE_TTL_MINUTES,
  DropshipPasskeyService,
  type DropshipPasskeyCredentialRecord,
  type DropshipPasskeyRepository,
  type DropshipPasskeyServiceDependencies,
  type DropshipStoredPasskeyAuthentication,
  type DropshipStoredPasskeyRegistration,
  type DropshipWebAuthnProvider,
} from "../../application/dropship-passkey-service";
import type { DropshipAuthIdentityRecord } from "../../application/dropship-auth-service";
import type { DropshipEntitlementSnapshot } from "../../application/dropship-ports";
import type {
  CompleteDropshipPasskeyLoginInput,
  CompleteDropshipPasskeyRegistrationInput,
  VerifyDropshipSensitiveActionPasskeyInput,
} from "../../application/dropship-auth-dtos";
import type { DropshipSessionPrincipal } from "../../domain/auth";

const now = new Date("2026-04-30T12:00:00.000Z");

describe("DropshipPasskeyService", () => {
  let deps: FakePasskeyDeps;
  let service: DropshipPasskeyService;
  let principal: DropshipSessionPrincipal;

  beforeEach(() => {
    deps = new FakePasskeyDeps();
    service = new DropshipPasskeyService(deps.build());
    principal = {
      authIdentityId: 101,
      memberId: "member-1",
      cardShellzEmail: "vendor@cardshellz.test",
      hasPasskey: false,
      authMethod: "password",
      entitlementStatus: "active",
      authenticatedAt: now.toISOString(),
    };
  });

  it("starts passkey registration with an expiring challenge and excludes existing credentials", async () => {
    deps.credentials.push(fakeCredential({ credentialId: "existing-credential" }));

    const result = await service.startRegistration(principal);

    expect(result.options.challenge).toBe("registration-challenge");
    expect(result.challenge).toEqual({
      challenge: "registration-challenge",
      memberId: "member-1",
      expiresAt: new Date(now.getTime() + DROPSHIP_PASSKEY_CHALLENGE_TTL_MINUTES * 60 * 1000),
    });
    expect(deps.webAuthn.lastRegistrationExcludeCredentials).toEqual(["existing-credential"]);
  });

  it("completes registration, stores public-key credential material, and marks passkey enrolled", async () => {
    const started = await service.startRegistration(principal);

    const updatedPrincipal = await service.completeRegistration(
      principal,
      started.challenge,
      { response: fakeRegistrationResponse("new-credential") },
    );

    expect(deps.credentials[0]).toMatchObject({
      authIdentityId: 101,
      memberId: "member-1",
      credentialId: "new-credential",
      publicKey: "public-key-base64url",
      signCount: 7,
      transports: ["internal"],
    });
    expect(updatedPrincipal).toMatchObject({
      memberId: "member-1",
      authMethod: "password",
      hasPasskey: true,
    });
  });

  it("starts passkey login without revealing unknown Card Shellz emails", async () => {
    const result = await service.startLogin({ email: "missing@cardshellz.test" });

    expect(result.options.challenge).toBe("authentication-challenge");
    expect(result.challenge.memberId).toBeNull();
    expect(deps.webAuthn.lastAuthenticationAllowCredentials).toEqual([]);
  });

  it("completes passkey login and updates the credential counter", async () => {
    deps.credentials.push(fakeCredential({ credentialId: "login-credential", signCount: 2 }));
    const started = await service.startLogin({ email: "vendor@cardshellz.test" });

    const loggedIn = await service.completeLogin(started.challenge, {
      response: fakeAuthenticationResponse("login-credential"),
    });

    expect(loggedIn).toMatchObject({
      memberId: "member-1",
      authMethod: "passkey",
      hasPasskey: true,
    });
    expect(deps.credentials[0].signCount).toBe(12);
    expect(deps.lastUsedAt).toEqual(now);
  });

  it("uses passkey confirmation for sensitive actions when the principal has a passkey", async () => {
    const passkeyPrincipal: DropshipSessionPrincipal = {
      ...principal,
      hasPasskey: true,
      authMethod: "passkey",
    };
    deps.credentials.push(fakeCredential({ credentialId: "step-up-credential", signCount: 3 }));

    const started = await service.startSensitiveActionChallenge(passkeyPrincipal, {
      action: "add_funding_method",
    });
    const proof = await service.verifySensitiveActionChallenge(
      passkeyPrincipal,
      started.challenge,
      {
        action: "add_funding_method",
        response: fakeAuthenticationResponse("step-up-credential"),
      },
    );

    expect(started.options.challenge).toBe("authentication-challenge");
    expect(proof).toMatchObject({
      action: "add_funding_method",
      method: "passkey",
      verifiedAt: now,
    });
    expect(deps.credentials[0].signCount).toBe(12);
  });

  it("rejects expired registration challenges", async () => {
    const expired: DropshipStoredPasskeyRegistration = {
      challenge: "registration-challenge",
      memberId: "member-1",
      expiresAt: new Date(now.getTime() - 1),
    };

    await expect(service.completeRegistration(
      principal,
      expired,
      { response: fakeRegistrationResponse("new-credential") },
    )).rejects.toMatchObject({
      code: "DROPSHIP_PASSKEY_CHALLENGE_EXPIRED",
    });
  });

  it("rejects sensitive-action passkeys that belong to a different member", async () => {
    const passkeyPrincipal: DropshipSessionPrincipal = {
      ...principal,
      hasPasskey: true,
      authMethod: "passkey",
    };
    deps.credentials.push(fakeCredential({
      memberId: "member-2",
      credentialId: "other-member-credential",
    }));
    const challenge: DropshipStoredPasskeyAuthentication = {
      challenge: "authentication-challenge",
      memberId: "member-1",
      action: "add_funding_method",
      expiresAt: new Date(now.getTime() + 60_000),
    };

    await expect(service.verifySensitiveActionChallenge(
      passkeyPrincipal,
      challenge,
      {
        action: "add_funding_method",
        response: fakeAuthenticationResponse("other-member-credential"),
      },
    )).rejects.toMatchObject({
      code: "DROPSHIP_PASSKEY_MEMBER_MISMATCH",
    });
  });
});

class FakePasskeyDeps {
  readonly identity: DropshipAuthIdentityRecord = {
    authIdentityId: 101,
    memberId: "member-1",
    primaryEmail: "vendor@cardshellz.test",
    passwordHash: "hashed-password",
    passwordHashAlgorithm: "test",
    status: "active",
    passkeyEnrolledAt: null,
  };
  readonly entitlement: DropshipEntitlementSnapshot = {
    memberId: "member-1",
    cardShellzEmail: "vendor@cardshellz.test",
    planId: "ops-plan",
    planName: ".ops",
    subscriptionId: "sub-1",
    includesDropship: true,
    status: "active",
    reasonCode: "ENTITLED",
  };
  readonly credentials: DropshipPasskeyCredentialRecord[] = [];
  readonly webAuthn = new FakeWebAuthnProvider();
  lastUsedAt: Date | null = null;

  build(): DropshipPasskeyServiceDependencies {
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
      repository: new FakePasskeyRepository(this),
      webAuthn: this.webAuthn,
      clock: {
        now: () => now,
      },
      config: {
        rpName: "Card Shellz Dropship",
        rpId: "cardshellz.test",
        origin: "https://cardshellz.test",
      },
    };
  }
}

class FakePasskeyRepository implements DropshipPasskeyRepository {
  constructor(private readonly deps: FakePasskeyDeps) {}

  async findAuthIdentityByMemberId(memberId: string): Promise<DropshipAuthIdentityRecord | null> {
    if (memberId !== this.deps.identity.memberId) return null;
    return this.deps.identity;
  }

  async findPasskeyCredentialByCredentialId(credentialId: string): Promise<DropshipPasskeyCredentialRecord | null> {
    return this.deps.credentials.find((credential) => credential.credentialId === credentialId) ?? null;
  }

  async listPasskeyCredentialsByMemberId(memberId: string): Promise<DropshipPasskeyCredentialRecord[]> {
    return this.deps.credentials.filter((credential) => credential.memberId === memberId);
  }

  async createPasskeyCredential(input: {
    authIdentityId: number;
    memberId: string;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[];
    aaguid: string | null;
    backupEligible: boolean;
    backupState: boolean;
  }): Promise<DropshipPasskeyCredentialRecord> {
    const credential: DropshipPasskeyCredentialRecord = {
      id: this.deps.credentials.length + 1,
      backupEligible: input.backupEligible,
      backupState: input.backupState,
      ...input,
    };
    this.deps.credentials.push(credential);
    return credential;
  }

  async updatePasskeyCredentialAfterAuthentication(input: {
    credentialId: string;
    newSignCount: number;
    backupState: boolean;
    usedAt: Date;
  }): Promise<void> {
    const credential = this.deps.credentials.find((candidate) => candidate.credentialId === input.credentialId);
    if (credential) {
      credential.signCount = input.newSignCount;
      credential.backupState = input.backupState;
    }
    this.deps.lastUsedAt = input.usedAt;
  }

  async markPasskeyEnrolled(input: {
    authIdentityId: number;
    enrolledAt: Date;
  }): Promise<DropshipAuthIdentityRecord> {
    expect(input.authIdentityId).toBe(this.deps.identity.authIdentityId);
    this.deps.identity.passkeyEnrolledAt = input.enrolledAt;
    return this.deps.identity;
  }
}

class FakeWebAuthnProvider implements DropshipWebAuthnProvider {
  lastRegistrationExcludeCredentials: string[] = [];
  lastAuthenticationAllowCredentials: string[] = [];

  async generateRegistrationOptions(input: {
    excludeCredentials: DropshipPasskeyCredentialRecord[];
  }) {
    this.lastRegistrationExcludeCredentials = input.excludeCredentials.map((credential) => credential.credentialId);
    return {
      challenge: "registration-challenge",
      rp: { id: "cardshellz.test", name: "Card Shellz Dropship" },
    };
  }

  async verifyRegistrationResponse(input: {
    response: CompleteDropshipPasskeyRegistrationInput["response"];
    expectedChallenge: string;
  }) {
    return {
      verified: input.expectedChallenge === "registration-challenge",
      credentialId: input.response.id,
      publicKey: "public-key-base64url",
      signCount: 7,
      transports: ["internal"],
      aaguid: "aaguid-test",
      backupEligible: true,
      backupState: false,
    };
  }

  async generateAuthenticationOptions(input: {
    allowCredentials: DropshipPasskeyCredentialRecord[];
  }) {
    this.lastAuthenticationAllowCredentials = input.allowCredentials.map((credential) => credential.credentialId);
    return {
      challenge: "authentication-challenge",
      allowCredentials: input.allowCredentials.map((credential) => ({ id: credential.credentialId })),
    };
  }

  async verifyAuthenticationResponse(input: {
    response: VerifyDropshipSensitiveActionPasskeyInput["response"];
    expectedChallenge: string;
  }) {
    return {
      verified: input.expectedChallenge === "authentication-challenge",
      credentialId: input.response.id,
      newSignCount: 12,
      backupState: true,
    };
  }
}

function fakeCredential(overrides: Partial<DropshipPasskeyCredentialRecord> = {}): DropshipPasskeyCredentialRecord {
  return {
    id: 1,
    authIdentityId: 101,
    memberId: "member-1",
    credentialId: "credential-1",
    publicKey: "public-key-base64url",
    signCount: 1,
    transports: ["internal"],
    aaguid: "aaguid-test",
    backupEligible: true,
    backupState: false,
    ...overrides,
  };
}

function fakeRegistrationResponse(credentialId: string): CompleteDropshipPasskeyRegistrationInput["response"] {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "client-data",
      attestationObject: "attestation-object",
      transports: ["internal"],
    },
  };
}

function fakeAuthenticationResponse(credentialId: string): CompleteDropshipPasskeyLoginInput["response"] {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
    },
  };
}

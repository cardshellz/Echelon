import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  CompleteDropshipPasskeyLoginInput,
  CompleteDropshipPasskeyRegistrationInput,
} from "../application/dropship-auth-dtos";
import type {
  DropshipPasskeyCredentialRecord,
  DropshipPasskeyOptions,
  DropshipVerifiedPasskeyAuthentication,
  DropshipVerifiedPasskeyRegistration,
  DropshipWebAuthnProvider,
} from "../application/dropship-passkey-service";

type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]["response"];
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]["response"];
type WebAuthnCredential = Parameters<typeof verifyAuthenticationResponse>[0]["credential"];
type AuthenticatorTransport = NonNullable<
  Parameters<typeof generateAuthenticationOptions>[0]["allowCredentials"]
>[number]["transports"] extends Array<infer T> | undefined ? T : never;

export class SimpleWebAuthnPasskeyProvider implements DropshipWebAuthnProvider {
  async generateRegistrationOptions(input: {
    rpName: string;
    rpId: string;
    userId: string;
    userName: string;
    userDisplayName: string;
    excludeCredentials: DropshipPasskeyCredentialRecord[];
  }): Promise<DropshipPasskeyOptions> {
    const options = await generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userID: Buffer.from(input.userId, "utf8"),
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      excludeCredentials: input.excludeCredentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransport[],
      })),
    });

    return options as unknown as DropshipPasskeyOptions;
  }

  async verifyRegistrationResponse(input: {
    response: CompleteDropshipPasskeyRegistrationInput["response"];
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<DropshipVerifiedPasskeyRegistration> {
    const verification = await verifyRegistrationResponse({
      response: input.response as RegistrationResponse,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return {
        verified: false,
        credentialId: "",
        publicKey: "",
        signCount: 0,
        transports: [],
        aaguid: null,
        backupEligible: false,
        backupState: false,
      };
    }

    return {
      verified: true,
      credentialId: verification.registrationInfo.credential.id,
      publicKey: bufferToBase64Url(verification.registrationInfo.credential.publicKey),
      signCount: verification.registrationInfo.credential.counter,
      transports: input.response.response.transports ?? [],
      aaguid: verification.registrationInfo.aaguid,
      backupEligible: verification.registrationInfo.credentialDeviceType === "multiDevice",
      backupState: verification.registrationInfo.credentialBackedUp,
    };
  }

  async generateAuthenticationOptions(input: {
    rpId: string;
    allowCredentials: DropshipPasskeyCredentialRecord[];
  }): Promise<DropshipPasskeyOptions> {
    const options = await generateAuthenticationOptions({
      rpID: input.rpId,
      allowCredentials: input.allowCredentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports as AuthenticatorTransport[],
      })),
      userVerification: "required",
    });

    return options as unknown as DropshipPasskeyOptions;
  }

  async verifyAuthenticationResponse(input: {
    response: CompleteDropshipPasskeyLoginInput["response"];
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: DropshipPasskeyCredentialRecord;
  }): Promise<DropshipVerifiedPasskeyAuthentication> {
    const verification = await verifyAuthenticationResponse({
      response: input.response as AuthenticationResponse,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
      credential: {
        id: input.credential.credentialId,
        publicKey: base64UrlToBuffer(input.credential.publicKey),
        counter: input.credential.signCount,
        transports: input.credential.transports as WebAuthnCredential["transports"],
      },
    });

    return {
      verified: verification.verified,
      credentialId: verification.authenticationInfo.credentialID,
      newSignCount: verification.authenticationInfo.newCounter,
      backupState: verification.authenticationInfo.credentialBackedUp,
    };
  }
}

function bufferToBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlToBuffer(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

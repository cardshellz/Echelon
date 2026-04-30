import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { randomInt } from "crypto";
import type { z } from "zod";
import { ShellzClubEntitlementAdapter } from "../../infrastructure/shellz-club-entitlement.adapter";
import { PgDropshipAuthIdentityRepository } from "../../infrastructure/dropship-auth.repository";
import { BcryptDropshipPasswordHasher } from "../../infrastructure/dropship-password-hasher";
import { SmtpDropshipAuthEmailSender } from "../../infrastructure/dropship-auth-email.sender";
import { SimpleWebAuthnPasskeyProvider } from "../../infrastructure/simple-webauthn-passkey.provider";
import { DropshipAuthService, type DropshipAuthCodeGenerator } from "../../application/dropship-auth-service";
import {
  DropshipPasskeyService,
  type DropshipStoredPasskeyAuthentication,
  type DropshipStoredPasskeyRegistration,
} from "../../application/dropship-passkey-service";
import {
  completeDropshipPasskeyLoginInputSchema,
  completeDropshipPasskeyRegistrationInputSchema,
  completeDropshipAccountBootstrapInputSchema,
  dropshipPasswordLoginInputSchema,
  startDropshipPasskeyLoginInputSchema,
  startDropshipAccountBootstrapInputSchema,
  startDropshipSensitiveActionChallengeInputSchema,
  startDropshipSensitiveActionPasskeyInputSchema,
  verifyDropshipSensitiveActionChallengeInputSchema,
  verifyDropshipSensitiveActionPasskeyInputSchema,
} from "../../application/dropship-auth-dtos";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "../../application/dropship-ports";
import { DropshipError } from "../../domain/errors";
import type { DropshipSensitiveAction, DropshipSessionPrincipal } from "../../domain/auth";

declare module "express-session" {
  interface SessionData {
    dropship?: DropshipSessionPrincipal;
    dropshipSensitiveProofs?: Partial<Record<DropshipSensitiveAction, DropshipSensitiveProof>>;
    dropshipPasskeyRegistration?: SerializedPasskeyRegistrationChallenge;
    dropshipPasskeyLogin?: SerializedPasskeyAuthenticationChallenge;
    dropshipPasskeySensitiveAction?: SerializedPasskeyAuthenticationChallenge;
  }
}

export interface DropshipSensitiveProof {
  method: "email_mfa" | "passkey";
  verifiedAt: string;
  expiresAt: string;
}

interface SerializedPasskeyRegistrationChallenge {
  challenge: string;
  memberId: string;
  expiresAt: string;
}

interface SerializedPasskeyAuthenticationChallenge {
  challenge: string;
  memberId: string | null;
  action: DropshipSensitiveAction | null;
  expiresAt: string;
}

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: { code: "DROPSHIP_AUTH_RATE_LIMITED", message: "Too many dropship auth requests." } },
  standardHeaders: true,
  legacyHeaders: false,
});

const sensitiveActionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: { code: "DROPSHIP_AUTH_RATE_LIMITED", message: "Too many dropship step-up requests." } },
  standardHeaders: true,
  legacyHeaders: false,
});

export function registerDropshipAuthRoutes(
  app: Express,
  service: DropshipAuthService = createDropshipAuthServiceFromEnv(),
  passkeyService: DropshipPasskeyService = createDropshipPasskeyServiceFromEnv(),
): void {
  app.post("/api/dropship/auth/bootstrap/start", authRateLimiter, async (req, res) => {
    try {
      const input = parseBody(startDropshipAccountBootstrapInputSchema, req.body);
      await service.startAccountBootstrap(input);
      return res.status(202).json({ accepted: true });
    } catch (error) {
      return sendDropshipAuthError(res, error);
    }
  });

  app.post("/api/dropship/auth/bootstrap/complete", authRateLimiter, async (req, res) => {
    try {
      const input = parseBody(completeDropshipAccountBootstrapInputSchema, req.body);
      const principal = await service.completeAccountBootstrap(input);
      req.session.dropship = principal;
      req.session.dropshipSensitiveProofs = {};
      await saveSession(req);
      return res.status(201).json({ principal });
    } catch (error) {
      return sendDropshipAuthError(res, error);
    }
  });

  app.post("/api/dropship/auth/login/password", authRateLimiter, async (req, res) => {
    try {
      const input = parseBody(dropshipPasswordLoginInputSchema, req.body);
      const principal = await service.loginWithPassword(input);
      req.session.dropship = principal;
      req.session.dropshipSensitiveProofs = {};
      await saveSession(req);
      return res.json({
        principal,
        sensitiveActionStepUp: principal.hasPasskey ? "passkey" : "email_mfa",
      });
    } catch (error) {
      return sendDropshipAuthError(res, error);
    }
  });

  app.post("/api/dropship/auth/login/passkey/start", authRateLimiter, async (req, res) => {
    try {
      const input = parseBody(startDropshipPasskeyLoginInputSchema, req.body);
      const result = await passkeyService.startLogin(input);
      req.session.dropshipPasskeyLogin = serializeAuthenticationChallenge(result.challenge);
      await saveSession(req);
      return res.status(202).json({ options: result.options });
    } catch (error) {
      return sendDropshipAuthError(res, error);
    }
  });

  app.post("/api/dropship/auth/login/passkey/complete", authRateLimiter, async (req, res) => {
    try {
      const input = parseBody(completeDropshipPasskeyLoginInputSchema, req.body);
      const challenge = deserializeAuthenticationChallenge(req.session.dropshipPasskeyLogin);
      if (!challenge) {
        throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_REQUIRED", "Passkey login challenge is required.");
      }
      const principal = await passkeyService.completeLogin(challenge, input);
      req.session.dropship = principal;
      req.session.dropshipSensitiveProofs = {};
      delete req.session.dropshipPasskeyLogin;
      await saveSession(req);
      return res.json({
        principal,
        sensitiveActionStepUp: "passkey",
      });
    } catch (error) {
      return sendDropshipAuthError(res, error);
    }
  });

  app.post("/api/dropship/auth/logout", (req, res) => {
    delete req.session.dropship;
    delete req.session.dropshipSensitiveProofs;
    delete req.session.dropshipPasskeyRegistration;
    delete req.session.dropshipPasskeyLogin;
    delete req.session.dropshipPasskeySensitiveAction;
    req.session.save((error) => {
      if (error) {
        return res.status(500).json({
          error: {
            code: "DROPSHIP_SESSION_SAVE_FAILED",
            message: "Dropship session failed to save.",
          },
        });
      }
      return res.json({ success: true });
    });
  });

  app.get("/api/dropship/auth/me", requireDropshipAuth, (req, res) => {
    return res.json({
      principal: req.session.dropship,
      sensitiveProofs: req.session.dropshipSensitiveProofs ?? {},
    });
  });

  app.post(
    "/api/dropship/auth/passkeys/register/start",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("register_passkey"),
    authRateLimiter,
    async (req, res) => {
      try {
        const result = await passkeyService.startRegistration(req.session.dropship!);
        req.session.dropshipPasskeyRegistration = serializeRegistrationChallenge(result.challenge);
        await saveSession(req);
        return res.status(202).json({ options: result.options });
      } catch (error) {
        return sendDropshipAuthError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/auth/passkeys/register/complete",
    requireDropshipAuth,
    authRateLimiter,
    async (req, res) => {
      try {
        const input = parseBody(completeDropshipPasskeyRegistrationInputSchema, req.body);
        const challenge = deserializeRegistrationChallenge(req.session.dropshipPasskeyRegistration);
        if (!challenge) {
          throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_REQUIRED", "Passkey registration challenge is required.");
        }
        const principal = await passkeyService.completeRegistration(req.session.dropship!, challenge, input);
        req.session.dropship = principal;
        delete req.session.dropshipPasskeyRegistration;
        await saveSession(req);
        return res.status(201).json({ principal });
      } catch (error) {
        return sendDropshipAuthError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/auth/sensitive-actions/challenge/start",
    requireDropshipAuth,
    sensitiveActionRateLimiter,
    async (req, res) => {
      try {
        const input = parseBody(startDropshipSensitiveActionChallengeInputSchema, req.body);
        const result = await service.startSensitiveActionChallenge(req.session.dropship!, input);
        if (result.method === "passkey") {
          return res.status(202).json({ method: "passkey", passkeyRequired: true });
        }
        return res.status(202).json({
          method: result.method,
          challengeId: result.challengeId,
          expiresAt: result.expiresAt?.toISOString(),
        });
      } catch (error) {
        return sendDropshipAuthError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/auth/sensitive-actions/challenge/verify",
    requireDropshipAuth,
    sensitiveActionRateLimiter,
    async (req, res) => {
      try {
        const input = parseBody(verifyDropshipSensitiveActionChallengeInputSchema, req.body);
        const proof = await service.verifySensitiveActionChallenge(req.session.dropship!, input);
        req.session.dropshipSensitiveProofs = {
          ...(req.session.dropshipSensitiveProofs ?? {}),
          [proof.action]: {
            method: proof.method,
            verifiedAt: proof.verifiedAt.toISOString(),
            expiresAt: proof.expiresAt.toISOString(),
          },
        };
        await saveSession(req);
        return res.json({
          action: proof.action,
          method: proof.method,
          verifiedAt: proof.verifiedAt.toISOString(),
          expiresAt: proof.expiresAt.toISOString(),
        });
      } catch (error) {
        return sendDropshipAuthError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/auth/sensitive-actions/passkey/start",
    requireDropshipAuth,
    sensitiveActionRateLimiter,
    async (req, res) => {
      try {
        const input = parseBody(startDropshipSensitiveActionPasskeyInputSchema, req.body);
        const result = await passkeyService.startSensitiveActionChallenge(req.session.dropship!, input);
        req.session.dropshipPasskeySensitiveAction = serializeAuthenticationChallenge(result.challenge);
        await saveSession(req);
        return res.status(202).json({
          method: "passkey",
          options: result.options,
        });
      } catch (error) {
        return sendDropshipAuthError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/auth/sensitive-actions/passkey/verify",
    requireDropshipAuth,
    sensitiveActionRateLimiter,
    async (req, res) => {
      try {
        const input = parseBody(verifyDropshipSensitiveActionPasskeyInputSchema, req.body);
        const challenge = deserializeAuthenticationChallenge(req.session.dropshipPasskeySensitiveAction);
        if (!challenge) {
          throw new DropshipError("DROPSHIP_PASSKEY_CHALLENGE_REQUIRED", "Passkey sensitive-action challenge is required.");
        }
        const proof = await passkeyService.verifySensitiveActionChallenge(req.session.dropship!, challenge, input);
        req.session.dropshipSensitiveProofs = {
          ...(req.session.dropshipSensitiveProofs ?? {}),
          [proof.action]: {
            method: proof.method,
            verifiedAt: proof.verifiedAt.toISOString(),
            expiresAt: proof.expiresAt.toISOString(),
          },
        };
        delete req.session.dropshipPasskeySensitiveAction;
        await saveSession(req);
        return res.json({
          action: proof.action,
          method: proof.method,
          verifiedAt: proof.verifiedAt.toISOString(),
          expiresAt: proof.expiresAt.toISOString(),
        });
      } catch (error) {
        return sendDropshipAuthError(res, error);
      }
    },
  );
}

export function requireDropshipAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.dropship) {
    res.status(401).json({
      error: {
        code: "DROPSHIP_AUTH_REQUIRED",
        message: "Dropship authentication is required.",
      },
    });
    return;
  }
  next();
}

export function requireDropshipSensitiveActionProof(
  action: DropshipSensitiveAction,
  clock: DropshipClock = new SystemClock(),
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const proof = req.session.dropshipSensitiveProofs?.[action];
    if (!proof || new Date(proof.expiresAt).getTime() <= clock.now().getTime()) {
      res.status(403).json({
        error: {
          code: "DROPSHIP_STEP_UP_REQUIRED",
          message: "Recent dropship sensitive-action verification is required.",
          context: { action },
        },
      });
      return;
    }
    next();
  };
}

export function createDropshipAuthServiceFromEnv(): DropshipAuthService {
  const entitlementAdapter = new ShellzClubEntitlementAdapter();
  return new DropshipAuthService({
    identity: entitlementAdapter,
    entitlement: entitlementAdapter,
    authIdentities: new PgDropshipAuthIdentityRepository(),
    passwordHasher: new BcryptDropshipPasswordHasher(),
    emailSender: new SmtpDropshipAuthEmailSender(),
    codeGenerator: new CryptoSixDigitCodeGenerator(),
    clock: new SystemClock(),
    logger: new ConsoleDropshipLogger(),
    challengeSecret: process.env.DROPSHIP_AUTH_CHALLENGE_SECRET ?? process.env.SESSION_SECRET ?? "",
  });
}

export function createDropshipPasskeyServiceFromEnv(): DropshipPasskeyService {
  const entitlementAdapter = new ShellzClubEntitlementAdapter();
  const repository = new PgDropshipAuthIdentityRepository();
  return new DropshipPasskeyService({
    identity: entitlementAdapter,
    entitlement: entitlementAdapter,
    repository,
    webAuthn: new SimpleWebAuthnPasskeyProvider(),
    clock: new SystemClock(),
    config: {
      rpName: process.env.DROPSHIP_WEBAUTHN_RP_NAME || "Card Shellz Dropship",
      rpId: process.env.DROPSHIP_WEBAUTHN_RP_ID || "cardshellz.io",
      origin: process.env.DROPSHIP_WEBAUTHN_ORIGIN || "https://cardshellz.io",
    },
  });
}

function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_INVALID_AUTH_REQUEST",
      "Dropship auth request failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function sendDropshipAuthError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: publicErrorContext(error.context),
      },
    });
  }

  console.error("[DropshipAuth] Unhandled auth error", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_AUTH_INTERNAL_ERROR",
      message: "Dropship auth request failed.",
    },
  });
}

function statusForDropshipError(code: string): number {
  switch (code) {
    case "DROPSHIP_INVALID_AUTH_REQUEST":
    case "INVALID_CARD_SHELLZ_EMAIL":
    case "DROPSHIP_PASSWORD_POLICY_FAILED":
    case "DROPSHIP_PASSKEY_CHALLENGE_REQUIRED":
    case "DROPSHIP_PASSKEY_CHALLENGE_ACTION_MISMATCH":
      return 400;
    case "DROPSHIP_INVALID_LOGIN":
    case "DROPSHIP_INVALID_EMAIL_CHALLENGE":
    case "DROPSHIP_MEMBER_NOT_FOUND":
    case "DROPSHIP_PASSKEY_AUTHENTICATION_FAILED":
    case "DROPSHIP_PASSKEY_NOT_FOUND":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_PASSKEY_STEP_UP_REQUIRED":
    case "DROPSHIP_EMAIL_MFA_STEP_UP_REQUIRED":
    case "DROPSHIP_PASSKEY_REQUIRED":
    case "DROPSHIP_PASSKEY_CHALLENGE_MEMBER_MISMATCH":
    case "DROPSHIP_PASSKEY_MEMBER_MISMATCH":
    case "DROPSHIP_AUTH_IDENTITY_REQUIRED":
      return 403;
    case "DROPSHIP_PASSKEY_ALREADY_REGISTERED":
      return 409;
    case "DROPSHIP_PASSKEY_CHALLENGE_EXPIRED":
      return 410;
    case "DROPSHIP_AUTH_EMAIL_DELIVERY_FAILED":
      return 503;
    default:
      return 500;
  }
}

function serializeRegistrationChallenge(
  challenge: DropshipStoredPasskeyRegistration,
): SerializedPasskeyRegistrationChallenge {
  return {
    challenge: challenge.challenge,
    memberId: challenge.memberId,
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

function deserializeRegistrationChallenge(
  challenge: SerializedPasskeyRegistrationChallenge | undefined,
): DropshipStoredPasskeyRegistration | null {
  if (!challenge) return null;
  return {
    challenge: challenge.challenge,
    memberId: challenge.memberId,
    expiresAt: new Date(challenge.expiresAt),
  };
}

function serializeAuthenticationChallenge(
  challenge: DropshipStoredPasskeyAuthentication,
): SerializedPasskeyAuthenticationChallenge {
  return {
    challenge: challenge.challenge,
    memberId: challenge.memberId,
    action: challenge.action,
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

function deserializeAuthenticationChallenge(
  challenge: SerializedPasskeyAuthenticationChallenge | undefined,
): DropshipStoredPasskeyAuthentication | null {
  if (!challenge) return null;
  return {
    challenge: challenge.challenge,
    memberId: challenge.memberId,
    action: challenge.action,
    expiresAt: new Date(challenge.expiresAt),
  };
}

function publicErrorContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const redacted = { ...context };
  delete redacted.password;
  delete redacted.passwordHash;
  delete redacted.challengeHash;
  delete redacted.verificationCode;
  return redacted;
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class SystemClock implements DropshipClock {
  now(): Date {
    return new Date();
  }
}

class CryptoSixDigitCodeGenerator implements DropshipAuthCodeGenerator {
  generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }
}

class ConsoleDropshipLogger implements DropshipLogger {
  info(event: DropshipLogEvent): void {
    console.info(JSON.stringify({ level: "info", ...event }));
  }

  warn(event: DropshipLogEvent): void {
    console.warn(JSON.stringify({ level: "warn", ...event }));
  }

  error(event: DropshipLogEvent): void {
    console.error(JSON.stringify({ level: "error", ...event }));
  }
}

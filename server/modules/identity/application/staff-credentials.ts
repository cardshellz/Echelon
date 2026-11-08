import { logger } from "../../../platform/observability/logger";
import bcrypt from "bcrypt";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import {
  breakGlassStaffPasswordRecoverySchema,
  changeStaffPasswordSchema,
  credentialVersionSchema,
  forgotStaffPasswordRequestSchema,
  resetStaffPasswordSchema,
  resetStaffPasswordWithTokenSchema,
  staffCredentialReviewSchema,
  STAFF_PASSWORD_RESET_TTL_MS,
  STAFF_RESET_PERMISSION,
  STAFF_PRIVILEGED_RESET_PERMISSION,
} from "@shared/staff-credentials";
import { IdentityAdministrationError, parseAdministrationActor, parseAdministrationInput, type IdentityAdministrationActor } from "../domain/access-administration";
import { runIdentityAdministration } from "../infrastructure/access-administration.repository";
import { readStaffCredentialState, isProtectedStaffTarget } from "../infrastructure/staff-credentials.repository";
import { readAccessConfiguration } from "../infrastructure/access-configuration.repository";
import { getUser, getUserByUsername, updateUser, updateUserLastLogin } from "../infrastructure/identity.repository";
import { readCommandAuthorityActor } from "../infrastructure/command-authority.repository";
import { persistAuditEvent } from "../../../infrastructure/transactional-audit";
import { notifyStaffAuthorityChanged } from "../authority-events";
import { sendEmail } from "../../notifications/email.service";
import type { User } from "@shared/schema";

function forbidden(): never { throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_FORBIDDEN",403,"Current credential authority is required."); }
function stale(): never { throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE",409,"Credentials changed. Sign in or review current state again."); }
const targetIdSchema=z.string().min(1).refine(value=>value.trim().length>0);
const emailValueSchema=z.string().trim().email();

function recoverySecret(): string {
  const secret = process.env.STAFF_RECOVERY_TOKEN_SECRET?.trim() || process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new IdentityAdministrationError(
      "IDENTITY_CREDENTIAL_RECOVERY_UNAVAILABLE",
      503,
      "Password recovery is not configured.",
    );
  }
  return secret;
}

const recoveryTokenPayloadSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1),
  credentialVersion: credentialVersionSchema,
  operationId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
}).strict();

type RecoveryTokenPayload = z.infer<typeof recoveryTokenPayloadSchema>;

function computeOuterRecoveryMac(secret: string, encodedPayload: string): Buffer {
  return createHmac("sha256", secret)
    .update(`echelon.identity.password_reset.outer.v1:${encodedPayload}`)
    .digest();
}

function computeStateRecoveryMac(
  secret: string,
  encodedPayload: string,
  credentialVersion: string,
  passwordHash: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(`echelon.identity.password_reset.state.v1:${encodedPayload}:${credentialVersion}:${passwordHash}`)
    .digest();
}

function safeEqualBase64Url(actualBase64Url: string, expected: Buffer): boolean {
  try {
    const actual = Buffer.from(actualBase64Url, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createStaffPasswordRecoveryToken(params: {
  userId: string;
  credentialVersion: string;
  passwordHash: string;
  operationId?: string;
  nowMs?: number;
  ttlMs?: number;
}): { token: string; operationId: string; expiresAt: number } {
  const secret = recoverySecret();
  const operationId = params.operationId ?? randomUUID();
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = params.ttlMs ?? STAFF_PASSWORD_RESET_TTL_MS;
  const payload: RecoveryTokenPayload = {
    v: 1,
    userId: params.userId,
    credentialVersion: params.credentialVersion,
    operationId,
    expiresAt: nowMs + ttlMs,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const outerSig = computeOuterRecoveryMac(secret, encodedPayload).toString("base64url");
  const stateSig = computeStateRecoveryMac(
    secret,
    encodedPayload,
    params.credentialVersion,
    params.passwordHash,
  ).toString("base64url");
  return {
    token: `${encodedPayload}.${outerSig}.${stateSig}`,
    operationId,
    expiresAt: payload.expiresAt,
  };
}

function parseAndVerifyOuterRecoveryToken(
  rawToken: string,
  nowMs = Date.now(),
): { encodedPayload: string; stateSig: string; payload: RecoveryTokenPayload } {
  const secret = recoverySecret();
  const parts = rawToken.trim().split(".");
  if (parts.length !== 3) {
    throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has expired.");
  }
  const [encodedPayload, outerSig, stateSig] = parts;
  if (!encodedPayload || !outerSig || !stateSig) {
    throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has expired.");
  }
  if (!safeEqualBase64Url(outerSig, computeOuterRecoveryMac(secret, encodedPayload))) {
    throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has expired.");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has expired.");
  }
  const parsed = recoveryTokenPayloadSchema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.expiresAt <= nowMs) {
    throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has expired.");
  }
  return { encodedPayload, stateSig, payload: parsed.data };
}

function configuredRecoveryEmailMap(): Map<string, string> {
  const map = new Map<string, string>();
  const rawJson = process.env.STAFF_RECOVERY_EMAILS_JSON?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            const email = emailValueSchema.safeParse(value);
            if (email.success && key.trim().length > 0) {
              map.set(key.trim().toLowerCase(), email.data.toLowerCase());
            }
          }
        }
      }
    } catch {
      // Ignore malformed env JSON and fail closed for unmapped accounts.
    }
  }
  const adminEmail = process.env.STAFF_ADMIN_RECOVERY_EMAIL?.trim();
  if (adminEmail) {
    const parsedEmail = emailValueSchema.safeParse(adminEmail);
    if (parsedEmail.success) {
      const adminUsername = (process.env.STAFF_ADMIN_RECOVERY_USERNAME?.trim() || "admin").toLowerCase();
      if (!map.has(adminUsername)) {
        map.set(adminUsername, parsedEmail.data.toLowerCase());
      }
    }
  }
  return map;
}

export function resolveStaffRecoveryEmail(user: Pick<User, "id" | "username">): string | null {
  const map = configuredRecoveryEmailMap();
  const byId = map.get(user.id.trim().toLowerCase());
  if (byId) return byId;
  const byUsername = map.get(user.username.trim().toLowerCase());
  if (byUsername) return byUsername;
  const directEmail = emailValueSchema.safeParse(user.username.trim());
  return directEmail.success ? directEmail.data.toLowerCase() : null;
}

/** Never attach a newly read generation to a password verified before a reset.
 * Recheck the exact verified hash under account/state locks before login wins. */
export async function authenticateStaffSession(username: unknown, password: unknown) {
  const input=z.object({ username:z.string().min(1), password:z.string().min(1) }).safeParse({username,password});
  if(!input.success) forbidden();
  const candidate=await getUserByUsername(input.data.username);
  if(!candidate?.active || !await bcrypt.compare(input.data.password,candidate.password)) forbidden();
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM identity.users WHERE id=${candidate.id} FOR UPDATE`);
    const current=await getUser(candidate.id,tx);
    if(!current?.active || current.password!==candidate.password) forbidden();
    const state=await readStaffCredentialState(candidate.id,tx);
    if(!state) forbidden();
    await updateUserLastLogin(candidate.id,tx);
    const {password:_secret,...user}=current;
    return {user,credentialVersion:state.credentialVersion,mustChangePassword:state.mustChangePassword};
  });
}

export async function reviewStaffCredentialReset(target: unknown, rawActor: IdentityAdministrationActor) {
  const id=targetIdSchema.parse(target),actor=parseAdministrationActor(rawActor);
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('echelon.identity.access_administration.v1',0))`);
    const authority=await readCommandAuthorityActor(tx,actor.actorId);
    const actorState=await readStaffCredentialState(actor.actorId,tx);
    if(!actor.credentialVersion || actorState?.credentialVersion!==actor.credentialVersion || actorState.mustChangePassword) forbidden();
    if(!authority.active || !authority.permissions.includes(STAFF_RESET_PERMISSION) || id===actor.actorId) forbidden();
    const protectedTarget=await isProtectedStaffTarget(id,tx);
    const requiredPermission=protectedTarget?STAFF_PRIVILEGED_RESET_PERMISSION:STAFF_RESET_PERMISSION;
    if(!authority.permissions.includes(requiredPermission)) forbidden();
    const state=await readStaffCredentialState(id,tx);
    if(!state) throw new IdentityAdministrationError("IDENTITY_USER_NOT_FOUND",404,"Account credentials are not available.");
    return staffCredentialReviewSchema.parse({userId:id,credentialVersion:state.credentialVersion,protectedTarget,
      requiredPermission,expectedAccessRevision:(await readAccessConfiguration(tx)).revision,lastOperationId:state.lastOperationId});
  });
}

async function resetStaffPasswordImplementation(target: unknown, raw: unknown, rawActor: IdentityAdministrationActor) {
  const id=targetIdSchema.parse(target),input=parseAdministrationInput(resetStaffPasswordSchema,raw);
  const actor=parseAdministrationActor({...rawActor,expectedAccessRevision:input.expectedAccessRevision,operationId:input.operationId});
  if(!actor.credentialVersion || id===actor.actorId) forbidden();
  const password=await bcrypt.hash(input.password,10);
  await db.transaction(tx=>runIdentityAdministration(tx,actor,STAFF_RESET_PERMISSION,"credential_reset",async()=>{
    const actorState=await readStaffCredentialState(actor.actorId,tx);
    const actorUser=await getUser(actor.actorId,tx);
    if(!actorState || actorState.mustChangePassword || !actorUser || !await bcrypt.compare(input.currentPassword,actorUser.password)) forbidden();
    const protectedTarget=await isProtectedStaffTarget(id,tx);
    const authority=await readCommandAuthorityActor(tx,actor.actorId);
    if(protectedTarget && !authority.permissions.includes(STAFF_PRIVILEGED_RESET_PERMISSION)) forbidden();
    await tx.execute(sql`SELECT id FROM identity.users WHERE id=${id} FOR UPDATE`);
    const state=await readStaffCredentialState(id,tx,true);
    if(!state || state.credentialVersion!==input.expectedCredentialVersion) stale();
    const version=randomUUID();
    await updateUser(id,{password},tx);
    await tx.execute(sql`UPDATE identity.staff_credentials SET credential_version=${version}::uuid,
      must_change_password=true,last_operation_id=${input.operationId}::uuid WHERE user_id=${id}`);
    return {result:undefined,target:`user:${id}`,before:{credentialVersion:state.credentialVersion},
      after:{credentialVersion:version,passwordChanged:true,mustChangePassword:true,protectedTarget,reason:input.reason}};
  }));
  await notifyStaffAuthorityChanged([id]);
}

/** Lifecycle-only: an active zero-role account can replace its own credential.
 * An administrator reset cannot use this route without the target's credential. */
async function changeOwnStaffPasswordImplementation(raw: unknown, rawActor: IdentityAdministrationActor) {
  const input=parseAdministrationInput(changeStaffPasswordSchema,raw),actor=parseAdministrationActor(rawActor);
  if(!actor.credentialVersion) forbidden();
  const password=await bcrypt.hash(input.password,10);
  await db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('echelon.identity.access_administration.v1',0))`);
    await tx.execute(sql`SELECT id FROM identity.users WHERE id=${actor.actorId} FOR UPDATE`);
    const user=await getUser(actor.actorId,tx),state=await readStaffCredentialState(actor.actorId,tx,true);
    if(!user?.active || !state || state.credentialVersion!==actor.credentialVersion) stale();
    if(!await bcrypt.compare(input.currentPassword,user.password)) forbidden();
    if(await bcrypt.compare(input.password,user.password)) throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID",400,"Choose a different password.");
    const version=randomUUID();
    await updateUser(actor.actorId,{password},tx);
    await tx.execute(sql`UPDATE identity.staff_credentials SET credential_version=${version}::uuid,must_change_password=false,
      last_operation_id=${input.operationId}::uuid WHERE user_id=${actor.actorId}`);
    await persistAuditEvent(tx,{actor:actor.actorId,action:"identity.access.credential_changed",target:`user:${actor.actorId}`,
      changes:{before:{credentialVersion:state.credentialVersion},after:{credentialVersion:version,passwordChanged:true,mustChangePassword:false}},
      context:{operationId:input.operationId,attemptId:actor.attemptId,reason:"self_credential_change"}},{emitStructuredLog:false});
  });
  await notifyStaffAuthorityChanged([actor.actorId]);
}

export async function recoverStaffPasswordBreakGlass(raw: unknown): Promise<{
  userId: string;
  username: string;
  credentialVersion: string;
  mustChangePassword: true;
  protectedTarget: boolean;
  operationId: string;
}> {
  const input = parseAdministrationInput(breakGlassStaffPasswordRecoverySchema, raw);
  const actor: IdentityAdministrationActor = {
    actorId: `break_glass:${input.operator}`,
    operationId: input.operationId,
    attemptId: randomUUID(),
  };
  return observedCredentialCommand("identity.access.credential_break_glass_recovery", actor, async () => {
    const password = await bcrypt.hash(input.password, 10);
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('echelon.identity.access_administration.v1',0))`);
      const initial = input.userId
        ? await getUser(input.userId, tx)
        : await getUserByUsername(input.username!, tx);
      if (!initial) {
        throw new IdentityAdministrationError("IDENTITY_USER_NOT_FOUND", 404, "Active staff account not found.");
      }
      await tx.execute(sql`SELECT id FROM identity.users WHERE id=${initial.id} FOR UPDATE`);
      const user = await getUser(initial.id, tx);
      if (!user?.active) {
        throw new IdentityAdministrationError("IDENTITY_USER_NOT_FOUND", 404, "Active staff account not found.");
      }
      const state = await readStaffCredentialState(user.id, tx, true);
      if (!state) {
        throw new IdentityAdministrationError("IDENTITY_USER_NOT_FOUND", 404, "Account credentials are not available.");
      }
      if (await bcrypt.compare(input.password, user.password)) {
        throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "Choose a different temporary password.");
      }
      const protectedTarget = await isProtectedStaffTarget(user.id, tx);
      const version = randomUUID();
      await updateUser(user.id, { password }, tx);
      await tx.execute(sql`UPDATE identity.staff_credentials SET credential_version=${version}::uuid,
        must_change_password=true,last_operation_id=${input.operationId}::uuid WHERE user_id=${user.id}`);
      await persistAuditEvent(tx, {
        actor: `break_glass:${input.operator}`,
        action: "identity.access.credential_break_glass_recovery",
        target: `user:${user.id}`,
        changes: {
          before: { credentialVersion: state.credentialVersion, mustChangePassword: state.mustChangePassword },
          after: {
            credentialVersion: version,
            passwordChanged: true,
            mustChangePassword: true,
            protectedTarget,
            reason: input.reason,
          },
        },
        context: {
          operationId: input.operationId,
          attemptId: actor.attemptId,
          reason: input.reason,
          operator: input.operator,
          channel: "cli_break_glass",
        },
      }, { emitStructuredLog: false });
      return {
        userId: user.id,
        username: user.username,
        credentialVersion: version,
        mustChangePassword: true as const,
        protectedTarget,
        operationId: input.operationId,
      };
    });
    await notifyStaffAuthorityChanged([result.userId]);
    return result;
  });
}

export interface StaffPasswordRecoveryMailPort {
  sendRecoveryEmail?: (message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    resetUrl: string;
    expiresInMinutes: number;
  }) => Promise<void>;
  publicOrigin?: string;
  nowMs?: number;
}

export async function requestStaffPasswordRecoveryEmail(
  raw: unknown,
  options: StaffPasswordRecoveryMailPort = {},
): Promise<{ accepted: true; delivered: boolean }> {
  const input = parseAdministrationInput(forgotStaffPasswordRequestSchema, raw);
  const identifier = input.identifier.trim();
  const normalized = identifier.toLowerCase();

  let candidate = await getUserByUsername(identifier);
  if (!candidate) {
    const emailMap = configuredRecoveryEmailMap();
    for (const [mappedKey, mappedEmail] of emailMap.entries()) {
      if (mappedEmail === normalized) {
        candidate = (await getUserByUsername(mappedKey)) ?? (await getUser(mappedKey));
        if (candidate) break;
      }
    }
  }
  if (!candidate?.active) {
    return { accepted: true, delivered: false };
  }
  const toEmail = resolveStaffRecoveryEmail(candidate);
  if (!toEmail) {
    return { accepted: true, delivered: false };
  }

  const operationId = randomUUID();
  const attemptId = randomUUID();
  const issued = await db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM identity.users WHERE id=${candidate!.id} FOR UPDATE`);
    const current = await getUser(candidate!.id, tx);
    const state = current?.active ? await readStaffCredentialState(current.id, tx, true) : undefined;
    if (!current?.active || !state) return null;
    const tokenBundle = createStaffPasswordRecoveryToken({
      userId: current.id,
      credentialVersion: state.credentialVersion,
      passwordHash: current.password,
      operationId,
      nowMs: options.nowMs,
    });
    await persistAuditEvent(tx, {
      actor: `self_service:${current.id}`,
      action: "identity.access.credential_recovery_requested",
      target: `user:${current.id}`,
      changes: {
        before: { credentialVersion: state.credentialVersion },
        after: { credentialVersion: state.credentialVersion, expiresAt: new Date(tokenBundle.expiresAt).toISOString() },
      },
      context: {
        operationId,
        attemptId,
        reason: "self_service_password_recovery_requested",
        channel: "verified_email",
      },
    }, { emitStructuredLog: false });
    return { user: current, ...tokenBundle };
  });

  if (!issued) {
    return { accepted: true, delivered: false };
  }

  const origin = (options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? process.env.APP_URL ?? "http://localhost:5000").replace(/\/+$/, "");
  const resetUrl = `${origin}/login?resetToken=${encodeURIComponent(issued.token)}`;
  const expiresInMinutes = Math.round(STAFF_PASSWORD_RESET_TTL_MS / 60_000);
  const subject = "Echelon Staff Password Reset";
  const text = [
    `A password reset was requested for your Echelon staff account (${issued.user.username}).`,
    `Use the single-use link below within ${expiresInMinutes} minutes to set a new password:`,
    resetUrl,
    "If you did not request this reset, you can safely ignore this email.",
  ].join("\n\n");
  const html = `<div style="font-family:-apple-system,Arial,sans-serif;font-size:14px;color:#111;line-height:1.5;">
    <p>A password reset was requested for your Echelon staff account (<strong>${issued.user.username.replace(/[&<>]/g, "")}</strong>).</p>
    <p>Use the single-use link below within <strong>${expiresInMinutes} minutes</strong> to choose a new password:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p style="color:#6b7280;font-size:12px;">This link is bound to your current credential generation and becomes invalid immediately after use.</p>
  </div>`;

  if (options.sendRecoveryEmail) {
    await options.sendRecoveryEmail({ to: toEmail, subject, html, text, resetUrl, expiresInMinutes });
  } else {
    await sendEmail({ to: toEmail, subject, html, text });
  }
  return { accepted: true, delivered: true };
}

export async function resetStaffPasswordWithToken(
  raw: unknown,
  options: { nowMs?: number } = {},
): Promise<{ userId: string; credentialVersion: string }> {
  const input = parseAdministrationInput(resetStaffPasswordWithTokenSchema, raw);
  const { encodedPayload, stateSig, payload } = parseAndVerifyOuterRecoveryToken(input.token, options.nowMs);
  const secret = recoverySecret();
  const actor: IdentityAdministrationActor = {
    actorId: payload.userId,
    credentialVersion: payload.credentialVersion,
    operationId: input.operationId,
    attemptId: randomUUID(),
  };

  return observedCredentialCommand("identity.access.credential_self_service_reset", actor, async () => {
    const newPasswordHash = await bcrypt.hash(input.password, 10);
    const result = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('echelon.identity.access_administration.v1',0))`);
      await tx.execute(sql`SELECT id FROM identity.users WHERE id=${payload.userId} FOR UPDATE`);
      const user = await getUser(payload.userId, tx);
      const state = await readStaffCredentialState(payload.userId, tx, true);
      if (!user?.active || !state || state.credentialVersion !== payload.credentialVersion) {
        throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has already been used.");
      }
      const expectedStateMac = computeStateRecoveryMac(secret, encodedPayload, state.credentialVersion, user.password);
      if (!safeEqualBase64Url(stateSig, expectedStateMac)) {
        throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE", 403, "This password reset link is invalid or has already been used.");
      }
      if (await bcrypt.compare(input.password, user.password)) {
        throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "Choose a different password.");
      }
      const version = randomUUID();
      await updateUser(user.id, { password: newPasswordHash }, tx);
      await tx.execute(sql`UPDATE identity.staff_credentials SET credential_version=${version}::uuid,
        must_change_password=false,last_operation_id=${input.operationId}::uuid WHERE user_id=${user.id}`);
      await persistAuditEvent(tx, {
        actor: user.id,
        action: "identity.access.credential_self_service_reset",
        target: `user:${user.id}`,
        changes: {
          before: { credentialVersion: state.credentialVersion },
          after: { credentialVersion: version, passwordChanged: true, mustChangePassword: false },
        },
        context: {
          operationId: input.operationId,
          tokenOperationId: payload.operationId,
          attemptId: actor.attemptId,
          reason: "self_service_token_password_reset",
          channel: "verified_email",
        },
      }, { emitStructuredLog: false });
      return { userId: user.id, credentialVersion: version };
    });
    await notifyStaffAuthorityChanged([result.userId]);
    return result;
  });
}

async function observedCredentialCommand<T>(action:string,actor:IdentityAdministrationActor,work:()=>Promise<T>):Promise<T> {
  const start=performance.now();
  function report(outcome:"succeeded"|"failed",code?:string){try{logger[outcome==="succeeded"?"info":"error"](action,{
    module:"identity",action,outcome,actorId:actor.actorId,operationId:actor.operationId,attemptId:actor.attemptId,
    duration_ms:performance.now()-start,release:process.env.HEROKU_SLUG_COMMIT??process.env.RELEASE_VERSION??"unknown",
    ...(code?{error_code:code,failed_step:"credential_transaction",retry_safety:"read_current_credential_state"}:{})
  });}catch{/* Critical audit commits with the credential; diagnostics are a best-effort side channel. */}}
  try{const value=await work();report("succeeded");return value;}catch(error){report("failed",error instanceof IdentityAdministrationError?error.code:"IDENTITY_CREDENTIAL_COMMAND_FAILED");throw error;}
}
export function resetStaffPassword(target:unknown,raw:unknown,actor:IdentityAdministrationActor){
  const input=parseAdministrationInput(resetStaffPasswordSchema,raw);
  const context=parseAdministrationActor({...actor,operationId:input.operationId});
  return observedCredentialCommand("identity.access.credential_reset",context,()=>resetStaffPasswordImplementation(target,input,context));
}
export function changeOwnStaffPassword(raw:unknown,actor:IdentityAdministrationActor){
  const input=parseAdministrationInput(changeStaffPasswordSchema,raw);
  const context=parseAdministrationActor({...actor,operationId:input.operationId});
  return observedCredentialCommand("identity.access.credential_changed",context,()=>changeOwnStaffPasswordImplementation(input,context));
}

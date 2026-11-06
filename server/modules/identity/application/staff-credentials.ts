import { logger } from "../../../platform/observability/logger";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { changeStaffPasswordSchema, resetStaffPasswordSchema, staffCredentialReviewSchema,
  STAFF_RESET_PERMISSION, STAFF_PRIVILEGED_RESET_PERMISSION } from "@shared/staff-credentials";
import { IdentityAdministrationError, parseAdministrationActor, parseAdministrationInput, type IdentityAdministrationActor } from "../domain/access-administration";
import { runIdentityAdministration } from "../infrastructure/access-administration.repository";
import { readStaffCredentialState, isProtectedStaffTarget } from "../infrastructure/staff-credentials.repository";
import { readAccessConfiguration } from "../infrastructure/access-configuration.repository";
import { getUser, getUserByUsername, updateUser, updateUserLastLogin } from "../infrastructure/identity.repository";
import { readCommandAuthorityActor } from "../infrastructure/command-authority.repository";
import { persistAuditEvent } from "../../../infrastructure/transactional-audit";

function forbidden(): never { throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_FORBIDDEN",403,"Current credential authority is required."); }
function stale(): never { throw new IdentityAdministrationError("IDENTITY_CREDENTIAL_STALE",409,"Credentials changed. Sign in or review current state again."); }
const targetIdSchema=z.string().min(1).refine(value=>value.trim().length>0);

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
  return db.transaction(tx=>runIdentityAdministration(tx,actor,STAFF_RESET_PERMISSION,"credential_reset",async()=>{
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

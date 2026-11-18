import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import { WebSocket } from "ws";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { STAFF_CONTROL_PERMISSIONS } from "@shared/staff-credentials";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { identityAdministrationFixtureSql } from "../fixtures/identity-administration.fixture";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
const connection=vi.hoisted(()=>({database:null as NodePgDatabase<typeof schema>|null}));
vi.mock("../../../../db",()=>({db:new Proxy({},{get(_target,property){
  if(!connection.database)throw new Error("Explicit disposable fixture required");
  const value=Reflect.get(connection.database,property);return typeof value==="function"?value.bind(connection.database):value;
}})}));
import { registerAuthRoutes } from "../../identity.routes";
import { createStaffSessionGate } from "../../staff-session";
import { requirePermission } from "../../../../routes/middleware";
import { updateUserUseCase, assignUserRolesUseCase, updateRolePermissionsUseCase } from "../../application/identity.use-cases";
import { reviewStaffCredentialReset,resetStaffPassword,changeOwnStaffPassword,authenticateStaffSession,recoverStaffPasswordBreakGlass,requestStaffPasswordRecoveryEmail,resetStaffPasswordWithToken } from "../../application/staff-credentials";
import { readStaffCredentialState } from "../../infrastructure/staff-credentials.repository";
import { setupWebSocket,broadcastToUser } from "../../../../websocket";
import { registerCustomerReturnCustomerAuthRoutes } from "../../../returns/interfaces/http/customer-return-customer-auth.routes";
import { createStaffStreamObserver } from "../../staff-stream";

const databaseUrl=process.env.ECHELON_TEST_DATABASE_URL;
if(databaseUrl)validatePostgresTestEnvironment(process.env);
const integration=databaseUrl?describe.sequential:describe.skip;
integration("staff credential ownership, session revocation and recovery",()=>{
  let database:InventoryCutoverTestDatabase,server:Server,base:string,socketServer:ReturnType<typeof setupWebSocket>;
  let passwordHash:string;
  const actorId="credential-editor",targetId="credential-target",managerId="credential-recovery-manager";
  const original="Synthetic original password",replacement="Synthetic temporary password",chosen="Synthetic user chosen password";
  let role:number,targetRole:number;
  let delayedLoaded:()=>void,releaseDelayed:Promise<void>;
  let streamReady:()=>void,releaseStream:Promise<void>,observerOwnerFinished=false;
  beforeAll(async()=>{
    database=await createInventoryCutoverTestDatabase(databaseUrl,true,identityAdministrationFixtureSql);
    connection.database=drizzle(database.pool,{schema});passwordHash=await bcrypt.hash(original,4);
  });
  afterAll(async()=>{connection.database=null;await database?.close();});
  beforeEach(async()=>{
    await database.pool.query("TRUNCATE public.audit_events,identity.auth_user_roles,identity.auth_role_permissions,identity.auth_roles,identity.users CASCADE");
    await database.pool.query("INSERT INTO identity.users(id,username,password,role) VALUES($1::varchar,$1::text,$4,'picker'),($2::varchar,$2::text,$4,'admin'),($3::varchar,$3::text,$4,'picker')",[actorId,targetId,managerId,passwordHash]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id) SELECT id FROM identity.users");
    const rows=(await database.pool.query<{id:number}>("INSERT INTO identity.auth_roles(name) VALUES('Custom editor'),('Custom target'),('Recovery management') RETURNING id")).rows;
    role=rows[0].id;targetRole=rows[1].id;
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2),($3,$4),($5,$6)",[actorId,role,targetId,targetRole,managerId,rows[2].id]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='inventory' AND action='view'",[targetRole]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource || ':' || action=ANY($2::text[])",[rows[2].id,["users:manage_roles","roles:edit"]]);
    await grantActor(["users:view","users:edit"]);
    const app=express();app.set("trust proxy","loopback");app.use(express.json());
    const sessions=session({secret:"disposable-synthetic-session-signing-fixture-only",resave:false,saveUninitialized:false});
    app.use(sessions);app.use(createStaffSessionGate());registerAuthRoutes(app);
    app.get("/api/business-check",requirePermission("inventory","view"),(_req,res)=>res.json({allowed:true}));
    app.get("/api/fixture/delayed-save",requirePermission("inventory","view"),async(req,res)=>{
      delayedLoaded();await releaseDelayed;
      // Reproduce a real in-flight request saving the pre-reset session later.
      await new Promise<void>((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));res.json({saved:true});
    });
    app.get("/api/fixture/stream",requirePermission("inventory","view"),async(req,res)=>{
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const observer=createStaffStreamObserver(req,res,"inventory:view");
      observer.send({beforeReset:true});await observer.flush();streamReady();await releaseStream;
      observerOwnerFinished=true;observer.send({afterReset:"must not be delivered"});await observer.flush();res.end();
    });
    app.get("/api/fixture/principals",(req,res)=>res.json({user:req.session.user?.id??null,
      version:req.session.staffCredentialVersion??null,completion:req.session.staffCredentialCompletion??null,
      customer:!!req.session.customerReturnSession,secure:req.session.cookie.secure,dropship:req.session.dropship,
      dropshipProofs:req.session.dropshipSensitiveProofs,passkey:req.session.dropshipPasskeyLogin}));
    app.post("/api/fixture/dropship-principal",(req,res)=>{
      req.session.dropship={memberId:"synthetic-vendor",cardShellzEmail:"synthetic@example.invalid",hasPasskey:true,
        authMethod:"password",authIdentityId:1,entitlementStatus:"active",authenticatedAt:"2026-11-05T00:00:00Z"};
      req.session.dropshipSensitiveProofs={connect_store:{method:"email_mfa",verifiedAt:"2026-11-05T00:00:00Z",expiresAt:"2026-11-05T00:10:00Z"}};
      req.session.dropshipPasskeyLogin={challenge:"synthetic-challenge",memberId:"synthetic-vendor",action:null,expiresAt:"2026-11-05T00:10:00Z"};
      res.json({fixture:true});
    });
    const customer={channelId:1,externalCustomerId:"123456",shopDomain:"synthetic.myshopify.com",sessionKey:"C".repeat(43),authenticatedAt:1,expiresAt:9999999999999};
    registerCustomerReturnCustomerAuthRoutes(app,{privateTesting:()=>false,context:(async()=>({config:{publicOrigin:base},auth:{
      authenticate:async()=>customer,principal:async(value:unknown)=>{if(!value)throw new Error("No synthetic customer");return value;}
    }})) as never});
    app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(500).json({error:"Synthetic request failed"}));
    server=createServer(app);socketServer=setupWebSocket(server,sessions);
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async()=>{
    socketServer?.clients.forEach(socket=>socket.terminate());
    if(socketServer)await new Promise<void>(resolve=>socketServer.close(()=>resolve()));
    if(server?.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  });
  async function grantActor(keys:string[]){
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1",[role]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource || ':' || action=ANY($2::text[])",[role,keys]);
  }
  async function authority(id=actorId){return {actorId:id,credentialVersion:(await readStaffCredentialState(id,connection.database!))!.credentialVersion};}
  async function input(){const review=await reviewStaffCredentialReset(targetId,await authority());return {password:replacement,currentPassword:original,
    expectedCredentialVersion:review.credentialVersion,expectedAccessRevision:review.expectedAccessRevision,operationId:randomUUID(),reason:"Synthetic authorized recovery"};}
  async function call(path:string,cookie?:string,body?:unknown,method=body===undefined?"GET":"POST"){
    return requestLocalHttp(base+path,{method,headers:{"Content-Type":"application/json","Origin":base,"X-Return-Command":"1","X-Forwarded-Proto":"https",...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function login(id=actorId,password=original,cookie?:string){const res=await call("/api/auth/login",cookie,{username:id,password});expect(res.status).toBe(200);return res.headers.get("set-cookie")!.split(";")[0];}
  async function state(){return (await database.pool.query("SELECT account.password,state.* FROM identity.users account JOIN identity.staff_credentials state ON state.user_id=account.id WHERE account.id=$1",[targetId])).rows[0];}
  async function allowReset(privileged=false){await grantActor(["users:view","users:edit","users:reset_password",...(privileged?["users:reset_privileged_password"]:[])]);}
  async function socket(cookie:string){return new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(base.replace("http:","ws:")+"/ws",{headers:{Cookie:cookie}});ws.once("open",()=>resolve(ws));ws.once("error",reject);});}

  it("profile-only API and public command cannot reset a real access manager",async()=>{
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='roles' AND action='edit'",[targetRole]);
    const before=await state(),cookie=await login();
    expect((await call(`/api/users/${targetId}`,cookie,{password:replacement},"PATCH")).status).toBe(400);
    await expect(updateUserUseCase(targetId,{password:replacement} as never,await authority())).rejects.toMatchObject({statusCode:400});
    expect((await call(`/api/users/${targetId}/password-reset`,cookie,{})).status).toBe(403);
    expect(await state()).toEqual(before);
  });
  it.each(STAFF_CONTROL_PERMISSIONS)("ordinary reset authority cannot control a holder of %s",async key=>{
    await allowReset();
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) SELECT $1,id,'{}'::jsonb FROM identity.auth_permissions WHERE resource || ':' || action=$2",[targetRole,key]);
    await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1",[targetId]);
    await expect(reviewStaffCredentialReset(targetId,await authority())).rejects.toMatchObject({statusCode:403});
    expect((await state()).password).toBe(passwordHash);
  });
  it("permits explicitly authorized protected reset and retains assignments and manager coverage",async()=>{
    await allowReset(true);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='roles' AND action='edit'",[targetRole]);
    const assignments=(await database.pool.query("SELECT * FROM identity.auth_user_roles ORDER BY id")).rows;
    const review=await reviewStaffCredentialReset(targetId,await authority());expect(review.protectedTarget).toBe(true);
    await resetStaffPassword(targetId,await input(),await authority());
    expect((await database.pool.query("SELECT * FROM identity.auth_user_roles ORDER BY id")).rows).toEqual(assignments);
    expect((await state()).must_change_password).toBe(true);
  });
  it.each(["Administrator","Team Lead"])("protects actual assigned system %s authority even without grants",async name=>{
    await allowReset();await database.pool.query("UPDATE identity.auth_roles SET name=$2,is_system=1 WHERE id=$1",[targetRole,name]);
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1",[targetRole]);
    await expect(reviewStaffCredentialReset(targetId,await authority())).rejects.toMatchObject({statusCode:403});
  });
  it("does not turn a same-name custom role or a legacy admin profile into privileged authority",async()=>{
    await allowReset();await database.pool.query("UPDATE identity.auth_roles SET name='Administrator',is_system=0 WHERE id=$1",[targetRole]);
    expect((await reviewStaffCredentialReset(targetId,await authority())).protectedTarget).toBe(false);
  });
  it("requires current actor credential proof and rejects self-admin reset",async()=>{
    await allowReset();const command=await input(),before=await state();
    await expect(resetStaffPassword(targetId,{...command,currentPassword:"Wrong synthetic password"},await authority())).rejects.toMatchObject({statusCode:403});
    await expect(resetStaffPassword(targetId,command,{actorId})).rejects.toMatchObject({statusCode:403});
    await expect(reviewStaffCredentialReset(actorId,await authority())).rejects.toMatchObject({statusCode:403});
    expect(await state()).toEqual(before);
  });
  it("rejects missing and stale actor proof for ordinary Identity commands too",async()=>{
    await expect(updateUserUseCase(targetId,{displayName:"Not allowed"},{actorId})).rejects.toMatchObject({code:"IDENTITY_CREDENTIAL_STALE"});
    const actor=await authority();await database.pool.query("UPDATE identity.staff_credentials SET credential_version=gen_random_uuid() WHERE user_id=$1",[actorId]);
    await expect(updateUserUseCase(targetId,{displayName:"Not allowed"},actor)).rejects.toMatchObject({code:"IDENTITY_CREDENTIAL_STALE"});
  });
  it("one concurrent reset wins; stale retry never replaces the credential again",async()=>{
    await allowReset();const command=await input(),actor=await authority();
    const results=await Promise.allSettled([resetStaffPassword(targetId,command,actor),resetStaffPassword(targetId,{...command,operationId:randomUUID()},actor)]);
    expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    const after=await state();await expect(resetStaffPassword(targetId,command,actor)).rejects.toMatchObject({code:"IDENTITY_CREDENTIAL_STALE"});
    expect(await state()).toEqual(after);
  });
  it("a privilege change after review makes that reset stale",async()=>{
    await allowReset();const command=await input(),before=await state();
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='roles' AND action='edit'",[targetRole]);
    await expect(resetStaffPassword(targetId,command,await authority())).rejects.toMatchObject({code:"IDENTITY_ACCESS_STALE"});
    expect(await state()).toEqual(before);
  });
  it("audit failure rolls credential and generation back together",async()=>{
    await allowReset();const command=await input(),before=await state();
    await database.pool.query("CREATE FUNCTION public.reject_credential_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END$$; CREATE TRIGGER reject_credential_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_credential_audit()");
    try{await expect(resetStaffPassword(targetId,command,await authority())).rejects.toThrow();expect(await state()).toEqual(before);}
    finally{await database.pool.query("DROP TRIGGER reject_credential_audit ON public.audit_events; DROP FUNCTION public.reject_credential_audit()");}
  });
  it("revokes old HTTP sessions, limits temporary login, and completes zero-role self recovery",async()=>{
    await allowReset();const cookie=await login(targetId);expect((await call("/api/business-check",cookie)).status).toBe(200);
    await resetStaffPassword(targetId,await input(),await authority());
    expect((await call("/api/business-check",cookie)).status).toBe(401);
    await expect(authenticateStaffSession(targetId,original)).rejects.toThrow();
    const temporary=await login(targetId,replacement);expect((await call("/api/business-check",temporary)).status).toBe(401);
    await database.pool.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1",[targetId]);
    expect((await call("/api/auth/me",temporary)).status).toBe(200);
    expect((await call("/api/auth/password",temporary,{currentPassword:replacement,password:chosen,operationId:randomUUID()})).status).toBe(204);
    expect((await call("/api/auth/me",temporary)).status).toBe(401);
    expect((await call("/api/auth/me",await login(targetId,chosen))).status).toBe(200);
    const audit=JSON.stringify((await database.pool.query("SELECT * FROM public.audit_events")).rows);
    for(const secret of [original,replacement,chosen,passwordHash,(await state()).password])expect(audit).not.toContain(secret);
  });
  it("never attaches a reset's new generation to a previously verified old password",async()=>{
    await allowReset();const command=await input();
    let proof!:()=>void,release!:()=>void;const verified=new Promise<void>(resolve=>{proof=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
    const realCompare=bcrypt.compare.bind(bcrypt);
    const spy=vi.spyOn(bcrypt,"compare").mockImplementationOnce((async(plain:string,hash:string)=>{
      const result=await realCompare(plain,hash);proof();await resume;return result;
    }) as never);
    const loginAttempt=authenticateStaffSession(targetId,original);
    try{await verified;await resetStaffPassword(targetId,command,await authority());release();await expect(loginAttempt).rejects.toMatchObject({statusCode:403});}
    finally{release();spy.mockRestore();}
  });
  it("an in-flight old session save cannot restore staff access after reset",async()=>{
    await allowReset();const cookie=await login(targetId);
    let loaded!:()=>void,release!:()=>void;const observed=new Promise<void>(resolve=>{loaded=resolve;});
    delayedLoaded=loaded;releaseDelayed=new Promise<void>(resolve=>{release=resolve;});
    const inFlight=call("/api/fixture/delayed-save",cookie);
    try{await observed;await resetStaffPassword(targetId,await input(),await authority());release();expect((await inFlight).status).toBe(200);
      expect((await call("/api/business-check",cookie)).status).toBe(401);}
    finally{release();}
  });
  it("revokes already-open event-stream delivery without cancelling its accepted owner work",async()=>{
    await allowReset();const cookie=await login(targetId);let ready!:()=>void,release!:()=>void;
    const admitted=new Promise<void>(resolve=>{ready=resolve;});streamReady=ready;releaseStream=new Promise<void>(resolve=>{release=resolve;});observerOwnerFinished=false;
    const request=call("/api/fixture/stream",cookie);
    try{await admitted;await resetStaffPassword(targetId,await input(),await authority());release();const response=await request;
      const body=await response.text();expect(body).toContain("beforeReset");expect(body).not.toContain("afterReset");expect(observerOwnerFinished).toBe(true);
    }finally{release();}
  });
  it("preserves login and self-change for previously accepted long legacy credentials",async()=>{
    const id="legacy-credential-fixture",username="legacy-"+"u".repeat(300),legacy="p".repeat(1100),hash=await bcrypt.hash(legacy,4);
    await database.pool.query("INSERT INTO identity.users(id,username,password) VALUES($1,$2,$3)",[id,username,hash]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id) VALUES($1)",[id]);
    expect((await authenticateStaffSession(username,legacy)).user.id).toBe(id);
    await changeOwnStaffPassword({currentPassword:legacy,password:chosen,operationId:randomUUID()},await authority(id));
    expect((await authenticateStaffSession(username,chosen)).user.id).toBe(id);
  });
  it.each([false,true])("preserves independent customer scope and staff generation across real regeneration; completion=%s",async temporary=>{
    await allowReset();if(temporary)await resetStaffPassword(targetId,await input(),await authority());
    const password=temporary?replacement:original,cookie=await login(targetId,password);
    const response=await call("/api/returns/customer/session",cookie,{proof:"synthetic-proof"});
    expect(response.status).toBe(200);expect(response.headers.get("set-cookie")).toContain("Secure");
    const regenerated=response.headers.get("set-cookie")!.split(";")[0];expect(regenerated).not.toBe(cookie);
    const principal=await(await call("/api/fixture/principals",regenerated)).json();
    expect(principal.customer).toBe(true);expect(principal.secure).toBe(true);
    const expected=(await authority(targetId)).credentialVersion;
    if(temporary){expect(principal.user).toBeNull();expect(principal.completion.credentialVersion).toBe(expected);}
    else {expect(principal.user).toBe(targetId);expect(principal.version).toBe(expected);}
    const staffLogin=await call("/api/auth/login",regenerated,{username:targetId,password});
    expect(staffLogin.status).toBe(200);expect(staffLogin.headers.get("set-cookie")).toContain("Secure");
    const after=await(await call("/api/fixture/principals",staffLogin.headers.get("set-cookie")!.split(";")[0])).json();
    expect(after.customer).toBe(true);expect(after.secure).toBe(true);
  });
  it("revokes existing WebSocket delivery and rejects new stale/temporary upgrades",async()=>{
    await allowReset();const cookie=await login(targetId),ws=await socket(cookie),messages:string[]=[];ws.on("message",data=>messages.push(data.toString()));
    const closed=new Promise<number>(resolve=>ws.once("close",code=>resolve(code)));
    await resetStaffPassword(targetId,await input(),await authority());await broadcastToUser(targetId,{type:"notification",private:"must never arrive"});
    expect(await closed).toBe(1008);expect(messages.join(" ")).not.toContain("must never arrive");
    await expect(socket(cookie)).rejects.toThrow();await expect(socket(await login(targetId,replacement))).rejects.toThrow();
  });
  it("rate limits credential attempts before unbounded password work",async()=>{
    await allowReset();const cookie=await login();
    for(let i=0;i<10;i++)expect((await call(`/api/users/${targetId}/credential-review`,cookie)).status).toBe(200);
    expect((await call(`/api/users/${targetId}/credential-review`,cookie)).status).toBe(429);
  });
  it("staff login preserves an existing independent .ops principal and bound proof state",async()=>{
    const seeded=await call("/api/fixture/dropship-principal",undefined,{}),cookie=seeded.headers.get("set-cookie")!.split(";")[0];
    const before=await(await call("/api/fixture/principals",cookie)).json();
    const next=await login(actorId,original,cookie),after=await(await call("/api/fixture/principals",next)).json();
    expect(after.dropship).toEqual(before.dropship);expect(after.dropshipProofs).toEqual(before.dropshipProofs);expect(after.passkey).toEqual(before.passkey);
    expect(after.user).toBe(actorId);expect(next).not.toBe(cookie);
  });
  it("allocated upgrade backfills existing accounts without changing hashes, roles or assignments",async()=>{
    const draft=readFileSync(new URL("../../../../../migrations/900000056000020040001_staff_credential_state.sql",import.meta.url),"utf8");
    const baseline=identityAdministrationFixtureSql.replace(draft,"")+"INSERT INTO identity.users(id,username,password,role) VALUES('upgrade-a','upgrade-a','synthetic-retained-hash','admin'),('upgrade-b','upgrade-b','synthetic-retained-hash','picker');";
    const upgrade=await createInventoryCutoverTestDatabase(databaseUrl,true,baseline);
    try{const before=(await upgrade.pool.query("SELECT * FROM identity.users ORDER BY id")).rows;
      await upgrade.pool.query("BEGIN;"+draft+"COMMIT;");
      expect((await upgrade.pool.query("SELECT * FROM identity.users ORDER BY id")).rows).toEqual(before);
      const rows=(await upgrade.pool.query("SELECT * FROM identity.staff_credentials ORDER BY user_id")).rows;
      expect(rows).toHaveLength(2);expect(new Set(rows.map(row=>row.credential_version)).size).toBe(2);
      expect(rows.every(row=>row.must_change_password===false&&row.last_operation_id===null)).toBe(true);
      expect((await upgrade.pool.query("SELECT * FROM identity.auth_user_roles")).rows).toEqual([]);
      await expect(upgrade.pool.query("INSERT INTO identity.staff_credentials(user_id) VALUES('missing-user')")).rejects.toMatchObject({code:"23503"});
    }finally{await upgrade.close();}
  });
  it("break-glass CLI recovery rotates credential generation, requires password change on next login, and immediately closes open WebSockets",async()=>{
    const cookie=await login(targetId),ws=await socket(cookie);
    const closed=new Promise<number>(resolve=>ws.once("close",code=>resolve(code)));
    const opId=randomUUID();
    const outcome=await recoverStaffPasswordBreakGlass({username:targetId,password:replacement,reason:"Emergency break-glass recovery after lockout",operator:"cli-brett",operationId:opId});
    expect(outcome.userId).toBe(targetId);expect(outcome.mustChangePassword).toBe(true);
    expect(await closed).toBe(1008);
    expect((await call("/api/business-check",cookie)).status).toBe(401);
    const tempCookie=await login(targetId,replacement);
    expect((await call("/api/business-check",tempCookie)).status).toBe(401);
    expect((await call("/api/auth/password",tempCookie,{currentPassword:replacement,password:chosen,operationId:randomUUID()})).status).toBe(204);
    expect((await call("/api/business-check",await login(targetId,chosen))).status).toBe(200);
    const audits=(await database.pool.query("SELECT action,actor,target FROM public.audit_events WHERE action='identity.access.credential_break_glass_recovery'")).rows;
    expect(audits).toEqual([{action:"identity.access.credential_break_glass_recovery",actor:"break_glass:cli-brett",target:`user:${targetId}`}]);
  });
  it("self-service verified-email recovery issues a single-use 15-minute token, rejects replay, and records immutable audit events",async()=>{
    vi.stubEnv("SESSION_SECRET","disposable-synthetic-session-signing-fixture-only");
    vi.stubEnv("STAFF_RECOVERY_EMAILS_JSON",JSON.stringify({[targetId]:"target@example.invalid"}));
    try{
      let capturedUrl="";
      const requested=await requestStaffPasswordRecoveryEmail({identifier:"target@example.invalid"},{
        publicOrigin:base,
        sendRecoveryEmail:async(msg)=>{capturedUrl=msg.resetUrl;},
      });
      expect(requested).toEqual({accepted:true,delivered:true});
      const token=new URL(capturedUrl).searchParams.get("resetToken")!;
      expect(token).toBeTruthy();
      const resetRes=await call("/api/auth/reset-password-token",undefined,{token,password:chosen,operationId:randomUUID()});
      expect(resetRes.status).toBe(204);
      const replayRes=await call("/api/auth/reset-password-token",undefined,{token,password:"AnotherValidPassword!1",operationId:randomUUID()});
      expect(replayRes.status).toBe(403);
      expect((await call("/api/business-check",await login(targetId,chosen))).status).toBe(200);
      const audits=(await database.pool.query("SELECT action FROM public.audit_events WHERE target=$1 ORDER BY id",[ `user:${targetId}` ])).rows.map(r=>r.action);
      expect(audits).toEqual(["identity.access.credential_recovery_requested","identity.access.credential_self_service_reset"]);
    }finally{vi.unstubAllEnvs();}
  });
  it("pushes authority:updated to active WebSockets on role permission edits and closes sockets immediately when roles are removed",async()=>{
    await grantActor(["users:view","roles:view","roles:edit","users:manage_roles"]);
    const cookie=await login(targetId),ws=await socket(cookie),messages:string[]=[];
    ws.on("message",data=>messages.push(data.toString()));
    const permRows=(await database.pool.query<{id:number}>("SELECT id FROM identity.auth_permissions WHERE resource IN ('inventory','orders') AND action='view' ORDER BY resource")).rows;
    const rev1=(await reviewStaffCredentialReset(targetId,await (async()=>{await allowReset(true);return authority();})())).expectedAccessRevision;
    await grantActor(["users:view","roles:view","roles:edit","users:manage_roles"]);
    const revAfterGrant=(await (await call("/api/users",await login(actorId))).headers.get("x-access-revision"))!;
    await updateRolePermissionsUseCase(targetRole,permRows.map(r=>r.id),{...(await authority()),expectedAccessRevision:revAfterGrant});
    await new Promise(resolve=>setTimeout(resolve,40));
    expect(messages.some(m=>m.includes('"type":"authority:updated"'))).toBe(true);
    const closed=new Promise<number>(resolve=>ws.once("close",code=>resolve(code)));
    const revBeforeRemove=(await (await call("/api/users",await login(actorId))).headers.get("x-access-revision"))!;
    await assignUserRolesUseCase(targetId,[],{...(await authority()),expectedAccessRevision:revBeforeRemove});
    expect(await closed).toBe(1008);
    void rev1;
  });
});

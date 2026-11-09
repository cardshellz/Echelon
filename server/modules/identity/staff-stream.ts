import type { Request,Response } from "express";
import { hasStaffCapability } from "@shared/staff-capabilities";
import { isCurrentStaffCredential } from "@shared/staff-credentials";
import { readStaffCredentialState } from "./infrastructure/staff-credentials.repository";
import { readCurrentStaffAccess } from "./infrastructure/staff-access.repository";
import { onStaffAuthorityChanged } from "./authority-events";
import { logger } from "../../platform/observability/logger";

// Observer-only backpressure. Never cancel or repeat the owning business action.
// Allows all 500 push-product updates plus completion; excessive rate-limit hints
// close only the observer. This is a defensive bound, not a capacity claim.
export const STAFF_STREAM_QUEUE_LIMIT=512;
export function createStaffStreamObserver(req:Request,res:Response,permission:string,verify?:()=>Promise<boolean>) {
  const id=req.session?.user?.id,version=req.session?.staffCredentialVersion;
  const check=verify??(async()=>{
    if(!id)return false;
    const [access,state]=await Promise.all([readCurrentStaffAccess(id),readStaffCredentialState(id)]);
    return !!access && !state?.mustChangePassword && isCurrentStaffCredential(version,state)
      && hasStaffCapability(access.permissions,permission);
  });
  let stopped=false,drain:Promise<void>|undefined;const pending:string[]=[];
  let unsubscribe:(()=>void)|undefined;
  const stop=(code:string)=>{
    if(stopped)return;
    stopped=true;pending.length=0;unsubscribe?.();unsubscribe=undefined;
    try{logger.warn("identity.stream.delivery",{module:"identity",outcome:"observer_stopped",error_code:code,
      retry_safety:"read_owner_status_before_business_retry"});}catch{/* Diagnostics never cancel accepted work. */}
  };
  if(id){
    unsubscribe=onStaffAuthorityChanged(async affected=>{
      if(stopped||(affected&&!affected.includes(id)))return;
      try{if(!await check())stop("IDENTITY_STREAM_AUTHORITY_REVOKED");}
      catch{stop("IDENTITY_STREAM_AUTHORITY_UNAVAILABLE");}
    });
  }
  res.on("close",()=>{stopped=true;pending.length=0;unsubscribe?.();unsubscribe=undefined;});
  async function deliver(){
    try{while(!stopped && pending.length){
      const event=pending.shift()!;
      if(!await check()){stop("IDENTITY_STREAM_AUTHORITY_REVOKED");break;}
      if(!stopped && !res.writableEnded)res.write(event);
    }}catch{stop("IDENTITY_STREAM_AUTHORITY_UNAVAILABLE");}
  }
  function pump(){
    if(drain||stopped||!pending.length)return;
    drain=deliver().finally(()=>{drain=undefined;pump();});
  }
  return {
    send(event:unknown){
      if(stopped)return;
      if(pending.length>=STAFF_STREAM_QUEUE_LIMIT){stop("IDENTITY_STREAM_BACKPRESSURE");return;}
      try{pending.push(`data: ${JSON.stringify(event)}\n\n`);}catch{stop("IDENTITY_STREAM_PAYLOAD_INVALID");return;}
      pump();
    },
    async flush(){while(drain)await drain;},
  };
}

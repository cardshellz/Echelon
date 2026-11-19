import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { newStaffPasswordSchema, staffCredentialReviewSchema } from "@shared/staff-credentials";
import { z } from "zod";

export function StaffPasswordReset({userId,label}:{userId:string;label:string}) {
  const {user,hasPermission}=useAuth();
  const [open,setOpen]=useState(false),[review,setReview]=useState<z.infer<typeof staffCredentialReviewSchema>|null>(null);
  const [current,setCurrent]=useState(""),[password,setPassword]=useState(""),[reason,setReason]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  if(user?.id===userId||!hasPermission("users","reset_password"))return null;
  return <><button className="border rounded p-2 text-sm" disabled={busy} onClick={async()=>{
    setBusy(true);setError("");setCurrent("");setPassword("");setReview(null);setOpen(true);
    try{const res=await fetch(`/api/users/${encodeURIComponent(userId)}/credential-review`,{credentials:"include",cache:"no-store"});
      if(!res.ok)throw new Error();setReview(staffCredentialReviewSchema.parse(await res.json()));}
    catch{setError("Reset authority could not be verified. You may not have permission to reset this account.");}
    finally{setBusy(false);}
  }}>Reset password</button>{open&&<div role="dialog" aria-modal="true" aria-label={`Reset password for ${label}`} className="fixed inset-0 z-50 bg-background p-6 overflow-auto">
    <div className="max-w-lg mx-auto space-y-4"><h2 className="text-xl font-semibold">Reset password for {label}</h2>
      {review&&<><p>{review.protectedTarget?"This account has protected access-control authority.":"This is an ordinary staff account."} Existing sessions will lose staff access. The temporary password permits only choosing a new password.</p>
      <label className="block">Your current password<input type="password" autoComplete="current-password" className="border p-2 block w-full" value={current} onChange={e=>setCurrent(e.target.value)}/></label>
      <label className="block">Temporary password<input type="password" autoComplete="new-password" className="border p-2 block w-full" value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <label className="block">Reason<input className="border p-2 block w-full" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <button className="border p-2 rounded" disabled={busy||!current||!reason.trim()||!newStaffPasswordSchema.safeParse(password).success} onClick={async()=>{
        if(busy)return;setBusy(true);setError("");
        try{const res=await fetch(`/api/users/${encodeURIComponent(userId)}/password-reset`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({currentPassword:current,password,reason,expectedAccessRevision:review.expectedAccessRevision,
            expectedCredentialVersion:review.credentialVersion,operationId:crypto.randomUUID()})});
          if(!res.ok)throw new Error();setOpen(false);
        }catch{setError("Reset could not be confirmed. Close and review current credential state before another attempt.");}
        finally{setReview(null);setPassword("");setCurrent("");setBusy(false);}
      }}>Confirm reset</button></>}
      {error&&<p role="alert">{error}</p>}<button className="border rounded p-2" disabled={busy} onClick={()=>{setOpen(false);setPassword("");setCurrent("");}}>Close</button>
    </div></div>}</>;
}

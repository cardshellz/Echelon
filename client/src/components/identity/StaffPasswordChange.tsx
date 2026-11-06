import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { newStaffPasswordSchema } from "@shared/staff-credentials";

/** No application shell: temporary credentials grant lifecycle access only. */
export function StaffPasswordChange() {
  const {refetch,logout}=useAuth();
  const [current,setCurrent]=useState(""),[password,setPassword]=useState(""),[confirmation,setConfirmation]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  return <main className="max-w-lg mx-auto p-6 space-y-4"><h1 className="text-2xl font-semibold">Change your staff password</h1>
    <p>Choose a new password before using staff functions. Other staff sessions will end. You will sign in again afterward.</p>
    <form className="space-y-4" onSubmit={async event=>{
      event.preventDefault();if(busy)return;
      if(password!==confirmation || !newStaffPasswordSchema.safeParse(password).success){setError("Enter matching passwords of at most 72 UTF-8 bytes.");return;}
      setBusy(true);setError("");
      try{const response=await fetch("/api/auth/password",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({currentPassword:current,password,operationId:crypto.randomUUID()})});
        if(!response.ok)throw new Error();
        setCurrent("");setPassword("");setConfirmation("");await refetch();
      }catch{setError("Password change could not be confirmed. Check your current password or sign in again before retrying.");}
      finally{setBusy(false);}
    }}>
      <label className="block">Current password<input className="block border p-2 w-full" type="password" autoComplete="current-password" required value={current} onChange={e=>setCurrent(e.target.value)}/></label>
      <label className="block">New password<input className="block border p-2 w-full" type="password" autoComplete="new-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <label className="block">Confirm new password<input className="block border p-2 w-full" type="password" autoComplete="new-password" required value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
      {error&&<p role="alert">{error}</p>}<button className="border rounded p-2" disabled={busy}>Change password</button>
    </form><button disabled={busy} className="border rounded p-2" onClick={()=>void logout()}>Sign out</button></main>;
}

import React, { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/** Identity-only screen: do not mount operational queries while access is absent. */
export function StaffAccessNotice({ denied = false }: { denied?: boolean }) {
  const { accessError, accessStatus, assignedRoles, refetch, logout } = useAuth();
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setLocalError(null);
    try { await action(); }
    catch { setLocalError("The request could not be completed. Please try again."); }
    finally { setPending(false); }
  };
  const hasAssignments = assignedRoles.length > 0;
  return <main className="flex min-h-screen items-center justify-center p-6" data-testid="staff-access-notice">
    <section className="max-w-lg space-y-4 rounded-lg border bg-card p-6">
      <h1 className="text-xl font-semibold">{accessStatus === "unverified" ? "Access verification unavailable" : "Access unavailable"}</h1>
      <p>{accessError || (denied ? "Your assigned roles do not provide access to this page." : hasAssignments
        ? "Your assigned roles do not provide access to an available starting page. Contact an administrator."
        : "You have no assigned roles. An administrator must assign access before you can use Echelon.")}</p>
      {localError && <p role="alert">{localError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => { void act(refetch); }} disabled={pending}>Refresh access</Button>
        <Button variant="outline" onClick={() => { void act(logout); }} disabled={pending}>Sign out</Button>
        {accessStatus === "authenticated" && <Button variant="link" asChild><Link href="/staff/password">Change password</Link></Button>}
        {denied && hasAssignments && accessStatus === "authenticated" && <Button variant="link" asChild><Link href="/">Home</Link></Button>}
      </div>
    </section>
  </main>;
}

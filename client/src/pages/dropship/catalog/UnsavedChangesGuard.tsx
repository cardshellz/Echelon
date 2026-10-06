import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { describeUnsavedDrafts, updateUnsavedDrafts, type UnsavedDraft } from "@/lib/dropship-unsaved-changes";

interface UnsavedChangesContextValue {
  setDraft: (id: string, label: string, dirty: boolean) => void;
  guard: (leave: () => void) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

/**
 * One leave guard for every editor on the page. Editors report unsaved
 * changes with `useUnsavedDraft`; ways off the step (the Next button, the step
 * links, the store picker) go through `useLeaveGuard`, which asks first while
 * anything is unsaved. Closing or reloading the tab gets the browser's own
 * prompt. Leaving through the portal's menu or the browser's Back button is
 * not caught here.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<readonly UnsavedDraft[]>([]);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  // Read inside `guard` so its identity stays stable while drafts change.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const setDraft = useCallback((id: string, label: string, dirty: boolean) => {
    setDrafts((current) => updateUnsavedDrafts(current, id, dirty ? { id, label } : null));
  }, []);
  const guard = useCallback((leave: () => void) => {
    if (draftsRef.current.length === 0) leave();
    else setPendingLeave(() => leave);
  }, []);

  const hasDrafts = drafts.length > 0;
  useEffect(() => {
    if (!hasDrafts) return;
    const askBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", askBeforeUnload);
    return () => window.removeEventListener("beforeunload", askBeforeUnload);
  }, [hasDrafts]);

  const value = useMemo(() => ({ setDraft, guard }), [setDraft, guard]);
  const leaveNow = () => {
    const leave = pendingLeave;
    setPendingLeave(null);
    leave?.();
  };

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <AlertDialog open={pendingLeave !== null} onOpenChange={(open) => { if (!open) setPendingLeave(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{describeUnsavedDrafts(drafts) ?? "Your changes aren't saved."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={leaveNow}>Discard and leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesContext.Provider>
  );
}

/**
 * Reports this editor's unsaved changes while `dirty` is true, and clears
 * them when the editor unmounts. Does nothing outside an UnsavedChangesProvider.
 */
export function useUnsavedDraft(id: string, label: string, dirty: boolean): void {
  const context = useContext(UnsavedChangesContext);
  useEffect(() => {
    context?.setDraft(id, label, dirty);
  }, [context, id, label, dirty]);
  useEffect(() => () => context?.setDraft(id, label, false), [context, id, label]);
}

/**
 * Runs `leave` at once when nothing is unsaved, or after the vendor chooses
 * "Discard and leave". Outside an UnsavedChangesProvider it always runs at once.
 */
export function useLeaveGuard(): (leave: () => void) => void {
  return useContext(UnsavedChangesContext)?.guard ?? leaveAtOnce;
}

function leaveAtOnce(leave: () => void): void {
  leave();
}

/**
 * A wouter Link that goes through the leave guard. wouter itself leaves a
 * click that opens a new tab or window (modifier keys, other buttons) to the
 * browser without calling onClick, so the current tab and its unsaved
 * changes stay as they are.
 */
export function GuardedLink({ href, onClick, ...props }: ComponentProps<typeof Link> & { href: string }) {
  const guard = useLeaveGuard();
  const [location, navigate] = useLocation();
  return (
    <Link
      {...props}
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        // A link to where the vendor already is leaves nothing, so it needs no question.
        if (event.defaultPrevented || href === location) return;
        // Stops wouter's own navigation; the guard navigates once it may.
        event.preventDefault();
        guard(() => navigate(href));
      }}
    />
  );
}

/** Shown on an editor while it holds changes the vendor has not saved. */
export function NotSavedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
      <span aria-hidden="true">●</span> Not saved
    </span>
  );
}

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
import {
  describeLeavePrompt,
  scopeUnsavedDrafts,
  updateUnsavedDrafts,
  type UnsavedDraft,
  type UnsavedDraftExtra,
} from "@/lib/dropship-unsaved-changes";

/**
 * Runs `leave` at once when nothing is unsaved, or after the vendor chooses
 * "Discard and leave". With `scope`, only the drafts with those ids count
 * (closing or switching one editor asks about that editor only).
 */
export type LeaveGuard = (leave: () => void, scope?: readonly string[]) => void;

interface UnsavedChangesContextValue {
  setDraft: (id: string, label: string, dirty: boolean, extra?: UnsavedDraftExtra) => void;
  guard: LeaveGuard;
}

interface PendingLeave {
  leave: () => void;
  /** Null asks about every draft on the page. */
  scope: readonly string[] | null;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);
/** The drafts themselves, apart from the setters, so an editor reporting a draft does not re-render on every other draft. */
const UnsavedDraftsContext = createContext<readonly UnsavedDraft[]>([]);

/**
 * One leave guard for every editor on the page. Editors report unsaved
 * changes with `useUnsavedDraft`; ways off the step (the Next button, the step
 * links, the store picker) go through `useLeaveGuard`, which asks first while
 * anything is unsaved. Closing or reloading the tab gets the browser's own
 * prompt (and, from an editor whose save is in flight, `useBrowserLeavePrompt`).
 * Leaving through the portal's menu or the browser's Back button is not
 * caught here.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<readonly UnsavedDraft[]>([]);
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  // Read inside `guard` and `leaveNow` so the guard's identity stays stable while drafts change.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const setDraft = useCallback((id: string, label: string, dirty: boolean, extra?: UnsavedDraftExtra) => {
    const entry: UnsavedDraft | null = !dirty ? null
      : extra ? { id, label, changes: extra.changes, discard: extra.discard } : { id, label };
    setDrafts((current) => updateUnsavedDrafts(current, id, entry));
  }, []);
  const guard = useCallback<LeaveGuard>((leave, scope) => {
    const asking = scopeUnsavedDrafts(draftsRef.current, scope ?? null);
    if (asking.length === 0) leave();
    else setPendingLeave({ leave, scope: scope ?? null });
  }, []);

  useBrowserLeavePrompt(drafts.length > 0);

  const value = useMemo(() => ({ setDraft, guard }), [setDraft, guard]);
  const leaveNow = () => {
    const pending = pendingLeave;
    setPendingLeave(null);
    if (!pending) return;
    // Editors that can drop their own changes do so; the older panels keep
    // theirs until they unmount, as before.
    for (const draft of scopeUnsavedDrafts(draftsRef.current, pending.scope)) draft.discard?.();
    pending.leave();
  };
  // The question keeps its scope while the dialog animates closed, so its words don't change under the vendor.
  const askedScope = useRef<readonly string[] | null>(null);
  if (pendingLeave) askedScope.current = pendingLeave.scope;
  const asking = scopeUnsavedDrafts(drafts, askedScope.current);

  return (
    <UnsavedChangesContext.Provider value={value}>
      <UnsavedDraftsContext.Provider value={drafts}>
        {children}
      </UnsavedDraftsContext.Provider>
      <AlertDialog open={pendingLeave !== null} onOpenChange={(open) => { if (!open) setPendingLeave(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{describeLeavePrompt(asking) ?? "Your changes aren't saved."}</AlertDialogDescription>
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
 * An editor that counts its changes passes `extra`: the count words the leave
 * prompt ("You have 2 changes that aren't saved."), and `discard`, which must
 * keep one identity across renders, drops them on "Discard and leave".
 */
export function useUnsavedDraft(id: string, label: string, dirty: boolean, extra?: UnsavedDraftExtra): void {
  const context = useContext(UnsavedChangesContext);
  const changes = extra?.changes;
  const discard = extra?.discard;
  useEffect(() => {
    context?.setDraft(id, label, dirty, changes !== undefined && discard !== undefined ? { changes, discard } : undefined);
  }, [context, id, label, dirty, changes, discard]);
  useEffect(() => () => context?.setDraft(id, label, false), [context, id, label]);
}

/**
 * While `asking` is true, closing or reloading the tab gets the browser's own
 * prompt. The page's guard asks while anything is unsaved; an editor asks too
 * while a save is in flight that the guard leaves out, since closing the tab
 * loses the save's answer.
 */
export function useBrowserLeavePrompt(asking: boolean): void {
  useEffect(() => {
    if (!asking) return undefined;
    const askBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", askBeforeUnload);
    return () => window.removeEventListener("beforeunload", askBeforeUnload);
  }, [asking]);
}

/** Every editor's unsaved draft on the page (the bar and "Older settings" read them). Empty outside an UnsavedChangesProvider. */
export function useUnsavedDrafts(): readonly UnsavedDraft[] {
  return useContext(UnsavedDraftsContext);
}

/**
 * Runs `leave` at once when nothing is unsaved, or after the vendor chooses
 * "Discard and leave". Outside an UnsavedChangesProvider it always runs at once.
 */
export function useLeaveGuard(): LeaveGuard {
  return useContext(UnsavedChangesContext)?.guard ?? leaveAtOnce;
}

function leaveAtOnce(leave: () => void): void {
  leave();
}

/**
 * A wouter Link that goes through the leave guard. wouter itself leaves a
 * click that opens a new tab or window (modifier keys, other buttons) to the
 * browser without calling onClick, so the current tab and its unsaved
 * changes stay as they are. With `scope`, only the drafts with those ids
 * count, as for `useLeaveGuard` (a link onto the step that holds a draft
 * leaves that draft out, since going there drops nothing).
 */
export function GuardedLink({ href, onClick, scope, ...props }: ComponentProps<typeof Link> & { href: string; scope?: readonly string[] }) {
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
        guard(() => navigate(href), scope);
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

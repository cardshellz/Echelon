import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type Block = { dirty: boolean; unresolved: boolean; discard?: () => void };
type Navigation = { register(id: string, block: Block | null): void; request(action: () => void): void };
const Context = createContext<Navigation>({ register: () => undefined, request: action => action() });

export function DraftNavigation({ children }: { children: ReactNode }) {
  const blocks = useRef(new Map<string, Block>());
  const [pending, setPending] = useState<{ action: () => void; unresolved: boolean } | null>(null);
  const register = useCallback((id: string, block: Block | null) => {
    if (block) blocks.current.set(id, block); else blocks.current.delete(id);
  }, []);
  const request = useCallback((action: () => void) => {
    const current = [...blocks.current.values()];
    if (current.some(block => block.unresolved || block.dirty)) {
      setPending({ action, unresolved: current.some(block => block.unresolved) });
    } else action();
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (![...blocks.current.values()].some(block => block.dirty || block.unresolved)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  return <Context.Provider value={{ register, request }}>
    {children}
    <AlertDialog open={pending !== null} onOpenChange={open => { if (!open) setPending(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.unresolved ? "Resolve the save first" : "Discard unsaved changes?"}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.unresolved
            ? "A save is still pending or its outcome is unknown. Stay here and retry the same save before changing channels or closing the editor."
            : "Your unsaved edits will be discarded. Saved drafts and live settings will not change."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          {!pending?.unresolved && <AlertDialogAction onClick={event => {
            // Recheck: a save could have started while this dialog was open.
            if ([...blocks.current.values()].some(block => block.unresolved)) {
              event.preventDefault();
              setPending(current => current ? { ...current, unresolved: true } : null); return;
            }
            for (const block of blocks.current.values()) if (block.dirty) block.discard?.();
            const action = pending?.action; setPending(null); action?.();
          }}>Discard changes</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Context.Provider>;
}

export function useDraftNavigation() { return useContext(Context).request; }
export function useDraftNavigationBlock(dirty: boolean, unresolved: boolean, discard?: () => void) {
  const id = useId();
  const { register } = useContext(Context);
  useEffect(() => { register(id, { dirty, unresolved, discard }); return () => register(id, null); }, [id, dirty, unresolved, discard, register]);
}

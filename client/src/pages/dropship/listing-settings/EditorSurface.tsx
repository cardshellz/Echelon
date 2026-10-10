import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import { NotSavedBadge } from "../catalog/UnsavedChangesGuard";

/** Something that can take focus back when the editor closes, such as a row's [Change] button. */
export interface FocusReturnTarget {
  readonly current: HTMLElement | null;
}

export interface EditorSurfaceProps {
  open: boolean;
  /** The editor's name, e.g. "Shipping policy". */
  title: string;
  /** Shows "● Not saved" beside the title. */
  notSaved: boolean;
  /** × or Esc. The caller decides whether to ask first (`requestClose`). */
  onClose: () => void;
  /** [Cancel] [Save] and the save state; sticky at the bottom of a phone sheet. */
  footer: ReactNode;
  children: ReactNode;
  /** Gets focus back when the editor closes (R:97). */
  returnFocusTo?: FocusReturnTarget;
  /** One line under the title. */
  description?: ReactNode;
}

const FOCUSABLE = "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * Where a Store defaults editor opens (plan 4.6, 4.7): an inline panel under
 * its row at 640 px and wider, a bottom sheet with a sticky footer below.
 * Esc closes it either way, and focus goes back to `returnFocusTo`. Keep it
 * mounted and pass `open={false}` to close it: focus goes back on that change.
 */
export function EditorSurface(props: EditorSurfaceProps) {
  const wide = useMinWidth(SM_MIN_WIDTH_PX);
  return wide ? <InlineEditorPanel {...props} /> : <EditorBottomSheet {...props} />;
}

function InlineEditorPanel({ open, title, notSaved, onClose, footer, children, returnFocusTo, description }: EditorSurfaceProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  // Starts closed, so an editor that mounts already open still takes focus.
  const wasOpen = useRef(false);

  useEffect(() => {
    const panel = panelRef.current;
    if (open && !wasOpen.current && panel && !panel.contains(document.activeElement)) {
      // Like a dialog: focus moves into the editor that just opened.
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    if (!open && wasOpen.current) focusIfConnected(returnFocusTo?.current ?? null);
    wasOpen.current = open;
  }, [open, returnFocusTo]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A list or menu opened from inside the editor sits in a portal outside
    // this panel; its Esc closes that list only.
    if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target)) return;
    event.preventDefault();
    onClose();
  };

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="editor-surface"
      data-surface="inline"
      onKeyDown={onKeyDown}
      className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={titleId} className="text-sm font-semibold text-zinc-900">{title}</h4>
        {notSaved && <NotSavedBadge />}
      </div>
      {description && <p className="mt-1 text-sm text-zinc-600">{description}</p>}
      <div className="mt-3 space-y-3">{children}</div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2" data-testid="editor-surface-footer">{footer}</div>
    </section>
  );
}

function EditorBottomSheet({ open, title, notSaved, onClose, footer, children, returnFocusTo, description }: EditorSurfaceProps) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="bottom"
        data-testid="editor-surface"
        data-surface="sheet"
        // With no description, Radix's aria-describedby would point at nothing (and it warns), so it is dropped.
        {...(description ? {} : { "aria-describedby": undefined })}
        onCloseAutoFocus={(event) => {
          // The sheet has no trigger, so Radix would send focus to <body>.
          const target = returnFocusTo?.current ?? null;
          if (!target || !target.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
        className="flex max-h-[90dvh] flex-col gap-0 p-0 motion-reduce:animate-none motion-reduce:transition-none"
      >
        <SheetHeader className="px-4 pb-2 pr-12 pt-4 text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
            {title}
            {notSaved && <NotSavedBadge />}
          </SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
        <div
          className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-background px-4 py-3"
          data-testid="editor-surface-footer"
        >
          {footer}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function focusIfConnected(target: HTMLElement | null): void {
  if (target && target.isConnected) target.focus();
}

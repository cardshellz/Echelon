import { useEffect, useId, useRef } from "react";

interface NavigationGuard {
  /** Initialized once at the document boundary; tests may inject a fixed ID. */
  documentId: string;
  enabled: boolean;
  pending: boolean;
  shouldConfirm(destination: URL, source: URL): boolean;
  onConfirmedDiscard(destination: URL): void;
}

/** Wouter's history events are notifications after navigation, not blockers.
 * Guard push/replace before they run and native history before its subscribers
 * can unmount the editor. Known traversals are restored with history.go, never
 * by overwriting the destination entry. Unknown entries may be traversed: the
 * route host retains only unsaved workspaces until saved/discarded. */
export function useListingNavigationGuard(guard: NavigationGuard): void {
  const guardId = useId();
  const activationSequence = useRef(0);
  const current = useRef(guard);
  current.current = guard;
  useEffect(() => {
    if (!guard.enabled) return;
    let acceptedHref = window.location.href;
    const originalPush = window.history.pushState;
    const originalReplace = window.history.replaceState;
    const epoch = `${guard.documentId}:${guardId}:${++activationSequence.current}`;
    let acceptedIndex = 0;
    let restoring = false;
    const stamp = (state: unknown, index: number) => ({
      ...(state && typeof state === "object" ? state : {}),
      echelonListingNavigation: { epoch, index },
    });
    originalReplace.call(
      window.history,
      stamp(window.history.state, acceptedIndex),
      "",
      acceptedHref,
    );
    function permit(destination: URL): boolean {
      if (destination.href === acceptedHref) return true;
      if (current.current.pending) {
        window.alert(
          "Wait for the draft save to finish before leaving this page.",
        );
        return false;
      }
      if (!current.current.shouldConfirm(destination, new URL(acceptedHref)))
        return true;
      if (
        !window.confirm(
          "Discard unsaved draft changes and leave this page? Saved drafts and live listings will not change.",
        )
      )
        return false;
      current.current.onConfirmedDiscard(destination);
      return true;
    }
    function wrap(
      original: History["pushState"],
      pushes: boolean,
    ): History["pushState"] {
      return function (data, unused, url) {
        const destination = new URL(
          url?.toString() ?? window.location.href,
          window.location.href,
        );
        if (!permit(destination)) return;
        const nextIndex = acceptedIndex + (pushes ? 1 : 0);
        original.call(window.history, stamp(data, nextIndex), unused, url);
        acceptedIndex = nextIndex;
        acceptedHref = window.location.href;
      };
    }
    const push = wrap(originalPush, true);
    const replace = wrap(originalReplace, false);
    window.history.pushState = push;
    window.history.replaceState = replace;
    const onPopState = (event: PopStateEvent) => {
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const destination = new URL(window.location.href);
      const entry = event.state?.echelonListingNavigation;
      const known = entry?.epoch === epoch && Number.isSafeInteger(entry.index);
      if (known && entry.index !== acceptedIndex && !permit(destination)) {
        event.stopImmediatePropagation();
        restoring = true;
        window.history.go(acceptedIndex - entry.index);
        return;
      }
      acceptedHref = destination.href;
      if (known) acceptedIndex = entry.index;
      else {
        // Adopt an unknown entry without changing its URL; unsaved UI remains
        // mounted in the route host, so no pending buffer is discarded.
        acceptedIndex = 0;
        originalReplace.call(
          window.history,
          stamp(window.history.state, acceptedIndex),
          "",
          destination.href,
        );
      }
    };
    window.addEventListener("popstate", onPopState, true);
    return () => {
      if (window.history.pushState === push)
        window.history.pushState = originalPush;
      if (window.history.replaceState === replace)
        window.history.replaceState = originalReplace;
      window.removeEventListener("popstate", onPopState, true);
    };
  }, [guard.enabled, guard.documentId, guardId]);
  // Retained hidden sessions still need refresh/tab-close protection.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !current.current.pending &&
        !current.current.shouldConfirm(
          new URL("/", window.location.origin),
          new URL(window.location.href),
        )
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
}

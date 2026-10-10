import { useCallback, useSyncExternalStore } from "react";

/**
 * Tailwind's `sm` breakpoint. Below it the Listing settings step uses its
 * phone layout (design 3.4: phones are below 640 px). `useIsMobile` breaks at
 * 768 px, so it does not fit here.
 */
export const SM_MIN_WIDTH_PX = 640;

/**
 * Whether the window is at least `minWidthPx` wide, kept up to date as it
 * resizes. Without a window (a static render, a test) it answers true, so the
 * wide layout is the default; a test stubs `window.matchMedia` to get the
 * narrow one.
 */
export function useMinWidth(minWidthPx: number): boolean {
  const query = minWidthQuery(minWidthPx);
  const subscribe = useCallback((onChange: () => void) => {
    const list = mediaQueryList(query);
    if (!list) return () => undefined;
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  const snapshot = () => mediaQueryList(query)?.matches ?? true;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The media query for "at least this wide". Refuses a width that is not a positive whole number of pixels. */
export function minWidthQuery(minWidthPx: number): string {
  if (!Number.isSafeInteger(minWidthPx) || minWidthPx <= 0) {
    throw new Error(`useMinWidth needs a positive whole number of pixels, not ${String(minWidthPx)}.`);
  }
  return `(min-width: ${minWidthPx}px)`;
}

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

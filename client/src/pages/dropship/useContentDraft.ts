import { useEffect, useRef, useState } from "react";
import { createDropshipIdempotencyKey, DropshipApiError, fetchJson, putJson, queryErrorMessage } from "@/lib/dropship-ops-surface";

export interface ContentSaveCallbacks {
  disabled?: boolean; onSaveStarted(): void; onSaveSettled(): void; onSaved(): Promise<void>;
}
/** One editor session owns its version and retry key; background reads never replace a dirty draft. */
export function useContentDraft<State, Draft>(options: {
  endpoint: string; read(value: unknown): State; draftFrom(state: State): Draft;
  request(state: State, draft: Draft): Record<string, unknown>; validateSave(value: unknown): void;
  callbacks: ContentSaveCallbacks;
  refreshToken?: string;
  matchesRefreshToken?(state: State, token: string | undefined): boolean;
}) {
  const latest = useRef(options); latest.current = options;
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const attempt = useRef<Record<string, unknown> | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [phase, setPhase] = useState<"loading" | "editing" | "saving" | "uncertain" | "conflict" | "refresh_error">("loading");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lastRefreshToken = useRef(options.refreshToken);
  async function load(keepDraft = false) {
    const current = latest.current.read(await fetchJson(latest.current.endpoint));
    if (mounted.current) { setState(current); if (!keepDraft) setDraft(latest.current.draftFrom(current)); }
  }
  useEffect(() => {
    mounted.current = true;
    void load().then(() => { if (mounted.current) setPhase("editing"); }).catch((caught) => {
      if (mounted.current) { setError(queryErrorMessage(caught, "Content could not be loaded.")); setPhase("conflict"); }
    });
    return () => { mounted.current = false; };
  }, [options.endpoint]);
  useEffect(() => {
    if (lastRefreshToken.current === options.refreshToken) return;
    lastRefreshToken.current = options.refreshToken;
    if (!state || phase !== "editing" || options.matchesRefreshToken?.(state, options.refreshToken)) return;
    if (JSON.stringify(draft) !== JSON.stringify(options.draftFrom(state))) {
      setPhase("conflict"); setError("Content changed while you were editing. Your text is preserved; reload and reconcile it with the current description before saving.");
    } else { void reload(); }
  }, [options.refreshToken]);
  function edit(next: Draft) {
    if (phase !== "editing" || options.callbacks.disabled) return;
    setDraft(next); setError(""); setMessage(""); attempt.current = null;
  }
  function discard(): boolean {
    // Cancel only a local edit. An uncertain write must be reconciled with the
    // server, never presented as though it could be undone locally.
    if (inFlight.current || phase !== "editing" || state === null || options.callbacks.disabled) return false;
    setDraft(options.draftFrom(state)); setError(""); setMessage(""); attempt.current = null;
    return true;
  }
  async function reload(keepDraft = false): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true; setPhase("loading"); setError("");
    try {
      await load(keepDraft); attempt.current = null;
      if (mounted.current) { setPhase("editing"); setMessage(keepDraft ? "Latest saved content loaded. Your draft is preserved; compare it before saving." : ""); }
      return mounted.current;
    }
    catch (caught) {
      if (mounted.current) { setError(queryErrorMessage(caught, "Content could not be reloaded.")); setPhase("conflict"); }
      return false;
    }
    finally { inFlight.current = false; }
  }
  async function save(): Promise<boolean> {
    if (inFlight.current || !state || draft === null || options.callbacks.disabled || !["editing", "uncertain"].includes(phase)) return false;
    let request: Record<string, unknown>;
    try { request = attempt.current ?? { ...options.request(state, draft), idempotencyKey: createDropshipIdempotencyKey("listing-content") }; }
    catch (caught) { setError(queryErrorMessage(caught, "Check the description fields.")); return false; }
    attempt.current = request;
    inFlight.current = true; setPhase("saving"); setError(""); setMessage("");
    const callbacks = options.callbacks;
    let started = false;
    let saved = false;
    try {
      callbacks.onSaveStarted(); started = true;
      options.validateSave(await putJson(options.endpoint, request)); saved = true; attempt.current = null;
      await load();
      await callbacks.onSaved();
      if (mounted.current) { setPhase("editing"); setMessage("Draft saved and preview refreshed. No live listing was changed."); }
      return mounted.current;
    } catch (caught) {
      if (mounted.current) {
        setPhase(saved ? "refresh_error" : caught instanceof DropshipApiError && caught.status < 500 ? "conflict" : "uncertain");
        setError(saved ? "Draft saved, but the preview could not be refreshed. Retry the preview refresh."
          : queryErrorMessage(caught, "Save was not confirmed. Retry the same save to confirm its outcome."));
      }
      return false;
    } finally {
      inFlight.current = false;
      if (started) callbacks.onSaveSettled();
    }
  }
  async function refreshPreview(): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true; setPhase("loading"); setError("");
    try {
      await load(); await options.callbacks.onSaved();
      if (mounted.current) { setPhase("editing"); setMessage("Saved draft and preview refreshed. No live listing was changed."); }
      return mounted.current;
    } catch (caught) {
      if (mounted.current) { setError(queryErrorMessage(caught, "Preview refresh failed.")); setPhase("refresh_error"); }
      return false;
    }
    finally { inFlight.current = false; }
  }
  return { state, draft, edit, discard, save, reload, refreshPreview, phase, error, message,
    busy: ["loading", "saving"].includes(phase), editable: phase === "editing" && !options.callbacks.disabled };
}

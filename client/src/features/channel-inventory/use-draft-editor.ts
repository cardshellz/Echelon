import { useEffect, useRef, useState } from "react";
import { ChannelInventoryApiError, describeError } from "./api";
import { canReplaceDraftBaseline, isDefinitiveDraftRejection, type DraftSaveState } from "./draft-session";
import { useDraftNavigationBlock } from "./DraftNavigation";

/** Pins the edited revision and the exact retry payload, independent of query refreshes. */
export function useDraftEditor<Value, Baseline, Command, Result>(options: {
  value: Value;
  baseline: Baseline;
  fingerprint: string;
  equal(left: Value, right: Value): boolean;
  build(value: Value, baseline: Baseline, idempotencyKey: string): Command;
  send(command: Command): Promise<Result>;
  onSaved(result: Result): void | Promise<void>;
}) {
  const [captured, setCaptured] = useState(() => ({
    value: options.value, baseline: options.baseline, fingerprint: options.fingerprint,
  }));
  const [value, setValue] = useState(options.value);
  const [saveState, setSaveState] = useState<DraftSaveState<Command>>({ kind: "idle" });
  const inFlight = useRef(false);
  const retained = useRef<Command | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = !options.equal(value, captured.value);
  const stale = captured.fingerprint !== options.fingerprint;
  const uncertain = saveState.kind === "uncertain";
  const pending = saveState.kind === "saving";
  const conflict = saveState.kind === "conflict" || (stale && dirty);

  useEffect(() => {
    if (!stale || !canReplaceDraftBaseline({ dirty, saveState: saveState.kind })) return;
    setCaptured({ value: options.value, baseline: options.baseline, fingerprint: options.fingerprint });
    setValue(options.value);
    setError(null);
  }, [stale, dirty, saveState.kind, options.value, options.baseline, options.fingerprint]);

  const reset = () => {
    if (inFlight.current || uncertain) return;
    retained.current = null;
    setCaptured({ value: options.value, baseline: options.baseline, fingerprint: options.fingerprint });
    setValue(options.value);
    setSaveState({ kind: "idle" });
    setError(null);
  };
  useDraftNavigationBlock(dirty || conflict, pending || uncertain, reset);
  const save = async () => {
    if (inFlight.current || (conflict && !uncertain)) return;
    let command: Command;
    try {
      command = retained.current ?? options.build(value, captured.baseline, crypto.randomUUID());
    } catch (failure) {
      // Local input validation did not send a request. It is safe to edit again.
      setError(failure instanceof Error ? failure.message : "Check the entered values.");
      return;
    }
    retained.current = command;
    inFlight.current = true;
    setSaveState({ kind: "saving", command });
    setError(null);
    let result: Result;
    try {
      result = await options.send(command);
    } catch (failure) {
      const status = failure instanceof ChannelInventoryApiError ? failure.status : null;
      const rejected = isDefinitiveDraftRejection(status);
      if (rejected) retained.current = null;
      setSaveState(status === 409 ? { kind: "conflict" }
        : rejected ? { kind: "idle" } : { kind: "uncertain", command });
      setError(rejected ? describeError(failure).message
        : "The save outcome is unknown. Retry the same save to recover its result before editing or leaving this workspace.");
      inFlight.current = false;
      return;
    }
    // A failed cache refresh must not turn a confirmed save into an uncertain write.
    retained.current = null;
    inFlight.current = false;
    setCaptured(current => ({ ...current, value }));
    setSaveState({ kind: "idle" });
    try { await options.onSaved(result); }
    catch {
      setSaveState({ kind: "conflict" });
      setError("The draft was saved, but the latest view could not be loaded. Reload before editing again.");
    }
  };
  return { value, setValue, dirty, pending, uncertain, conflict, error, save, reset,
    locked: pending || uncertain || conflict,
    baseline: captured.baseline };
}

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  archiveReturnPolicy,
  formatReturnPolicyArchiveContext,
  loadReturnPolicyArchivePreview,
  ReturnPolicyArchiveError,
  type ReturnPolicyArchiveReferences,
} from "@/lib/return-policy-archive";
import type {
  ReturnPolicyArchiveInput,
  ReturnPolicyArchivePreview,
} from "@shared/returns/return-policy-archive.contract";

interface ArchiveIntent {
  input: ReturnPolicyArchiveInput;
  key: string;
}

export function ReturnPolicyArchiveDialog({
  policyId,
  references,
  onClose,
  onArchived,
}: {
  policyId: number;
  references: ReturnPolicyArchiveReferences;
  onClose: () => void;
  onArchived: () => void;
}) {
  const [preview, setPreview] = useState<ReturnPolicyArchivePreview | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [intent, setIntent] = useState<ArchiveIntent | null>(null);
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPreview(null);
    setError(null);
    setBlocked(false);
    setIntent(null);
    void loadReturnPolicyArchivePreview(policyId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setPreview(next);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof ReturnPolicyArchiveError
              ? cause.message
              : "The archive impact could not be loaded. Try again.",
          );
          setBlocked(
            cause instanceof ReturnPolicyArchiveError &&
              [
                "RETURN_POLICY_ACCESS_REQUIRED",
                "RETURN_POLICY_NOT_ACTIVE",
              ].includes(cause.code),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [policyId, attempt]);
  useEffect(() => () => saveController.current?.abort(), []);

  async function apply() {
    if (!preview || loading || saving || blocked) return;
    const command = intent ?? {
      input: {
        expectedVersion: preview.policy.version,
        previewRevision: preview.revision,
      },
      key: crypto.randomUUID(),
    };
    setIntent(command);
    setError(null);
    setSaving(true);
    const controller = new AbortController();
    saveController.current = controller;
    try {
      await archiveReturnPolicy(
        policyId,
        command.input,
        command.key,
        controller.signal,
      );
      if (!controller.signal.aborted) onArchived();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof ReturnPolicyArchiveError
          ? cause.message
          : "The archive outcome could not be confirmed. Retry the same request to check its outcome.",
      );
      if (cause instanceof ReturnPolicyArchiveError) {
        if (cause.code === "RETURN_POLICY_ARCHIVE_CHANGED") {
          setPreview(null);
          setIntent(null);
        } else if (
          [
            "RETURN_POLICY_ACCESS_REQUIRED",
            "RETURN_POLICY_NOT_ACTIVE",
          ].includes(cause.code)
        ) {
          setPreview(null);
          setBlocked(true);
        }
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Archive return policy</DialogTitle>
          <DialogDescription>
            Review which policy will apply to future returns. Existing returns
            and their policy history are retained.
          </DialogDescription>
        </DialogHeader>
        {loading && <p role="status">Checking policy impact…</p>}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {preview && (
          <div
            className="space-y-4 text-sm"
            data-testid="return-policy-archive-impact"
          >
            <p>
              <strong>{preview.policy.name}</strong> · version{" "}
              {preview.policy.version} · {preview.policy.returnWindowDays}-day
              return window
            </p>
            <div className="space-y-2">
              <h3 className="font-medium">After archiving</h3>
              {preview.effects.length === 0 && (
                <p>No currently resolved policy contexts change.</p>
              )}
              {preview.effects.map((effect, index) => (
                <div
                  key={`${effect.contextLabel}:${index}`}
                  className="rounded-md border p-3"
                  data-testid={`archive-effect-${index}`}
                >
                  <p className="break-words font-medium">
                    {formatReturnPolicyArchiveContext(
                      effect.contextLabel,
                      references,
                    )}
                  </p>
                  <p>
                    {effect.after
                      ? `${effect.after.name} · version ${effect.after.version} · ${effect.after.returnWindowDays}-day return window`
                      : "No active policy. New returns in this context will be blocked until a policy applies."}
                  </p>
                </div>
              ))}
            </div>
            {preview.unaffectedMoreSpecificPolicies.length > 0 && (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">
                  More specific policies stay active (
                  {preview.unaffectedMoreSpecificPolicies.length})
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {preview.unaffectedMoreSpecificPolicies.map((policy) => (
                    <li key={policy.id}>
                      {policy.name} · version {policy.version}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="rounded-md bg-muted p-3">
              {preview.historicalReferences.returnCases} return cases and{" "}
              {preview.historicalReferences.portalIntakes} portal returns keep
              their original policy records. Archiving does not delete them or
              change refunds, inventory, or purchased labels.
            </p>
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          {!preview && !loading && !blocked && (
            <Button
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Refresh impact
            </Button>
          )}
          {preview && (
            <Button
              variant="destructive"
              disabled={loading || saving || blocked}
              onClick={() => void apply()}
            >
              {saving
                ? "Archiving…"
                : intent
                  ? "Retry archive"
                  : "Archive policy"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

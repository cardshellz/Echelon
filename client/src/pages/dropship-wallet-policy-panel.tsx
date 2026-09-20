/**
 * Dropship "Wallet policy" tab — the staff surface for the six limits the
 * vendor wallet enforces (migration 0681).
 *
 * This component only renders and posts. Every decision — dollars to integer
 * cents, the cross-field rules, whether the form still matches what is in
 * force, the request body, what a server error code means — lives in
 * `dropship-wallet-policy-model.ts`.
 *
 * Two things it deliberately does NOT do:
 *  - it never edits the card funding fee (served read-only, with the server's
 *    own reason), and
 *  - it never computes the impact counts locally. The server measures the
 *    vendor population, including for a candidate policy, and this page prints
 *    the numbers it is given.
 */

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, Save, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  postJson,
  queryErrorCode,
  queryErrorMessage,
} from "@/lib/dropship-ops-surface";
import {
  DROPSHIP_WALLET_POLICY_ADMIN_URL,
  DROPSHIP_WALLET_POLICY_IDEMPOTENCY_PREFIX,
  DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS,
  buildDropshipWalletPolicyOverviewUrl,
  buildDropshipWalletPolicyVersionRequest,
  dropshipWalletPolicyEnvLabel,
  dropshipWalletPolicyFormFromLimits,
  dropshipWalletPolicyLimitsKey,
  dropshipWalletPolicyProposedMinimums,
  dropshipWalletPolicySaveErrorMessage,
  dropshipWalletPolicySourceLabel,
  emptyDropshipWalletPolicyForm,
  formatDropshipBasisPoints,
  isDropshipWalletPolicyFormDirty,
  parseDropshipWalletPolicyForm,
  parseDropshipWalletPolicyMutation,
  parseDropshipWalletPolicyOverview,
  type DropshipWalletPolicyForm,
  type DropshipWalletPolicyImpactView,
  type DropshipWalletPolicyLimitsView,
  type DropshipWalletPolicyOverview,
} from "./dropship-wallet-policy-model";

export function DropshipWalletPolicyPanel({
  canView,
  canEdit,
}: {
  canView: boolean;
  canEdit: boolean;
}) {
  // The draft is keyed by the limits it was started from. When a new version is
  // published — by this operator or another — the key stops matching and the
  // form falls back to the new baseline instead of silently editing a policy
  // that no longer exists.
  const [draft, setDraft] = useState<{
    limitsKey: string;
    form: DropshipWalletPolicyForm;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const overviewQuery = useQuery<DropshipWalletPolicyOverview>({
    queryKey: [DROPSHIP_WALLET_POLICY_ADMIN_URL],
    queryFn: async ({ signal }) =>
      parseDropshipWalletPolicyOverview(
        await fetchJson<unknown>(DROPSHIP_WALLET_POLICY_ADMIN_URL, { signal }),
      ),
    enabled: canView,
  });
  // A disabled query can still hold cached data from before a permission
  // change, so the permission — not the cache — decides what is rendered.
  const overview = canView ? overviewQuery.data : undefined;

  const baselineKey = overview ? dropshipWalletPolicyLimitsKey(overview.limits) : null;
  const form = overview
    ? draft && draft.limitsKey === baselineKey
      ? draft.form
      : dropshipWalletPolicyFormFromLimits(overview.limits)
    : emptyDropshipWalletPolicyForm;

  const parsed = useMemo(() => parseDropshipWalletPolicyForm(form), [form]);
  const errors = parsed.success ? {} : parsed.errors;
  const dirty = overview ? isDropshipWalletPolicyFormDirty(form, overview.limits) : false;

  // A proposal only exists when a MINIMUM differs from what is in force; the
  // overview already measured the population against the limits in force.
  const proposal = overview
    ? dropshipWalletPolicyProposedMinimums(form, overview.limits)
    : null;
  const proposedImpactUrl = proposal
    ? buildDropshipWalletPolicyOverviewUrl(proposal)
    : null;
  const proposedImpactQuery = useQuery<DropshipWalletPolicyOverview>({
    queryKey: [proposedImpactUrl ?? "wallet-policy-no-proposal"],
    queryFn: async ({ signal }) => {
      if (!proposedImpactUrl) throw new Error("No proposed wallet policy minimums to measure.");
      return parseDropshipWalletPolicyOverview(
        await fetchJson<unknown>(proposedImpactUrl, { signal }),
      );
    },
    enabled: canView && proposedImpactUrl !== null,
  });
  const proposedImpact = proposedImpactUrl ? proposedImpactQuery.data?.impact : undefined;
  const impact = proposedImpact ?? overview?.impact ?? null;

  function updateForm(patch: Partial<DropshipWalletPolicyForm>) {
    if (!canEdit || !overview || !baselineKey || busy) return;
    setDraft({ limitsKey: baselineKey, form: { ...form, ...patch } });
    setMessage("");
  }

  function clearFeedback() {
    setMessage("");
    setError("");
  }

  function resetForm() {
    setDraft(null);
    clearFeedback();
  }

  async function savePolicy() {
    if (!canEdit || !overview || !parsed.success || busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const body = buildDropshipWalletPolicyVersionRequest({
        limits: parsed.limits,
        changeNote: parsed.changeNote,
        // One key per save attempt, as on the carrier-protection tab: it makes
        // a double-submit of THIS attempt a replay rather than a second version.
        idempotencyKey: createDropshipIdempotencyKey(
          DROPSHIP_WALLET_POLICY_IDEMPOTENCY_PREFIX,
        ),
      });
      const result = parseDropshipWalletPolicyMutation(
        await postJson<unknown>(DROPSHIP_WALLET_POLICY_ADMIN_URL, body),
      );
      setMessage(
        result.idempotentReplay
          ? `Wallet policy version ${result.policy.version} was already published; nothing changed.`
          : `Wallet policy version ${result.policy.version} published. Vendor auto-reload settings were not rewritten.`,
      );
      setDraft(null);
      await overviewQuery.refetch();
    } catch (caught) {
      setError(
        dropshipWalletPolicySaveErrorMessage(
          queryErrorCode(caught),
          queryErrorMessage(caught, "The wallet policy was not saved."),
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <section className="rounded-md border bg-card p-4" data-testid="wallet-policy-permission-required">
        <h2 className="text-lg font-semibold">Wallet policy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The dropship view permission is required. No wallet policy data is shown.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Wallet className="h-5 w-5" />
              Wallet policy
            </h2>
            <p className="text-sm text-muted-foreground">
              The limits the vendor wallet enforces: the auto-reload floors, the manual top-up
              bounds, the payment hold timeout and the hold expiry warning window. Saving publishes
              a new immutable version and retires the current one.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {overview && (
              <Badge variant="outline" className="h-9 px-3">
                Read {formatDateTime(overview.generatedAt)}
              </Badge>
            )}
            <Button
              type="button"
              variant="outline"
              className="h-9 gap-2"
              disabled={busy || overviewQuery.isFetching}
              onClick={() => {
                // Edits survive a reload: the draft is keyed by the limits it
                // started from, so it is kept when they are unchanged and
                // dropped automatically when a new version has taken over.
                clearFeedback();
                void overviewQuery.refetch();
              }}
            >
              <RefreshCw
                className={overviewQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              />
              Reload policy
            </Button>
          </div>
        </div>

        {overviewQuery.isError && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(overviewQuery.error, "The wallet policy could not be read.")}
            </AlertDescription>
          </Alert>
        )}
        {!overview && overviewQuery.isLoading && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Loading the wallet policy…
          </p>
        )}
      </section>

      {overview && (
        <>
          <LimitSourceTable overview={overview} />

          <section className="rounded-md border bg-card p-4" data-testid="wallet-policy-form">
            <h3 className="font-semibold">New policy version</h3>
            <p className="text-sm text-muted-foreground">
              Amounts are dollars and are stored as whole cents. Timings are whole minutes.
              {canEdit
                ? " Publishing retires the current version in the same transaction."
                : " The dropship manage-operations permission is required to change these values."}
            </p>
            <fieldset
              disabled={!canEdit || busy}
              className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3"
            >
              {DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.map((descriptor) => {
                const inputId = `wallet-policy-${descriptor.formField}`;
                const fieldError = errors[descriptor.formField];
                return (
                  <div key={descriptor.formField} className="space-y-2">
                    <Label htmlFor={inputId}>
                      {descriptor.label}
                      {descriptor.unit === "cents" ? " ($)" : " (minutes)"}
                    </Label>
                    <Input
                      id={inputId}
                      inputMode={descriptor.unit === "cents" ? "decimal" : "numeric"}
                      value={form[descriptor.formField]}
                      disabled={!canEdit || busy}
                      onChange={(event) =>
                        updateForm({ [descriptor.formField]: event.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">{descriptor.help}</p>
                    {fieldError && (
                      <p role="alert" className="text-xs text-destructive">
                        {fieldError}
                      </p>
                    )}
                  </div>
                );
              })}
              <div className="space-y-2 md:col-span-2 xl:col-span-3">
                <Label htmlFor="wallet-policy-change-note">Change note (optional)</Label>
                <Textarea
                  id="wallet-policy-change-note"
                  value={form.changeNote}
                  disabled={!canEdit || busy}
                  placeholder="Why these limits are changing"
                  onChange={(event) => updateForm({ changeNote: event.target.value })}
                />
                {errors.changeNote && (
                  <p role="alert" className="text-xs text-destructive">
                    {errors.changeNote}
                  </p>
                )}
              </div>
            </fieldset>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                className="gap-2"
                disabled={!canEdit || busy || !dirty || !parsed.success}
                onClick={() => void savePolicy()}
              >
                <Save className="h-4 w-4" />
                {busy ? "Publishing…" : "Publish new version"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!canEdit || busy || !dirty}
                onClick={resetForm}
              >
                Discard changes
              </Button>
              {!dirty && (
                <span className="text-xs text-muted-foreground">
                  These values match the limits in force.
                </span>
              )}
            </div>
            {message && (
              <p role="status" className="mt-3 text-sm text-foreground">
                {message}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </section>

          <DropshipWalletPolicyImpactPanel
            impact={impact}
            isMeasuringProposal={proposedImpactUrl !== null && proposedImpactQuery.isFetching}
            proposalError={
              proposedImpactUrl !== null && proposedImpactQuery.isError
                ? queryErrorMessage(
                    proposedImpactQuery.error,
                    "The proposed minimums could not be measured.",
                  )
                : null
            }
          />

          <CardFundingFeePanel fee={overview.cardFundingFee} />
        </>
      )}
    </div>
  );
}

/**
 * Where each value in force came from. Staff should never have to guess whether
 * a number was published, inherited from a dyno config variable, or is simply
 * the column default, so both layers are shown side by side.
 */
function LimitSourceTable({ overview }: { overview: DropshipWalletPolicyOverview }) {
  const policy = overview.policy;
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Limits in force</h3>
        <Badge variant={overview.limitsSource === "policy" ? "default" : "outline"}>
          {overview.limitsSource === "policy"
            ? `Policy version ${policy?.version ?? "?"}`
            : "Environment fallback"}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {overview.limitsSource === "policy" && policy
          ? `Published ${formatDateTime(policy.createdAt)} by ${policy.createdBy.actorType}`
            + `${policy.createdBy.actorId ? ` ${policy.createdBy.actorId}` : ""}`
            + `${policy.changeNote ? ` — ${policy.changeNote}` : ""}`
          : "No policy version has been published, so the wallet is still running on the environment "
            + "values below. Publishing a version here takes over from them."}
      </p>
      <div className="mt-3 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Limit</TableHead>
              <TableHead className="text-right">In force</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Environment value</TableHead>
              <TableHead>Environment variable</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {DROPSHIP_WALLET_POLICY_LIMIT_DESCRIPTORS.map((descriptor) => {
              const envKey = overview.envKeys[descriptor.limitField];
              return (
                <TableRow key={descriptor.limitField}>
                  <TableCell>
                    <div className="font-medium">{descriptor.label}</div>
                    <div className="text-xs text-muted-foreground">{descriptor.help}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatLimit(overview.limits, descriptor.limitField, descriptor.unit)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {dropshipWalletPolicySourceLabel(overview.limitsSource, envKey)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatLimit(overview.envLimits, descriptor.limitField, descriptor.unit)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {dropshipWalletPolicyEnvLabel(envKey)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * The vendor population against the minimums the server measured. Every number
 * here — including which minimums it was measured against — comes from the
 * server's impact payload, so the page can never claim a count it invented.
 */
export function DropshipWalletPolicyImpactPanel({
  impact,
  isMeasuringProposal,
  proposalError,
}: {
  impact: DropshipWalletPolicyImpactView | null;
  isMeasuringProposal: boolean;
  proposalError: string | null;
}) {
  return (
    <section className="rounded-md border bg-card p-4" data-testid="wallet-policy-impact">
      <h3 className="font-semibold">Who this asks to change something</h3>
      {impact ? (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Measured against an auto-reload trigger floor of{" "}
            <span className="font-medium text-foreground">
              {formatCents(impact.proposedAutoReloadMinTriggerCents)}
            </span>{" "}
            and a minimum single top-up of{" "}
            <span className="font-medium text-foreground">
              {formatCents(impact.proposedAutoReloadMinAmountCents)}
            </span>
            , counted {formatDateTime(impact.evaluatedAt)}.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            <li data-testid="wallet-policy-impact-below-floor">
              <span className="font-medium tabular-nums">
                {impact.vendorsBelowMinimumFloor} of {impact.activeVendorsWithAutoReloadSettings}
              </span>{" "}
              active vendors with auto-reload settings have a trigger below that floor.
            </li>
            <li data-testid="wallet-policy-impact-below-limit">
              <span className="font-medium tabular-nums">
                {impact.vendorsBelowMinimumSingleTopUpLimit} of{" "}
                {impact.activeVendorsWithAutoReloadSettings}
              </span>{" "}
              active vendors with auto-reload settings have a single top-up limit below that
              minimum. A vendor with no single top-up limit saved is not counted.
            </li>
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            Saving does not change their stored settings. Those vendors keep the settings they
            saved and auto-reload keeps working; they are only asked to raise the value the next
            time they change their auto-reload settings themselves.
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          No vendor counts were returned with the policy.
        </p>
      )}
      {isMeasuringProposal && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Measuring the proposed minimums…
        </p>
      )}
      {proposalError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {proposalError} The counts above are the last ones the server returned. This does not
          block publishing.
        </p>
      )}
    </section>
  );
}

/**
 * The card funding fee, shown exactly as served. There is no input here on
 * purpose: the server owns the rate and explains why it cannot be edited from
 * this page.
 */
function CardFundingFeePanel({
  fee,
}: {
  fee: DropshipWalletPolicyOverview["cardFundingFee"];
}) {
  return (
    <section className="rounded-md border bg-card p-4" data-testid="wallet-policy-card-fee">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Card funding fee</h3>
        <Badge variant="outline">Read-only</Badge>
      </div>
      <p className="mt-2 text-sm">
        <span className="font-medium tabular-nums">{formatDropshipBasisPoints(fee.bps)}</span>{" "}
        ({fee.bps} bps), from{" "}
        <span className="font-medium">{fee.envKey}</span>.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{fee.readOnlyReason}</p>
    </section>
  );
}

function formatLimit(
  limits: DropshipWalletPolicyLimitsView,
  field: keyof DropshipWalletPolicyLimitsView,
  unit: "cents" | "minutes",
): string {
  const value = limits[field];
  return unit === "cents"
    ? formatCents(value)
    : `${value.toLocaleString("en-US")} min`;
}

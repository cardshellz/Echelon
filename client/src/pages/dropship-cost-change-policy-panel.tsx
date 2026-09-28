/**
 * Dropship "Cost changes" tab — the staff settings module for how a change to
 * a .ops cost reaches vendors (migration 0710,
 * docs/DROPSHIP-COST-CHANGE-CONTROLS.md): the notice before a higher cost is
 * charged, whether orders keep the current cost meanwhile, who is told, what
 * happens to listings, and how often costs are checked.
 *
 * This component only renders and posts. Every decision — the words for each
 * setting, boxes to integers, whether the form still matches what is in
 * force, the request body, what each version changed, which settings act
 * today, what a server error means — lives in
 * `dropship-cost-change-policy-model.ts`.
 *
 * The page never implies a setting acts before the code that enforces it has
 * shipped: the server reports which parts are live, and each setting shows it.
 */

import React, { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, Save, Scale } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
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
  formatDateTime,
  postJson,
  queryErrorCode,
  queryErrorMessage,
} from "@/lib/dropship-ops-surface";
import {
  DROPSHIP_BELOW_COST_LISTING_CHOICES,
  DROPSHIP_COST_CHANGE_ENFORCEMENT_PARTS,
  DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL,
  DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_PREFIX,
  DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH,
  DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS,
  DROPSHIP_COST_CHANGE_SETTING_GROUPS,
  DROPSHIP_COST_DECREASE_TIMING_CHOICES,
  DROPSHIP_RULE_PRICED_LISTING_CHOICES,
  buildDropshipCostChangePolicyVersionRequest,
  describeDropshipCostChangeToday,
  dropshipCostChangePolicyFormFromSettings,
  dropshipCostChangePolicyNeedsStaffConfirmation,
  dropshipCostChangePolicyRequestFingerprint,
  dropshipCostChangePolicySaveErrorMessage,
  dropshipCostChangePolicySettingsKey,
  formatDropshipCostChangePolicyActor,
  formatDropshipCostChangeSetting,
  isDropshipCostChangePolicyFormDirty,
  isDropshipCostChangePolicyPartlyEnforced,
  isDropshipCostChangeSettingInEffect,
  parseDropshipCostChangePolicyForm,
  parseDropshipCostChangePolicyMutation,
  parseDropshipCostChangePolicyOverview,
  summarizeDropshipCostChangePolicyVersion,
  type DropshipCostChangeChoice,
  type DropshipCostChangeEnforcementView,
  type DropshipCostChangePolicyForm,
  type DropshipCostChangePolicyFormErrors,
  type DropshipCostChangePolicyOverview,
  type DropshipCostChangeSettingDescriptor,
  type DropshipCostChangeSettingGroup,
} from "./dropship-cost-change-policy-model";
import { DropshipCostChangeActivityPanel } from "./dropship-cost-change-activity-panel";

export function DropshipCostChangePolicyPanel({
  canView,
  canEdit,
}: {
  canView: boolean;
  canEdit: boolean;
}) {
  // The draft is keyed by the settings it was started from. When a new version
  // is published — by this operator or another — the key stops matching and
  // the form falls back to the new baseline instead of silently editing a
  // policy that no longer exists.
  const [draft, setDraft] = useState<{ settingsKey: string; form: DropshipCostChangePolicyForm } | null>(null);
  // One idempotency key per distinct request: retrying the same settings and
  // note after a lost response replays the first attempt on the server
  // instead of publishing a second, identical version. Refs, not state: two
  // clicks inside one frame must see the same key and the in-flight flag
  // before React re-renders the disabled button.
  const pendingSave = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const saveInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const overviewQuery = useQuery<DropshipCostChangePolicyOverview>({
    queryKey: [DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL],
    queryFn: async ({ signal }) =>
      parseDropshipCostChangePolicyOverview(
        await fetchJson<unknown>(DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL, { signal }),
      ),
    enabled: canView,
  });
  // A disabled query can still hold cached data from before a permission
  // change, so the permission — not the cache — decides what is rendered.
  const overview = canView ? overviewQuery.data : undefined;

  const baselineKey = overview ? dropshipCostChangePolicySettingsKey(overview.settings) : null;
  const form = overview
    ? draft && draft.settingsKey === baselineKey
      ? draft.form
      : dropshipCostChangePolicyFormFromSettings(overview.settings)
    : null;
  const parsed = form ? parseDropshipCostChangePolicyForm(form) : null;
  const dirty = overview && form ? isDropshipCostChangePolicyFormDirty(form, overview.settings) : false;
  const needsConfirmation = overview ? dropshipCostChangePolicyNeedsStaffConfirmation(overview) : false;
  const canPublish = canEdit && !busy && parsed?.success === true && (dirty || needsConfirmation);

  function updateForm(patch: Partial<DropshipCostChangePolicyForm>) {
    if (!canEdit || !form || !baselineKey || busy) return;
    setDraft({ settingsKey: baselineKey, form: { ...form, ...patch } });
    setMessage("");
  }

  function resetForm() {
    setDraft(null);
    pendingSave.current = null;
    setMessage("");
    setError("");
  }

  async function publish() {
    if (!canPublish || !parsed?.success || saveInFlight.current) return;
    saveInFlight.current = true;
    const fingerprint = dropshipCostChangePolicyRequestFingerprint(parsed.settings, parsed.changeNote);
    const idempotencyKey = pendingSave.current?.fingerprint === fingerprint
      ? pendingSave.current.idempotencyKey
      : createDropshipIdempotencyKey(DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_PREFIX);
    pendingSave.current = { fingerprint, idempotencyKey };
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const body = buildDropshipCostChangePolicyVersionRequest({
        settings: parsed.settings,
        changeNote: parsed.changeNote,
        idempotencyKey,
      });
      const result = parseDropshipCostChangePolicyMutation(
        await postJson<unknown>(DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL, body),
      );
      setMessage(
        result.idempotentReplay
          ? `Version ${result.policy.version} was already published; nothing changed.`
          : `Version ${result.policy.version} published.`,
      );
      setDraft(null);
      pendingSave.current = null;
      await overviewQuery.refetch();
    } catch (caught) {
      const code = queryErrorCode(caught);
      // A refused key can never succeed; anything else keeps the key so a
      // retry of the same request is a replay.
      if (code === "DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT") pendingSave.current = null;
      setError(
        dropshipCostChangePolicySaveErrorMessage(
          code,
          queryErrorMessage(caught, "The cost change policy was not saved."),
        ),
      );
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <section className="rounded-md border bg-card p-4" data-testid="cost-change-policy-permission-required">
        <h2 className="text-lg font-semibold">Cost changes</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The dropship view permission is required. No cost change policy data is shown.
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
              <Scale className="h-5 w-5" />
              Cost changes
            </h2>
            <p className="text-sm text-muted-foreground">
              How a change to a .ops cost reaches vendors: the notice before a higher cost is charged,
              who is told, and what happens to their listings. Saving publishes a new version and
              retires the current one; every version is kept.
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
                // Edits survive a reload while the settings in force are
                // unchanged; a new version drops them automatically.
                setMessage("");
                setError("");
                void overviewQuery.refetch();
              }}
            >
              <RefreshCw className={overviewQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Reload policy
            </Button>
          </div>
        </div>

        {overviewQuery.isError && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(overviewQuery.error, "The cost change policy could not be read.")}
            </AlertDescription>
          </Alert>
        )}
        {!overview && overviewQuery.isLoading && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Loading the cost change policy…
          </p>
        )}
      </section>

      {overview && form && parsed && (
        <>
          <DropshipCostChangeEnforcementPanel enforcement={overview.enforcement} />
          <DropshipCostChangeActivityPanel />
          <SettingsInForceTable overview={overview} />

          <section className="rounded-md border bg-card p-4" data-testid="cost-change-policy-form">
            <h3 className="font-semibold">New policy version</h3>
            <p className="text-sm text-muted-foreground">
              {canEdit
                ? needsConfirmation
                  ? "No one on staff has approved these settings yet. Change them, or publish them as they are to confirm them."
                  : "Change any setting and say why. Publishing retires the current version in the same step."
                : "The dropship manage-operations permission is required to change these settings."}
            </p>
            <fieldset disabled={!canEdit || busy} className="mt-4 min-w-0 space-y-6">
              {DROPSHIP_COST_CHANGE_SETTING_GROUPS.map((group) => (
                <SettingGroupFields
                  key={group.group}
                  group={group.group}
                  title={group.title}
                  description={group.description}
                  form={form}
                  errors={parsed.success ? {} : parsed.errors}
                  enforcement={overview.enforcement}
                  disabled={!canEdit || busy}
                  onChange={updateForm}
                />
              ))}
              <div className="space-y-2">
                <Label htmlFor="cost-change-policy-changeNote">Change note</Label>
                <Textarea
                  id="cost-change-policy-changeNote"
                  value={form.changeNote}
                  maxLength={DROPSHIP_COST_CHANGE_POLICY_MAX_CHANGE_NOTE_LENGTH}
                  disabled={!canEdit || busy}
                  placeholder="Why the policy is changing. Kept with the version."
                  onChange={(event) => updateForm({ changeNote: event.target.value })}
                />
                {/* An empty note is the starting state, not a mistake: it is named below the buttons instead. */}
                {!parsed.success && parsed.errors.changeNote && form.changeNote.trim() !== "" && (
                  <p role="alert" className="text-xs text-destructive">
                    {parsed.errors.changeNote}
                  </p>
                )}
              </div>
            </fieldset>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                className="gap-2"
                disabled={!canPublish}
                onClick={() => void publish()}
                data-testid="cost-change-policy-publish"
              >
                <Save className="h-4 w-4" />
                {busy ? "Publishing…" : dirty || !needsConfirmation ? "Publish new version" : "Confirm these settings"}
              </Button>
              <Button type="button" variant="ghost" disabled={!canEdit || busy || (!dirty && !form.changeNote)} onClick={resetForm}>
                Discard changes
              </Button>
              {canEdit && (
                <span className="text-xs text-muted-foreground" data-testid="cost-change-policy-publish-hint">
                  {publishHint({ dirty, needsConfirmation, noteMissing: form.changeNote.trim() === "", valid: parsed.success })}
                </span>
              )}
            </div>
            {message && (
              <p role="status" className="mt-3 text-sm text-foreground" data-testid="cost-change-policy-message">
                {message}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-destructive" data-testid="cost-change-policy-error">
                {error}
              </p>
            )}
          </section>

          <VersionHistory overview={overview} />
        </>
      )}
    </div>
  );
}

/** Which parts of the cost change controls act on the saved settings today, as the server reports it. */
export function DropshipCostChangeEnforcementPanel({ enforcement }: { enforcement: DropshipCostChangeEnforcementView }) {
  const partly = isDropshipCostChangePolicyPartlyEnforced(enforcement);
  return (
    <section className="rounded-md border bg-card p-4" data-testid="cost-change-policy-enforcement">
      <h3 className="font-semibold">What acts today</h3>
      {partly && (
        <p className="mt-1 text-sm text-muted-foreground" data-testid="cost-change-policy-today">
          {describeDropshipCostChangeToday(enforcement)}
        </p>
      )}
      <ul className="mt-3 space-y-2 text-sm">
        {DROPSHIP_COST_CHANGE_ENFORCEMENT_PARTS.map(({ part, label }) => (
          <li key={part} className="flex items-start gap-2" data-testid={`cost-change-policy-part-${part}`}>
            <Badge variant={enforcement[part] ? "default" : "outline"} className="shrink-0">
              {enforcement[part] ? "Live" : "Not live yet"}
            </Badge>
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettingsInForceTable({ overview }: { overview: DropshipCostChangePolicyOverview }) {
  const policy = overview.policy;
  return (
    <section className="rounded-md border bg-card p-4" data-testid="cost-change-policy-in-force">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Settings in force</h3>
        <Badge variant={overview.settingsSource === "policy" ? "default" : "outline"}>
          {overview.settingsSource === "policy" && policy ? `Version ${policy.version}` : "Defaults"}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {overview.settingsSource === "policy" && policy
          ? `Published ${formatDateTime(policy.createdAt)} by ${formatDropshipCostChangePolicyActor(policy.createdBy)}: ${policy.changeNote}`
          : "No version has been published, so the defaults below apply. Publishing a version records them."}
      </p>
      <div className="mt-3 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Setting</TableHead>
              <TableHead>In force</TableHead>
              <TableHead className="hidden sm:table-cell">Default</TableHead>
              <TableHead className="hidden sm:table-cell">Acts today</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS.map((descriptor) => {
              const defaultValue = formatDropshipCostChangeSetting(overview.defaults, descriptor.setting);
              const actsToday = isDropshipCostChangeSettingInEffect(descriptor.setting, overview.enforcement);
              return (
                <TableRow key={descriptor.setting} data-testid={`cost-change-policy-in-force-${descriptor.setting}`}>
                  <TableCell className="font-medium">{descriptor.label}</TableCell>
                  <TableCell>
                    {formatDropshipCostChangeSetting(overview.settings, descriptor.setting)}
                    {/* Phones drop the last two columns; the same facts sit under the value. */}
                    <div className="mt-1 text-xs text-muted-foreground sm:hidden">
                      Default: {defaultValue}. {actsToday ? "Acts today." : "Not live yet."}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{defaultValue}</TableCell>
                  <TableCell className="hidden sm:table-cell">{actsToday ? "Yes" : "Not yet"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function SettingGroupFields({
  group,
  title,
  description,
  form,
  errors,
  enforcement,
  disabled,
  onChange,
}: {
  group: DropshipCostChangeSettingGroup;
  title: string;
  description: string;
  form: DropshipCostChangePolicyForm;
  errors: DropshipCostChangePolicyFormErrors;
  enforcement: DropshipCostChangeEnforcementView;
  disabled: boolean;
  onChange: (patch: Partial<DropshipCostChangePolicyForm>) => void;
}) {
  const descriptors = DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS.filter((descriptor) => descriptor.group === group);
  return (
    <div className="space-y-3" data-testid={`cost-change-policy-group-${group}`}>
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {descriptors.map((descriptor) => (
          <SettingField
            key={descriptor.setting}
            descriptor={descriptor}
            form={form}
            errors={errors}
            inEffect={isDropshipCostChangeSettingInEffect(descriptor.setting, enforcement)}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}

function SettingField({
  descriptor,
  form,
  errors,
  inEffect,
  disabled,
  onChange,
}: {
  descriptor: DropshipCostChangeSettingDescriptor;
  form: DropshipCostChangePolicyForm;
  errors: DropshipCostChangePolicyFormErrors;
  inEffect: boolean;
  disabled: boolean;
  onChange: (patch: Partial<DropshipCostChangePolicyForm>) => void;
}): React.ReactElement {
  const id = `cost-change-policy-${descriptor.setting}`;
  const status = inEffect ? null : (
    <span className="ml-2 text-xs font-normal text-muted-foreground">(not live yet)</span>
  );
  const help = <p className="text-xs text-muted-foreground">{descriptor.help}</p>;

  switch (descriptor.setting) {
    case "increaseNoticeDays":
      return (
        <TextSetting id={id} label={`${descriptor.label} (days)`} status={status} help={help}
          value={form.increaseNoticeDays} inputMode="numeric" error={errors.increaseNoticeDays} disabled={disabled}
          onChange={(value) => onChange({ increaseNoticeDays: value })} />
      );
    case "noticeMinimumChangeCents":
      return (
        <TextSetting id={id} label={`${descriptor.label} ($ per unit)`} status={status} help={help}
          value={form.noticeMinimumChange} inputMode="decimal" error={errors.noticeMinimumChange} disabled={disabled}
          onChange={(value) => onChange({ noticeMinimumChange: value })} />
      );
    case "noticeMinimumChangeBps":
      return (
        <TextSetting id={id} label={`${descriptor.label} (%)`} status={status} help={help}
          value={form.noticeMinimumChangePercent} inputMode="decimal" error={errors.noticeMinimumChangePercent}
          disabled={disabled} onChange={(value) => onChange({ noticeMinimumChangePercent: value })} />
      );
    case "detectionIntervalMinutes":
      return (
        <TextSetting id={id} label={`${descriptor.label} (minutes)`} status={status} help={help}
          value={form.detectionIntervalMinutes} inputMode="numeric" error={errors.detectionIntervalMinutes}
          disabled={disabled} onChange={(value) => onChange({ detectionIntervalMinutes: value })} />
      );
    case "priceProtection":
    case "retailChangesGetNotice":
    case "notifyByEmail":
    case "notifyInPortal":
    case "notifyOnDecrease": {
      const setting = descriptor.setting;
      return (
        <div className="space-y-2">
          <div className="flex items-start gap-3">
            <Switch id={id} checked={form[setting]} disabled={disabled}
              onCheckedChange={(checked) => onChange({ [setting]: checked })} />
            <Label htmlFor={id} className="leading-5">
              {descriptor.label}
              {status}
            </Label>
          </div>
          {help}
        </div>
      );
    }
    case "decreaseTiming":
      return (
        <ChoiceSetting id={id} label={descriptor.label} status={status} help={help}
          choices={DROPSHIP_COST_DECREASE_TIMING_CHOICES} value={form.decreaseTiming} disabled={disabled}
          onChange={(value) => onChange({ decreaseTiming: value })} />
      );
    case "rulePricedListings":
      return (
        <ChoiceSetting id={id} label={descriptor.label} status={status} help={help}
          choices={DROPSHIP_RULE_PRICED_LISTING_CHOICES} value={form.rulePricedListings} disabled={disabled}
          onChange={(value) => onChange({ rulePricedListings: value })} />
      );
    case "belowCostFixedListings":
      return (
        <ChoiceSetting id={id} label={descriptor.label} status={status} help={help}
          choices={DROPSHIP_BELOW_COST_LISTING_CHOICES} value={form.belowCostFixedListings} disabled={disabled}
          onChange={(value) => onChange({ belowCostFixedListings: value })} />
      );
  }
}

function TextSetting({
  id,
  label,
  status,
  help,
  value,
  inputMode,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  status: React.ReactNode;
  help: React.ReactNode;
  value: string;
  inputMode: "numeric" | "decimal";
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {status}
      </Label>
      <Input id={id} inputMode={inputMode} value={value} disabled={disabled}
        aria-invalid={error ? true : undefined} onChange={(event) => onChange(event.target.value)} />
      {help}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ChoiceSetting<T extends string>({
  id,
  label,
  status,
  help,
  choices,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  status: React.ReactNode;
  help: React.ReactNode;
  choices: readonly DropshipCostChangeChoice<T>[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  const labelId = `${id}-label`;
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm font-medium leading-none">
        {label}
        {status}
      </p>
      <RadioGroup
        aria-labelledby={labelId}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          // Radix hands back a string; only a listed choice is accepted.
          const choice = choices.find((candidate) => candidate.value === next);
          if (choice) onChange(choice.value);
        }}
      >
        {choices.map((choice) => (
          <div key={choice.value} className="flex items-center gap-2">
            <RadioGroupItem id={`${id}-${choice.value}`} value={choice.value} />
            <Label htmlFor={`${id}-${choice.value}`} className="font-normal">
              {choice.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {help}
    </div>
  );
}

function VersionHistory({ overview }: { overview: DropshipCostChangePolicyOverview }) {
  return (
    <section className="rounded-md border bg-card p-4" data-testid="cost-change-policy-history">
      <h3 className="font-semibold">Version history</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Newest first. Published versions are never edited; each one records who published it and why.
      </p>
      {overview.versions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No version has been published yet.</p>
      ) : (
        <ol className="mt-3 divide-y rounded-md border">
          {overview.versions.map((version, index) => (
            <li key={version.policyId} className="space-y-2 p-3" data-testid={`cost-change-policy-version-${version.version}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Version {version.version}</span>
                {version.isActive ? (
                  <Badge>In force</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">Retired {formatDateTime(version.deactivatedAt)}</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Published {formatDateTime(version.createdAt)} by {formatDropshipCostChangePolicyActor(version.createdBy)}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{version.changeNote}</p>
              <VersionChanges summary={summarizeDropshipCostChangePolicyVersion(overview.versions, index)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function VersionChanges({
  summary,
}: {
  summary: ReturnType<typeof summarizeDropshipCostChangePolicyVersion>;
}): React.ReactElement {
  switch (summary.kind) {
    case "first":
      return <span className="text-sm text-muted-foreground">First version</span>;
    case "confirmed":
      return <span className="text-sm text-muted-foreground">No setting changed (confirmed as is)</span>;
    case "earlier_not_listed":
      return <span className="text-sm text-muted-foreground">Earlier version not listed</span>;
    case "changes":
      return (
        <ul className="space-y-1 text-sm">
          {summary.changes.map((change) => (
            <li key={change.setting}>
              {change.label}: {change.from} → {change.to}
            </li>
          ))}
        </ul>
      );
  }
}

function publishHint(input: { dirty: boolean; needsConfirmation: boolean; noteMissing: boolean; valid: boolean }): string {
  if (!input.dirty && !input.needsConfirmation) return "These settings match the version in force.";
  if (input.noteMissing) return "Add a change note to publish.";
  if (!input.valid) return "Fix the highlighted settings to publish.";
  return input.dirty ? "Ready to publish." : "Ready to confirm.";
}

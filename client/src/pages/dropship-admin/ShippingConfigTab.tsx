import {
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { DropshipSharedShippingPanel } from "@/components/shipping/DropshipSharedShippingPanel";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  type CarrierProtectionAssignmentConfig,
  type CarrierProtectionConfigResponse,
  type CarrierProtectionPolicyConfig,
  type DropshipShippingConfigOverview,
} from "@/lib/dropship-ops-surface";
import {
  FieldGroup,
  LabeledSelect,
  PanelHeader,
  ShippingInput,
  ShippingSimpleTable,
  ShippingTableSkeleton,
  ToggleField,
  type DropshipWarehouseOption,
} from "./dropship-admin-shared";

interface CarrierProtectionPolicyFormState {
  policyKey: string;
  supersedesPolicyId: string;
  name: string;
  status: "draft" | "active";
  coveredLoss: boolean;
  coveredMisdelivery: boolean;
  coveredDamage: boolean;
  merchandisePercent: string;
  shippingPercent: string;
  deductible: string;
  maxCredit: string;
  lossWaitDays: string;
  misdeliveryWaitDays: string;
  damageInspectionRequired: boolean;
  payoutTrigger:
    "internal_approval" | "carrier_claim_approved" | "carrier_payment_received";
  carrierClaimRequired: boolean;
  approvalMode: "manual" | "automatic";
  automaticApprovalLimit: string;
  effectiveFrom: string;
  effectiveTo: string;
}

interface CarrierProtectionAssignmentFormState {
  policyId: string;
  name: string;
  priority: string;
  channelId: string;
  warehouseId: string;
  carrier: string;
  service: string;
  destinationCountry: string;
  destinationRegion: string;
  minShipmentValue: string;
  maxShipmentValue: string;
  isDefault: boolean;
}

interface DropshipChannelOption {
  id: number;
  name: string;
  provider: string;
  status: string;
}

const emptyCarrierProtectionPolicyForm: CarrierProtectionPolicyFormState = {
  policyKey: "STANDARD_CARRIER_PROTECTION",
  supersedesPolicyId: "",
  name: "Standard Carrier Protection",
  status: "draft",
  coveredLoss: true,
  coveredMisdelivery: true,
  coveredDamage: true,
  merchandisePercent: "100",
  shippingPercent: "100",
  deductible: "0.00",
  maxCredit: "",
  lossWaitDays: "7",
  misdeliveryWaitDays: "2",
  damageInspectionRequired: true,
  payoutTrigger: "internal_approval",
  carrierClaimRequired: true,
  approvalMode: "manual",
  automaticApprovalLimit: "",
  effectiveFrom: "",
  effectiveTo: "",
};

const emptyCarrierProtectionAssignmentForm: CarrierProtectionAssignmentFormState =
  {
    policyId: "",
    name: "Default carrier protection",
    priority: "0",
    channelId: "",
    warehouseId: "",
    carrier: "",
    service: "",
    destinationCountry: "",
    destinationRegion: "",
    minShipmentValue: "",
    maxShipmentValue: "",
    isDefault: true,
  };

function ShippingConfigTab() {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [protectionPolicyForm, setProtectionPolicyForm] =
    useState<CarrierProtectionPolicyFormState>(
      emptyCarrierProtectionPolicyForm,
    );
  const [protectionAssignmentForm, setProtectionAssignmentForm] =
    useState<CarrierProtectionAssignmentFormState>(
      emptyCarrierProtectionAssignmentForm,
    );
  const protectionQuery = useQuery<CarrierProtectionConfigResponse>({
    queryKey: ["/api/dropship/admin/carrier-protection"],
    queryFn: () =>
      fetchJson<CarrierProtectionConfigResponse>(
        "/api/dropship/admin/carrier-protection",
      ),
  });
  const channelsQuery = useQuery<DropshipChannelOption[]>({
    queryKey: ["/api/channels"],
    queryFn: () => fetchJson<DropshipChannelOption[]>("/api/channels"),
  });
  const warehousesQuery = useQuery<DropshipWarehouseOption[]>({
    queryKey: ["/api/warehouses"],
    queryFn: () => fetchJson<DropshipWarehouseOption[]>("/api/warehouses"),
  });
  const warehouseOptions = useMemo(
    () =>
      (warehousesQuery.data ?? [])
        .filter(
          (warehouse) =>
            warehouse.isActive === 1 &&
            warehouse.warehouseType !== "bulk_storage",
        )
        .sort((first, second) => {
          if (first.isDefault !== second.isDefault)
            return second.isDefault - first.isDefault;
          return first.name.localeCompare(second.name);
        }),
    [warehousesQuery.data],
  );

  async function runShippingAction(action: string, task: () => Promise<void>) {
    setPendingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      await Promise.all([
        protectionQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Shipping config save failed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function saveProtectionPolicy() {
    await runShippingAction("carrier-protection-policy", async () => {
      await postJson("/api/dropship/admin/carrier-protection/policies", {
        policyKey: protectionPolicyForm.policyKey,
        supersedesPolicyId: optionalPositiveInteger(
          protectionPolicyForm.supersedesPolicyId,
        ),
        name: protectionPolicyForm.name,
        status: protectionPolicyForm.status,
        coveredLoss: protectionPolicyForm.coveredLoss,
        coveredMisdelivery: protectionPolicyForm.coveredMisdelivery,
        coveredDamage: protectionPolicyForm.coveredDamage,
        merchandiseReimbursementBps: percentageInputToBps(
          protectionPolicyForm.merchandisePercent,
        ),
        shippingReimbursementBps: percentageInputToBps(
          protectionPolicyForm.shippingPercent,
        ),
        deductibleCents: currencyInputToCents(
          protectionPolicyForm.deductible,
          "deductible",
        ),
        maxCreditCents: optionalCurrencyInputToCents(
          protectionPolicyForm.maxCredit,
          "maximum credit",
        ),
        lossWaitDays: requiredNonnegativeInteger(
          protectionPolicyForm.lossWaitDays,
          "loss wait days",
        ),
        misdeliveryWaitDays: requiredNonnegativeInteger(
          protectionPolicyForm.misdeliveryWaitDays,
          "misdelivery wait days",
        ),
        damageInspectionRequired: protectionPolicyForm.damageInspectionRequired,
        payoutTrigger: protectionPolicyForm.payoutTrigger,
        carrierClaimRequired: protectionPolicyForm.carrierClaimRequired,
        approvalMode: protectionPolicyForm.approvalMode,
        automaticApprovalLimitCents:
          protectionPolicyForm.approvalMode === "automatic"
            ? optionalCurrencyInputToCents(
                protectionPolicyForm.automaticApprovalLimit,
                "automatic approval limit",
              )
            : null,
        effectiveFrom: optionalIsoDate(protectionPolicyForm.effectiveFrom),
        effectiveTo: optionalIsoDate(protectionPolicyForm.effectiveTo),
        idempotencyKey: createDropshipIdempotencyKey(
          "carrier-protection-policy",
        ),
      });
      setProtectionPolicyForm(emptyCarrierProtectionPolicyForm);
      setMessage("Carrier-protection policy version created.");
    });
  }

  async function saveProtectionAssignment() {
    await runShippingAction("carrier-protection-assignment", async () => {
      await postJson("/api/dropship/admin/carrier-protection/assignments", {
        policyId: requiredPositiveInteger(
          protectionAssignmentForm.policyId,
          "policy",
        ),
        name: protectionAssignmentForm.name,
        priority: requiredInteger(
          protectionAssignmentForm.priority,
          "priority",
        ),
        channelId: protectionAssignmentForm.isDefault
          ? null
          : optionalPositiveInteger(protectionAssignmentForm.channelId),
        warehouseId: protectionAssignmentForm.isDefault
          ? null
          : optionalPositiveInteger(protectionAssignmentForm.warehouseId),
        carrier: protectionAssignmentForm.isDefault
          ? null
          : optionalText(protectionAssignmentForm.carrier),
        service: protectionAssignmentForm.isDefault
          ? null
          : optionalText(protectionAssignmentForm.service),
        destinationCountry: protectionAssignmentForm.isDefault
          ? null
          : optionalText(protectionAssignmentForm.destinationCountry),
        destinationRegion: protectionAssignmentForm.isDefault
          ? null
          : optionalText(protectionAssignmentForm.destinationRegion),
        minShipmentValueCents: protectionAssignmentForm.isDefault
          ? null
          : optionalCurrencyInputToCents(
              protectionAssignmentForm.minShipmentValue,
              "minimum shipment value",
            ),
        maxShipmentValueCents: protectionAssignmentForm.isDefault
          ? null
          : optionalCurrencyInputToCents(
              protectionAssignmentForm.maxShipmentValue,
              "maximum shipment value",
            ),
        isDefault: protectionAssignmentForm.isDefault,
        idempotencyKey: createDropshipIdempotencyKey(
          "carrier-protection-assignment",
        ),
      });
      setProtectionAssignmentForm(emptyCarrierProtectionAssignmentForm);
      setMessage("Carrier-protection assignment created.");
    });
  }

  async function retireProtectionPolicy(policy: CarrierProtectionPolicyConfig) {
    await runShippingAction(
      `retire-protection-${policy.policyId}`,
      async () => {
        await postJson(
          `/api/dropship/admin/carrier-protection/policies/${policy.policyId}/retire`,
          {
            idempotencyKey: createDropshipIdempotencyKey(
              "carrier-protection-retire",
            ),
          },
        );
        setMessage(`${policy.name} v${policy.version} retired.`);
      },
    );
  }

  async function activateProtectionPolicy(
    policy: CarrierProtectionPolicyConfig,
  ) {
    await runShippingAction(
      `activate-protection-${policy.policyId}`,
      async () => {
        await postJson(
          `/api/dropship/admin/carrier-protection/policies/${policy.policyId}/activate`,
          {
            idempotencyKey: createDropshipIdempotencyKey(
              "carrier-protection-activate",
            ),
          },
        );
        setMessage(`${policy.name} v${policy.version} activated.`);
      },
    );
  }

  async function deactivateProtectionAssignment(
    assignment: CarrierProtectionAssignmentConfig,
  ) {
    await runShippingAction(
      `deactivate-protection-assignment-${assignment.assignmentId}`,
      async () => {
        await postJson(
          `/api/dropship/admin/carrier-protection/assignments/${assignment.assignmentId}/deactivate`,
          {
            idempotencyKey: createDropshipIdempotencyKey(
              "carrier-protection-assignment-deactivate",
            ),
          },
        );
        setMessage(`${assignment.name} deactivated.`);
      },
    );
  }

  return (
    <div className="space-y-5">
      <DropshipSharedShippingPanel />
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">
          Carrier protection coverage and claims
        </summary>
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}{" "}
        <CarrierProtectionAdmin
          assignments={protectionQuery.data?.config.assignments ?? []}
          assignmentForm={protectionAssignmentForm}
          channels={(channelsQuery.data ?? []).filter(
            (channel) => channel.status === "active",
          )}
          isLoading={protectionQuery.isLoading}
          pendingAction={pendingAction}
          policies={protectionQuery.data?.config.policies ?? []}
          policyForm={protectionPolicyForm}
          warehouses={warehouseOptions}
          onAssignmentChange={setProtectionAssignmentForm}
          onActivatePolicy={activateProtectionPolicy}
          onDeactivateAssignment={deactivateProtectionAssignment}
          onPolicyChange={setProtectionPolicyForm}
          onRetirePolicy={retireProtectionPolicy}
          onSaveAssignment={saveProtectionAssignment}
          onSavePolicy={saveProtectionPolicy}
        />
      </details>
    </div>
  );
}

function CarrierProtectionAdmin({
  assignments,
  assignmentForm,
  channels,
  isLoading,
  pendingAction,
  policies,
  policyForm,
  warehouses,
  onAssignmentChange,
  onActivatePolicy,
  onDeactivateAssignment,
  onPolicyChange,
  onRetirePolicy,
  onSaveAssignment,
  onSavePolicy,
}: {
  assignments: CarrierProtectionAssignmentConfig[];
  assignmentForm: CarrierProtectionAssignmentFormState;
  channels: DropshipChannelOption[];
  isLoading: boolean;
  pendingAction: string | null;
  policies: CarrierProtectionPolicyConfig[];
  policyForm: CarrierProtectionPolicyFormState;
  warehouses: DropshipWarehouseOption[];
  onAssignmentChange: Dispatch<
    SetStateAction<CarrierProtectionAssignmentFormState>
  >;
  onActivatePolicy: (policy: CarrierProtectionPolicyConfig) => void;
  onDeactivateAssignment: (
    assignment: CarrierProtectionAssignmentConfig,
  ) => void;
  onPolicyChange: Dispatch<SetStateAction<CarrierProtectionPolicyFormState>>;
  onRetirePolicy: (policy: CarrierProtectionPolicyConfig) => void;
  onSaveAssignment: () => void;
  onSavePolicy: () => void;
}) {
  const [section, setSection] = useState<"policies" | "assignments">(
    "policies",
  );
  const [selectedPolicy, setSelectedPolicy] =
    useState<CarrierProtectionPolicyConfig | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { type: "retire"; policy: CarrierProtectionPolicyConfig }
    | { type: "deactivate"; assignment: CarrierProtectionAssignmentConfig }
    | null
  >(null);
  const activePolicies = policies.filter(
    (policy) => policy.status === "active",
  );

  function executeConfirmedAction() {
    if (!confirmAction) return;
    if (confirmAction.type === "retire")
      void onRetirePolicy(confirmAction.policy);
    else void onDeactivateAssignment(confirmAction.assignment);
    setConfirmAction(null);
  }

  return (
    <section className="mt-5 rounded-md border bg-card p-4">
      <PanelHeader
        title="Carrier protection"
        detail="Configure what carrier events are covered, how credits are calculated, and where each immutable policy version applies."
      />
      <Tabs
        value={section}
        onValueChange={(value) =>
          setSection(value as "policies" | "assignments")
        }
        className="mt-4 space-y-4"
      >
        <TabsList>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="assignments">Assignment rules</TabsTrigger>
        </TabsList>

        <TabsContent value="policies" className="m-0 space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-4 rounded-md border p-4">
              <div>
                <h3 className="font-semibold">New policy version</h3>
                <p className="text-sm text-muted-foreground">
                  Published terms are immutable. Select a prior policy to create
                  its next version.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <ShippingInput
                  label="Policy code"
                  value={policyForm.policyKey}
                  onChange={(policyKey) =>
                    onPolicyChange((current) => ({ ...current, policyKey }))
                  }
                />
                <ShippingInput
                  label="Policy name"
                  value={policyForm.name}
                  onChange={(name) =>
                    onPolicyChange((current) => ({ ...current, name }))
                  }
                />
                <LabeledSelect
                  label="New version of"
                  value={policyForm.supersedesPolicyId || "none"}
                  onChange={(value) =>
                    onPolicyChange((current) => ({
                      ...current,
                      supersedesPolicyId: value === "none" ? "" : value,
                    }))
                  }
                  options={[
                    { value: "none", label: "New policy" },
                    ...policies
                      .filter((policy) => policy.status !== "retired")
                      .map((policy) => ({
                        value: String(policy.policyId),
                        label: `${policy.name} v${policy.version}`,
                      })),
                  ]}
                />
                <LabeledSelect
                  label="Initial status"
                  value={policyForm.status}
                  onChange={(value) =>
                    onPolicyChange((current) => ({
                      ...current,
                      status: value as "draft" | "active",
                    }))
                  }
                  options={[
                    { value: "draft", label: "Draft" },
                    { value: "active", label: "Active" },
                  ]}
                />
              </div>

              <FieldGroup title="Covered events">
                <ToggleField
                  label="Loss"
                  checked={policyForm.coveredLoss}
                  onChange={(coveredLoss) =>
                    onPolicyChange((current) => ({ ...current, coveredLoss }))
                  }
                />
                <ToggleField
                  label="Misdelivery"
                  checked={policyForm.coveredMisdelivery}
                  onChange={(coveredMisdelivery) =>
                    onPolicyChange((current) => ({
                      ...current,
                      coveredMisdelivery,
                    }))
                  }
                />
                <ToggleField
                  label="Carrier damage"
                  checked={policyForm.coveredDamage}
                  onChange={(coveredDamage) =>
                    onPolicyChange((current) => ({ ...current, coveredDamage }))
                  }
                />
              </FieldGroup>

              <div className="grid gap-3 md:grid-cols-2">
                <ShippingInput
                  label="Merchandise reimbursement %"
                  value={policyForm.merchandisePercent}
                  onChange={(merchandisePercent) =>
                    onPolicyChange((current) => ({
                      ...current,
                      merchandisePercent,
                    }))
                  }
                />
                <ShippingInput
                  label="Shipping reimbursement %"
                  value={policyForm.shippingPercent}
                  onChange={(shippingPercent) =>
                    onPolicyChange((current) => ({
                      ...current,
                      shippingPercent,
                    }))
                  }
                />
                <ShippingInput
                  label="Deductible"
                  value={policyForm.deductible}
                  onChange={(deductible) =>
                    onPolicyChange((current) => ({ ...current, deductible }))
                  }
                />
                <ShippingInput
                  label="Maximum credit"
                  placeholder="No cap"
                  value={policyForm.maxCredit}
                  onChange={(maxCredit) =>
                    onPolicyChange((current) => ({ ...current, maxCredit }))
                  }
                />
                <ShippingInput
                  label="Loss wait days"
                  value={policyForm.lossWaitDays}
                  onChange={(lossWaitDays) =>
                    onPolicyChange((current) => ({ ...current, lossWaitDays }))
                  }
                />
                <ShippingInput
                  label="Misdelivery wait days"
                  value={policyForm.misdeliveryWaitDays}
                  onChange={(misdeliveryWaitDays) =>
                    onPolicyChange((current) => ({
                      ...current,
                      misdeliveryWaitDays,
                    }))
                  }
                />
                <LabeledSelect
                  label="Payout trigger"
                  value={policyForm.payoutTrigger}
                  onChange={(value) =>
                    onPolicyChange((current) => ({
                      ...current,
                      payoutTrigger:
                        value as CarrierProtectionPolicyFormState["payoutTrigger"],
                    }))
                  }
                  options={[
                    { value: "internal_approval", label: "Internal approval" },
                    {
                      value: "carrier_claim_approved",
                      label: "Carrier approves claim",
                    },
                    {
                      value: "carrier_payment_received",
                      label: "Carrier payment received",
                    },
                  ]}
                />
                <LabeledSelect
                  label="Approval"
                  value={policyForm.approvalMode}
                  onChange={(value) =>
                    onPolicyChange((current) => ({
                      ...current,
                      approvalMode: value as "manual" | "automatic",
                      automaticApprovalLimit:
                        value === "manual"
                          ? ""
                          : current.automaticApprovalLimit,
                    }))
                  }
                  options={[
                    { value: "manual", label: "Manual" },
                    { value: "automatic", label: "Automatic below limit" },
                  ]}
                />
                {policyForm.approvalMode === "automatic" && (
                  <ShippingInput
                    label="Automatic approval limit"
                    value={policyForm.automaticApprovalLimit}
                    onChange={(automaticApprovalLimit) =>
                      onPolicyChange((current) => ({
                        ...current,
                        automaticApprovalLimit,
                      }))
                    }
                  />
                )}
                <ShippingInput
                  label="Effective from"
                  type="datetime-local"
                  value={policyForm.effectiveFrom}
                  onChange={(effectiveFrom) =>
                    onPolicyChange((current) => ({ ...current, effectiveFrom }))
                  }
                />
                <ShippingInput
                  label="Effective to"
                  type="datetime-local"
                  value={policyForm.effectiveTo}
                  onChange={(effectiveTo) =>
                    onPolicyChange((current) => ({ ...current, effectiveTo }))
                  }
                />
              </div>
              <FieldGroup title="Processing requirements">
                <ToggleField
                  label="Inspect damage"
                  checked={policyForm.damageInspectionRequired}
                  onChange={(damageInspectionRequired) =>
                    onPolicyChange((current) => ({
                      ...current,
                      damageInspectionRequired,
                    }))
                  }
                />
                <ToggleField
                  label="Track carrier claim"
                  checked={policyForm.carrierClaimRequired}
                  onChange={(carrierClaimRequired) =>
                    onPolicyChange((current) => ({
                      ...current,
                      carrierClaimRequired,
                    }))
                  }
                />
              </FieldGroup>
              <Button
                className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                disabled={pendingAction !== null}
                onClick={onSavePolicy}
              >
                <Save className="h-4 w-4" />
                Create policy version
              </Button>
            </div>

            <CarrierProtectionPolicyTable
              policies={policies}
              isLoading={isLoading}
              onActivate={onActivatePolicy}
              onRetire={(policy) =>
                setConfirmAction({ type: "retire", policy })
              }
              onView={setSelectedPolicy}
            />
          </div>
        </TabsContent>

        <TabsContent value="assignments" className="m-0 space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-4 rounded-md border p-4">
              <div>
                <h3 className="font-semibold">New assignment rule</h3>
                <p className="text-sm text-muted-foreground">
                  Higher priorities match first. Keep one default rule as the
                  fallback.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <LabeledSelect
                  label="Policy"
                  value={assignmentForm.policyId || "none"}
                  onChange={(value) =>
                    onAssignmentChange((current) => ({
                      ...current,
                      policyId: value === "none" ? "" : value,
                    }))
                  }
                  options={[
                    { value: "none", label: "Select policy" },
                    ...activePolicies.map((policy) => ({
                      value: String(policy.policyId),
                      label: `${policy.name} v${policy.version}`,
                    })),
                  ]}
                />
                <ShippingInput
                  label="Rule name"
                  value={assignmentForm.name}
                  onChange={(name) =>
                    onAssignmentChange((current) => ({ ...current, name }))
                  }
                />
                <ShippingInput
                  label="Priority"
                  value={assignmentForm.priority}
                  onChange={(priority) =>
                    onAssignmentChange((current) => ({ ...current, priority }))
                  }
                />
                <ToggleField
                  label="Default fallback"
                  checked={assignmentForm.isDefault}
                  onChange={(isDefault) =>
                    onAssignmentChange((current) => ({ ...current, isDefault }))
                  }
                />
              </div>
              {!assignmentForm.isDefault && (
                <div className="grid gap-3 md:grid-cols-2">
                  <LabeledSelect
                    label="Channel"
                    value={assignmentForm.channelId || "any"}
                    onChange={(value) =>
                      onAssignmentChange((current) => ({
                        ...current,
                        channelId: value === "any" ? "" : value,
                      }))
                    }
                    options={[
                      { value: "any", label: "Any channel" },
                      ...channels.map((channel) => ({
                        value: String(channel.id),
                        label: channel.name,
                      })),
                    ]}
                  />
                  <LabeledSelect
                    label="Warehouse"
                    value={assignmentForm.warehouseId || "any"}
                    onChange={(value) =>
                      onAssignmentChange((current) => ({
                        ...current,
                        warehouseId: value === "any" ? "" : value,
                      }))
                    }
                    options={[
                      { value: "any", label: "Any warehouse" },
                      ...warehouses.map((warehouse) => ({
                        value: String(warehouse.id),
                        label: warehouse.name,
                      })),
                    ]}
                  />
                  <ShippingInput
                    label="Carrier"
                    placeholder="Any carrier"
                    value={assignmentForm.carrier}
                    onChange={(carrier) =>
                      onAssignmentChange((current) => ({ ...current, carrier }))
                    }
                  />
                  <ShippingInput
                    label="Service"
                    placeholder="Any service"
                    value={assignmentForm.service}
                    onChange={(service) =>
                      onAssignmentChange((current) => ({ ...current, service }))
                    }
                  />
                  <ShippingInput
                    label="Destination country"
                    placeholder="Any country"
                    value={assignmentForm.destinationCountry}
                    onChange={(destinationCountry) =>
                      onAssignmentChange((current) => ({
                        ...current,
                        destinationCountry,
                      }))
                    }
                  />
                  <ShippingInput
                    label="Destination region"
                    placeholder="Any region"
                    value={assignmentForm.destinationRegion}
                    onChange={(destinationRegion) =>
                      onAssignmentChange((current) => ({
                        ...current,
                        destinationRegion,
                      }))
                    }
                  />
                  <ShippingInput
                    label="Minimum shipment value"
                    placeholder="No minimum"
                    value={assignmentForm.minShipmentValue}
                    onChange={(minShipmentValue) =>
                      onAssignmentChange((current) => ({
                        ...current,
                        minShipmentValue,
                      }))
                    }
                  />
                  <ShippingInput
                    label="Maximum shipment value"
                    placeholder="No maximum"
                    value={assignmentForm.maxShipmentValue}
                    onChange={(maxShipmentValue) =>
                      onAssignmentChange((current) => ({
                        ...current,
                        maxShipmentValue,
                      }))
                    }
                  />
                </div>
              )}
              <Button
                className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                disabled={pendingAction !== null}
                onClick={onSaveAssignment}
              >
                <Save className="h-4 w-4" />
                Create assignment
              </Button>
            </div>
            <CarrierProtectionAssignmentTable
              assignments={assignments}
              isLoading={isLoading}
              onDeactivate={(assignment) =>
                setConfirmAction({ type: "deactivate", assignment })
              }
            />
          </div>
        </TabsContent>
      </Tabs>

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && pendingAction === null) setConfirmAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === "retire"
                ? "Retire policy version?"
                : "Deactivate assignment?"}
            </DialogTitle>
            <DialogDescription>
              Existing claims and snapshots remain unchanged. This action only
              prevents new matches.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmAction(null)}
              disabled={pendingAction !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={executeConfirmedAction}
              disabled={pendingAction !== null}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedPolicy !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPolicy(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selectedPolicy?.name} v{selectedPolicy?.version}
            </DialogTitle>
            <DialogDescription>{selectedPolicy?.policyKey}</DialogDescription>
          </DialogHeader>
          {selectedPolicy && (
            <CarrierProtectionPolicyDetails policy={selectedPolicy} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedPolicy(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CarrierProtectionPolicyTable({
  policies,
  isLoading,
  onActivate,
  onRetire,
  onView,
}: {
  policies: CarrierProtectionPolicyConfig[];
  isLoading: boolean;
  onActivate: (policy: CarrierProtectionPolicyConfig) => void;
  onRetire: (policy: CarrierProtectionPolicyConfig) => void;
  onView: (policy: CarrierProtectionPolicyConfig) => void;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  return (
    <ShippingSimpleTable
      title="Policy versions"
      emptyTitle="No carrier-protection policies"
      headers={["Policy", "Status", "Coverage", "Credit", "Payout", "Actions"]}
      rows={policies.map((policy) => [
        <div key="policy">
          <div>{policy.name}</div>
          <div className="text-xs text-muted-foreground">
            {policy.policyKey} v{policy.version}
          </div>
        </div>,
        formatStatus(policy.status),
        [
          policy.coveredLoss && "Loss",
          policy.coveredMisdelivery && "Misdelivery",
          policy.coveredDamage && "Damage",
        ]
          .filter(Boolean)
          .join(", "),
        `${policy.merchandiseReimbursementBps / 100}% merchandise + ${policy.shippingReimbursementBps / 100}% shipping`,
        formatStatus(policy.payoutTrigger),
        <div key="actions" className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onView(policy)}>
            View
          </Button>
          {policy.status === "draft" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onActivate(policy)}
            >
              Activate
            </Button>
          )}
          {policy.status === "active" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRetire(policy)}
            >
              Retire
            </Button>
          )}
        </div>,
      ])}
    />
  );
}

function CarrierProtectionPolicyDetails({
  policy,
}: {
  policy: CarrierProtectionPolicyConfig;
}) {
  const details = [
    ["Status", formatStatus(policy.status)],
    [
      "Covered events",
      [
        policy.coveredLoss && "Loss",
        policy.coveredMisdelivery && "Misdelivery",
        policy.coveredDamage && "Damage",
      ]
        .filter(Boolean)
        .join(", "),
    ],
    [
      "Merchandise reimbursement",
      `${policy.merchandiseReimbursementBps / 100}%`,
    ],
    ["Shipping reimbursement", `${policy.shippingReimbursementBps / 100}%`],
    ["Deductible", formatCents(policy.deductibleCents)],
    [
      "Maximum credit",
      policy.maxCreditCents == null
        ? "No cap"
        : formatCents(policy.maxCreditCents),
    ],
    ["Loss wait", `${policy.lossWaitDays} days`],
    ["Misdelivery wait", `${policy.misdeliveryWaitDays} days`],
    [
      "Damage inspection",
      policy.damageInspectionRequired ? "Required" : "Not required",
    ],
    ["Payout trigger", formatStatus(policy.payoutTrigger)],
    [
      "Carrier claim",
      policy.carrierClaimRequired ? "Track required" : "Not required",
    ],
    [
      "Approval",
      policy.approvalMode === "automatic"
        ? `Automatic through ${formatCents(policy.automaticApprovalLimitCents ?? 0)}`
        : "Manual",
    ],
    [
      "Effective",
      `${formatDateTime(policy.effectiveFrom)}${policy.effectiveTo ? ` - ${formatDateTime(policy.effectiveTo)}` : " - Open"}`,
    ],
  ];
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {details.map(([label, value]) => (
        <div key={label}>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-sm font-medium">{value}</div>
        </div>
      ))}
    </div>
  );
}

function CarrierProtectionAssignmentTable({
  assignments,
  isLoading,
  onDeactivate,
}: {
  assignments: CarrierProtectionAssignmentConfig[];
  isLoading: boolean;
  onDeactivate: (assignment: CarrierProtectionAssignmentConfig) => void;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  return (
    <ShippingSimpleTable
      title="Assignment rules"
      emptyTitle="No carrier-protection assignments"
      headers={["Rule", "Policy", "Match", "Priority", "Status", "Actions"]}
      rows={assignments.map((assignment) => [
        assignment.name,
        `${assignment.policyName} v${assignment.policyVersion}`,
        assignment.isDefault
          ? "Default fallback"
          : carrierProtectionAssignmentScope(assignment),
        String(assignment.priority),
        assignment.isActive ? "Active" : "Inactive",
        assignment.isActive ? (
          <Button
            key="deactivate"
            variant="outline"
            size="sm"
            onClick={() => onDeactivate(assignment)}
          >
            Deactivate
          </Button>
        ) : (
          "-"
        ),
      ])}
    />
  );
}

function carrierProtectionAssignmentScope(
  assignment: CarrierProtectionAssignmentConfig,
): string {
  const valueRange =
    assignment.minShipmentValueCents != null ||
    assignment.maxShipmentValueCents != null
      ? formatShippingMoneyRange(
          assignment.minShipmentValueCents,
          assignment.maxShipmentValueCents,
        )
      : null;
  return (
    [
      assignment.channelName,
      assignment.warehouseName,
      assignment.carrier,
      assignment.service,
      assignment.destinationCountry,
      assignment.destinationRegion,
      valueRange,
    ]
      .filter(Boolean)
      .join(" / ") || "All shipments"
  );
}

function shippingPolicyStatus(
  policy: {
    policyId: number;
    isActive: boolean;
    effectiveFrom: string;
    effectiveTo: string | null;
  },
  activePolicyId: number | null,
  generatedAt?: string,
): string {
  if (!policy.isActive) return "Inactive";
  const at = new Date(generatedAt ?? Date.now()).getTime();
  if (new Date(policy.effectiveFrom).getTime() > at) return "Scheduled";
  if (policy.effectiveTo && new Date(policy.effectiveTo).getTime() <= at)
    return "Expired";
  return policy.policyId === activePolicyId ? "Effective" : "Superseded";
}

function currencyInputToCents(value: string, label: string): number {
  return decimalInputToInteger(value, 2, label);
}

function optionalCurrencyInputToCents(
  value: string,
  label: string,
): number | null {
  return value.trim() ? currencyInputToCents(value, label) : null;
}

function percentageInputToBps(value: string): number {
  const bps = decimalInputToInteger(value, 2, "percentage");
  if (bps > 10000) throw new Error("Percentage must be between 0 and 100.");
  return bps;
}

function decimalInputToInteger(
  value: string,
  scale: number,
  label: string,
): number {
  const normalized = value.trim();
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${scale}}))?$`).exec(
    normalized,
  );
  if (!match)
    throw new Error(
      `${label} must be a non-negative number with at most ${scale} decimal places.`,
    );
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(scale, "0");
  const parsed = Number(`${whole}${fraction}`);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large.`);
  return parsed;
}

function requiredInteger(value: string, label: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${label} must be an integer.`);
  return parsed;
}

function requiredNonnegativeInteger(value: string, label: string): number {
  const parsed = requiredInteger(value, label);
  if (parsed < 0) throw new Error(`${label} cannot be negative.`);
  return parsed;
}

function requiredPositiveInteger(value: string, label: string): number {
  const parsed = requiredInteger(value, label);
  if (parsed <= 0) throw new Error(`${label} is required.`);
  return parsed;
}

function optionalPositiveInteger(value: string): number | undefined {
  return value.trim() ? requiredPositiveInteger(value, "value") : undefined;
}

function optionalText(value: string): string | null {
  return value.trim() || null;
}

function optionalIsoDate(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("Effective date is invalid.");
  return date.toISOString();
}

function activeCount(items: Array<{ isActive: boolean }> | undefined): number {
  return items?.filter((item) => item.isActive).length ?? 0;
}

function activeRateTableCount(
  config: DropshipShippingConfigOverview | undefined,
): number {
  return (
    config?.rateTables.filter((table) => table.status === "active").length ?? 0
  );
}

function formatShippingMoneyRange(
  minCents: number | null,
  maxCents: number | null,
): string {
  if (minCents === null && maxCents === null) return "No min/max";
  if (minCents !== null && maxCents !== null)
    return `${formatCents(minCents)} - ${formatCents(maxCents)}`;
  if (minCents !== null) return `Min ${formatCents(minCents)}`;
  return `Max ${formatCents(maxCents ?? 0)}`;
}

export {
  emptyCarrierProtectionPolicyForm,
  emptyCarrierProtectionAssignmentForm,
  ShippingConfigTab,
  CarrierProtectionAdmin,
  CarrierProtectionPolicyTable,
  CarrierProtectionPolicyDetails,
  CarrierProtectionAssignmentTable,
  carrierProtectionAssignmentScope,
  shippingPolicyStatus,
  currencyInputToCents,
  optionalCurrencyInputToCents,
  percentageInputToBps,
  decimalInputToInteger,
  requiredInteger,
  requiredNonnegativeInteger,
  requiredPositiveInteger,
  optionalPositiveInteger,
  optionalText,
  optionalIsoDate,
  activeCount,
  activeRateTableCount,
  formatShippingMoneyRange,
  type CarrierProtectionPolicyFormState,
  type CarrierProtectionAssignmentFormState,
  type DropshipChannelOption,
};
export default ShippingConfigTab;

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerReturnLabelSettingsState } from "@shared/returns/customer-return-label.contract";
import type { ReturnCarrierRuleDraft } from "@/lib/customer-return-label-settings";
import { customerReturnWeightLimitSchema } from "@shared/returns/customer-return-carrier-policy";

export function ReturnLabelCarrierRules({
  carriers,
  rules,
  onChange,
  requireAvailable = true,
}: {
  carriers: CustomerReturnLabelSettingsState["carriers"];
  rules: ReturnCarrierRuleDraft[];
  onChange: (rules: ReturnCarrierRuleDraft[]) => void;
  requireAvailable?: boolean;
}) {
  function update(carrierId: string, patch: Partial<ReturnCarrierRuleDraft>) {
    onChange(
      rules.map((rule) =>
        rule.carrierId === carrierId ? { ...rule, ...patch } : rule,
      ),
    );
  }
  return (
    <section aria-labelledby="return-carrier-rules-title" className="space-y-3">
      <div>
        <h3 id="return-carrier-rules-title" className="font-medium">
          Allowed carriers and services
        </h3>
        <p className="text-sm text-muted-foreground">
          Each box uses the lowest available return-label price from the
          services you allow. A weight limit excludes that account above the
          limit; carrier restrictions still apply.
        </p>
      </div>
      {rules.length === 0 && (
        <p className="text-sm">
          No connected return services are available. Refresh shipping choices
          to try again.
        </p>
      )}
      {rules.map((rule) => {
        const carrier = carriers.find(
          (candidate) => candidate.id === rule.carrierId,
        );
        const name = carrier?.name ?? "Unavailable carrier";
        const label = `${name} (${rule.carrierId})`;
        const prefix = `return-rule-${rule.carrierId}`;
        const missingServices = rule.serviceCodes.filter(
          (code) => !carrier?.services.some((service) => service.code === code),
        );
        const invalidWeight =
          rule.maxWeightLb.trim() !== "" &&
          !customerReturnWeightLimitSchema.safeParse(rule.maxWeightLb).success;
        return (
          <div
            key={rule.carrierId}
            className="min-w-0 space-y-3 rounded-lg border p-3"
            data-testid={`return-carrier-rule-${rule.carrierId}`}
          >
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                className="h-5 w-5 shrink-0"
                checked={rule.enabled}
                onChange={(event) =>
                  update(rule.carrierId, { enabled: event.target.checked })
                }
                aria-label={`Allow ${label}`}
              />
              <span className="min-w-0 break-words font-medium">
                {name}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {rule.carrierId}
                </span>
              </span>
            </label>
            {!carrier && (
              <p className="text-sm text-destructive">
                {requireAvailable
                  ? "This connected account is unavailable. Disable it or refresh before saving."
                  : "This connected account is currently unavailable. Its saved rules can be kept while labels are disabled; verify it before enabling labels."}
              </p>
            )}
            {rule.enabled && (
              <div className="space-y-3 border-t pt-3">
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">
                    Allowed return services
                  </legend>
                  {carrier?.services.map((service) => (
                    <label
                      key={service.code}
                      className="flex min-h-11 items-center gap-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0"
                        checked={rule.serviceCodes.includes(service.code)}
                        onChange={(event) =>
                          update(rule.carrierId, {
                            serviceCodes: event.target.checked
                              ? [...rule.serviceCodes, service.code]
                              : rule.serviceCodes.filter(
                                  (code) => code !== service.code,
                                ),
                          })
                        }
                        aria-label={`Allow ${service.name} from ${label}`}
                      />
                      <span className="break-words">{service.name}</span>
                    </label>
                  ))}
                  {missingServices.map((code) => (
                    <label
                      key={code}
                      className="flex min-h-11 items-center gap-3 text-sm text-destructive"
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0"
                        checked
                        onChange={() =>
                          update(rule.carrierId, {
                            serviceCodes: rule.serviceCodes.filter(
                              (selected) => selected !== code,
                            ),
                          })
                        }
                        aria-label={`Remove unavailable ${code} from ${label}`}
                      />
                      <span className="break-all">
                        {code} · unavailable; clear to remove
                      </span>
                    </label>
                  ))}
                  {rule.serviceCodes.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Choose at least one service for this account.
                    </p>
                  )}
                </fieldset>
                <div className="max-w-sm space-y-1">
                  <Label htmlFor={`${prefix}-weight`}>
                    Maximum box weight (lb)
                  </Label>
                  <Input
                    id={`${prefix}-weight`}
                    inputMode="decimal"
                    value={rule.maxWeightLb}
                    maxLength={16}
                    placeholder="No added limit"
                    aria-label={`Maximum box weight (lb) for ${label}`}
                    aria-invalid={invalidWeight}
                    aria-describedby={`${prefix}-weight-help`}
                    onChange={(event) =>
                      update(rule.carrierId, {
                        maxWeightLb: event.target.value,
                      })
                    }
                  />
                  <p
                    id={`${prefix}-weight-help`}
                    className={`text-xs ${invalidWeight ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {invalidWeight
                      ? "Enter a positive weight with up to three decimal places, or leave blank."
                      : rule.maxWeightLb.trim()
                        ? `${name} is excluded above ${rule.maxWeightLb.trim()} lb.`
                        : "No added business limit. Carrier restrictions still apply."}
                  </p>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

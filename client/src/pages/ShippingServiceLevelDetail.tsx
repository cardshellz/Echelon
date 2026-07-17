import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  fulfillmentModeLabel,
  loadShippingServiceLevels,
  refreshShippingServiceLevels,
  saveServiceLevelDetails,
  serviceLevelPromise,
  SHIPPING_ADMIN_CONFIG_KEY,
  type ShippingServiceLevel,
} from "@/components/shipping/service-levels/api";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  Loader2,
  PackageCheck,
  Save,
  Settings2,
  Truck,
} from "lucide-react";

type FlowStep = "definition" | "routing" | "review";

interface DefinitionDraft {
  displayName: string;
  description: string;
  promiseMinBusinessDays: string;
  promiseMaxBusinessDays: string;
  isActive: boolean;
}

const FLOW_STEPS: Array<{
  id: FlowStep;
  label: string;
  icon: typeof Settings2;
}> = [
  { id: "definition", label: "Definition", icon: Settings2 },
  { id: "routing", label: "Fulfillment routing", icon: Truck },
  { id: "review", label: "Review and activate", icon: PackageCheck },
];

function definitionFromLevel(level: ShippingServiceLevel): DefinitionDraft {
  return {
    displayName: level.displayName,
    description: level.description ?? "",
    promiseMinBusinessDays: level.promiseMinBusinessDays === null
      ? ""
      : String(level.promiseMinBusinessDays),
    promiseMaxBusinessDays: level.promiseMaxBusinessDays === null
      ? ""
      : String(level.promiseMaxBusinessDays),
    isActive: level.isActive,
  };
}

function parsePromise(draft: DefinitionDraft): {
  min: number | null;
  max: number | null;
  error: string | null;
} {
  const minText = draft.promiseMinBusinessDays.trim();
  const maxText = draft.promiseMaxBusinessDays.trim();
  if (minText === "" && maxText === "") return { min: null, max: null, error: null };
  if (minText === "" || maxText === "") {
    return { min: null, max: null, error: "Set both ends of the delivery promise." };
  }
  const min = Number(minText);
  const max = Number(maxText);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
    return { min: null, max: null, error: "Enter a valid business-day range." };
  }
  return { min, max, error: null };
}

export default function ShippingServiceLevelDetail() {
  const params = useParams<{ id: string }>();
  const levelId = Number(params.id);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [step, setStep] = useState<FlowStep>("definition");
  const [definition, setDefinition] = useState<DefinitionDraft | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: [SHIPPING_ADMIN_CONFIG_KEY],
    queryFn: loadShippingServiceLevels,
  });
  const level = data?.serviceLevels.find((candidate) => candidate.id === levelId) ?? null;

  useEffect(() => {
    if (!level) return;
    setDefinition(definitionFromLevel(level));
  }, [level]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!level || !definition) throw new Error("Service level is not loaded.");
      const promise = parsePromise(definition);
      if (promise.error) throw new Error(promise.error);
      if (!definition.displayName.trim()) throw new Error("Checkout name is required.");
      await saveServiceLevelDetails(level.id, {
        displayName: definition.displayName.trim(),
        description: definition.description.trim(),
        promiseMinBusinessDays: promise.min,
        promiseMaxBusinessDays: promise.max,
        isActive: definition.isActive,
      });
    },
    onSuccess: () => {
      refreshShippingServiceLevels(queryClient);
      toast({ title: "Service level saved" });
      navigate("/shipping-service-levels");
    },
    onError: (error: Error) => {
      toast({ title: "Could not save service level", description: error.message, variant: "destructive" });
    },
  });

  if (!Number.isInteger(levelId) || levelId <= 0 || (!isLoading && (!level || isError))) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Service level not found</AlertTitle>
          <AlertDescription>This shipping option is unavailable or could not be loaded.</AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="mt-4">
          <Link to="/shipping-service-levels">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Service Levels
          </Link>
        </Button>
      </div>
    );
  }

  if (isLoading || !level || !definition) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (level.code !== "standard") {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link to="/shipping-service-levels">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Service Levels
          </Link>
        </Button>
        <Alert>
          <Truck className="h-4 w-4" />
          <AlertTitle>{level.displayName} is planned for a later phase</AlertTitle>
          <AlertDescription>
            Standard Shipping is the only checkout option in the initial rollout. This option will
            become configurable when provider accounts and fulfillment-method routing are added.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const promise = parsePromise(definition);
  const activeStepIndex = FLOW_STEPS.findIndex((candidate) => candidate.id === step);
  const moveForward = () => {
    if (step === "definition") {
      if (!definition.displayName.trim()) {
        toast({ title: "Checkout name is required", variant: "destructive" });
        return;
      }
      if (promise.error) {
        toast({ title: "Delivery promise needs attention", description: promise.error, variant: "destructive" });
        return;
      }
      setStep("routing");
      return;
    }
    if (step === "routing") setStep("review");
  };

  const moveBack = () => {
    if (step === "review") setStep("routing");
    else if (step === "routing") setStep("definition");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <header className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link to="/shipping-service-levels">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Service Levels
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold md:text-2xl">{level.displayName}</h1>
              <Badge variant={definition.isActive ? "default" : "secondary"}>
                {definition.isActive ? "Active" : "Inactive"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {fulfillmentModeLabel(level.fulfillmentMode)} shipping option
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label="Service level setup" className="self-start lg:sticky lg:top-6">
          <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
            {FLOW_STEPS.map((flowStep, index) => {
              const Icon = flowStep.icon;
              const isCurrent = flowStep.id === step;
              const isComplete = index < activeStepIndex;
              return (
                <li key={flowStep.id}>
                  <button
                    type="button"
                    className={`flex min-h-12 w-full items-center gap-3 rounded-md border px-3 text-left text-sm transition-colors ${
                      isCurrent
                        ? "border-primary bg-primary/5 font-medium"
                        : "border-transparent hover:bg-muted"
                    }`}
                    onClick={() => setStep(flowStep.id)}
                    aria-current={isCurrent ? "step" : undefined}
                  >
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                      isCurrent || isComplete ? "border-primary text-primary" : "text-muted-foreground"
                    }`}>
                      {isComplete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                    </span>
                    {flowStep.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="min-w-0">
          {step === "definition" && (
            <section className="space-y-6" aria-labelledby="definition-heading">
              <div>
                <h2 id="definition-heading" className="text-lg font-semibold">Definition</h2>
                <p className="text-sm text-muted-foreground">
                  The name and delivery promise shown to the customer.
                </p>
              </div>

              <div className="grid gap-5 border-y py-6 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="service-level-name">Checkout name</Label>
                  <Input
                    id="service-level-name"
                    value={definition.displayName}
                    onChange={(event) => setDefinition((current) => current && ({
                      ...current,
                      displayName: event.target.value,
                    }))}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="service-level-description">Customer-facing description</Label>
                  <Textarea
                    id="service-level-description"
                    rows={3}
                    value={definition.description}
                    onChange={(event) => setDefinition((current) => current && ({
                      ...current,
                      description: event.target.value,
                    }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Delivery type</Label>
                  <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
                    {fulfillmentModeLabel(level.fulfillmentMode)}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Pricing measure</Label>
                  <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
                    {level.fulfillmentMode === "freight" ? "Pallet count" : "Shipment weight"}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="promise-min">Minimum business days</Label>
                  <Input
                    id="promise-min"
                    type="number"
                    min="0"
                    step="1"
                    value={definition.promiseMinBusinessDays}
                    onChange={(event) => setDefinition((current) => current && ({
                      ...current,
                      promiseMinBusinessDays: event.target.value,
                    }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="promise-max">Maximum business days</Label>
                  <Input
                    id="promise-max"
                    type="number"
                    min="0"
                    step="1"
                    value={definition.promiseMaxBusinessDays}
                    onChange={(event) => setDefinition((current) => current && ({
                      ...current,
                      promiseMaxBusinessDays: event.target.value,
                    }))}
                  />
                  {promise.error && <p className="text-sm text-destructive">{promise.error}</p>}
                </div>
              </div>
            </section>
          )}

          {step === "routing" && (
            <section className="space-y-6" aria-labelledby="routing-heading">
              <div>
                <h2 id="routing-heading" className="text-lg font-semibold">Fulfillment routing</h2>
                <p className="text-sm text-muted-foreground">
                  How the checkout option is translated into a label-purchase method.
                </p>
              </div>

              <Alert>
                <Truck className="h-4 w-4" />
                <AlertTitle>Provider routing is not configured in the initial rollout</AlertTitle>
                <AlertDescription>
                  Standard Shipping is priced from its active rate table. Label purchase continues
                  through the existing fulfillment workflow. Later, connected carrier accounts will
                  supply an authoritative method catalog for routing and enforcement here.
                </AlertDescription>
              </Alert>

              <dl className="grid gap-x-8 gap-y-5 border-y py-6 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-muted-foreground">Checkout pricing</dt>
                  <dd className="mt-1 font-medium">Standard rate table</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Label method selection</dt>
                  <dd className="mt-1 font-medium">Existing fulfillment workflow</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Carrier account sync</dt>
                  <dd className="mt-1 font-medium">Planned</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Method enforcement</dt>
                  <dd className="mt-1 font-medium">Planned</dd>
                </div>
              </dl>
            </section>
          )}

          {step === "review" && (
            <section className="space-y-6" aria-labelledby="review-heading">
              <div>
                <h2 id="review-heading" className="text-lg font-semibold">Review and activate</h2>
                <p className="text-sm text-muted-foreground">
                  Confirm the Standard Shipping name, promise, and availability.
                </p>
              </div>

              <dl className="grid gap-x-8 gap-y-5 border-y py-6 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-muted-foreground">Checkout option</dt>
                  <dd className="mt-1 font-medium">{definition.displayName}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Delivery type</dt>
                  <dd className="mt-1 font-medium">{fulfillmentModeLabel(level.fulfillmentMode)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Delivery promise</dt>
                  <dd className="mt-1 font-medium">{serviceLevelPromise({
                    promiseMinBusinessDays: promise.min,
                    promiseMaxBusinessDays: promise.max,
                  })}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">Checkout pricing</dt>
                  <dd className="mt-1 font-medium">Active Standard rate table</dd>
                </div>
              </dl>

              <div className="flex items-center justify-between gap-4 rounded-md border p-4">
                <div>
                  <Label htmlFor="service-level-active" className="text-base font-medium">
                    Available for checkout
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Active rate tables may offer this option to eligible orders.
                  </p>
                </div>
                <Switch
                  id="service-level-active"
                  checked={definition.isActive}
                  onCheckedChange={(checked) => setDefinition((current) => current && ({
                    ...current,
                    isActive: checked === true,
                  }))}
                />
              </div>

              {definition.isActive && (
                <Alert>
                  <CircleCheck className="h-4 w-4" />
                  <AlertTitle>Standard Shipping enabled</AlertTitle>
                  <AlertDescription>
                    Checkout can offer this option wherever an active Standard rate table matches.
                  </AlertDescription>
                </Alert>
              )}
            </section>
          )}

          <div className="sticky bottom-0 mt-8 flex items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur">
            <Button
              type="button"
              variant="outline"
              onClick={moveBack}
              disabled={step === "definition" || saveMutation.isPending}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            {step === "review" ? (
              <Button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save service level
              </Button>
            ) : (
              <Button type="button" onClick={moveForward}>
                Continue
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

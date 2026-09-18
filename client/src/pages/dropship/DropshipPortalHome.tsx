import { useQuery } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { dropshipPortalPath, useDropshipAuth } from "@/lib/dropship-auth";
import { isOnboardingVendor } from "@/lib/dropship-onboarding";
import { fetchJson, type DropshipOnboardingState } from "@/lib/dropship-ops-surface";

const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;

/**
 * Where a signed-in vendor lands. A vendor still onboarding goes straight to
 * the checklist; everyone else goes to the dashboard. When the state cannot be
 * loaded the dashboard is where the error is shown, so it goes there too.
 */
export default function DropshipPortalHome() {
  const { principal } = useDropshipAuth();
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: [...ONBOARDING_QUERY_KEY],
    queryFn: () => fetchJson<DropshipOnboardingState>(ONBOARDING_QUERY_KEY[0]),
    enabled: !!principal,
  });
  if (!principal || (!onboardingQuery.data && !onboardingQuery.error)) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6" data-testid="portal-home-loading">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const destination = onboardingQuery.data && isOnboardingVendor(onboardingQuery.data.vendor.status)
    ? "/onboarding"
    : "/dashboard";
  return <Redirect to={dropshipPortalPath(destination)} />;
}

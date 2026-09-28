import { Redirect, useSearch } from "wouter";
import { legacyReturnPolicyPath } from "@/lib/return-policy-shipping";

/** Preserve administrator bookmarks without retaining a second configuration owner. */
export default function ReturnLabelSettings() {
  const search = useSearch();
  return <Redirect to={legacyReturnPolicyPath(search)} />;
}

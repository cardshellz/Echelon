import { vi } from "vitest";
import type { EbayQuantityRequestAdmission } from "../../quantity-publication-request";
import type { QuantityPublicationAdmission } from "../../../inventory-planning/application/quantity-publication-admission.port";

/** Explicit admitted legacy authority for HTTP-only tests. Never used by a
 * production factory; database gate behavior has separate PostgreSQL coverage.
 *
 * vi.fn types its call signature from Parameters/ReturnType of the procedure, so
 * a generic port method (`Promise<T>`) becomes `Promise<unknown>` and a bare mock
 * is not assignable to EbayQuantityRequestAdmission. Each mock does keep the
 * generic contract at runtime (it returns whatever `work` returns), so the owner
 * is typed as both its mocks and the port. */
export function createAdmittedEbayQuantityTestOwner() {
  const mocks = {
    item: vi.fn<EbayQuantityRequestAdmission["item"]>(async (_sku, work) => work(null)),
    group: vi.fn<EbayQuantityRequestAdmission["group"]>(async (_group, _skus, work) => work(null)),
    reducing: vi.fn<EbayQuantityRequestAdmission["reducing"]>(async (_identity, work) => work()),
  };
  return mocks as typeof mocks & EbayQuantityRequestAdmission;
}

export function createAdmittedQuantityTestOwner() {
  return {
    run: vi.fn<QuantityPublicationAdmission["run"]>(async (_scope, work) => work()),
    runListing: vi.fn<QuantityPublicationAdmission["runListing"]>(async (_scope, _plan, work) => work(null)),
    runListingGroup: vi.fn<QuantityPublicationAdmission["runListingGroup"]>(async (_scope, _members, _plan, work) => work(null)),
    runQuantityReducingLifecycle: vi.fn<QuantityPublicationAdmission["runQuantityReducingLifecycle"]>(async (_scope, work) => work()),
    runOutbox: vi.fn<QuantityPublicationAdmission["runOutbox"]>(async (_claim, work) => work()),
  };
}

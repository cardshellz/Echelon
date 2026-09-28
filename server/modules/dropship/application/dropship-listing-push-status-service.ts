import { z } from "zod";
import { DropshipError } from "../domain/errors";

/** Job statuses after which nothing more happens to the job's items. */
export const FINISHED_LISTING_PUSH_JOB_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export interface VendorListingPushItemRecord {
  itemId: number;
  listingId: number | null;
  productVariantId: number;
  sku: string | null;
  productName: string;
  variantName: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  /** The worker's own classification of a failure; null while the item has not failed. */
  retryable: boolean | null;
  externalListingId: string | null;
}

export interface VendorListingPushJobRecord {
  jobId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  items: VendorListingPushItemRecord[];
}

export interface DropshipVendorListingPushItem extends VendorListingPushItemRecord {
  /** A public page for a listing this push put live; null on other platforms and for items that did not complete. */
  listingUrl: string | null;
}

export interface DropshipVendorListingPushJob extends Omit<VendorListingPushJobRecord, "items" | "vendorId"> {
  finished: boolean;
  items: DropshipVendorListingPushItem[];
}

export interface DropshipListingPushStatusRepository {
  findVendorIdByMemberId(memberId: string): Promise<number | null>;
  /** The job with its items, only when this vendor owns it. */
  loadVendorJob(input: { vendorId: number; jobId: number }): Promise<VendorListingPushJobRecord | null>;
}

const memberIdSchema = z.string().trim().min(1).max(255);
const jobIdSchema = z.number().int().positive().max(2_147_483_647);

/**
 * What became of a push the vendor queued. Reads are scoped to the vendor's
 * own jobs: another vendor's job, or a member with no vendor, reads as not
 * found rather than forbidden, so job ids cannot be probed.
 */
export class DropshipListingPushStatusService {
  constructor(private readonly deps: { repository: DropshipListingPushStatusRepository }) {}

  async getForMember(memberId: unknown, jobId: unknown): Promise<DropshipVendorListingPushJob> {
    const member = memberIdSchema.safeParse(memberId);
    if (!member.success) throw new DropshipError("DROPSHIP_AUTH_REQUIRED", "Sign in to see your listing pushes.");
    const id = jobIdSchema.safeParse(jobId);
    if (!id.success) throw new DropshipError("DROPSHIP_LISTING_PUSH_JOB_INVALID", "The listing push id is not valid.", { jobId });
    const vendorId = await this.deps.repository.findVendorIdByMemberId(member.data);
    const job = vendorId === null ? null : await this.deps.repository.loadVendorJob({ vendorId, jobId: id.data });
    if (!job) throw new DropshipError("DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND", "That listing push was not found.", { jobId: id.data });
    const { vendorId: _owner, ...visible } = job;
    return {
      ...visible,
      finished: FINISHED_LISTING_PUSH_JOB_STATUSES.has(job.status),
      items: job.items.map((item) => ({
        ...item,
        listingUrl: item.status === "completed" ? marketplaceListingUrl(job.platform, item.externalListingId) : null,
      })),
    };
  }
}

/** Only an eBay item id forms a public page a vendor can open; other platforms keep the id alone. */
export function marketplaceListingUrl(platform: string, externalListingId: string | null): string | null {
  if (externalListingId === null) return null;
  if (platform === "ebay" && /^\d{6,20}$/.test(externalListingId)) return `https://www.ebay.com/itm/${externalListingId}`;
  return null;
}

import type { AddressInfo } from "node:net";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerListingLifecycleRoutes } from "../../interfaces/http/listing-lifecycle.routes";
import { ListingMemberLifecycleError } from "../../domain/listing-member-lifecycle";

const { membership } = vi.hoisted(() => ({ membership: vi.fn() }));
vi.mock("../../../../listing-intent-propagation.composition", () => ({
  listingIntentPropagationRepository: { vendorForMemberStore: membership },
}));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (_resource: string, action: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      if (action === "edit" && req.headers["x-can-edit"] !== "yes")
        return res.status(403).json({ code: "FORBIDDEN" });
      next();
    },
}));
vi.mock("../../../dropship/interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, res: Response, next: NextFunction) => {
    if (req.headers["x-member"] !== "signed-in") return res.sendStatus(401);
    next();
  },
}));

describe("shared listing member recovery HTTP ownership", () => {
  const owner = {
    memberHistory: vi.fn(async () => []),
    memberRecoveryPreview: vi.fn(async () => ({ canResume: true })),
    resumeMemberRecovery: vi.fn(async () => ({ state: "pending" })),
  };
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const command = {
    operationId: "18ab628a-ac68-4c5a-973b-3fb91cbdf11b",
    commandKey: "09eb00b2-7ac4-4195-ae69-ceef6559e7fd",
    reviewHash: "a".repeat(64),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    membership.mockResolvedValue(7);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = {
        user: { id: "operator-4" },
        dropship: { memberId: 14 },
      } as unknown as Request["session"];
      next();
    });
    // This HTTP harness exercises only the three recovery entry points. The
    // real owner, schema validation and persistence run in PostgreSQL tests.
    app.locals.services = { listingLifecycle: owner } as unknown as typeof app.locals.services;
    registerListingLifecycleRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const post = (
    path: string,
    body: unknown = command,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const channel = "/api/channels/10/listing-lifecycle/members/recovery";

  it("allows a read-only review but requires edit permission to authorize recovery", async () => {
    expect(
      (await post(channel, { operationId: command.operationId })).status,
    ).toBe(200);
    expect(owner.memberRecoveryPreview).toHaveBeenCalledWith(10, {
      operationId: command.operationId,
    });
    expect((await post(channel + "/resume")).status).toBe(403);
    expect(owner.resumeMemberRecovery).not.toHaveBeenCalled();
  });

  it("passes the authenticated operator, never a body actor, to the shared owner", async () => {
    const response = await post(channel + "/resume", command, {
      "x-can-edit": "yes",
    });
    expect(response.status).toBe(200);
    expect(owner.resumeMemberRecovery).toHaveBeenCalledWith(
      10,
      command,
      "operator-4",
    );
  });

  it("preserves a normalized recovery diagnostic and rejects invalid channel scope", async () => {
    owner.memberRecoveryPreview.mockRejectedValueOnce(
      new ListingMemberLifecycleError(
        "LISTING_MEMBER_OBSERVATION_INVALID",
        "Refresh the recovery review.",
      ),
    );
    const response = await post(channel);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "LISTING_MEMBER_OBSERVATION_INVALID",
    });
    expect((await post(channel.replace("/10/", "/-1/"))).status).toBe(400);
    expect(owner.memberRecoveryPreview).toHaveBeenCalledTimes(1);
  });

  it("requires Dropship authentication and resolves vendor scope from membership", async () => {
    const path =
      "/api/dropship/listings/stores/70/listing-lifecycle/members/recovery/resume";
    expect((await post(path)).status).toBe(401);
    expect(membership).not.toHaveBeenCalled();
    expect(
      (await post(path, command, { "x-member": "signed-in" })).status,
    ).toBe(200);
    expect(membership).toHaveBeenCalledWith(14, 70);
    expect(owner.resumeMemberRecovery).toHaveBeenCalledWith(
      { connectionId: 70, vendorId: 7 },
      command,
      "dropship-member:14",
    );
  });

  it("does not expose another vendor's history or authorize its recovery", async () => {
    membership.mockResolvedValue(null);
    const prefix = "/api/dropship/listings/stores/70/listing-lifecycle/members";
    for (const suffix of ["", "/recovery", "/recovery/resume"])
      expect(
        (await post(prefix + suffix, command, { "x-member": "signed-in" }))
          .status,
      ).toBe(404);
    expect(owner.memberHistory).not.toHaveBeenCalled();
    expect(owner.memberRecoveryPreview).not.toHaveBeenCalled();
    expect(owner.resumeMemberRecovery).not.toHaveBeenCalled();
  });
});

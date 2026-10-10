import express from "express";
import session from "express-session";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exchange: vi.fn(), getChannel: vi.fn(), getChannels: vi.fn(), tokenRows: vi.fn() }));
vi.mock("../../../db", () => ({ db: { select: () => ({ from: mocks.tokenRows }) } }));
vi.mock("../../../modules/channels", () => ({ channelMethods: { getChannelById: mocks.getChannel, getAllChannels: mocks.getChannels } }));
vi.mock("../../../modules/channels/adapters/ebay/ebay-auth.service", () => ({
  createEbayAuthConfig: () => ({ clientId: "client", clientSecret: "secret", ruName: "return", environment: "production" }),
  EbayAuthService: class {
    getConsentUrl(state: string) { return `https://auth.ebay.test/authorize?state=${state}`; }
    exchangeAuthorizationCode = mocks.exchange;
  },
}));
vi.mock("../../middleware", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => req.session.user ? next() : res.status(401).json({ error: "Authentication required" }),
  requirePermission: (resource: string, action: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (resource !== "channels" || !["edit", "view"].includes(action)) throw new Error("Unexpected OAuth permission");
    return req.header("x-deny-permission") === "true" ? res.status(403).json({ error: "Permission denied" }) : next();
  },
}));
import { registerEbayOAuthRoutes } from "../../ebay-oauth.routes";

const servers: Server[] = [];
function createClient(application: express.Express) {
  const server = createServer(application); servers.push(server);
  const ready = new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") resolve(`http://127.0.0.1:${address.port}`);
  }));
  let cookie = "";
  return { get(path: string) {
    const headers: Record<string, string> = {};
    const builder = {
      set(key: string, value: string) { headers[key] = value; return builder; },
      async expect(status: number) {
        const response = await fetch(`${await ready}${path}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) }, redirect: "manual" });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) cookie = cookies.map((value) => value.split(";")[0]).join("; ");
        const text = await response.text();
        expect(response.status, text).toBe(status);
        return { text, headers: { location: response.headers.get("location")! } };
      },
    };
    return builder;
  } };
}
const request = Object.assign(createClient, { agent: createClient });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

function app() {
  const app = express();
  app.use(session({ secret: "test-secret-only-for-session-security-tests", resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (req.header("x-test-user")) req.session.user = { id: req.header("x-test-user")! } as NonNullable<typeof req.session.user>; next(); });
  registerEbayOAuthRoutes(app); return app;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.getChannel.mockResolvedValue({ id: 67, provider: "ebay" }); mocks.getChannels.mockResolvedValue([{ id: 67, provider: "ebay" }]); mocks.exchange.mockResolvedValue(undefined); mocks.tokenRows.mockResolvedValue([]);
});

describe("eBay OAuth session binding", () => {
  it("requires channel edit permission to begin or complete authorization", async () => {
    await request(app()).get("/api/ebay/oauth/consent").expect(401);
    await request(app()).get("/api/ebay/oauth/consent").set("x-test-user", "user-1").set("x-deny-permission", "true").expect(403);
    await request(app()).get("/api/ebay/oauth/callback?code=code&state=67").expect(401);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("consumes the saved challenge and ignores callback channel selection", async () => {
    const agent = request.agent(app());
    const consent = await agent.get("/api/ebay/oauth/consent?channelId=67").set("x-test-user", "user-1").expect(302);
    const state = new URL(consent.headers.location).searchParams.get("state")!;
    expect(state).toMatch(/^echelon-[a-f0-9]{64}$/);
    const callback = `/api/ebay/oauth/callback?code=authorization-code&channelId=999&state=${state}`;
    await agent.get(callback).expect(200);
    expect(mocks.exchange).toHaveBeenCalledWith(67, "authorization-code");
    await agent.get(callback).expect(400);
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
  });
  it("rejects an authorization response copied to a different session", async () => {
    const application = app();
    const consent = await request.agent(application).get("/api/ebay/oauth/consent").set("x-test-user", "user-1").expect(302);
    const state = new URL(consent.headers.location).searchParams.get("state")!;
    await request.agent(application).get(`/api/ebay/oauth/callback?code=code&state=${state}`).set("x-test-user", "user-2").expect(400);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("does not render provider HTML or credentials into the callback page", async () => {
    const agent = request.agent(app());
    const consent = await agent.get("/api/ebay/oauth/consent").set("x-test-user", "user-1").expect(302);
    const state = new URL(consent.headers.location).searchParams.get("state")!;
    mocks.exchange.mockRejectedValueOnce(new Error('<img src=x onerror=alert(1)> Bearer SECRET_TOKEN'));
    const response = await agent.get(`/api/ebay/oauth/callback?code=code&state=${state}`).expect(400);
    expect(response.text).not.toContain("<img"); expect(response.text).not.toContain("SECRET_TOKEN");
    expect(response.text).toContain("&lt;img"); expect(response.text).toContain("Return to eBay Connection settings");
    expect(response.text).toContain("Error code: EBAY_OAUTH_CONNECTION_FAILED");
  });
  it("reports a failed status read without disclosing database errors or pretending it succeeded", async () => {
    mocks.tokenRows.mockRejectedValueOnce(new Error("postgresql://user:SECRET@database/provider-credentials"));
    const response = await request(app()).get("/api/ebay/oauth/status").set("x-test-user", "user-1").expect(503);
    expect(JSON.parse(response.text)).toMatchObject({ configured: true, code: "EBAY_AUTH_STATUS_UNAVAILABLE" });
    expect(response.text).toContain("Refresh Connection settings");
    expect(response.text).not.toContain("SECRET"); expect(response.text).not.toContain("postgresql");
  });
});

import { expect, test, type Page } from "@playwright/test";
import { staffAuthorityFixture } from "./fixtures/staff-authority.fixture";
import { buildAccessReview } from "../../server/modules/identity/domain/access-review";
import type { AccessConfiguration } from "../../server/modules/identity/domain/access-configuration";

async function setup(page: Page, permissions: string[],completion=false,zeroRoles=false) {
  let completedCredentialChange=false;
  const state = { writes: [] as Array<{ path: string; body: Record<string,unknown> }>, unexpected: [] as string[], errors: [] as string[] };
  const configuration: AccessConfiguration = {
    revision: "a".repeat(64),
    users: [{ id: "staff-2",label: "Synthetic shipment operator",active: 1 }],
    roles: [{ id: 7,name: "Shipment reader",system: 0 },{ id: 8,name: "Cost access",system: 0 }],
    permissions: [{ id: 1,key: "shipments:view" },{ id: 2,key: "shipments:view_costs" },{ id: 3,key: "shipments:view_order_context" }],
    memberships: [{ userId: "staff-2",roleId: 7 }],
    grants: [{ roleId: 7,permissionId: 1,restriction: null },{ roleId: 8,permissionId: 2,restriction: null }],
  };
  const profile = { id: "staff-2",username: "shipment-operator",displayName: "Synthetic shipment operator",role: "picker",active: 1,createdAt: "2026-11-05T00:00:00Z",lastLoginAt: null };
  const catalog = [
    { id: 1,resource: "shipments",action: "view",category: "shipping",description: "View shipments without order management or costs" },
    { id: 2,resource: "shipments",action: "view_costs",category: "shipping",description: "View sensitive carrier costs" },
    { id: 3,resource: "shipments",action: "view_order_context",category: "shipping",description: "View a linked read-only order summary" },
  ];
  page.on("pageerror",error => state.errors.push(error.message));
  await page.route("**/*",route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**",async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === "/api/auth/me") {if(completedCredentialChange)return route.fulfill({status:401,json:{error:"Sign in again"}});return route.fulfill({ json: {...staffAuthorityFixture({
      user: { id: "staff-1",username: "synthetic-staff",role: "picker" },permissions,systemRoles: [],
      assignedRoles: (completion||zeroRoles)?[]:[{ id: 50,name: "Custom access",isSystem: false }],
    }),credentialActionRequired:completion} });}
    if(path==="/api/auth/password" && method==="POST"){state.writes.push({path,body:request.postDataJSON()});completedCredentialChange=true;return route.fulfill({status:204});}
    if(path==="/api/users/staff-2/credential-review")return route.fulfill({json:{userId:"staff-2",credentialVersion:"a760c267-283a-43bd-9bfb-c8a6d1048033",protectedTarget:true,requiredPermission:"users:reset_privileged_password",expectedAccessRevision:configuration.revision,lastOperationId:null}});
    if(path==="/api/users/staff-2/password-reset" && method==="POST"){state.writes.push({path,body:request.postDataJSON()});return route.fulfill({status:204});}
    if (path === "/api/outbound-shipments") return route.fulfill({ json: {
      rows: [{ id: 1,orderId: 10,orderNumber: "TEST-10",customerName: "Synthetic recipient",channelName: "Test channel",
        status: "shipped",carrier: "USPS",trackingNumber: "TEST-TRACK",trackingUrl: null,shippedAt: "2026-11-05T00:00:00Z",
        ...(permissions.includes("shipments:view_costs") ? { carrierCostCents: 1234 } : {}) }],
      total: 1,summary: { byCarrier: [{ carrier: "USPS",count: 1 }],byStatus: [{ status: "shipped",count: 1 }] },
    } });
    if (path === "/api/outbound-shipments/1/order-context") return route.fulfill({ json: { shipmentId: 1,order: {
      orderNumber: "TEST-10",customerName: "Synthetic recipient",warehouseStatus: "shipped",onHold: false,
      items: [{ id: 101,sku: "SKU-A",name: "Synthetic item",quantity: 2,pickedQuantity: 2,status: "completed" }],hasMoreItems: false,
    } } });
    if (path === "/api/notifications") return route.fulfill({ json: [] });
    if (path === "/api/notifications/unread-count") return route.fulfill({ json: { count: 0 } });
    if (path === "/api/permissions") return route.fulfill({ json: catalog });
    if (path === "/api/roles") return route.fulfill({ json: configuration.roles.map(role => ({
      id: role.id,name: role.name,isSystem: 0,description: "Synthetic role",createdAt: "2026-11-05T00:00:00Z",
    })) });
    if (path === "/api/users") return route.fulfill({ headers: { "X-Access-Revision": configuration.revision },json: [profile] });
    if (path === "/api/users/staff-2" && method === "PATCH") {
      const body = request.postDataJSON(); state.writes.push({ path,body });
      if(body.expectedAccessRevision !== configuration.revision) return route.fulfill({ status: 409,json: { code: "IDENTITY_ACCESS_STALE",error: "private diagnostic" } });
      if(body.displayName !== undefined) profile.displayName=body.displayName;
      if(body.active !== undefined) profile.active=body.active;
      configuration.revision="b".repeat(64); return route.fulfill({ json: profile });
    }
    if (/^\/api\/roles\/\d+\/permissions$/.test(path)) {
      const roleId = Number(path.split("/")[3]);
      if (method === "GET") return route.fulfill({ json: catalog.filter(item => configuration.grants.some(grant => grant.roleId === roleId && grant.permissionId === item.id)).map(item => ({ ...item,isRestricted: false })) });
      const body = request.postDataJSON(); state.writes.push({ path,body });
      configuration.grants = configuration.grants.filter(grant => grant.roleId !== roleId).concat(body.permissionIds.map((permissionId: number) => ({ roleId,permissionId,restriction: null })));
      configuration.revision = "b".repeat(64); return route.fulfill({ json: { success: true } });
    }
    if (/^\/api\/roles\/\d+\/access-review$/.test(path)) {
      const body = request.postDataJSON() ?? {};
      return route.fulfill({ json: buildAccessReview(configuration,{ kind: "role",id: Number(path.split("/")[3]),permissionIds: body.permissionIds,removeRole: body.removeRole },true) });
    }
    if (path === "/api/users/staff-2/access-review") {
      const body = request.postDataJSON() ?? {};
      return route.fulfill({ json: buildAccessReview(configuration,{ kind: "user",id: "staff-2",roleIds: body.roleIds },true) });
    }
    if (path === "/api/users/staff-2/roles" && method === "PUT") {
      const body = request.postDataJSON(); state.writes.push({ path,body }); configuration.memberships = body.roleIds.map((roleId: number) => ({ userId: "staff-2",roleId }));
      configuration.revision = "b".repeat(64); return route.fulfill({ json: { success: true } });
    }
    if (method === "GET" && (/^\/api\/(settings|health|system|notifications|warehouses|operations)(\/|$)/.test(path)))
      return route.fulfill({ json: path === "/api/warehouses" ? [] : {} });
    state.unexpected.push(method+" "+path); return route.fulfill({ status: 403,json: { error: "Unexpected fixture entrypoint" } });
  });
  return { ...state,configuration,profile };
}

test("shipment capability keeps costs and order-management links separately gated",async ({ page }) => {
  const state = await setup(page,["shipments:view"]); await page.goto("/");
  await expect(page.getByRole("heading",{ name: "Shipments",exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader",{ name: "Cost",exact: true })).toHaveCount(0);
  await expect(page.getByRole("link",{ name: "TEST-10",exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/orders"]')).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});
test("shipment order context has a filtered return path and no order-management handoff",async ({ page }) => {
  const state = await setup(page,["shipments:view","shipments:view_order_context"]);
  await page.goto("/outbound-shipments?search=TEST&days=90&page=1");
  await page.getByRole("link",{ name: "TEST-10",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Shipment order summary" })).toBeVisible();
  await expect(page.getByText("Synthetic item",{ exact: true })).toBeVisible();
  await expect(page.getByRole("button",{ name: /cancel|edit|hold/i })).toHaveCount(0);
  await page.getByRole("link",{ name: "Back to shipments" }).click();
  await expect(page.getByPlaceholder("Search order #, tracking, customer...")).toHaveValue("TEST");
  expect(state.unexpected.filter(value => value.includes("/api/orders"))).toEqual([]); expect(state.errors).toEqual([]);
});
test("only an explicit cost grant shows carrier costs",async ({ page }) => {
  await setup(page,["shipments:view","shipments:view_costs"]); await page.goto("/outbound-shipments");
  await expect(page.getByRole("columnheader",{ name: "Cost",exact: true })).toBeVisible();
  await expect(page.getByRole("cell",{ name: "$12.34",exact: true })).toBeVisible();
});
test("a direct order-context link is denied without the capability and performs no context read",async ({ page }) => {
  const reads: string[] = []; page.on("request",request => { if (request.url().includes("/order-context")) reads.push(request.url()); });
  await setup(page,["shipments:view"]); await page.goto("/outbound-shipments/1/order");
  await expect(page.getByTestId("staff-access-notice")).toBeVisible();
  expect(reads).toEqual([]);
});
test("invalid contextual links fail clearly with a safe return path",async ({ page }) => {
  await setup(page,["shipments:view","shipments:view_order_context"]); await page.goto("/outbound-shipments/bad/order");
  await expect(page.getByText("This shipment link is invalid.")).toBeVisible();
  await expect(page.getByRole("link",{ name: "Back to shipments" })).toHaveAttribute("href","/outbound-shipments");
});
test("role editing previews affected users and saves only after explicit review",async ({ page }) => {
  const state = await setup(page,["roles:view","roles:edit","users:view"]); await page.goto("/roles");
  await page.getByTestId("role-item-7").click();
  await expect(page.getByText("Synthetic shipment operator",{ exact: true })).toBeVisible();
  await page.getByTestId("checkbox-perm-2").click(); expect(state.writes).toEqual([]);
  await page.getByTestId("button-review-role-access").click();
  await expect(page.getByTestId("button-save-reviewed-role")).toBeEnabled(); expect(state.writes).toEqual([]);
  await page.getByTestId("button-save-reviewed-role").click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toEqual({ permissionIds: [1,2],expectedAccessRevision: "a".repeat(64) });
  expect(state.errors).toEqual([]);
});
test("assignment dependencies block an incomplete journey without automatic grants",async ({ page },testInfo) => {
  const state = await setup(page,["users:view","users:manage_roles","roles:view"]); await page.goto("/users");
  await page.getByTestId(testInfo.project.name === "mobile" ? "button-manage-roles-mobile-staff-2" : "button-manage-roles-staff-2").click();
  await page.getByTestId("checkbox-assigned-role-8").click(); await page.getByTestId("checkbox-assigned-role-7").click();
  await page.getByTestId("button-review-assignments").click();
  await expect(page.getByText("This change creates incomplete access. Resolve its prerequisites before saving.")).toBeVisible();
  await expect(page.getByTestId("button-save-assignments")).toBeDisabled();
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});


test("a profile-only edit sends no saved activation value and needs no role-read grant",async ({ page },testInfo) => {
  const state = await setup(page,["users:view","users:edit"]); await page.goto("/users");
  await page.getByTestId(testInfo.project.name === "mobile" ? "button-edit-user-mobile-staff-2" : "button-edit-user-staff-2").click();
  await page.getByTestId("input-edit-displayname").fill("Renamed synthetic operator");
  await page.getByTestId("button-save-user").click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toEqual({ displayName: "Renamed synthetic operator",expectedAccessRevision: "a".repeat(64) });
  await expect(page.getByTestId(testInfo.project.name === "mobile" ? "card-user-staff-2" : "row-user-staff-2").getByText("Renamed synthetic operator",{ exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});
test("a stale profile edit cannot silently reactivate an account or repeat its write",async ({ page },testInfo) => {
  const state = await setup(page,["users:view","users:edit"]); await page.goto("/users");
  await page.getByTestId(testInfo.project.name === "mobile" ? "button-edit-user-mobile-staff-2" : "button-edit-user-staff-2").click();
  state.profile.active=0; state.configuration.revision="b".repeat(64);
  await page.getByTestId("input-edit-displayname").fill("Stale renamed operator");
  await page.getByTestId("button-save-user").click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByText("The profile update could not be confirmed. Close and reopen this account to review current access before trying again.")).toBeVisible();
  await expect(page.getByTestId("button-save-user")).toBeDisabled();
  expect(state.profile.active).toBe(0); expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).not.toHaveProperty("active");
  await expect(page.getByText("private diagnostic",{ exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("credential reset is a reviewed separate action, absent from profile editing",async({page})=>{
  const state=await setup(page,["users:view","users:reset_password","users:reset_privileged_password"]);await page.goto("/users");
  await expect(page.getByRole("button",{name:/Edit profile for/})).toHaveCount(0);
  await page.locator('button:visible').filter({hasText:/^Reset password$/}).first().click();
  const dialog=page.getByRole("dialog",{name:"Reset password for shipment-operator"});await expect(dialog.getByText(/protected access-control authority/)).toBeVisible();
  await dialog.getByLabel("Your current password").fill("Synthetic actor credential");await dialog.getByLabel("Temporary password").fill("Synthetic temporary credential");
  await dialog.getByLabel("Reason").fill("Synthetic authorized recovery");await dialog.getByRole("button",{name:"Confirm reset"}).click();
  await expect(dialog).not.toBeVisible();expect(state.writes).toHaveLength(1);expect(state.writes[0]).toMatchObject({path:"/api/users/staff-2/password-reset",body:{expectedAccessRevision:"a".repeat(64)}});expect(state.unexpected).toEqual([]);expect(state.errors).toEqual([]);
});
test("temporary zero-role staff reaches only credential completion then signs in again",async({page})=>{
  const state=await setup(page,[],true);await page.goto("/");
  await expect(page.getByRole("heading",{name:"Change your staff password"})).toBeVisible();await expect(page.getByTestId("staff-access-notice")).not.toBeVisible();
  await page.getByLabel("Current password",{exact:true}).fill("Synthetic temporary credential");await page.getByLabel("New password",{exact:true}).fill("Synthetic chosen credential");await page.getByLabel("Confirm new password").fill("Synthetic chosen credential");
  await page.getByRole("button",{name:"Change password",exact:true}).click();await expect(page.getByTestId("button-login")).toBeVisible();
  expect(state.writes).toHaveLength(1);expect(state.writes[0].path).toBe("/api/auth/password");expect(state.unexpected).toEqual([]);expect(state.errors).toEqual([]);
});

test("active zero-role staff can voluntarily change its password without gaining business access",async({page})=>{
  const state=await setup(page,[],false,true);await page.goto("/staff/password");
  await expect(page.getByRole("heading",{name:"Change your staff password"})).toBeVisible();
  await page.getByLabel("Current password",{exact:true}).fill("Synthetic current credential");await page.getByLabel("New password",{exact:true}).fill("Synthetic chosen credential");await page.getByLabel("Confirm new password").fill("Synthetic chosen credential");
  await page.getByRole("button",{name:"Change password",exact:true}).click();await expect(page.getByTestId("button-login")).toBeVisible();expect(state.writes).toHaveLength(1);expect(state.writes[0].path).toBe("/api/auth/password");expect(state.unexpected).toEqual([]);
});

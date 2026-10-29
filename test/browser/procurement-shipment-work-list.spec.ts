import { expect, test, type Page } from "@playwright/test";
import { shipmentListItem } from "../fixtures/shipment-work-list";
import { installFixtures } from "./procurement-fixtures";

async function fixture(page: Page) {
  const failures=await installFixtures(page);
  const rows=Array.from({length:205},(_,i)=>shipmentListItem({id:205-i,shipmentNumber:`TEST-SHP-${205-i}`,
    status:(205-i)%2===0 ? "cancelled" : (205-i)===1 ? "closed" : "booked",
    mode:(205-i)===3 ? "air" : "sea_fcl",carrierName:(205-i)<=3 ? "Old needle carrier" : "Other carrier",
    estimatedTotalCostCents:1,actualTotalCostCents:2}));
  const issues=[3,1].map(id=>({id:`posting_review_required-${id}`,type:"posting_review_required",severity:"critical",
    shipmentId:id,shipmentNumber:`TEST-SHP-${id}`,shipmentStatus:rows.find(row=>row.id===id)!.status,
    detail:"Current source needs review.",action:"review_cost_evidence"}));
  const state={status:200,malformed:false,gate:null as Promise<void>|null,queries:[] as URLSearchParams[]};
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/inbound-shipments"&&route.request().method()==="GET") {
      state.queries.push(url.searchParams);
      if(state.gate) await state.gate;
      if(state.status!==200) return route.fulfill({status:state.status,json:{error:"Private database diagnostic"}});
      if(state.malformed) return route.fulfill({json:{shipments:[],total:0}});
      const status=url.searchParams.get("status"),mode=url.searchParams.get("mode"),search=url.searchParams.get("search")?.toLowerCase();
      const costFilter=url.searchParams.get("costFilter");
      let matching=rows.filter(row=>(status==="active" ? row.status!=="cancelled" : !status||status==="all"||status===row.status)
        &&(!mode||mode===row.mode)&&(!search||`${row.shipmentNumber} ${row.carrierName}`.toLowerCase().includes(search)));
      if(costFilter&&costFilter!=="all") matching=matching.filter(row=>issues.some(issue=>issue.shipmentId===row.id)&&(costFilter==="any"||costFilter==="critical"));
      const offset=Number(url.searchParams.get("offset")??0),limit=Number(url.searchParams.get("limit")??50);
      const shipments=matching.slice(offset,offset+limit);
      return route.fulfill({json:{shipments,total:matching.length,offset,limit,hasMore:offset+shipments.length<matching.length,
        costHealthItems:issues.filter(issue=>shipments.some(row=>row.id===issue.shipmentId))}});
    }
    if(url.pathname==="/api/procurement/landed-cost-health") return route.fulfill({json:{status:"critical",scannedShipments:205,critical:2,warning:0,
      counts:{allocationBlockers:0,allocationWarnings:0,pendingFinalization:0,finalizedNotPushed:0,staleProvisionalLots:0,postingReviewRequired:2,provisionalOtherCosts:0},items:issues}});
    return route.fallback();
  });
  return {state,failures};
}

test("reaches older shipments beyond100 and keeps closed rows in Not cancelled",async({page},info)=>{
  const {failures}=await fixture(page);await page.goto("/shipments");
  const nav=page.getByRole("navigation",{name:"Shipment pages"});
  await expect(nav).toContainText("Showing 1–50 of 103 matching shipments");
  await expect(page.getByText("Status counts and open-shipment costs below cover this page only.",{exact:false})).toBeVisible();
  await nav.getByRole("button",{name:"Next shipments"}).click();
  await expect(nav).toContainText("Showing 51–100 of 103 matching shipments");
  await nav.getByRole("button",{name:"Next shipments"}).click();
  await expect(nav).toContainText("Showing 101–103 of 103 matching shipments");
  await expect(page.getByRole("region",{name:"Shipment results"}).getByText("TEST-SHP-1",{exact:true}).filter({visible:true})).toBeVisible();
  await expect(nav.getByRole("button",{name:"Next shipments"})).toBeDisabled();
  await page.screenshot({path:info.outputPath("shipment-last-page.png"),fullPage:true});
  expect(failures).toEqual([]);
});

test("search and mode changes reset pagination and search the complete matching list",async({page})=>{
  const {state,failures}=await fixture(page);await page.goto("/shipments");
  const nav=page.getByRole("navigation",{name:"Shipment pages"});
  await nav.getByRole("button",{name:"Next shipments"}).click();
  await expect(nav).toContainText("51–100");
  await page.getByPlaceholder("Search shipment, PO, SKU, carrier or container...").fill("needle");
  await expect(nav).toContainText("Showing 1–2 of 2 matching shipments");
  expect(state.queries.at(-1)!.get("offset")).toBe("0");
  await page.getByRole("combobox").click();await page.getByRole("option",{name:"Air",exact:true}).click();
  await expect(nav).toContainText("Showing 1–1 of 1 matching shipments");
  expect(state.queries.at(-1)!.get("mode")).toBe("air");
  expect(failures).toEqual([]);
});

test("status changes reset pagination and the cancelled category remains reachable",async({page})=>{
  const {state}=await fixture(page);await page.goto("/shipments");
  const nav=page.getByRole("navigation",{name:"Shipment pages"});
  await nav.getByRole("button",{name:"Next shipments"}).click();await expect(nav).toContainText("51–100");
  await page.getByRole("button",{name:"Cancelled",exact:true}).click();
  await expect(nav).toContainText("Showing 1–50 of 102 matching shipments");
  expect(state.queries.at(-1)!.get("offset")).toBe("0");
  await page.getByRole("button",{name:"Closed",exact:true}).click();
  await expect(nav).toContainText("Showing 1–1 of 1 matching shipments");
});

test("cost filters request complete server membership before paging and reset the page",async({page})=>{
  const {state,failures}=await fixture(page);await page.goto("/shipments");
  const nav=page.getByRole("navigation",{name:"Shipment pages"});
  await nav.getByRole("button",{name:"Next shipments"}).click();await expect(nav).toContainText("51–100");
  await page.getByLabel("Shipment cost filters",{exact:true}).getByRole("button",{name:"Critical",exact:true}).click();
  await expect(nav).toContainText("Showing 1–2 of 2 matching shipments");
  expect(state.queries.at(-1)!.get("costFilter")).toBe("critical");
  expect(state.queries.at(-1)!.get("offset")).toBe("0");
  await expect(page.getByRole("region",{name:"Shipment results"}).getByText("Check shipping costs",{exact:true}).filter({visible:true})).toHaveCount(2);
  expect(failures).toEqual([]);
});

for(const failure of ["http","malformed"] as const) test(`${failure} read failure cannot impersonate an empty list or zero summary; retry recovers`,async({page})=>{
  const {state,failures}=await fixture(page);state.status=failure==="http"?503:200;state.malformed=failure==="malformed";
  await page.goto("/shipments");
  const alert=page.getByRole("alert").filter({hasText:failure==="http"?"Shipments could not be loaded":"Shipment response is incomplete"});
  await expect(alert).toBeVisible();await expect(page.getByText("No inbound shipments match these filters.")).toHaveCount(0);
  await expect(page.getByText("Matching Shipments",{exact:true})).toHaveCount(0);
  await expect(page.getByText("Private database diagnostic",{exact:true})).toHaveCount(0);
  state.status=200;state.malformed=false;await alert.getByRole("button",{name:"Retry shipments"}).click();
  await expect(page.getByRole("navigation",{name:"Shipment pages"})).toContainText("103 matching shipments");
  await expect(alert).toHaveCount(0);expect(failures).toEqual([]);
});

test("loading and successful empty results are visibly different",async({page})=>{
  const {state}=await fixture(page);let release!:()=>void;state.gate=new Promise<void>(resolve=>{release=resolve});
  await page.goto("/shipments");await expect(page.getByText("Loading shipments…",{exact:true})).toBeVisible();
  await expect(page.getByText("No inbound shipments match these filters.")).toHaveCount(0);
  state.gate=null;release();await expect(page.getByRole("navigation",{name:"Shipment pages"})).toBeVisible();
  await page.getByPlaceholder("Search shipment, PO, SKU, carrier or container...").fill("no matching shipment");
  await expect(page.getByRole("navigation",{name:"Shipment pages"})).toContainText("0 matching shipments");
  await expect(page.getByText("No inbound shipments match these filters.").filter({visible:true})).toBeVisible();
});


test("returning to a cached filter rechecks evidence and hides the old list after failure",async({page})=>{
  const {state}=await fixture(page);await page.goto("/shipments");
  const nav=page.getByRole("navigation",{name:"Shipment pages"});
  await expect(nav).toContainText("103 matching shipments");
  const search=page.getByPlaceholder("Search shipment, PO, SKU, carrier or container...");
  await search.fill("needle");await expect(nav).toContainText("2 matching shipments");
  state.status=503;await search.fill("");
  const alert=page.getByRole("alert").filter({hasText:"Shipments could not be loaded"});
  await expect(alert).toBeVisible();
  await expect(nav).toHaveCount(0);
  await expect(page.getByRole("region",{name:"Shipment results"})).toHaveCount(0);
  await expect(page.getByText("Matching Shipments",{exact:true})).toHaveCount(0);
  state.status=200;await alert.getByRole("button",{name:"Retry shipments"}).click();
  await expect(nav).toContainText("103 matching shipments");
});

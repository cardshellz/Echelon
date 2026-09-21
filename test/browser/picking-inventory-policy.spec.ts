import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

// Exercise the page's actual event handlers with real React scheduling. Only
// transport and surrounding application ports are replaced; no production API runs.
let script: string;
test.beforeAll(async () => {
  const source = readFileSync(resolve("client/src/pages/Picking.tsx"), "utf8");
  const tree = ts.createSourceFile("Picking.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map<string, ts.VariableDeclaration>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const extract = (name: string) => {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Picker handler missing: ${name}`);
    return `const ${declaration.getText(tree)};`;
  };
  const mutation = declarations.get("updateItemMutation")?.initializer;
  if (!mutation || !ts.isCallExpression(mutation) || !ts.isObjectLiteralExpression(mutation.arguments[0])) throw new Error("Picker mutation missing");
  const options = mutation.arguments[0];
  const callback = (name: string) => {
    const property = options.properties.find(property => property.name?.getText(tree) === name);
    if (!property || !ts.isPropertyAssignment(property)) throw new Error(`Picker callback missing: ${name}`);
    return property.initializer.getText(tree);
  };
  const functions = ["applyServerItemToLocalQueues", "discardOptimisticLocalOrderForItem", "handleListItemPickOne",
    "handleListItemPickDirect", "handleListItemManualPickOne"].map(extract).join("\n");
  const harness = `
    import React, {useState,useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    ${readFileSync(resolve("client/src/lib/picking-progress.ts"), "utf8")}
    const diagnostics = {sounds:[],toasts:[],requests:[],settled:false};
    function Harness({items,responseKind,pickingMode}) {
      const [localSingleQueue,setLocalSingleQueue]=useState([{id:'order',status:'in_progress',items}]);
      const singleQueue=localSingleQueue;
      const [queue,setQueue]=useState([{id:'order',status:'in_progress',items}]);
      const [activeOrderId,setActiveOrderId]=useState('order');
      const [activeBatchId,setActiveBatchId]=useState('order');
      const [view,setView]=useState('picking');
      const [currentItemIndex,setCurrentItemIndex]=useState(0);
      const [,setLastScannedItemId]=useState(null);
      const activeWork=(pickingMode==='batch'?queue:singleQueue)[0];
      const binCountPendingRef=useRef(false),orderCompletedPendingRef=useRef(false),scanPickInFlightRef=useRef(new Set());
      const setBinCountOpen=()=>{},setBinCountContext=()=>{},setMultiQtyOpen=()=>{};
      const playSound=value=>diagnostics.sounds.push(value),triggerHaptic=()=>{},rejectScan=()=>{};
      const toast=value=>diagnostics.toasts.push(value);
      const confirmed=items.map(item=>({...item,quantity:item.qty,pickedQuantity:0,fulfilledQuantity:0,status:'pending',imageUrl:null}));
      const queryClient={setQueryData:()=>{},invalidateQueries:()=>{},getQueryData:()=>[{items:confirmed}]};
      const updateItemMutation={mutate(request){
        diagnostics.requests.push(request);
        setTimeout(()=>{
          if(responseKind==='http_error') handleError(new Error('No pickable location has stock'),request);
          else if(responseKind==='success' || responseKind==='untracked_success') handleSuccess({
            item:{...confirmed.find(item=>item.id===request.itemId),pickedQuantity:request.pickedQuantity,status:request.status},
            inventory:{deducted:responseKind==='success',resolution:{autoResolved:false,reviewRequired:false},replen:{triggered:false}}
          });
          else handleSuccess({item:confirmed.find(item=>item.id===request.itemId),inventory:{deducted:false,
            resolution:{autoResolved:false,reviewRequired:true,message:'No pickable location has stock'},replen:{triggered:false}}});
          diagnostics.settled=true;
        },30);
      }};
      ${functions}
      const handleSuccess=${callback("onSuccess")};
      const handleError=${callback("onError")};
      window.readState=()=>({view,orders:pickingMode==='batch'?queue:localSingleQueue,...diagnostics});
      return <main>
        <button onClick={()=>handleListItemManualPickOne(0)}>manual</button>
        <button onClick={()=>handleListItemPickOne(0)}>scan</button>
        <button onClick={()=>handleListItemPickDirect(0,items[0].qty)}>all</button>
      </main>;
    }
    window.mount=props=>createRoot(document.getElementById('root')).render(<Harness {...props}/>);
  `;
  const result = await build({ stdin: { contents: harness, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  script = result.outputFiles[0].text;
});

for (const responseKind of ["http_error", "legacy_rejection", "success", "untracked_success"]) {
  for (const count of [1, 4]) {
    for (const mode of ["manual", "scan", "all"]) {
      test(`${responseKind}: ${mode} uses confirmed progress for ${count === 1 ? "single" : "combined"} order`, async ({ page }) => {
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ content: script });
        await page.evaluate(({ count, responseKind }) => (window as any).mount({
          responseKind, pickingMode: "single", items: Array.from({ length: count }, (_, index) => ({
            id: index + 1, sku: "REUSED", name: "Test item", location: "UNASSIGNED", qty: 1, picked: 0, status: "pending", image: "",
          })),
        }), { count, responseKind });
        await page.getByRole("button", { name: mode, exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).readState().settled)).toBe(true);
        // The page schedules completion after 500 ms; verify that timer never leaves the picker.
        await page.waitForTimeout(600);
        const state = await page.evaluate(() => (window as any).readState());
        expect(state.requests).toHaveLength(1);
        const accepted = responseKind === "success" || responseKind === "untracked_success";
        expect(state.orders[0].items[0]).toMatchObject({ picked: accepted ? 1 : 0, status: accepted ? "completed" : "pending" });
        expect(state.orders[0].status).toBe(accepted && count === 1 ? "completed" : "in_progress");
        expect(state.toasts).toHaveLength(accepted ? 0 : 1);
        if (!accepted) {
          expect(state.view).toBe("picking");
          expect(state.sounds).not.toContain("complete");
        }
      });
    }
  }
}

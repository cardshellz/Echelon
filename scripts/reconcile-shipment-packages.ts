import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { PackageReconciliationRequest } from "../server/modules/oms/package-reconciliation.service";

export function parsePackageReconciliationFlags(args: readonly string[]) {
  const values = new Map<string,string>();let execute=false;
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--execute'){execute=true;continue;}
    if(arg==='--json')continue;
    if(!['--source-item-ids','--correct-previous-label-ids','--actor','--reason','--command-key','--expected-plan-hash'].includes(arg)
      ||!args[index+1]||args[index+1].startsWith('--')||values.has(arg))throw new Error(`Invalid or repeated reconciliation flag: ${arg}`);
    values.set(arg,args[++index]);
  }
  const ids=(value:string|undefined,required:boolean)=>{
    if(value===undefined&&!required)return[];
    const list=z.string().regex(/^[1-9]\d*(,[1-9]\d*)*$/).parse(value).split(',').map(Number);
    z.array(z.number().int().positive().safe()).min(1).max(500).parse(list);
    if(new Set(list).size!==list.length)throw new Error('Source and label identities must be unique');return list.sort((a,b)=>a-b);
  };
  const request:PackageReconciliationRequest={sourceItemIds:ids(values.get('--source-item-ids'),true),correctedPreviousLabelIds:ids(values.get('--correct-previous-label-ids'),false),
    actor:z.string().trim().min(1).max(200).parse(values.get('--actor')),reason:z.string().trim().min(1).max(500).parse(values.get('--reason')),
    commandKey:z.string().trim().min(1).max(200).parse(values.get('--command-key'))};
  const expectedPlanHash=values.has('--expected-plan-hash')?z.string().regex(/^[a-f0-9]{64}$/).parse(values.get('--expected-plan-hash')):undefined;
  return{execute,request,expectedPlanHash};
}

export async function runPackageReconciliationCli(args:readonly string[]) {
  const options=parsePackageReconciliationFlags(args);
  // Load application composition only after validating the explicit scope.
  const [{db,pool},{createChannelFulfillmentProviderClients},{ChannelIdentityService},{channels},
    {eq},{createPackageReconciliationService}]=await Promise.all([
      import('../server/db'),import('../server/modules/channels/channel-fulfillment-provider-clients.service'),
      import('../server/modules/channels/channel-identity.service'),import('../shared/schema'),import('drizzle-orm'),import('../server/services/package-reconciliation'),
    ]);
  try{
    const clients=createChannelFulfillmentProviderClients({channels:{async getChannelById(id){return(await db.select().from(channels).where(eq(channels.id,id)).limit(1))[0]??null;}},
      identities:new ChannelIdentityService(db),ebayAuth:()=>{throw new Error('This historical adoption command supports Shopify only');}});
    const service=createPackageReconciliationService({database:db,channels:clients,runExclusive:async(key,work)=>{
      const client=await pool.connect();let locked=false;
      try{locked=(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[key])).rows[0].locked;return locked?await work():null;}
      finally{if(locked)await client.query('SELECT pg_advisory_unlock($1::bigint)',[key]);client.release();}
    }});
    const result=options.execute?await service.execute(options.request,options.expectedPlanHash):await service.preview(options.request);
    console.log(JSON.stringify({execute:options.execute,result}));return result;
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runPackageReconciliationCli(process.argv.slice(2)).catch(error=>{
  console.error(JSON.stringify({code:error.code??'PACKAGE_RECONCILIATION_FAILED',message:error.message}));process.exitCode=1;
});

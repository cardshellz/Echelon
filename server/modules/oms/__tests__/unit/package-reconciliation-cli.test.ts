import { describe,expect,it } from 'vitest';
import { parsePackageReconciliationFlags } from '../../../../../scripts/reconcile-shipment-packages';
const flags=['--source-item-ids','3,1','--actor','operator','--reason','Confirmed package','--command-key','correction-1'];
describe('package reconciliation command boundary',()=>{
  it('defaults to preview and requires an exact explicit scope',()=>{
    expect(parsePackageReconciliationFlags(flags)).toMatchObject({execute:false,request:{sourceItemIds:[1,3],correctedPreviousLabelIds:[]}});
    expect(parsePackageReconciliationFlags([...flags,'--execute','--correct-previous-label-ids','8'])).toMatchObject({execute:true,request:{correctedPreviousLabelIds:[8]}});
  });
  it.each([['--source-item-ids','0'],['--source-item-ids','1,1'],['--source-item-ids','1;delete'],['--actor'],['--unknown','x']].map(values => ({ values })))('rejects invalid flags %j',({values})=>{
    const existing = flags.indexOf(values[0]);
    const remaining = existing < 0 ? flags : flags.filter((_value, index) => index !== existing && index !== existing + 1);
    expect(()=>parsePackageReconciliationFlags([...remaining,...values])).toThrow();
  });
  it('rejects a repeated scope flag even when both values are valid', () => {
    expect(() => parsePackageReconciliationFlags([...flags, '--source-item-ids', '1'])).toThrow('repeated');
  });
});

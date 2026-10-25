import type { SupplierCreditDetail, SupplierCreditOptions } from "../../shared/procurement/supplier-credit";
export const creditVersion = "a".repeat(64);
export const creditAllowed = {allowed:true,code:"ALLOWED",reason:"Available"};
export const creditDenied = {allowed:false,code:"BLOCKED",reason:"Review required"};
export function supplierCreditFixture(overrides: Partial<SupplierCreditDetail> = {}): SupplierCreditDetail {
 return {id:9,sourceInvoiceId:71,sourceInvoiceNumber:"INV-71",vendorId:2,vendorName:"Test supplier",currency:"USD",supplierReference:"CN-100",creditCalendarDate:"2026-10-19",reason:"Supplier price reduction",status:"approved",version:creditVersion,totalAmountCents:10000,appliedAmountCents:0,unappliedAmountCents:10000,balanceState:"available",balanceIssues:[],costStatus:"posted",costIssues:[],createdBy:"ap-reader",createdAt:"2026-10-19T15:00:00.000Z",approvedBy:"ap-reader",approvedAt:"2026-10-19T15:01:00.000Z",voidedBy:null,voidedAt:null,voidReason:null,replacesCreditId:null,replacedByCreditId:null,lines:[{id:1,invoiceLineId:701,amountCents:10000,label:"Toploader cases",disposition:{kind:"price_reduction",component:"product"},sourceEvidence:{},costState:"posted",costIssues:[]}],applications:[],capabilities:{approve:creditDenied,apply:creditAllowed,void:creditAllowed,replace:creditDenied},...overrides};
}
export function supplierCreditOptionsFixture(): SupplierCreditOptions {
 return {sourceInvoiceId:71,invoiceNumber:"INV-71",vendorId:2,vendorName:"Test supplier",currency:"USD",sourceVersion:creditVersion,canCreate:creditAllowed,lines:[{invoiceLineId:701,label:"Toploader cases",lineAmountCents:10000,creditedAmountCents:0,availableAmountCents:10000,components:["product","packaging"],returnDispositions:[{returnDispositionId:41,quantityAvailable:3,unitLabel:"cases",evidenceReference:"RMA-41",label:"Damaged cases returned"}],issues:[]}]};
}

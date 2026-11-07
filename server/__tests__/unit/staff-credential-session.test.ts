import { describe,it,expect,vi } from "vitest";
import type { Request,Response } from "express";
vi.mock("../../db",()=>({db:{}}));
import { createStaffSessionGate } from "../../modules/identity/staff-session";
import { isCurrentStaffCredential,newStaffPasswordSchema } from "@shared/staff-credentials";
const version="a760c267-283a-43bd-9bfb-c8a6d1048033";
const state={userId:"synthetic",credentialVersion:version,mustChangePassword:false,lastOperationId:null};
describe("staff credential admission",()=>{
  it.each([undefined,null,"", "not-a-generation","c48fc9e4-e520-4c39-aa45-c86250d71749"])("rejects missing/malformed/stale proof %s",proof=>{
    expect(isCurrentStaffCredential(proof,state)).toBe(false);
  });
  it("accepts only the exact current non-password generation",()=>{
    expect(isCurrentStaffCredential(version,state)).toBe(true);expect(isCurrentStaffCredential(version,undefined)).toBe(false);
  });
  it("rejects bcrypt truncation, including multibyte input",()=>{
    expect(newStaffPasswordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(newStaffPasswordSchema.safeParse("a".repeat(73)).success).toBe(false);
    expect(newStaffPasswordSchema.safeParse("é".repeat(37)).success).toBe(false);
  });
  function request(path:string,proof:unknown=version){return {path,session:{user:{id:"synthetic"},staffCredentialVersion:proof,customerReturnSession:{sessionKey:"independent-customer-scope"}}} as unknown as Request;}
  function response(){const res={status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return res as unknown as Response;}
  it("clears only stale staff scope before legacy guards and leaves independent customer scope",async()=>{
    const req=request("/api/legacy",undefined),next=vi.fn();delete req.session.staffCredentialVersion;
    await createStaffSessionGate(vi.fn().mockResolvedValue(state))(req,response(),next);
    expect(req.session.user).toBeUndefined();expect(req.session.customerReturnSession).toMatchObject({sessionKey:"independent-customer-scope"});expect(next).toHaveBeenCalledOnce();
  });
  it("fails closed without exposing database diagnostics",async()=>{
    const res=response(),next=vi.fn();await createStaffSessionGate(vi.fn().mockRejectedValue(new Error("Synthetic database secret")))(request("/api/users"),res,next);
    expect(next).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(503);expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("secret");
  });
  it.each(["/api/auth/me","/api/auth/password"])("allows forced-change lifecycle path %s",async path=>{
    const next=vi.fn();await createStaffSessionGate(vi.fn().mockResolvedValue({...state,mustChangePassword:true}))(request(path),response(),next);expect(next).toHaveBeenCalledOnce();
  });
  it("temporary staff credentials do not grant business access",async()=>{
    const req=request("/api/business"),res=response(),next=vi.fn();await createStaffSessionGate(vi.fn().mockResolvedValue({...state,mustChangePassword:true}))(req,res,next);
    expect(req.session.user).toBeUndefined();expect(req.session.staffCredentialCompletion?.credentialVersion).toBe(version);
    expect(next).toHaveBeenCalledOnce();
  });
});

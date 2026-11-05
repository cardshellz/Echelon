import { EventEmitter } from "node:events";
import type { Request,Response } from "express";
import { describe,it,expect,vi } from "vitest";
vi.mock("../../db",()=>({db:{}}));
import { createStaffStreamObserver,STAFF_STREAM_QUEUE_LIMIT } from "../../modules/identity/staff-stream";
function response(){return Object.assign(new EventEmitter(),{write:vi.fn(),writableEnded:false}) as unknown as Response;}
describe("staff observer delivery remains separate from business execution",()=>{
  it("permits current output but suppresses post-revocation progress/completion",async()=>{
    const res=response(),verify=vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const stream=createStaffStreamObserver({} as Request,res,"channels:edit",verify);
    stream.send({step:1});await stream.flush();stream.send({step:2});stream.send({complete:true});await stream.flush();
    expect(res.write).toHaveBeenCalledTimes(1);expect(res.write).toHaveBeenCalledWith('data: {"step":1}\n\n');
  });
  it("fails closed on credential lookup failure without throwing into the owner",async()=>{
    const res=response(),stream=createStaffStreamObserver({} as Request,res,"channels:edit",vi.fn().mockRejectedValue(new Error("Synthetic credential diagnostic")));
    stream.send({private:"not delivered"});await expect(stream.flush()).resolves.toBeUndefined();expect(res.write).not.toHaveBeenCalled();
  });
  it("bounds queued events while a credential check is pending",async()=>{
    let release!:(value:boolean)=>void;const check=new Promise<boolean>(resolve=>{release=resolve;});
    const res=response(),stream=createStaffStreamObserver({} as Request,res,"channels:edit",()=>check);
    for(let i=0;i<STAFF_STREAM_QUEUE_LIMIT+2;i++)stream.send({i});release(true);await stream.flush();expect(res.write).not.toHaveBeenCalled();
  });
  it("does not deliver queued data after the observer disconnects",async()=>{
    let release!:(value:boolean)=>void;const check=new Promise<boolean>(resolve=>{release=resolve;});
    const res=response(),stream=createStaffStreamObserver({} as Request,res,"channels:edit",()=>check);
    stream.send({private:"not delivered"});res.emit("close");release(true);await stream.flush();expect(res.write).not.toHaveBeenCalled();
  });
});

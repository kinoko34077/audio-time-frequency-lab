import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {stopChildProcess} from "../web-demo/test-process-cleanup.mjs";

test("stopChildProcess waits for the isolated process to exit",async t=>{
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{
    stdio:"ignore"
  });
  await once(child,"spawn");
  let exitObserved=false;
  child.once("exit",()=>{exitObserved=true;});
  t.after(async()=>{
    if(!exitObserved){
      child.kill();
      await Promise.race([
        new Promise(resolve=>child.once("exit",resolve)),
        new Promise(resolve=>setTimeout(resolve,1000))
      ]);
    }
  });

  await stopChildProcess(child,"cleanup fixture");
  assert.equal(exitObserved,true,
    "the child exit event must fire before cleanup returns");
});

import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

// #63 regression: a duplicated binding in the gesture callback prevented
// the whole browser player from booting even though DSP-only tests passed.
// Parse the REAL staged module entry and its directly modified dependencies.
test("actual player and AudioWorklet module entrypoints parse before browser CI",()=>{
  for(const file of ["web-demo/app.mjs","web-demo/player-wave-editor.mjs","web-demo/source-pcm-bridge.mjs","web-demo/source-pcm.worklet.js","web-demo/source-granular.mjs"]){
    const p=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
    assert.equal(p.status,0,
      "ES module syntax invalid in "+file+": "+(p.stderr||p.stdout));
  }
});

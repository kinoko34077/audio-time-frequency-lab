import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {splitWheelNumber,composeWheelNumber} from "./vendor/frequency-warp-ui/digit-wheel-picker.mjs";
test("shared wheel and context menu files match the pinned Frequency Warp Git blobs",async()=>{
  const manifest=JSON.parse(await readFile(new URL("./vendor/frequency-warp-ui/manifest.json",import.meta.url),"utf8"));
  assert.equal(manifest.repository,"kinoko34077/frequency-warp-vst");
  assert.match(manifest.commit,/^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(manifest.files).sort(),["digit-wheel-picker.css","digit-wheel-picker.mjs","parameter-context-menu.css","parameter-context-menu.mjs"]);
  for(const [file,meta] of Object.entries(manifest.files)){
    const bytes=await readFile(new URL("./vendor/frequency-warp-ui/"+file,import.meta.url));
    const blob=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
    assert.equal(blob,meta.gitBlob,"shared file must not be edited locally: "+file);
  }
  const options={signed:true,places:[0,-1,-2,-3,-4]};
  assert.equal(composeWheelNumber(splitWheelNumber(-1.2345,options),options),-1.2345);
});

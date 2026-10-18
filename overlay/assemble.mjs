/** Build-time only. Reuse the complete pinned Frequency Warp web-demo.
 * Apply small, audited host hooks in a TEMPORARY COPY; never rewrite or
 * cherry-pick the upstream source snapshot. Keep legacy Lab as /legacy/.
 */
import {readFile,writeFile,mkdir,rm,copyFile,cp} from "node:fs/promises";
import {resolve,join} from "node:path";
import {stageSite} from "../upstream/frequency-warp-vst/web-demo/stage-pages.mjs";

const base=resolve("upstream/frequency-warp-vst/web-demo"),scratch=resolve("_lab_source"),destination=resolve("_site");
const wasm=resolve(process.argv[2]||"");
if(!wasm)throw Error("Compiled upstream WASM required");
await rm(scratch,{recursive:true,force:true});
await cp(base,scratch,{recursive:true});
function replaceExactly(content,oldText,newText,name){
  const occurrences=content.split(oldText).length-1;
  if(occurrences!==1)throw Error("Source adapter mismatch "+name+"; expected one anchor, got "+occurrences);
  return content.replace(oldText,newText);
}
let html=await readFile(join(scratch,"index.html"),"utf8");
const playerStart=html.indexOf('<section class="panel player"');
if(playerStart<0)throw Error("Upstream player panel not present");
const playerEnd=html.indexOf("</section>",playerStart)+10;
if(playerEnd<10)throw Error("Upstream player end not present");
const panel=`
<section class="panel lab-overlay-panel" id="lab-panel" aria-labelledby="lab-heading">
  <div class="section-header"><div><p class="eyebrow">TIME / PITCH · MODEL COMPARISON</p><h2 id="lab-heading">時間・音程モデル比較</h2></div><span class="micro-hint">上の音源・波形を共用</span></div>
  <p>音源の選択・波形シーク・原音再生・周波数ワープは、コピー元のリアルタイム機構をそのまま使用します。</p>
  <div class="lab-overlay-grid">
    <label>速度 <input id="lab-speed" aria-label="独立した再生速度" type="number" min=".5" max="2" step=".05" value="1"> ×</label>
    <label>ピッチ <input id="lab-pitch" aria-label="独立したピッチ" type="number" min="-12" max="12" step="1" value="0"> 半音</label>
    <label>オフライン解析モデル <select id="lab-model">
      <option value="pv">Phase Vocoder</option><option value="wsola">WSOLA</option>
      <option value="dual">短窓＋長窓</option><option value="am">AM包絡</option>
    </select></label>
  </div>
  <div class="lab-overlay-actions">
    <button type="button" id="lab-live" class="primary" disabled>▶ LIVE · 時間／音程</button>
    <button type="button" id="lab-render" disabled>モデル解析（オフライン）</button>
    <button type="button" id="lab-dry" disabled>原音 A</button>
    <button type="button" id="lab-processed" disabled>加工音 B</button>
    <button type="button" id="lab-stop">■ 停止</button>
    <button type="button" id="lab-export" disabled>加工音WAV</button>
  </div>
  <p id="lab-summary" class="micro-hint">先に音源を選択してください</p>
  <p id="lab-status" role="status" aria-live="polite">元ページの音源選択を使用します。</p>
  <p class="micro-hint">LIVEは全体事前レンダリングのない粒状ピッチ補償＋可変速度で、PV/WSOLAとは異なる実験方式です。4つの既存解析モデルは加工音B用のオフライン処理です。品質・遅延・音源同定の正確性を保証するものではありません。</p>
</section>
`;
html=html.slice(0,playerEnd)+panel+html.slice(playerEnd);
html=replaceExactly(html,'<script type="module" src="./app.mjs"></script>','<script type="module" src="./app.mjs"></script>\n<script type="module" src="./lab-overlay.mjs"></script>',"HTML overlay script");
html=html.replace('<title>Frequency Warp — Realtime Laboratory</title>','<title>Audio Time–Frequency Lab / Frequency Warp</title>');
await writeFile(join(scratch,"index.html"),html);
let app=await readFile(join(scratch,"app.mjs"),"utf8");
app=replaceExactly(app,'function playPosition(){','function playPosition(){\n  if(window.__audioLabSourceTime)return window.__audioLabSourceTime();',"live source position");
app=replaceExactly(app,'function seek(seconds){','function seek(seconds){\n  if(window.__audioLabSeek?.(seconds)){state.seek=seconds;refreshStatusSeek();return;}',"host seek");
app=replaceExactly(app,'  state.seek=frac*duration();\n  if(state.player){','    state.seek=frac*duration();\n    if(window.__audioLabSeek?.(state.seek)){refreshStatusSeek();return;}\n    if(state.player){',"waveform seek");
app=replaceExactly(app,'async function play(mode="wet",offset=null){','async function play(mode="wet",offset=null){\n  if(window.__audioLabSourceTime && offset===null)state.seek=window.__audioLabSourceTime();\n  window.__audioLabStopOverlay?.();',"upstream player takeover");
app=replaceExactly(app,'function stop(){','function stop(){\n  window.__audioLabStopOverlay?.();',"upstream stop takeover");
app=replaceExactly(app,'    message("読み込み完了。再生できます。");','    message("読み込み完了。再生できます。");\n    window.dispatchEvent(new Event("audio-lab-source-change"));',"reused input lifecycle");
app+=`
window.__audioLabHost={
  snapshot:()=>state.dry?{channels:state.dry,sampleRate:state.decoded.sampleRate,duration:duration(),name:state.name}:null,
  stop:()=>stop(),playDry:(offset)=>play("dry",offset),position:()=>playPosition(),
  context:()=>context()
};
window.dispatchEvent(new Event("audio-lab-host-ready"));
`;
await writeFile(join(scratch,"app.mjs"),app);
let css=await readFile(join(scratch,"style.css"),"utf8");
css+=`
.lab-overlay-panel{border-color:var(--line,#456);margin-top:12px}
.lab-overlay-panel p{font-size:13px}
.lab-overlay-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px;margin:12px 0}
.lab-overlay-grid label{display:flex;flex-direction:column;gap:4px;font-size:13px}
.lab-overlay-grid input,.lab-overlay-grid select{width:100%;min-height:40px;border-radius:7px;padding:8px;background:var(--surface,#17212d);color:inherit;border:1px solid #6c8290}
.lab-overlay-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#lab-status{padding:10px;overflow-wrap:anywhere;border-radius:7px;background:rgba(80,120,140,.10);border:1px solid #567}
`;
await writeFile(join(scratch,"style.css"),css);
for(const [from,to] of [
  ["overlay/lab-overlay.mjs","lab-overlay.mjs"],
  ["overlay/live-pitch.worklet.js","live-pitch.worklet.js"],
  ["overlay/lab-model.worker.mjs","lab-model.worker.mjs"],
  ["dsp.mjs","lab-dsp.mjs"]
])await copyFile(resolve(from),join(scratch,to));
const collected=await stageSite({sourceDir:scratch,outputDir:destination,wasmPath:wasm});
if(!["index.html","app.mjs","dsp_core.wasm","realtime.worklet.js","lab-overlay.mjs","lab-dsp.mjs","lab-model.worker.mjs","live-pitch.worklet.js"].every(f=>collected.includes(f))){
  throw Error("Published dependency graph misses copied host or overlay assets");
}
await mkdir(join(destination,"legacy"),{recursive:true});
for(const file of ["index.html","style.css","app.mjs","dsp.mjs","timeline.mjs","processor.worker.mjs"]){
  await copyFile(resolve(file),join(destination,"legacy",file));
}
console.log("PASS source-derived public host with streaming audio, appended model lab and legacy fallback; staged "+collected.length+" active assets");

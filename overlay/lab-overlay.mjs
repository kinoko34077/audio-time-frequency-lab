import {renderPCM,wav16,MODELS} from "./lab-dsp.mjs";

/** This module EXTENDS the copied Frequency Warp host; it never replaces its
 * original file picker, robust decoder, waveform, Rust DSP or settings UI.
 * The real-time granular Worklet is distinct from the offline analysis models.
 */
const $=id=>document.getElementById(id);
const ui={
  speed:$("lab-speed"),pitch:$("lab-pitch"),model:$("lab-model"),status:$("lab-status"),
  live:$("lab-live"),offline:$("lab-render"),dry:$("lab-dry"),processed:$("lab-processed"),
  stop:$("lab-stop"),export:$("lab-export"),summary:$("lab-summary")
};
let context=null,workletReady=false,live=null,processed=null,processingWorker=null,renderJob=0,offlinePlayer=null,latest=null;
const host=()=>window.__audioLabHost;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const params=()=>({speed:clamp(Number(ui.speed.value)||1,.5,2),semitones:clamp(Number(ui.pitch.value)||0,-12,12),model:ui.model.value});
const notice=(value)=>{ui.status.textContent=value;};
const fmt=(seconds)=>Math.max(0,Number(seconds)||0).toFixed(2);
const source=()=>host()?.snapshot()||null;
const referenceTime=()=>{
  if(live){const now=live.ctx.currentTime;return (live.originalTime+(now-live.at)*live.speed)%(live.duration||1);}
  if(offlinePlayer){const now=offlinePlayer.ctx.currentTime;return (offlinePlayer.startSourceTime+(now-offlinePlayer.at)*offlinePlayer.speed)%(offlinePlayer.duration||1);}
  return host()?.position()||0;
};
const toAudioBuffer=(ctx,data)=>{const b=ctx.createBuffer(data.length,data[0].length,source().sampleRate);data.forEach((ch,i)=>b.copyToChannel(ch,i));return b;};
function stopAll({cancelRender=false}={}){
  if(live){try{live.source.stop();}catch{}try{live.source.disconnect();live.node.disconnect();}catch{}live=null;}
  if(offlinePlayer){try{offlinePlayer.source.stop();offlinePlayer.source.disconnect();}catch{}offlinePlayer=null;}
  window.__audioLabSourceTime=null;
  window.__audioLabSeek=null;
  if(cancelRender){renderJob++;processingWorker?.terminate();processingWorker=null;}
}
function sourceChanged(){
  stopAll({cancelRender:true});processed=null;latest=null;
  const src=source();
  ui.live.disabled=ui.offline.disabled=ui.dry.disabled=!src;
  ui.processed.disabled=ui.export.disabled=true;
  ui.summary.textContent=src?("共有音源 "+fmt(src.duration)+"秒 · "+src.sampleRate+" Hz · "+src.channels.length+"ch"):"先に上の音源選択欄から読み込んでください";
  notice(src?"音源読込済み。リアルタイム再生は全体事前計算なしで開始できます。":"元ページの音源選択を使用します。");
}
async function realtime(position=0){
  const src=source();if(!src){notice("先に元ページで音声ファイルを読み込んでください。");return;}
  const p=params();
  stopAll();
  await host().stop();
  const ctx=await host().context();context=ctx;
  if(!workletReady){
    await ctx.audioWorklet.addModule("./live-pitch.worklet.js");workletReady=true;
  }
  const buffer=toAudioBuffer(ctx,src.channels);
  const node=new AudioWorkletNode(ctx,"audio-lab-live-pitch",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[src.channels.length]});
  node.connect(ctx.destination);
  const audio=ctx.createBufferSource();audio.buffer=buffer;audio.loop=true;
  audio.playbackRate.value=p.speed;
  audio.connect(node);
  node.port.postMessage({type:"params",ratio:2**(p.semitones/12)/p.speed});
  const at=ctx.currentTime+.025;
  const seek=clamp(position,0,Math.max(0,src.duration-.01));
  audio.start(at,seek);
  live={ctx,node,source:audio,originalTime:seek,speed:p.speed,at,duration:src.duration};
  window.__audioLabSourceTime=()=>referenceTime();
  window.__audioLabSeek=seconds=>{
    if(!live&&!offlinePlayer)return false;
    if(live)void realtime(seconds).catch(e=>notice("ライブ再生エラー: "+e.message));
    else void audition(seconds).catch(e=>notice("試聴エラー: "+e.message));
    return true;
  };
  notice("LIVE: 全体レンダリングなしでストリーミング処理中。速度とピッチは再生中にも更新可能です。粒状合成による音質・遅延の制約があります。");
}
function applyLiveParams(){
  if(!live)return;
  const pos=referenceTime(),p=params(),now=live.ctx.currentTime;
  live.originalTime=pos;live.at=now;live.speed=p.speed;
  live.source.playbackRate.setTargetAtTime(p.speed,now,.008);
  live.node.port.postMessage({type:"params",ratio:2**(p.semitones/12)/p.speed});
  notice("LIVE: "+fmt(p.speed)+"× / "+p.semitones+" st を反映しました。実験的な粒状ピッチ補正です。");
}
function computeOffline(payload){
  if(typeof Worker==="undefined")return Promise.resolve(renderPCM(payload));
  return new Promise((resolve,reject)=>{
    const worker=new Worker("./lab-model.worker.mjs",{type:"module"});processingWorker=worker;
    worker.onmessage=({data})=>{worker.terminate();if(processingWorker===worker)processingWorker=null;data.ok?resolve(data):reject(Error(data.message||"DSP error"));};
    worker.onerror=()=>{worker.terminate();if(processingWorker===worker)processingWorker=null;reject(Error("解析Workerを起動できませんでした"));};
    const channels=payload.channels.map(ch=>Float32Array.from(ch));
    worker.postMessage({...payload,channels},channels.map(ch=>ch.buffer));
  });
}
async function renderOffline(){
  const src=source();if(!src){notice("まず音源を読み込んでください");return;}
  stopAll({cancelRender:true});await host().stop();
  const myJob=++renderJob,p=params();
  ui.offline.disabled=true;notice(MODELS.find(m=>m.id===p.model)?.label+"で解析・全体レンダリング中…");
  try{
    const out=await computeOffline({...p,channels:src.channels,sampleRate:src.sampleRate});
    if(myJob!==renderJob)return;
    processed={...out,speed:p.speed,semitones:p.semitones,model:p.model};
    latest=out;
    ui.processed.disabled=ui.export.disabled=false;
    notice("オフライン解析完了。加工音を試聴・WAV出力できます。これはリアルタイムPV/WSOLAの実装ではありません。");
  }catch(e){if(myJob===renderJob){processed=null;ui.processed.disabled=ui.export.disabled=true;notice("解析失敗: "+e.message+"。原音とLIVEは利用できます。");}}
  finally{if(myJob===renderJob)ui.offline.disabled=!source();}
}
async function audition(position=0){
  if(!processed||!source())return;
  const src=source();
  stopAll();await host().stop();
  const ctx=await host().context();
  const audio=ctx.createBufferSource();
  audio.buffer=ctx.createBuffer(processed.channels.length,processed.channels[0].length,processed.sampleRate);
  processed.channels.forEach((c,i)=>audio.buffer.copyToChannel(c,i));
  const seek=clamp(position,0,Math.max(0,src.duration-.01));
  audio.connect(ctx.destination);audio.start(0,seek/processed.speed);
  offlinePlayer={ctx,source:audio,at:ctx.currentTime,startSourceTime:seek,speed:processed.speed,duration:src.duration};
  audio.onended=()=>{if(offlinePlayer?.source===audio){offlinePlayer=null;window.__audioLabSourceTime=null;window.__audioLabSeek=null;}};
  window.__audioLabSourceTime=()=>referenceTime();
  window.__audioLabSeek=seconds=>{if(!offlinePlayer)return false;void audition(seconds);return true;};
  notice("オフライン加工音を試聴中。同じ元音源の時刻へシークできます。");
}
function save(){
  if(!processed)return;
  try{
    const bytes=wav16({channels:processed.channels,sampleRate:processed.sampleRate});
    const link=URL.createObjectURL(new Blob([bytes],{type:"audio/wav"})),a=document.createElement("a");
    a.href=link;a.download="audio-time-frequency-"+processed.model+".wav";document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(link),60000);
  }catch(e){notice("WAV出力失敗: "+e.message);}
}
function change(){
  if(live){applyLiveParams();return;}
  if(processed){processed=null;ui.processed.disabled=ui.export.disabled=true;notice("処理条件を変更しました。加工音の再レンダリングが必要です。");}
}
ui.live.addEventListener("click",()=>realtime(referenceTime()).catch(e=>notice("LIVE処理を起動できません: "+e.message)));
ui.offline.addEventListener("click",renderOffline);
ui.dry.addEventListener("click",()=>{const t=referenceTime();stopAll();void host()?.playDry(t);});
ui.processed.addEventListener("click",()=>audition(referenceTime()).catch(e=>notice(e.message)));
ui.stop.addEventListener("click",()=>{stopAll();void host()?.stop();notice("停止しました。");});
ui.export.addEventListener("click",save);
ui.speed.addEventListener("input",change);
ui.pitch.addEventListener("input",change);
ui.model.addEventListener("change",change);
window.__audioLabStopOverlay=()=>{stopAll();};
window.addEventListener("audio-lab-source-change",sourceChanged);
window.addEventListener("audio-lab-host-ready",sourceChanged);
sourceChanged();

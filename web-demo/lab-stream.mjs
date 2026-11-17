// Bounded, seek-aware model audition. All source PCM stays in this tab.
// The existing model DSP renders bounded chunks in a module Worker. Its PCM
// feeds the persistent source-time Worklet, which alone advances playback.
import {createSourcePCMBridge} from "./source-pcm-bridge.mjs";
export const CHUNK_SECONDS=1.5;
export function planChunk({totalFrames,sampleRate,speed,startSeconds,startFrame=null,model='dual',fftSize=2048,shortFftSize=512,longFftSize=fftSize,referenceWindows=8,jointBackend=null}){
  if(!(totalFrames>0&&sampleRate>0&&speed>0))throw RangeError('invalid source range');
  if(startFrame!==null&&!Number.isSafeInteger(startFrame))throw RangeError('invalid source frame');
  if(![1024,2048,4096,8192].includes(longFftSize)||![256,512,1024,2048].includes(shortFftSize)||(model==='dual'&&shortFftSize>=longFftSize))throw RangeError('invalid short/long FFT windows');
  if(!Number.isInteger(referenceWindows)||referenceWindows<2||referenceWindows>16)throw RangeError('invalid context window count');
  const requestedStart=startFrame===null?Math.floor(startSeconds*sampleRate):startFrame;
  const start=Math.min(totalFrames-1,Math.max(0,requestedStart));
  const core=Math.min(totalFrames-start,Math.ceil(CHUNK_SECONDS*sampleRate));
  const analysisWindow=(model==='wsola'||(model==='period-joint'&&jointBackend==='wsola'))?shortFftSize:longFftSize;
  // The experimental joint model disables long FFT and reference-window
  // controls. Its preview context must NOT accidentally depend on either.
  const context=model==='period-joint'?
    (jointBackend?Math.min(Math.ceil(sampleRate*.7),
      Math.max(Math.ceil(sampleRate*.120),analysisWindow*2)):Math.ceil(sampleRate*.120)):
    Math.min(Math.ceil(sampleRate*.7),Math.max(Math.ceil(sampleRate*.040),referenceWindows*analysisWindow/4,analysisWindow));
  const left=Math.min(start,context),right=Math.min(totalFrames-start-core,context);
  const wrapRight=start+core>=totalFrames?Math.min(totalFrames,context):0;
  const from=start-left,to=start+core+right;
  const crop=Math.round(left/speed),central=Math.ceil(core/speed);
  const tail=Math.min(Math.round(.025*sampleRate),Math.round(right/speed));
  return {from,to,left,right,wrapRight,core,start,shortFftSize,longFftSize,
    outputStart:crop,outputFrames:central+tail+(wrapRight>0?1:0),
    coreFrames:central,nextSeconds:(start+core)/sampleRate};
}
export async function createModelStream({ctx,sourceChannels,sampleRate,speed,semitones,model,fftSize,shortFftSize=512,longFftSize=fftSize,referenceWindows,periodCycles=8,jointBackend=null,startSeconds=0,onStatus=()=>{},onStarted=()=>{},onFailure=()=>{}}){
  const totalFrames=sourceChannels[0].length,duration=totalFrames/sampleRate;
  if(!Number.isSafeInteger(totalFrames)||totalFrames<1||
     !Number.isFinite(sampleRate)||sampleRate<=0||
     !Number.isFinite(speed)||speed<.5||speed>2||
     !Number.isFinite(semitones)||semitones<-12||semitones>12)
    throw RangeError("legacy Worker supports positive 0.5..2x and -12..12 semitones");
  let stopped=false,started=false,pending=false,job=0,generation=0;
  let bufferedSegments=0,lastMissingFrames=0,latestFrame=0,appliedRevision=0;
  let cursorFrame=0,activeJob=0,activeJobGeneration=0;
  let config={speed,semitones,model,fftSize,shortFftSize,longFftSize,
    referenceWindows,periodCycles,jointBackend};
  const initial=Math.min(totalFrames-1,Math.max(0,
    Math.floor((((startSeconds%duration)+duration)%duration)*sampleRate)));
  cursorFrame=latestFrame=initial;
  const worker=new Worker('./lab-processor.worker.mjs',{type:'module'});
  let bridge=null,master=null;
  const cleanup=()=>{
    if(stopped)return;
    stopped=true;worker.terminate();
    try{bridge?.dispose();}catch{}
    try{master?.disconnect();}catch{}
  };
  const fail=message=>{
    if(stopped)return;
    onFailure(message||"Worker処理失敗");cleanup();
  };
  const pump=()=>{
    if(stopped||pending||bufferedSegments>=2)return;
    const activeConfig=config,activeGeneration=generation;
    const plan=planChunk({totalFrames,sampleRate,
      speed:activeConfig.speed,startSeconds:cursorFrame/sampleRate,
      startFrame:cursorFrame,
      model:activeConfig.model,fftSize:activeConfig.fftSize,
      shortFftSize:activeConfig.shortFftSize,
      longFftSize:activeConfig.longFftSize,
      referenceWindows:activeConfig.referenceWindows,
      jointBackend:activeConfig.jointBackend});
    const channels=sourceChannels.map(ch=>{
      const core=ch.slice(plan.from,plan.to);
      if(!plan.wrapRight)return core;
      const wrapped=ch.slice(0,plan.wrapRight);
      const input=new Float32Array(core.length+wrapped.length);
      input.set(core);input.set(wrapped,core.length);return input;
    });
    pending=true;activeJob=++job;activeJobGeneration=activeGeneration;
    onStatus(lastMissingFrames>0?
      'Worker処理が再生時計に遅れ、実際の欠落PCMを記録しました':
      started?'次の区間をWorkerで処理中':'モデルの先頭区間を準備中…');
    try{worker.postMessage({job:activeJob,generation:activeGeneration,
      channels,sampleRate,speed:activeConfig.speed,
      semitones:activeConfig.semitones,model:activeConfig.model,
      fftSize:activeConfig.fftSize,shortFftSize:activeConfig.shortFftSize,
      longFftSize:activeConfig.longFftSize,
      referenceWindows:activeConfig.referenceWindows,
      periodCycles:activeConfig.periodCycles,
      jointBackend:activeConfig.jointBackend,plan},channels.map(ch=>ch.buffer));}
    catch(error){pending=false;fail(error.message);}
  };
  const onBridgeEvent=data=>{
    if(data.type==="progress"){
      if(data.workerGeneration===generation&&
         Number.isFinite(data.sourceFrame)&&data.sourceFrame>=0&&
         data.sourceFrame<totalFrames&&data.revision>=appliedRevision)
        latestFrame=data.sourceFrame;
      if(Number.isSafeInteger(data.bufferedSegments))
        bufferedSegments=data.bufferedSegments;
      if(Number.isFinite(data.missingFrames)&&
         data.missingFrames>lastMissingFrames){
        lastMissingFrames=data.missingFrames;
        onStatus("Worker処理が再生時計に遅れ、実際の欠落PCMを記録しました");
      }
      pump();
    }else if(data.type==="worker-state-accepted"&&
             data.generation===generation){
      latestFrame=data.sourceFrame;appliedRevision=data.revision;
      bufferedSegments=data.bufferedSegments??0;
      pump();
    }else if(data.type==="rendered-chunk-accepted"&&
             data.generation===generation){
      bufferedSegments=data.bufferedSegments??bufferedSegments;
    }else if(data.type==="fatal-error")fail(data.message);
  };
  try{
    bridge=await createSourcePCMBridge({ctx,sourceChannels,
      sourceSampleRate:sampleRate,speed,startFrame:initial,
      loopStartFrame:0,loopEndFrame:totalFrames,loopEnabled:true,
      processingMode:"worker",pitchSemitones:semitones,onEvent:onBridgeEvent});
    master=ctx.createGain();master.gain.value=1;
    bridge.connect(master);master.connect(ctx.destination);
  }catch(error){worker.terminate();try{master?.disconnect();}catch{}throw error;}
  worker.onmessage=async({data})=>{
    if(stopped||data.job!==activeJob)return;
    if(data.generation!==generation||
       activeJobGeneration!==generation){pending=false;pump();return;}
    if(!data.ok){pending=false;fail(data.message||'DSP処理失敗');return;}
    const plan=data.plan;
    try{
      const accepted=await bridge.pushRenderedChunk({
        generation:data.generation,startFrame:plan.start,
        endFrame:plan.start+plan.core,speed:config.speed,
        coreFrames:plan.coreFrames,channels:data.channels});
      if(stopped)return;
      if(data.generation!==generation){pending=false;pump();return;}
      if(accepted.stale){pending=false;pump();return;}
      bufferedSegments=accepted.bufferedSegments;
      cursorFrame=plan.start+plan.core>=totalFrames?0:plan.start+plan.core;
      pending=false;
      if(!started){
        // Give the first 1.5-second render enough lookahead to cover one
        // Worker round trip before exposing the stream to the audio clock.
        if(bufferedSegments<2){pump();return;}
        await bridge.play();
        if(stopped)return;
        started=true;onStarted(ctx.currentTime);
        onStatus('モデル音声を再生中 · 共通PCM音源時計');
      }
      pump();
    }catch(error){pending=false;fail(error.message);}
  };
  worker.onerror=event=>{if(!stopped)fail(event.message||'Worker起動失敗');};
  const reset=async(frame,nextConfig)=>{
    if(stopped)throw Error("model stream stopped");
    if(!Number.isSafeInteger(frame)||frame<0||frame>=totalFrames)
      throw RangeError("invalid Worker source frame");
    const next={...config,...nextConfig};
    if(!Number.isFinite(next.speed)||next.speed<.5||next.speed>2||
       !Number.isFinite(next.semitones)||next.semitones<-12||next.semitones>12)
      throw RangeError("legacy Worker supports positive 0.5..2x and -12..12 semitones");
    // Validate model/window constraints before invalidating audible output.
    planChunk({totalFrames,sampleRate,speed:next.speed,
      startSeconds:frame/sampleRate,startFrame:frame,
      model:next.model,fftSize:next.fftSize,
      shortFftSize:next.shortFftSize,longFftSize:next.longFftSize,
      referenceWindows:next.referenceWindows,jointBackend:next.jointBackend});
    config=next;generation++;cursorFrame=latestFrame=frame;
    bufferedSegments=0;lastMissingFrames=0;
    const requestedGeneration=generation;
    const accepted=await bridge.resetWorkerPlayback({frame,speed:next.speed,
      pitchSemitones:next.semitones,generation:requestedGeneration});
    if(!stopped&&requestedGeneration===generation){
      latestFrame=accepted.sourceFrame;appliedRevision=accepted.revision;
      bufferedSegments=accepted.bufferedSegments??0;pump();
    }
    return accepted;
  };
  return {master,start(){pump();},stop:cleanup,
    sourcePositionAt(){return latestFrame/sampleRate;},
    seek(frame){return reset(frame,{});},
    updateSettings({frame,speed,semitones,...settings}={}){
      return reset(frame,{...settings,
        speed:speed??config.speed,semitones:semitones??config.semitones});
    },
    get active(){return !stopped},get firstScheduled(){return started},
    get bufferedSegments(){return bufferedSegments}};
}

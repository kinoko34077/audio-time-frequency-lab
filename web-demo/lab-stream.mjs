// Bounded, seek-aware model audition. All source PCM stays in this tab.
// The existing model DSP renders bounded chunks in a module Worker. Its PCM
// feeds the persistent source-time Worklet, which alone advances playback.
import {createSourcePCMBridge} from "./source-pcm-bridge.mjs";
import {RENDERED_CHUNK_SLOTS} from "./source-pcm-renderer.mjs";
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
  let stopped=false,started=false,pending=false,stagingOperations=0,job=0;
  let handoffWorker=null,handoffPending=false,handoffInstalling=false;
  let handoffJobId=0,handoffGeneration=null,handoffResult=null;
  let handoffUnavailableGeneration=null;
  let generation=0,activeGeneration=0,stagedGeneration=null;
  let seekTransitionGeneration=null;
  let bufferedSegments=0,lastMissingFrames=0,latestFrame=0,appliedRevision=0;
  let cursorFrame=0,sequenceCursor=0,activeJob=0,activeJobGeneration=0;
  let activeJobConfig=null,activeJobSequence=0;
  let config={speed,semitones,model,fftSize,shortFftSize,longFftSize,
    referenceWindows,periodCycles,jointBackend};
  let activeConfig=config;
  const configs=new Map([[0,config]]),transitionWaiters=new Map();
  const initial=Math.min(totalFrames-1,Math.max(0,
    Math.floor((((startSeconds%duration)+duration)%duration)*sampleRate)));
  cursorFrame=latestFrame=initial;
  const worker=new Worker('./lab-processor.worker.mjs',{type:'module'});
  let bridge=null,master=null;
  const resolveTransition=(id,value)=>{
    const waiter=transitionWaiters.get(id);
    if(!waiter)return;
    transitionWaiters.delete(id);waiter.resolve(value);
  };
  const cancelTransitions=()=>{
    for(const id of [...transitionWaiters.keys()])
      resolveTransition(id,{cancelled:true});
  };
  const cancelHandoff=()=>{
    try{handoffWorker?.terminate();}catch{}
    handoffWorker=null;handoffPending=false;handoffJobId=0;
    handoffGeneration=null;handoffResult=null;
  };
  const cleanup=()=>{
    if(stopped)return;
    stopped=true;worker.terminate();cancelHandoff();
    cancelTransitions();
    try{bridge?.dispose();}catch{}
    try{master?.disconnect();}catch{}
  };
  const fail=message=>{
    if(stopped)return;
    onFailure(message||"Worker処理失敗");cleanup();
  };
  const prepareChunk=(jobConfig,startFrame,sequence)=>{
    const plan=planChunk({totalFrames,sampleRate,
      speed:jobConfig.speed,startSeconds:startFrame/sampleRate,
      startFrame,model:jobConfig.model,fftSize:jobConfig.fftSize,
      shortFftSize:jobConfig.shortFftSize,
      longFftSize:jobConfig.longFftSize,
      referenceWindows:jobConfig.referenceWindows,
      jointBackend:jobConfig.jointBackend});
    const channels=sourceChannels.map(ch=>{
      const core=ch.slice(plan.from,plan.to);
      if(!plan.wrapRight)return core;
      const wrapped=ch.slice(0,plan.wrapRight);
      const input=new Float32Array(core.length+wrapped.length);
      input.set(core);input.set(wrapped,core.length);return input;
    });
    return {plan,channels,sequence};
  };
  const installHandoffResult=async()=>{
    const result=handoffResult;handoffResult=null;
    if(!result)return;
    if(stopped||result.generation!==generation){
      resolveTransition(result.generation,{stale:true});return;
    }
    const {plan}=result;
    const accepted=await bridge.pushRenderedChunk({
      generation:result.generation,sequence:result.sequence,
      startFrame:plan.start,
      endFrame:plan.start+plan.core,speed:result.config.speed,
      coreFrames:plan.coreFrames,channels:result.channels});
    if(stopped)return;
    if(result.generation!==generation){
      resolveTransition(result.generation,{stale:true});return;
    }
    if(accepted.stale){stagedGeneration=null;return;}
    bufferedSegments=accepted.bufferedSegments;
    sequenceCursor=result.sequence+1;
    cursorFrame=plan.start+plan.core>=totalFrames?0:plan.start+plan.core;
  };
  const startHandoffJob=(targetGeneration,targetConfig,startFrame,sequence,
    {seek=false}={})=>{
    const taskJob=++job;
    let nextWorker;
    try{nextWorker=new Worker('./lab-processor.worker.mjs',{type:'module'});}
    catch{
      if(seek){
        const waiter=transitionWaiters.get(targetGeneration);
        if(waiter){transitionWaiters.delete(targetGeneration);
          waiter.reject(Error('seek PCM preparation failed: parallel Worker could not start'));}
        fail('seek PCM preparation failed: parallel Worker could not start');
        return;
      }
      handoffUnavailableGeneration=targetGeneration;
      stagedGeneration=null;
      onStatus('並行Workerを準備できず、旧PCM境界で切替を続行');
      return;
    }
    const {plan,channels}=prepareChunk(targetConfig,startFrame,sequence);
    handoffWorker=nextWorker;handoffPending=true;
    handoffJobId=taskJob;handoffGeneration=targetGeneration;
    const fallback=reason=>{
      if(stopped||handoffJobId!==taskJob)return;
      handoffPending=false;handoffWorker=null;handoffJobId=0;
      handoffGeneration=null;handoffUnavailableGeneration=targetGeneration;
      stagedGeneration=null;
      try{nextWorker.terminate();}catch{}
      if(seek){
        const waiter=transitionWaiters.get(targetGeneration);
        const error=Error('seek PCM preparation failed: '+
          (reason||'parallel Worker failed'));
        if(waiter){transitionWaiters.delete(targetGeneration);waiter.reject(error);}
        fail(error.message);
        return;
      }
      onStatus('並行Workerを準備できず、旧PCM境界で切替を続行');
      if(!pending)pump();
    };
    nextWorker.onerror=event=>fallback(event?.message||'parallel Worker error');
    nextWorker.onmessage=({data})=>{
      if(stopped||data.job!==taskJob||handoffJobId!==taskJob)return;
      if(data.generation!==targetGeneration||targetGeneration!==generation){
        handoffPending=false;handoffWorker=null;handoffJobId=0;
        handoffGeneration=null;
        try{nextWorker.terminate();}catch{}
        resolveTransition(targetGeneration,{stale:true});pump();return;
      }
      if(!data.ok){fallback(data.message||'parallel Worker DSP failed');return;}
      handoffPending=false;handoffWorker=null;handoffJobId=0;
      handoffGeneration=null;
      try{nextWorker.terminate();}catch{}
      handoffUnavailableGeneration=null;
      handoffResult={generation:targetGeneration,config:targetConfig,
        plan,sequence,channels:data.channels};
      pump();
    };
    try{nextWorker.postMessage({job:taskJob,generation:targetGeneration,
      channels,sampleRate,speed:targetConfig.speed,
      semitones:targetConfig.semitones,model:targetConfig.model,
      fftSize:targetConfig.fftSize,shortFftSize:targetConfig.shortFftSize,
      longFftSize:targetConfig.longFftSize,
      referenceWindows:targetConfig.referenceWindows,
      periodCycles:targetConfig.periodCycles,
      jointBackend:targetConfig.jointBackend,plan},channels.map(ch=>ch.buffer));}
    catch{fallback();}
  };
  const pump=()=>{
    if(stopped||stagingOperations>0||handoffInstalling)return;
    if(handoffResult&&!handoffInstalling){
      handoffInstalling=true;
      void installHandoffResult().catch(error=>fail(error.message))
        .finally(()=>{handoffInstalling=false;pump();});
      return;
    }
    const requestedGeneration=generation,requestedConfig=config;
    const transitioning=requestedGeneration!==activeGeneration;
    if(transitioning&&stagedGeneration!==requestedGeneration){
      stagingOperations++;
      onStatus('設定を切替中 · 現在のPCMを再生しながら次の世代を準備中');
      void bridge.stageWorkerPlayback({speed:requestedConfig.speed,
        pitchSemitones:requestedConfig.semitones,
        generation:requestedGeneration}).then(accepted=>{
        if(stopped)return;
        if(requestedGeneration!==generation){
          resolveTransition(requestedGeneration,{stale:true});return;
        }
        stagedGeneration=requestedGeneration;
        cursorFrame=accepted.sourceFrame;
        sequenceCursor=accepted.sequence;
        bufferedSegments=accepted.bufferedSegments??bufferedSegments;
        if(pending&&handoffUnavailableGeneration!==requestedGeneration)
          startHandoffJob(requestedGeneration,requestedConfig,
            accepted.sourceFrame,accepted.sequence);
      }).catch(error=>{
        if(requestedGeneration===generation){
          const waiter=transitionWaiters.get(requestedGeneration);
          if(waiter){transitionWaiters.delete(requestedGeneration);waiter.reject(error);}
          fail(error.message);
        }else resolveTransition(requestedGeneration,{stale:true});
      }).finally(()=>{stagingOperations--;pump();});
      return;
    }
    if(pending||handoffPending)return;
    const bufferLimit=RENDERED_CHUNK_SLOTS;
    if(bufferedSegments>=bufferLimit)return;
    const jobConfig=requestedConfig,jobGeneration=requestedGeneration;
    const {plan,channels,sequence}=prepareChunk(jobConfig,cursorFrame,
      sequenceCursor++);
    pending=true;activeJob=++job;activeJobGeneration=jobGeneration;
    activeJobConfig=jobConfig;activeJobSequence=sequence;
    onStatus(lastMissingFrames>0?
      'Worker処理が再生時計に遅れ、実際の欠落PCMを記録しました':
      started?'次の区間をWorkerで処理中':'モデルの先頭区間を準備中…');
    try{worker.postMessage({job:activeJob,generation:jobGeneration,
      channels,sampleRate,speed:jobConfig.speed,
      semitones:jobConfig.semitones,model:jobConfig.model,
      fftSize:jobConfig.fftSize,shortFftSize:jobConfig.shortFftSize,
      longFftSize:jobConfig.longFftSize,
      referenceWindows:jobConfig.referenceWindows,
      periodCycles:jobConfig.periodCycles,
      jointBackend:jobConfig.jointBackend,plan},channels.map(ch=>ch.buffer));}
    catch(error){pending=false;fail(error.message);}
  };
  const onBridgeEvent=data=>{
    if(data.type==="worker-state-activated"){
      if(data.generation>=activeGeneration){
        activeGeneration=data.generation;stagedGeneration=null;
        if(seekTransitionGeneration===data.generation)
          seekTransitionGeneration=null;
        activeConfig=configs.get(activeGeneration)||activeConfig;
        latestFrame=data.sourceFrame;appliedRevision=data.revision;
        bufferedSegments=data.bufferedSegments??bufferedSegments;
        for(const key of configs.keys())
          if(key!==activeGeneration&&key!==generation)configs.delete(key);
        onStatus(activeGeneration===generation?
          'モデル設定を切替 · 共通PCM音源時計':
          '次のモデル設定を準備中 · 共通PCM音源時計を継続');
        resolveTransition(activeGeneration,data);
        pump();
      }
    }else if(data.type==="progress"){
      if(data.workerGeneration===activeGeneration&&
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
             data.generation===activeGeneration){
      latestFrame=data.sourceFrame;appliedRevision=data.revision;
      bufferedSegments=data.bufferedSegments??0;
      pump();
    }else if(data.type==="rendered-chunk-accepted"){
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
    const resultGeneration=activeJobGeneration,resultConfig=activeJobConfig;
    if(data.generation!==resultGeneration){pending=false;pump();return;}
    if(resultGeneration!==activeGeneration&&resultGeneration!==generation){
      pending=false;pump();return;
    }
    if(!data.ok){pending=false;fail(data.message||'DSP処理失敗');return;}
    const plan=data.plan;
    try{
      const accepted=await bridge.pushRenderedChunk({
        generation:resultGeneration,sequence:activeJobSequence,
        startFrame:plan.start,
        endFrame:plan.start+plan.core,speed:resultConfig.speed,
        coreFrames:plan.coreFrames,channels:data.channels});
      if(stopped)return;
      if(accepted.stale){pending=false;pump();return;}
      if(resultGeneration!==activeGeneration&&resultGeneration!==generation){
        pending=false;pump();return;
      }
      bufferedSegments=accepted.bufferedSegments;
      if(resultGeneration===generation)
        sequenceCursor=Math.max(sequenceCursor,activeJobSequence+1);
      if(resultGeneration===generation||
         seekTransitionGeneration!==generation)
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
    }catch(error){
      pending=false;
      if(resultGeneration===activeGeneration||resultGeneration===generation)
        fail(error.message);
      else pump();
    }
  };
  worker.onerror=event=>{if(!stopped)fail(event.message||'Worker起動失敗');};
  const validateNext=(frame,nextConfig)=>{
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
    return next;
  };
  const reset=async(frame,nextConfig)=>{
    const next=validateNext(frame,nextConfig);
    for(const id of [...transitionWaiters.keys()])
      resolveTransition(id,{stale:true});
    cancelHandoff();
    config=next;generation++;
    const requestedGeneration=generation;
    stagedGeneration=null;lastMissingFrames=0;
    if(started){
      seekTransitionGeneration=requestedGeneration;
      configs.clear();configs.set(activeGeneration,activeConfig);
      configs.set(requestedGeneration,next);
      const seekPlan=planChunk({totalFrames,sampleRate,speed:next.speed,
        startSeconds:frame/sampleRate,startFrame:frame,model:next.model,
        fftSize:next.fftSize,shortFftSize:next.shortFftSize,
        longFftSize:next.longFftSize,referenceWindows:next.referenceWindows,
        jointBackend:next.jointBackend});
      const requiredChunks=seekPlan.core<Math.ceil(CHUNK_SECONDS*sampleRate)||
        next.speed>1.5?2:1;
      stagingOperations++;
      try{
        const staged=await bridge.stageWorkerSeekPlayback({frame,
          speed:next.speed,pitchSemitones:next.semitones,
          generation:requestedGeneration,requiredChunks});
        if(stopped||requestedGeneration!==generation)
          return {stale:true};
        stagedGeneration=requestedGeneration;
        cursorFrame=staged.sourceFrame;sequenceCursor=staged.sequence;
        bufferedSegments=staged.bufferedSegments??bufferedSegments;
        const promise=new Promise((resolve,reject)=>
          transitionWaiters.set(requestedGeneration,{resolve,reject}));
        startHandoffJob(requestedGeneration,next,staged.sourceFrame,
          staged.sequence,{seek:true});
        return promise;
      }catch(error){
        if(!stopped&&requestedGeneration===generation)
          fail('seek PCM staging failed: '+error.message);
        throw error;
      }finally{
        stagingOperations--;pump();
      }
    }
    activeConfig=next;activeGeneration=requestedGeneration;
    seekTransitionGeneration=null;
    configs.clear();configs.set(requestedGeneration,next);
    cursorFrame=latestFrame=frame;sequenceCursor=0;bufferedSegments=0;
    const accepted=await bridge.resetWorkerPlayback({frame,speed:next.speed,
      pitchSemitones:next.semitones,generation:requestedGeneration});
    if(!stopped&&requestedGeneration===generation){
      latestFrame=accepted.sourceFrame;appliedRevision=accepted.revision;
      bufferedSegments=accepted.bufferedSegments??0;pump();
    }
    return accepted;
  };
  const stageSettings=({frame,speed,semitones,...settings}={})=>{
    const targetFrame=frame??latestFrame;
    // Validate against the caller's source position, but the audible source
    // clock chooses the next safe retained-PCM boundary for activation.
    const next=validateNext(targetFrame,{...settings,
      speed:speed??config.speed,semitones:semitones??config.semitones});
    for(const id of [...transitionWaiters.keys()])
      resolveTransition(id,{stale:true});
    seekTransitionGeneration=null;
    config=next;generation++;
    configs.set(generation,next);
    for(const key of configs.keys())
      if(key!==activeGeneration&&key!==generation)configs.delete(key);
    lastMissingFrames=0;
    const requestedGeneration=generation;
    onStatus('設定を切替中 · 現在のPCMを継続再生');
    const promise=new Promise((resolve,reject)=>
      transitionWaiters.set(requestedGeneration,{resolve,reject}));
    pump();
    return promise;
  };
  return {master,start(){pump();},stop:cleanup,
    sourcePositionAt(){return latestFrame/sampleRate;},
    seek(frame){return reset(frame,{});},
    updateSettings:stageSettings,
    get active(){return !stopped},get firstScheduled(){return started},
    get bufferedSegments(){return bufferedSegments}};
}

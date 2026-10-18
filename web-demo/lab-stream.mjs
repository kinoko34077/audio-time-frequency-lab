// Bounded, seek-aware model audition. All source PCM stays in this tab.
// A small context-bearing chunk is rendered in a module Worker while previous
// chunks play. This is buffered live audition, NOT sample-by-sample DSP.
export const CHUNK_SECONDS=1.5;
export function planChunk({totalFrames,sampleRate,speed,startSeconds,fftSize=2048,referenceWindows=8}){
  if(!(totalFrames>0&&sampleRate>0&&speed>0))throw RangeError('invalid source range');
  if(![1024,2048,4096].includes(fftSize))throw RangeError('unsupported FFT window');
  if(!Number.isInteger(referenceWindows)||referenceWindows<2||referenceWindows>16)throw RangeError('invalid context window count');
  const start=Math.min(totalFrames-1,Math.max(0,Math.floor(startSeconds*sampleRate)));
  const core=Math.min(totalFrames-start,Math.ceil(CHUNK_SECONDS*sampleRate));
  const context=Math.min(Math.ceil(sampleRate*.7),Math.max(Math.ceil(sampleRate*.040),referenceWindows*fftSize/4));
  const left=Math.min(start,context),right=Math.min(totalFrames-start-core,context);
  const from=start-left,to=start+core+right;
  const crop=Math.round(left/speed),central=Math.round(core/speed);
  const tail=Math.min(Math.round(.025*sampleRate),Math.round(right/speed));
  return {from,to,left,right,core,start,outputStart:crop,outputFrames:central+tail,coreFrames:central,nextSeconds:(start+core)/sampleRate};
}
export function createModelStream({ctx,sourceChannels,sampleRate,speed,semitones,model,fftSize,referenceWindows,startSeconds=0,onStatus=()=>{},onStarted=()=>{},onFailure=()=>{}}){
  let stopped=false,active=false,pending=false,timer=0;
  const nodes=[],totalFrames=sourceChannels[0].length,duration=totalFrames/sampleRate;
  const worker=new Worker('./lab-processor.worker.mjs',{type:'module'});
  const master=ctx.createGain(); master.gain.value=1;master.connect(ctx.destination);
  let cursor=((startSeconds%duration)+duration)%duration;
  let nextWhen=ctx.currentTime+.12,started=false,job=0;
  function cleanup(){
    if(stopped)return;stopped=true;clearTimeout(timer);worker.terminate();
    for(const src of nodes){try{src.stop();src.disconnect();}catch{}}
    nodes.length=0;try{master.disconnect();}catch{}
  }
  function schedule(data,plan){
    if(stopped)return;
    const channels=data.channels;
    if(!channels?.length||!channels[0]?.length)throw Error('処理データが空です');
    const buffer=ctx.createBuffer(channels.length,channels[0].length,sampleRate);
    channels.forEach((ch,i)=>buffer.copyToChannel(ch,i));
    // Chunks meet at an exact source-time boundary. Short extra tails are
    // crossfaded against the next segment without shortening timeline.
    const startAt=Math.max(nextWhen,ctx.currentTime+.040);
    const gain=ctx.createGain(),src=ctx.createBufferSource();
    src.buffer=buffer;src.connect(gain);gain.connect(master);
    const fade=.018,coreDuration=plan.coreFrames/sampleRate,end=startAt+coreDuration;
    gain.gain.setValueAtTime(.0001,startAt);
    gain.gain.linearRampToValueAtTime(1,startAt+Math.min(fade,coreDuration/3));
    gain.gain.setValueAtTime(1,Math.max(startAt+fade,end-.009));
    gain.gain.linearRampToValueAtTime(.0001,Math.min(end+fade,startAt+buffer.duration));
    src.start(startAt);
    src.onended=()=>{try{src.disconnect();gain.disconnect();}catch{}const idx=nodes.indexOf(src);if(idx>=0)nodes.splice(idx,1);};
    nodes.push(src);
    if(!started){started=true;onStarted(startAt);onStatus('モデル音声を再生中 · 順次処理');}
    if(startAt>nextWhen+.040&&started)onStatus('処理が追いつかず短い音切れが発生した可能性があります');
    nextWhen=end;
  }
  worker.onmessage=({data})=>{
    if(stopped||!pending||data.job!==job)return;
    pending=false;
    if(!data.ok){onFailure(data.message||'DSP処理失敗');cleanup();return;}
    try{schedule(data,data.plan);}catch(err){onFailure(err.message);cleanup();return;}
    cursor=data.plan.nextSeconds>=duration-.5/sampleRate?0:data.plan.nextSeconds;
    refill();
  };
  worker.onerror=e=>{if(!stopped){onFailure(e.message||'Worker起動失敗');cleanup();}};
  function refill(){
    if(stopped||pending)return;
    const ahead=nextWhen-ctx.currentTime;
    // At most about 5s of decoded preview buffers in addition to the source.
    if(ahead>5.0){timer=setTimeout(refill,350);return;}
    const plan=planChunk({totalFrames,sampleRate,speed,startSeconds:cursor,fftSize,referenceWindows});
    const channels=sourceChannels.map(ch=>ch.slice(plan.from,plan.to));
    pending=true;job++;
    onStatus(started?'次の区間を先読み中':'モデルの先頭区間を準備中…');
    try{worker.postMessage({job,channels,sampleRate,speed,semitones,model,fftSize,plan},channels.map(ch=>ch.buffer));}
    catch(error){pending=false;onFailure(error.message);cleanup();}
  }
  return {master,start(){refill();},stop:cleanup,get active(){return !stopped},get firstScheduled(){return started}};
}

import {renderPCM} from './lab-dsp.mjs';
// Only a context-padded, bounded segment is transferred and rendered.
// Entire recordings are NEVER sent to this worker.
self.onmessage=({data})=>{
  const {job,generation,channels,sampleRate,speed,semitones,model,fftSize,shortFftSize=512,longFftSize=fftSize,periodCycles=8,jointBackend=null,plan}=data;
  const startedAt=performance.now();
  try {
    if(!plan||channels.some(ch=>ch.length!==plan.to-plan.from+
      (plan.wrapLeft||0)+(plan.wrapRight||0)))
      throw Error('区間情報が不正です');
    const rendered=renderPCM({channels,sampleRate,speed,semitones,model,
      fftSize,shortFftSize,longFftSize,
      sourceStartSeconds:plan.sourceStartFrame/sampleRate,
      periodCycles,jointBackend});
    const result=rendered.channels.map(ch=>{
      const out=new Float32Array(plan.outputFrames);
      const part=ch.subarray(plan.outputStart,plan.outputStart+out.length);
      out.set(part);return out;
    });
    self.postMessage({job,generation,ok:true,channels:result,plan,
      workerElapsedMs:performance.now()-startedAt},result.map(ch=>ch.buffer));
  } catch(error) {
    self.postMessage({job,generation,ok:false,message:error?.message||String(error),
      workerElapsedMs:performance.now()-startedAt});
  }
};

import {renderPCM} from './lab-dsp.mjs';
// Only a context-padded, bounded segment is transferred and rendered.
// Entire recordings are NEVER sent to this worker.
self.onmessage=({data})=>{
  const {job,channels,sampleRate,speed,semitones,model,fftSize,shortFftSize=512,longFftSize=fftSize,plan}=data;
  try {
    if(!plan||channels.some(ch=>ch.length!==plan.to-plan.from))throw Error('区間情報が不正です');
    const rendered=renderPCM({channels,sampleRate,speed,semitones,model,fftSize,shortFftSize,longFftSize});
    const result=rendered.channels.map(ch=>{
      const out=new Float32Array(plan.outputFrames);
      const part=ch.subarray(plan.outputStart,plan.outputStart+out.length);
      out.set(part);return out;
    });
    self.postMessage({job,ok:true,channels:result,plan},result.map(ch=>ch.buffer));
  } catch(error) {
    self.postMessage({job,ok:false,message:error?.message||String(error)});
  }
};

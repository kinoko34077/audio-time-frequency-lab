import {renderPCM} from "./lab-dsp.mjs";
self.onmessage=({data})=>{
 const {job,channels,sampleRate,speed,semitones,model}=data;
 try {
  const result=renderPCM({channels,sampleRate,speed,semitones,model});
  self.postMessage({job,ok:true,channels:result.channels,sampleRate:result.sampleRate},
   result.channels.map(ch=>ch.buffer));
 } catch(error) {
  self.postMessage({job,ok:false,message:error?.message||String(error)});
 }
};
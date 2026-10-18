import {renderPCM} from "./lab-dsp.mjs";
self.onmessage=({data})=>{
  try{
    const result=renderPCM({channels:data.channels,sampleRate:data.sampleRate,model:data.model,speed:data.speed,semitones:data.semitones});
    self.postMessage({ok:true,channels:result.channels,sampleRate:result.sampleRate},result.channels.map(ch=>ch.buffer));
  }catch(error){
    self.postMessage({ok:false,message:error?.message||String(error)});
  }
};

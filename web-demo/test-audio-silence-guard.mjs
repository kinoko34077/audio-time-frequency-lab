export function installTestAudioSilenceGuard(scope,audit){
  const AudioNode=scope?.AudioNode;
  const AudioWorkletNode=scope?.AudioWorkletNode;
  const MediaStreamAudioDestinationNode=scope?.MediaStreamAudioDestinationNode;
  if(typeof AudioNode?.prototype?.connect!=="function")
    throw TypeError("test audio silence guard requires AudioNode.connect");
  const audioNodePrototype=AudioNode.prototype;
  const workletPrototype=AudioWorkletNode?.prototype;
  const originalConnect=audioNodePrototype.connect;
  const originalWorkletDescriptor=workletPrototype&&
    Object.getOwnPropertyDescriptor(workletPrototype,"connect");
  const silentSinks=new WeakMap();

  function silentSink(context,destination){
    let sinks=silentSinks.get(context);
    if(!sinks){sinks=new Map();silentSinks.set(context,sinks);}
    let sink=sinks.get(destination);
    if(!sink){
      sink=context.createGain();
      sink.gain.value=0;
      originalConnect.call(sink,destination);
      sinks.set(destination,sink);
      audit.audioOutputMuteGain=0;
      audit.audioOutputMuteGains??=[];
      audit.audioOutputMuteGains.push(sink.gain.value);
    }
    return sink;
  }

  function guardedConnect(destination,...args){
    const context=this.context;
    const media=typeof MediaStreamAudioDestinationNode==="function"&&
      destination instanceof MediaStreamAudioDestinationNode;
    if(destination===context?.destination||media){
      audit.mutedOutputRoutes=(audit.mutedOutputRoutes||0)+1;
      originalConnect.call(this,silentSink(context,destination),...args);
      return destination;
    }
    return originalConnect.call(this,destination,...args);
  }

  audioNodePrototype.connect=guardedConnect;
  if(workletPrototype&&workletPrototype!==audioNodePrototype)
    workletPrototype.connect=guardedConnect;

  return ()=>{
    if(audioNodePrototype.connect===guardedConnect)
      audioNodePrototype.connect=originalConnect;
    if(workletPrototype&&workletPrototype!==audioNodePrototype&&
       workletPrototype.connect===guardedConnect){
      if(originalWorkletDescriptor)
        Object.defineProperty(workletPrototype,"connect",originalWorkletDescriptor);
      else delete workletPrototype.connect;
    }
  };
}

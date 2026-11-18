export function installTestAudioSilenceGuard(scope,audit){
  const AudioNode=scope?.AudioNode;
  const AudioWorkletNode=scope?.AudioWorkletNode;
  if(typeof AudioNode?.prototype?.connect!=="function")
    throw TypeError("test audio silence guard requires AudioNode.connect");
  const audioNodePrototype=AudioNode.prototype;
  const workletPrototype=AudioWorkletNode?.prototype;
  const originalConnect=audioNodePrototype.connect;
  const originalWorkletDescriptor=workletPrototype&&
    Object.getOwnPropertyDescriptor(workletPrototype,"connect");
  const silentSinks=new WeakMap();

  function silentSink(context){
    let sink=silentSinks.get(context);
    if(!sink){
      sink=context.createGain();
      sink.gain.value=0;
      originalConnect.call(sink,context.destination);
      silentSinks.set(context,sink);
      audit.audioOutputMuteGain=0;
    }
    return sink;
  }

  function guardedConnect(destination,...args){
    if(destination===this.context?.destination){
      audit.mutedOutputRoutes=(audit.mutedOutputRoutes||0)+1;
      originalConnect.call(this,silentSink(this.context),...args);
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

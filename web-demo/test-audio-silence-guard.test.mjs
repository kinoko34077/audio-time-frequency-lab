import test from "node:test";
import assert from "node:assert/strict";
import {
  installTestAudioSilenceGuard,
  installTestAudioSilenceGuardForPage
} from "./test-audio-silence-guard.mjs";

class FakeAudioNode{
  constructor(context){this.context=context;this.connections=[];}
  connect(destination,...args){
    this.connections.push({destination,args});
    return destination;
  }
}

class FakeGainNode extends FakeAudioNode{
  constructor(context){super(context);this.gain={value:1};}
}

class FakeMediaStreamAudioDestinationNode extends FakeAudioNode{}

class FakeAudioContext{
  constructor(){
    this.destination=new FakeAudioNode(this);
    this.mediaDestination=new FakeMediaStreamAudioDestinationNode(this);
    this.gains=[];
  }
  createGain(){
    const gain=new FakeGainNode(this);
    this.gains.push(gain);
    return gain;
  }
}

class FakeAudioWorkletNode extends FakeAudioNode{}

test("test playback mutes direct and MediaStream output routes",()=>{
  const audit={mutedOutputRoutes:0};
  const restore=installTestAudioSilenceGuard({
    AudioNode:FakeAudioNode,
    AudioWorkletNode:FakeAudioWorkletNode,
    MediaStreamAudioDestinationNode:FakeMediaStreamAudioDestinationNode
  },audit);

  const context=new FakeAudioContext();
  const worklet=new FakeAudioWorkletNode(context);
  const directNode=new FakeAudioNode(context);
  const mediaNode=new FakeAudioNode(context);
  assert.equal(worklet.connect(context.destination,1,0),context.destination);
  assert.equal(directNode.connect(context.destination),context.destination);
  assert.equal(mediaNode.connect(context.mediaDestination,0),context.mediaDestination);

  assert.equal(context.gains.length,2,"one silent sink is shared per output destination");
  const [silentSink,mediaSilentSink]=context.gains;
  assert.equal(silentSink.gain.value,0);
  assert.deepEqual(silentSink.connections,[{
    destination:context.destination,args:[]
  }]);
  assert.equal(mediaSilentSink.gain.value,0);
  assert.deepEqual(mediaSilentSink.connections,[{
    destination:context.mediaDestination,args:[]
  }]);
  assert.deepEqual(worklet.connections,[{destination:silentSink,args:[1,0]}]);
  assert.deepEqual(directNode.connections,[{destination:silentSink,args:[]}]);
  assert.deepEqual(mediaNode.connections,[{destination:mediaSilentSink,args:[0]}]);
  assert.equal(audit.mutedOutputRoutes,3);
  assert.equal(audit.audioOutputMuteGain,0);
  assert.deepEqual(audit.audioOutputMuteGains,[0,0]);
  restore();
});

test("browser test bootstrap mutes direct and MediaStream outputs before page code",async()=>{
  let registration;
  const page={evaluateOnNewDocument(callback,...args){
    registration={callback,args};
  }};
  await installTestAudioSilenceGuardForPage(page);
  assert.ok(registration,"guard must install before document scripts");

  const previousWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  const originalAudioConnect=Object.getOwnPropertyDescriptor(FakeAudioNode.prototype,"connect");
  const originalWorkletConnect=Object.getOwnPropertyDescriptor(FakeAudioWorkletNode.prototype,"connect");
  const scope={
    AudioNode:FakeAudioNode,
    AudioWorkletNode:FakeAudioWorkletNode,
    MediaStreamAudioDestinationNode:FakeMediaStreamAudioDestinationNode
  };
  Object.defineProperty(globalThis,"window",{configurable:true,value:scope});
  try{
    await registration.callback(...registration.args);
    const context=new FakeAudioContext();
    const direct=new FakeAudioNode(context),media=new FakeAudioNode(context);
    direct.connect(context.destination);
    media.connect(context.mediaDestination);
    assert.equal(scope.__audioSilenceAudit.mutedOutputRoutes,2);
    assert.deepEqual(context.gains.map(gain=>gain.gain.value),[0,0]);
    assert.equal(direct.connections[0].destination,context.gains[0]);
    assert.equal(media.connections[0].destination,context.gains[1]);
  }finally{
    Object.defineProperty(FakeAudioNode.prototype,"connect",originalAudioConnect);
    if(originalWorkletConnect)
      Object.defineProperty(FakeAudioWorkletNode.prototype,"connect",originalWorkletConnect);
    else delete FakeAudioWorkletNode.prototype.connect;
    if(previousWindow)
      Object.defineProperty(globalThis,"window",previousWindow);
    else delete globalThis.window;
  }
});

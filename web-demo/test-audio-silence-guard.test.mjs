import test from "node:test";
import assert from "node:assert/strict";
import {installTestAudioSilenceGuard} from "./test-audio-silence-guard.mjs";

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

class FakeAudioContext{
  constructor(){this.destination=new FakeAudioNode(this);this.gains=[];}
  createGain(){
    const gain=new FakeGainNode(this);
    this.gains.push(gain);
    return gain;
  }
}

class FakeAudioWorkletNode extends FakeAudioNode{}

test("test playback routes every audio node through a zero-gain destination guard",()=>{
  const audit={mutedOutputRoutes:0};
  const restore=installTestAudioSilenceGuard({
    AudioNode:FakeAudioNode,
    AudioWorkletNode:FakeAudioWorkletNode
  },audit);

  const context=new FakeAudioContext();
  const worklet=new FakeAudioWorkletNode(context);
  const directNode=new FakeAudioNode(context);
  assert.equal(worklet.connect(context.destination,1,0),context.destination);
  assert.equal(directNode.connect(context.destination),context.destination);

  assert.equal(context.gains.length,1,"one silent sink is shared per context");
  const [silentSink]=context.gains;
  assert.equal(silentSink.gain.value,0);
  assert.deepEqual(silentSink.connections,[{
    destination:context.destination,args:[]
  }]);
  assert.deepEqual(worklet.connections,[{destination:silentSink,args:[1,0]}]);
  assert.deepEqual(directNode.connections,[{destination:silentSink,args:[]}]);
  assert.equal(audit.mutedOutputRoutes,2);
  assert.equal(audit.audioOutputMuteGain,0);
  restore();
});

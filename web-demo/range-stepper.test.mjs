import test from "node:test";
import assert from "node:assert/strict";
import {incrementCanonical} from "./range-stepper.mjs";
import {bindPressRepeat} from "./press-repeat.mjs";

test("fine step retains precise canonical value outside a visible rail",()=>{
  assert.equal(incrementCanonical(-1.237,.01,1,-8,8),-1.227);
  assert.equal(incrementCanonical(-7.125,.01,-1,-8,8),-7.135);
  assert.equal(incrementCanonical(7.1234,.1,1,-12,12),7.2234);
  assert.equal(incrementCanonical(-7.123456789012,.1,-1,-12,12),-7.223456789012);
  assert.equal(incrementCanonical(-.01,.01,1,-8,8),0);
  assert.equal(incrementCanonical(7.999,.01,1,-8,8),8);
  assert.equal(incrementCanonical(-8,.01,-1,-8,8),-8);
  assert.throws(()=>incrementCanonical(0,0,1,-8,8),RangeError);
  assert.throws(()=>incrementCanonical(9,.01,1,-8,8),RangeError);
});
function eventNode(){
  const listeners=new Map();
  return {
    addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},
    removeEventListener(type,callback){listeners.get(type)?.delete(callback);},
    emit(type,data={}){for(const fn of [...(listeners.get(type)||[])])fn(data);}
  };
}
function fakeRig(options={}){
  let now=0,next=1,taps=0,holds=0,frames=0,enabled=true;
  const timers=new Map(),raf=new Map(),doc=eventNode(),view=eventNode();
  Object.assign(view,{performance:{now:()=>now},setTimeout:fn=>{const id=next++;timers.set(id,fn);return id;},
    clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>{const id=next++;raf.set(id,fn);return id;},
    cancelAnimationFrame:id=>raf.delete(id)});
  doc.defaultView=view;doc.hidden=false;
  const button=Object.assign(eventNode(),{ownerDocument:doc,setPointerCapture(){},hasPointerCapture:()=>false});
  const control=bindPressRepeat(button,{onTap:()=>taps++,onHoldStart:()=>{holds++;return options.stopAtStart!==true;},
    onHoldFrame:()=>{frames++;return options.stopAtFrame!==true;},canAct:()=>enabled});
  return {button,view,doc,control,
    press(id=1){button.emit("pointerdown",{pointerId:id,button:0,preventDefault(){}});},
    release(id=1){button.emit("pointerup",{pointerId:id});},
    timer(){now+=220;for(const [id,fn] of [...timers]){timers.delete(id);fn();}},
    frame(dt=16){now+=dt;for(const [id,fn] of [...raf]){raf.delete(id);fn(now);}},
    disable(){enabled=false;},
    get state(){return {taps,holds,frames,timers:timers.size,raf:raf.size};}};
}
test("press lifecycle: tap once, no duplicate pointer click, keyboard click, repeat and release",()=>{
  const r=fakeRig();
  r.press();r.release(2);assert.equal(r.state.timers,1);
  r.release();r.button.emit("click",{detail:1});assert.equal(r.state.taps,1);
  r.button.emit("click",{detail:0});assert.equal(r.state.taps,2);
  r.press();r.timer();r.frame(0);assert.equal(r.state.frames,0);
  r.frame();r.frame();assert.deepEqual(r.state,{taps:2,holds:1,frames:2,timers:0,raf:1});
  r.release();r.frame();assert.deepEqual(r.state,{taps:2,holds:1,frames:2,timers:0,raf:0});
});
test("all cancellation paths stop timers and RAF without a release tap",()=>{
  for(const cancel of [
    r=>r.button.emit("pointercancel",{pointerId:1}),
    r=>r.button.emit("lostpointercapture",{pointerId:1}),
    r=>r.view.emit("pointerup",{pointerId:1}),
    r=>r.view.emit("blur"),
    r=>{r.doc.hidden=true;r.doc.emit("visibilitychange");},
    r=>r.control.cancel(),
    r=>r.control.dispose()
  ])for(const held of [false,true]){
    const r=fakeRig();r.press();if(held){r.timer();r.frame();}
    cancel(r);const state=r.state;r.release();r.timer();r.frame();
    assert.equal(state.taps,0);assert.equal(state.timers,0);assert.equal(state.raf,0);
    assert.deepEqual(r.state,state);
  }
  const r=fakeRig();r.press();r.timer();r.disable();r.frame();r.release();
  assert.equal(r.state.frames,0);assert.equal(r.state.raf,0);assert.equal(r.state.taps,0);
});
test("reaching a bound stops repeat until a new press",()=>{
  for(const options of [{stopAtStart:true},{stopAtFrame:true}]){
    const r=fakeRig(options);r.press();r.timer();r.frame();r.frame();
    assert.equal(r.state.raf,0);r.release();assert.equal(r.state.taps,0);
    r.press();r.release();assert.equal(r.state.taps,1);
  }
});

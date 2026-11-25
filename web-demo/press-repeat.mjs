/** Shared press/repeat lifecycle, extracted from the waveform zoom buttons.
 * The caller owns the actual step/continuous operation and timing policy.
 * Return false from a hold callback to stop repeating at a boundary.
 */
export function bindPressRepeat(button,{onTap,onPress=()=>{},onHoldStart=()=>true,
  onHoldFrame,delay=220,canAct=()=>!button.disabled}){
  const doc=button.ownerDocument??globalThis.document;
  const view=doc?.defaultView??globalThis;
  let pointerId=null,startTimer=0,animation=0,held=false,lastTime=0,disposed=false;
  const off=[];
  const listen=(node,type,callback)=>{
    node.addEventListener(type,callback);
    off.push(()=>node.removeEventListener?.(type,callback));
  };
  const stopGlobalTracking=()=>{
    view.removeEventListener?.("pointerup",finishPointer);
    view.removeEventListener?.("pointercancel",finishPointer);
    view.removeEventListener?.("blur",finishBlur);
    doc?.removeEventListener("visibilitychange",finishVisibility);
  };
  function finish(event,applyTap){
    if(pointerId===null||(event&&event.pointerId!==pointerId))return;
    const id=pointerId,tap=applyTap&&!held&&!disposed&&canAct();
    pointerId=null;held=false;
    view.clearTimeout(startTimer);startTimer=0;
    if(animation)view.cancelAnimationFrame(animation);
    animation=0;stopGlobalTracking();
    if(button.hasPointerCapture?.(id))try{button.releasePointerCapture(id);}catch{}
    if(tap)onTap();
  }
  function finishPointer(event){finish(event,false);}
  function finishBlur(){finish(null,false);}
  function finishVisibility(){if(doc?.hidden)finish(null,false);}
  const repeat=time=>{
    animation=0;
    if(pointerId===null||disposed||!canAct()){finish(null,false);return;}
    const elapsed=Math.max(0,Math.min(40,time-lastTime));lastTime=time;
    // RAF can start at the same timestamp as the timer. Never treat a zero
    // interval as a clamped operation.
    if(elapsed>=1&&onHoldFrame(elapsed)===false)return;
    if(pointerId!==null&&!disposed)animation=view.requestAnimationFrame(repeat);
  };
  listen(button,"pointerdown",event=>{
    if(disposed||pointerId!==null||event.button!==0||event.isPrimary===false||!canAct())return;
    pointerId=event.pointerId;held=false;
    onPress();
    try{button.setPointerCapture(event.pointerId);}catch{}
    view.addEventListener?.("pointerup",finishPointer);
    view.addEventListener?.("pointercancel",finishPointer);
    view.addEventListener?.("blur",finishBlur);
    doc?.addEventListener("visibilitychange",finishVisibility);
    startTimer=view.setTimeout(()=>{
      startTimer=0;
      if(pointerId===null||disposed||!canAct()){finish(null,false);return;}
      held=true;lastTime=view.performance.now();
      if(onHoldStart()!==false&&pointerId!==null&&!disposed)
        animation=view.requestAnimationFrame(repeat);
    },delay);
    event.preventDefault();
  });
  listen(button,"pointerup",event=>finish(event,true));
  listen(button,"pointercancel",event=>finish(event,false));
  listen(button,"lostpointercapture",event=>finish(event,false));
  listen(button,"click",event=>{
    if(!disposed&&pointerId===null&&event.detail===0&&canAct())onTap();
  });
  return Object.freeze({cancel:()=>finish(null,false),dispose(){
    if(disposed)return;disposed=true;finish(null,false);
    for(const remove of off)remove();
  }});
}

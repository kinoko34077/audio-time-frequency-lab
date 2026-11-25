import {bindPressRepeat} from "./press-repeat.mjs";

// Use decimal addition when it is safely representable; do not snap a precise
// canonical value onto the slider's coarser lattice or visible range.
export function incrementCanonical(value,step,direction,min,max){
  if(![value,step,min,max].every(Number.isFinite)||step<=0||
      ![-1,1].includes(direction)||min>max||value<min||value>max)
    throw new RangeError("invalid fine step");
  const places=n=>{
    const [mantissa,exp="0"]=String(Math.abs(n)).split("e");
    return Math.max(0,(mantissa.split(".")[1]?.length??0)-Number(exp));
  };
  const scale=10**Math.max(places(value),places(step));
  const a=Math.round(value*scale),b=Math.round(step*scale),sum=a+direction*b;
  const next=[a,b,sum].every(Number.isSafeInteger)&&b>0?sum/scale:value+direction*step;
  return Math.max(min,Math.min(max,next));
}

/** One compact visual pair around a native range. The consumer may supply a
 * canonical step adapter (e.g. speed outside the visible rail). Otherwise the
 * existing native step lattice and input/change path remain authoritative.
 */
export function mountRangeStepButtons(slider,{onStep=null,delay=220,interval=80}={}){
  if(slider?.type!=="range"||!slider.parentNode||!Number.isFinite(interval)||interval<=0)
    throw new TypeError("range and positive repeat interval required");
  const doc=slider.ownerDocument,view=doc.defaultView;
  const root=doc.createElement("div");root.className="range-stepper";
  root.dataset.rangeStepper=slider.id;
  slider.before(root);root.append(slider);
  const available=()=>!slider.matches(":disabled")&&slider.getClientRects().length>0;
  const stepNative=direction=>{
    const before=slider.value;
    if(direction>0)slider.stepUp();else slider.stepDown();
    if(slider.value===before)return false;
    slider.dispatchEvent(new view.Event("input",{bubbles:true}));
    slider.dispatchEvent(new view.Event("change",{bubbles:true}));
    return true;
  };
  const step=direction=>available()&&(onStep?onStep(direction):stepNative(direction))!==false;
  const label=slider.getAttribute("aria-label")||slider.id;
  const buttons=[],controls=[];
  for(const direction of [-1,1]){
    const button=doc.createElement("button");button.type="button";
    button.className="range-step";button.dataset.rangeStep=direction<0?"minus":"plus";
    button.textContent=direction<0?"−":"+";
    button.setAttribute("aria-label",label+(direction<0?"を1段階減らす":"を1段階増やす"));
    button.title="タップで1段階、長押しで連続調整";
    button.setAttribute("aria-controls",slider.id);
    direction<0?root.prepend(button):root.append(button);
    let elapsed=0;
    controls.push(bindPressRepeat(button,{
      delay,canAct:available,
      onPress:()=>button.focus({preventScroll:true}),
      onTap:()=>step(direction),
      onHoldStart:()=>{elapsed=0;return step(direction);},
      onHoldFrame:dt=>{
        elapsed+=dt;
        if(elapsed<interval)return true;
        elapsed-=interval;return step(direction);
      }
    }));
    button.addEventListener("contextmenu",preventContextMenu);
    buttons.push(button);
  }
  function preventContextMenu(event){event.preventDefault();}
  const sync=()=>{
    for(const button of buttons)button.disabled=slider.matches(":disabled");
    if(slider.matches(":disabled"))for(const control of controls)control.cancel();
  };
  const observer=new view.MutationObserver(sync);
  observer.observe(slider,{attributes:true,attributeFilter:["disabled"]});
  sync();
  return Object.freeze({root,dispose(){
    observer.disconnect();
    for(const control of controls)control.dispose();
    for(const button of buttons)button.removeEventListener("contextmenu",preventContextMenu);
    if(root.parentNode){root.before(slider);root.remove();}
  }});
}

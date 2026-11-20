const validFrame=value=>Number.isSafeInteger(value)&&value>=0;

export function toggleSourceMarker(markers,frame,tolerance=0){
  if(!validFrame(frame)||!Number.isFinite(tolerance)||tolerance<0)
    return [...new Set(markers.filter(validFrame))].sort((a,b)=>a-b);
  const values=[...new Set(markers.filter(validFrame))].sort((a,b)=>a-b);
  const existing=values.findIndex(value=>Math.abs(value-frame)<=tolerance);
  if(existing>=0)values.splice(existing,1);
  else values.push(frame);
  return values.sort((a,b)=>a-b);
}

export function nearestMarkerLoop(markers,position,sourceFrames){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<2||!Number.isFinite(position))
    return null;
  const values=[...new Set(markers.filter(value=>validFrame(value)&&value<=sourceFrames))]
    .sort((a,b)=>a-b);
  if(values.length<2)return null;
  let upper=values.findIndex(value=>value>=position);
  if(upper<0)upper=values.length-1;
  if(upper===0)upper=1;
  const lower=Math.max(0,upper-1);
  const a=values[lower],b=values[upper];
  return b>a?{a,b}:null;
}

export function shiftLoopToFrame(loop,edge,frame,sourceFrames){
  if(!Number.isSafeInteger(sourceFrames)||sourceFrames<1||
     !Number.isSafeInteger(loop?.a)||!Number.isSafeInteger(loop?.b)||
     loop.a<0||loop.b<=loop.a||loop.b>sourceFrames||
     (edge!=="a"&&edge!=="b")||!Number.isFinite(frame))return null;
  const span=loop.b-loop.a;
  if(span>=sourceFrames)return {a:0,b:sourceFrames};
  if(edge==="a"){
    const a=Math.min(sourceFrames-span,Math.max(0,Math.round(frame)));
    return {a,b:a+span};
  }
  const b=Math.min(sourceFrames,Math.max(span,Math.round(frame)));
  return {a:b-span,b};
}

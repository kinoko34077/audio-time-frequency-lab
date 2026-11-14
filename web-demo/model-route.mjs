/** #63 U1/U5: dispatch guard for distinct existing DSP backends.
 * Granular is the only engine here with signed source time, 0x and true
 * sample-coordinate A/B. These capabilities must never be claimed for
 * Rust/PV/WSOLA/dual/AM without implementing them in their actual renderer.
 */
export const MODEL_IDS=Object.freeze(["granular","live","pv","wsola","dual","am"]);
export function primaryModelCapability(mode,speed){
  if(!MODEL_IDS.includes(mode))throw RangeError("unknown playback model");
  if(typeof speed!=="number"||!Number.isFinite(speed)||speed<-8||speed>8)
    throw RangeError("speed must be finite within -8..8");
  const granular=mode==="granular";
  return Object.freeze({
    mode,supported:granular||(speed>=.5&&speed<=2),
    signed:granular,zeroAudible:granular,sampleAB:granular,
    realtime:granular||mode==="live",
    reason:granular||speed>=.5&&speed<=2?"":"このモデルの速度は0.5〜2倍のみ。0倍・逆再生・2倍超は未対応です。"
  });
}

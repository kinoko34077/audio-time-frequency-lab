/** #36 / #63: one source of truth for player models and PCM-route eligibility.
 * The optional legacy individual-period path keeps its historical capability
 * limits; it is no longer a mandatory product parity target (2026-11-23).
 * Unknown renderer modes (raw/worker) are not user-selectable PCM models.
 */
const MODEL_DEFINITIONS=Object.freeze({
  spectral:Object.freeze({label:"STFT",alwaysPCM:true}),
  granular:Object.freeze({label:"Granular",alwaysPCM:true}),
  live:Object.freeze({label:"Rust/WASM",alwaysPCM:false}),
  pv:Object.freeze({label:"PV",alwaysPCM:false}),
  wsola:Object.freeze({label:"WSOLA",alwaysPCM:false}),
  dual:Object.freeze({label:"Dual",alwaysPCM:false}),
  am:Object.freeze({label:"AM",alwaysPCM:false})
});
export const MODEL_IDS=Object.freeze(Object.keys(MODEL_DEFINITIONS));
export const MODEL_LABELS=Object.freeze(Object.fromEntries(
  Object.entries(MODEL_DEFINITIONS).map(([id,entry])=>[id,entry.label])));

export function isContinuousPCMModel(mode,{individual=false}={}){
  const definition=Object.hasOwn(MODEL_DEFINITIONS,mode)?MODEL_DEFINITIONS[mode]:null;
  return Boolean(definition&&(definition.alwaysPCM||!individual));
}

export function primaryModelCapability(mode,speed,{individual=false}={}){
  if(!MODEL_IDS.includes(mode))throw RangeError("unknown playback model");
  if(typeof speed!=="number"||!Number.isFinite(speed)||speed<-8||speed>8)
    throw RangeError("speed must be finite within -8..8");
  if(typeof individual!=="boolean")throw TypeError("invalid individual-mode setting");
  const continuousPCM=isContinuousPCMModel(mode,{individual});
  const sampleAB=continuousPCM||mode!=="live";
  return Object.freeze({
    mode,supported:continuousPCM||(speed>=.5&&speed<=2),
    signed:continuousPCM,zeroAudible:continuousPCM,sampleAB,
    realtime:continuousPCM||mode==="live",
    reason:continuousPCM||speed>=.5&&speed<=2?"":"このモデルの速度は0.5〜2倍のみ。0倍・逆再生・2倍超は未対応です。"
  });
}

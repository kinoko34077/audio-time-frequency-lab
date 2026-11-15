/** #63 U1/U5: dispatch guard for ACTUAL model DSP routes.
 * Spectral STFT and Granular share the bounded PCM source-time Worklet and
 * can play signed/0 and sample-coordinate A/B. Rust/Worker algorithms do not
 * inherit these capabilities merely because a UI value was selected.
 */
export const MODEL_IDS=Object.freeze(["spectral","granular","live","pv","wsola","dual","am"]);
export function primaryModelCapability(mode,speed){
  if(!MODEL_IDS.includes(mode))throw RangeError("unknown playback model");
  if(typeof speed!=="number"||!Number.isFinite(speed)||speed<-8||speed>8)
    throw RangeError("speed must be finite within -8..8");
  const continuousPCM=mode==="spectral"||mode==="granular";
  return Object.freeze({
    mode,supported:continuousPCM||(speed>=.5&&speed<=2),
    signed:continuousPCM,zeroAudible:continuousPCM,sampleAB:continuousPCM,
    realtime:continuousPCM||mode==="live",
    reason:continuousPCM||speed>=.5&&speed<=2?"":"このモデルの速度は0.5〜2倍のみ。0倍・逆再生・2倍超は未対応です。"
  });
}

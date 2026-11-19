const TRANSPORT_LABELS={playing:'再生中',paused:'一時停止中',stopped:'停止中'};
const PHASE_LABELS={
  ready:'次回再生で適用',pending:'反映中',applied:'反映済み',
  failed:'反映失敗',saved:'設定保持',unsupported:'未対応'
};
const MODEL_LABELS={
  spectral:'STFT',granular:'Granular',live:'Rust/WASM',pv:'PV',
  wsola:'WSOLA',dual:'Dual',am:'AM'
};

function signed(value,digits){
  const number=Number(value);
  if(!Number.isFinite(number))throw new RangeError('playback status value must be finite');
  if(number===0)return number.toFixed(digits);
  return (number>0?'+':'−')+Math.abs(number).toFixed(digits);
}

export function formatPlaybackStatus({transport,phase,model,individual=false,
  speed,pitch}){
  const transportLabel=TRANSPORT_LABELS[transport];
  const phaseLabel=PHASE_LABELS[phase];
  const modelLabel=MODEL_LABELS[model];
  if(!transportLabel||!phaseLabel||!modelLabel)
    throw new RangeError('unknown playback status value');
  const selectedModel=modelLabel+(individual?'・個別波長':'');
  return `${transportLabel}・${phaseLabel}・${selectedModel}\n`+
    `${signed(speed,3)}×・${signed(pitch,3)}半音`;
}

export function rendererMatchesSelection({processingMode,selectedMode,
  individual=false,speed,selectedSpeed,pitchSemitones,selectedPitch}){
  return !individual&&processingMode===selectedMode&&
    speed===selectedSpeed&&pitchSemitones===selectedPitch;
}

export function transportFromReceipt({paused=false,running=false}){
  return paused?'paused':running?'playing':'stopped';
}

export function phaseForModelStart({supported,settingsPending}){
  if(!supported)return 'unsupported';
  return settingsPending?'pending':'applied';
}

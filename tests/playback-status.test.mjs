import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPlaybackStatus,rendererMatchesSelection,
  transportFromReceipt} from '../web-demo/playback-status.mjs';
import * as playbackStatus from '../web-demo/playback-status.mjs';

test('playback status summarizes state, selected model and canonical factors',()=>{
  const status=formatPlaybackStatus({transport:'playing',phase:'applied',
    model:'live',speed:1.5,pitch:12});
  assert.equal(status,'再生中・反映済み・Rust/WASM\n+1.500×・+12.000半音');
  assert.doesNotMatch(status,/revision|sourceFrame|cache不足|request/i);
});

test('playback status keeps reverse, freeze, pitch and individual model readable',()=>{
  assert.equal(formatPlaybackStatus({transport:'playing',phase:'pending',
    model:'pv',individual:true,speed:-0.001,pitch:-3.25}),
  '再生中・反映中・PV・個別波長\n−0.001×・−3.250半音');
  assert.equal(formatPlaybackStatus({transport:'stopped',phase:'saved',
    model:'spectral',speed:0,pitch:0}),
  '停止中・設定保持・STFT\n0.000×・0.000半音');
  assert.equal(formatPlaybackStatus({transport:'paused',phase:'failed',
    model:'dual',speed:1,pitch:2.5}),
  '一時停止中・反映失敗・Dual\n+1.000×・+2.500半音');
});

test('an old or unsupported renderer receipt cannot confirm the selected model',()=>{
  const selected={selectedMode:'pv',individual:true,selectedSpeed:3,selectedPitch:0};
  assert.equal(rendererMatchesSelection({...selected,
    processingMode:'spectral',speed:1,pitchSemitones:0}),false);
  assert.equal(rendererMatchesSelection({...selected,
    processingMode:'pv',speed:3,pitchSemitones:0}),false);
  assert.equal(rendererMatchesSelection({...selected,individual:false,
    processingMode:'pv',speed:3,pitchSemitones:0}),true);
  assert.equal(rendererMatchesSelection({...selected,individual:false,
    processingMode:'pv',speed:3,pitchSemitones:2}),false);
  assert.equal(rendererMatchesSelection({...selected,individual:false,
    processingMode:'pv',speed:1,pitchSemitones:0}),false);
});

test('paused transport stays paused when a silent render receipt arrives',()=>{
  assert.equal(transportFromReceipt({paused:true,running:false}),'paused');
  assert.equal(transportFromReceipt({paused:false,running:false}),'stopped');
  assert.equal(transportFromReceipt({paused:false,running:true}),'playing');
});

test('rejecting an unsupported model preserves the paused player transport',()=>{
  assert.equal(playbackStatus.transportFromPlayer({paused:true,active:true}),
    'paused');
  assert.equal(playbackStatus.transportFromPlayer({paused:false,active:true}),
    'playing');
  assert.equal(playbackStatus.transportFromPlayer({paused:false,active:false}),
    'stopped');
});

test('worker start status uses the current selection after async preparation',()=>{
  assert.equal(playbackStatus.phaseForModelStart?.({supported:false,settingsPending:false}),
    'unsupported');
  assert.equal(playbackStatus.phaseForModelStart?.({supported:true,settingsPending:true}),
    'pending');
  assert.equal(playbackStatus.phaseForModelStart?.({supported:true,settingsPending:false}),
    'applied');
});

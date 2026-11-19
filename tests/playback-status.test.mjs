import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPlaybackStatus} from '../web-demo/playback-status.mjs';

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

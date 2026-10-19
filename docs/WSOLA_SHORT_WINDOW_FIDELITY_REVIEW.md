# WSOLA 256サンプル短窓の音程・接続安定性：原因と移管した検証規則

Scope: `audio-time-frequency-lab` のWSOLAの短窓256〜2048、速度0.5〜2×、音程独立、1.5sストリーミング。コピー元 `frequency-warp-vst` のDSPアルゴリズムを同一方式とみなす資料ではない。以下の**会話記録（過去の経緯）**と、現行ソースから確認した事実・検証課題を区別する。

## 会議録・既存の調査に記載された教訓
1. [Frequency Warp #39 議事録](https://github.com/kinoko34077/frequency-warp-vst/issues/39) と [#70 第1章（issuecomment-6167099603）](https://github.com/kinoko34077/frequency-warp-vst/issues/70#issuecomment-6167099603) は、単純な窓の重なり数を増やしてもBの位相干渉・音質が解決しなかったこと、DSPで実際に使う変数と画面表示を一致させるべきことを記録。
2. [#70 第4章（issuecomment-6167151843）](https://github.com/kinoko34077/frequency-warp-vst/issues/70#issuecomment-6167151843) は、コム状の濁りがトレモロへ移るケースを、短時間RMS分位点で定量測定し、FFT周辺ビンの移動差を揃えた修正を報告。**本WSOLAの原因がFFT移動差という意味ではない**。移管するのは、聴感指摘を具体的なAM/phase/error指標へ分ける検証方式。
3. [#48 A無変換の音質損失](https://github.com/kinoko34077/frequency-warp-vst/issues/48)、[#50 DSP比較](https://github.com/kinoko34077/frequency-warp-vst/issues/50) は、変換不要・純音・ノイズ・音＋ノイズ・短いアタック・左右の位相や音量比を**同一条件で**評価し、音量だけの成功が忠実度を証明しないと記録。0.5倍／1.5倍のshort-N256と元音を比較する。
4. [#204 UI監査議事録](https://github.com/kinoko34077/frequency-warp-vst/issues/204)、[#238 タスク中心UX議事録](https://github.com/kinoko34077/frequency-warp-vst/issues/238) は、ユーザーが触った値と実処理への適用、requestedとACK、設定の可視性を混同しない、重複UIを足さず利用タスクへ集中、という整理を記録。**256を無告知で1024に置換して「256で処理した」と呼ばない**。
5. [#240 時刻試験の誤判定](https://github.com/kinoko34077/frequency-warp-vst/issues/240) は、UI秒表示を550ms後に見たテストが同一SHAで不安定だった記録。今回も画面表示だけでなく実BufferSource再生の進行を確認する。
6. [#5 非線形DSP研究](https://github.com/kinoko34077/frequency-warp-vst/issues/5) は、純音だけでなくグライド・交差する成分・過渡音・ノイズ・ステレオ・CPU/遅延を同一fixtureで比較することを要求。これは今後の音質受入テスト計画に採用し、すべて済んだと誤認しない。

## 現行コードで確認した短窓256の課題と修正
- 48kHz、N=256、hop=64、局所overlap=192 (=4ms)。110Hzは1周期436.36サンプルなので、窓だけでは半周期未満。既存の正規化相関（overlapの4サンプル刻み）とsource期待位置への小さな罰則では、類似した低域波形を区別しにくい。
- 同じN=256の実合成窓・同じhop=64を保持。接続探索の**照合証拠**として約28msを上限とした長めの原音波形を追加する。ユーザー指定Nの黙った拡張ではない。
- **失敗した初案は撤回**：次の入力位置を `prev+hop/stretch` に拘束すると、波形自体が時間方向に伸縮して低音110Hz→約56Hz（2倍伸長）、220Hz→約330Hz（1.5倍圧縮）へ変化したことを実CI #39101856263で検出。WSOLAは本来、`prev+hop` を自然な音声位相進行の基準とし、絶対ソース時刻 `pos/stretch` との食違いを**波形の周期に沿う繰返し・飛越し**で修正する方式へ変更した。単調な源位置移動は保証しない（周期繰返しを意図的に許可）。
- 最大約22msの入力位置探索で、重複領域＋長めの同一参照を用いた正規化波形相関と**理想ソース時刻への距離**を比較する。粗探索は候補16サンプル刻み／照合点16サンプル刻み、精細探索は候補1サンプル刻み／照合点4サンプル刻み。ステレオ2chの源位置は共通。ユーザー指定の合成窓N256・hop64は変えない。
- この修正は**単一WSOLA窓列内**の精度改善。チャンクをまたぐ位相状態・低音の完全無変調、複雑なグライドの忠実度、iPhone Safari実機性能まで証明しない。

## 受入テストと境界
- Unit: Fs=48k,N=256の110Hz低音、220Hz、低音グライド/高音/ノイズ/衝撃音、速度0.5×・1.5×、0半音/5半音、ステレオ逆位相比、ニュートラルの正確な原音通過、sample-rate・window設定伝搬。
- Numerical: 局所ゼロクロス音程の偏り、非有限値、音量消失、ステレオ比、実N256とN1024の差をチェック。**波形一致/音質保証をゼロクロスだけで判断しない**。
- Browser: 既存の181s・48kHz stereo・0.5×すべてのモデル開始/継続/seekとPages公開済みアセット確認を維持。実iPhoneは別の未受入条件。
- Future separate issue if persistent: 各1.5s処理区間の位相・接続誤差、信号別AM分位点、帯域別ノイズ比、long-duration CPU/latency、実音源サンプル。CI成功≠本人の楽曲を聴いた品質証明。

## 2026-10-19 new N256 attack scattering guard
- Audio Lab "256" means **256 samples**, not 256 ms. The short slider is enabled only in WSOLA and Dual (also their joint residual paths), not native PV/AM. At 48kHz N=256 is 5.333ms, hop=64 is 1.333ms.
- New joint-stereo source transient markers use source-frame RMS novelty and an explicit 35ms refractory. When WSOLA handles an onset neighbourhood, sample-grain positions share a native +hop advancement anchored to that original source attack and its exact transformed output timestamp. Outside each onset the historical pitch-protective phase-compatible source search remains unchanged; NEVER force all source hops to hop/stretch (the known failed design).
- Dual now derives its short transient carrier from the same native N WSOLA, not an independently phase-reset 256-bin vocoder; an onset-centred 32ms / long-frame footprint temporarily assigns ownership of the attack to the short carrier rather than fading two distinct STFT ghosts. Both channels receive the same source-time onset anchor. Gradual shoulder returns to the long PV signal outside the attack's analysis footprint. No silent change of 256 to 1024.
- Limitations: source RMS onset detection cannot reliably disambiguate all legato attacks under dense music, repeated drum hits closer than refractory, or a weak high-frequency attack buried beneath loud tonal content. CPU and subjective device recordings remain #2/#8; native Rust realtime and standalone PV/AM without short slider are not changed. Validate low-bass pitch, two close attacks, stereo and exact 1.5s chunk seam; don't assert perfect drum fidelity.

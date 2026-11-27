# 共通PCM往復参照 (#147)
RTR #4 R3b2bの要求に対応するATF所有の共有reader。既存のsource-timeline / source-pcm-bridge / Workletのrepeatを利用し、往復専用の時計やDSPを増設しない。
- 元PCMの半開区間[A,B)から、長さN= B-A、周期P=2(N−1)（N=1のみ1）の仮想列を定義。例えば元位置2,3,4,5なら仮想列2,3,4,5,4,3。端点を連続二重発音しない。
- createReflectedPCMSource({channels,startFrame,endFrame}) はimmutableな元PCMを参照する。sourceFrames/channelCount/read(start,count)を既存bridgeへ渡し、loopEnabled=true、loopStartFrame=0、loopEndFrame=sourceFramesとする。readは新規の要求窓だけを生成し、転送で元PCMをdetachしない。全周期を先行展開しない。
- toSourceFrame は循環する仮想座標を元の連続座標へ変換、toVirtualFrame は元座標と枝(returning)から仮想座標を復元、isReturningは戻り枝かを返す。再生の速度・位相・cache・出力時刻は既存機構が所有する。負速度も同じ仮想列を逆方向に参照。
- N=1は単一サンプルを表すのでrawではDCになる。非DC固定を要求する呼出側は局所窓/PV等の別の固定契約を使うこと。raw/PVの音響上の折返し品質・実機は別評価。
- 新規ファイルの供給契約。既存ATF UIの操作は変更しない。代表検証はreflected-pcm-source.test.mjsとreflected-pcm-source.browser.test.mjs。RTRでの実UI接続は別受入。

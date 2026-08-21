# Character VJ

<img width="3000" height="1251" alt="image" src="https://github.com/user-attachments/assets/6781625e-da27-43ef-9baf-45dc339e5c18" />

（立ち絵：ずんずんPJ公式 ずんだもん）

HWサンプラーっていうんですか？ 効果音をポン出しできるやつ、あれみたいな感じで、キャラクター出せたらおもしろいなぁとおもった次第です

画像/GIF（+ 短いSFX）を1〜8へ割り当て、BPM同期で叩けるキャラクターVJ的ななにかです

Vite + TypeScript + PixiJSで動作します

## D&D

- ステージへ画像/SFXをD&D → 全画面の割り当て画面を表示
- 上の素材を下の `1〜8` へD&Dして割り当て。画像とSFXは同じ番号に共存
- `Enter` → 現在の割り当てで確定（余った素材は無視）。`Esc` → 割り当てをキャンセル
- コントロールパネルの各 `1〜8` へ直接D&D → その番号へ即割り当て
- `IMAGES / SFX` エリアへ複数D&D → 1から順に割り当て
- `SKIP D&D ASSIGN` ON → 全画面割り当てを飛ばして自動割り当て。デフォルトOFF
- `DROP IMAGES / SHORT SFX` 表示は `Esc` で解除できます
- SFX付きスロットは割り当て画面で薄い黄色枠になる

GIF以外の画像は最適化して軽量表示されます

GIFは本番表示ではアニメーション再生します。UIサムネイルや背景の小さいコピーは軽量な静止プレビューです

## キー操作

| 操作                   | 機能                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `1〜8` / `Numpad 1〜8` | 各キューを発火（画像 + アニメーション + SFX）                           |
| `1〜8` 長押し          | 1拍ごとにAUTO発火                                                       |
| `Shift + 1〜9`         | AUTOラッチON/OFF。最大4つ                                               |
| `9` / `Numpad 9`       | 読み込み済み画像をランダムに1.5倍GRAVITY表示。常に前面、新しい9ほど手前 |
| `9` 長押し             | 毎拍ランダムGRAVITY                                                     |
| `+ / -`                | 全キャラ共通サイズ変更                                                  |
| `Shift + +/-`          | 現在キャラだけサイズ補正                                                |
| `← ↑ → ↓`              | 全キャラ共通位置変更                                                    |
| `Shift + 矢印`         | 現在キャラだけ位置補正                                                  |
| `Space`                | TAP BPM                                                                 |
| `Shift + Space`        | SYNC / 拍頭合わせ                                                       |
| `R`                    | 2小節（8拍）REC → 自動で2小節LOOP                                       |
| `Enter`                | 全アニメーション/SFX/AUTO/ラッチ/REC/LOOP/背景キャラを解除              |
| `Esc`                  | メニュー表示/非表示。D&D表示中は先にD&D表示を解除                       |

右下のミニキーボードもクリック操作できます。実キーボードを押すと対応キーが点灯します。画面上の `Shift` はトグル式です

## 1〜9の演出

`1 POP` / `2 RUSH` / `3 GHOST` / `4 IMPACT` / `5 FLIP` / `6 JUMP` / `7 SPAM` / `8 CHAOS` / `9 GRAVITY`

1～8は、Shiftで複数流そうとすると、2〜4列に並びます。9はちょっと拡大して飛んでるやつ

## コントロールパネル

- **BPM**: 30〜300。上下は1刻み。小数の直接入力/TAP算出も可
- **TAP / SYNC**: `Space` / `Shift+Space` と同じ
- **Quantize**: `OFF → 1/8拍 → 1/4拍 → 1拍 → 1小節`
- **Offset**: -300〜300ms（動画先行の法則かモニターがズレてるとき用）
- **SFX VOL**: 0〜400%、デフォルト100%。再生中にも反映
- **60 FPS LIMIT**: ONで更新を最大60fpsに制限します（めっちゃFPS出ちゃうモニター用）
- **SKIP D&D ASSIGN**: ONで全画面割り当てを飛ばして自動割り当てします
- **HIDE BACKGROUND**: ONで抽象図形/背景模様を非表示にして `#000000` にする。キャラクター系のにぎやかしレイヤーは残ります
- **REC**: 2小節分の操作を録画して自動ループする
- **ENABLE MIDI**: Web MIDIを有効化
- **FULLSCREEN**: 全画面表示

## その他の入力

- **Gamepad**: 最初の8ボタン → キュー1〜8。長押しAUTO対応
- **MIDI**: Note Onを1〜8へ循環割り当てし、Velocityを強さとして使用。Note Offで長押し解除（一応対応）
- Web MIDIはSecure Contextが必要なので、開発版ではlocalhostから開いてください

## その他のあれこれ

- SFXはD&D時にデコードし、先頭/末尾の明確な無音を自動トリムして再生
- BPMクロックは実時間基準。TAPはBPM変更のみ、SYNCで最初の拍を合わせる
- 左下に直近8件の操作ログ、右下に直近12秒のBPMグラフを表示
- 前景キャラ表示中は薄い同キャラが背景でも動き、さらに小さい背景キャラが最大24体くらい動く
- GIFはWebCodecs `ImageDecoder` でフレーム再生し、非対応環境ではnative GIFへフォールバック
- 高解像度画像、残像、背景キャラ、GIFなどはライブ時の負荷を抑えるため縮小キャッシュ/個数上限/必要時更新を使います

## 起動

```bash
npm install
npm run dev
```

## 観客スマホ Remote（WebSocket Relay）

VJ Hostの `REMOTE` → `SHOW QR` から参加受付を開き、観客のスマートフォンをリモートコントローラーとして接続できます。現在のtransportはCloudflare WebSocket Relayのみです。WebRTC、TURN、DIRECT modeはまだ含みません。

### Architecture

```text
Controller UI
  → RemoteCommand + seq
  → PartySocket（buffer disabled）
  → Hono / hono-party
  → Room PartyServer（1 room = 1 SQLite-backed Durable Object）
  → Host WebSocketTransport
  → RemoteInputAdapter
  → AppAction
  → VJApp / CueEngine
```

Cloudflare側はCueやBPM処理を持たず、検証済みRemoteCommandをControllerからHostへ転送するだけです。Controller同士へVJ操作をbroadcastしません。`RemoteTransport` interfaceを境界にしているため、将来別transportを追加しても`RemoteInputAdapter`以降は変更しない構成です。

### Security model

- Networkから`AppAction`を受け取らず、version付き`RemoteCommand`をZodでruntime validation
- 通常client messageは1 KiBまで。不正JSON、未知version、未知command、範囲外Cueを拒否
- identity、role、controllerSessionId、permissionsは認証済みWebSocket sessionからserver側で決定
- Host token、QR用joinSecret、短期session ticketを分離。Host tokenはQRへ含めない
- session ticketはURL queryへ置かずWebSocket subprotocolでUpgrade時だけ送る
- joinSecretはURL queryではなくfragmentへ格納し、JOIN成功後はControllerのaddress barから除去
- joinSecretとticketはWeb Cryptoで生成し、Durable ObjectへはSHA-256 hashだけを保存
- `CLOSE JOIN` ACK前にjoinを閉じてsecretを無効化。再OPEN時は必ずsecretをローテーション
- Controllerごとの単調増加seqをWorkerとHostの両方で検証
- Controller切断時はHostがdown中Cueへ`cue up`を生成し、hold残留を防止
- WorkerとHostの両方で約60 message/sec/controllerを上限にし、既知の`cue up`は解放優先
- Room全体は600 message/sec、active controllerは100、未期限切れsessionは200を上限にする
- Room createはIPごとに2回/分、Host ticket、JOIN、WebSocket UpgradeもRate Limiting bindingで制限し、緩いIP単位の総量制限を重ねる
- WebSocket以外のPartyServer requestはDurable Objectへ渡さず`426`で拒否
- PartySocketは`maxEnqueuedMessages: 0`かつOPEN時のみsendし、切断中の操作を再接続後に送らない
- Remote roomと全WebSocket sessionはroom作成から最大1時間とし、期限切れ時はAlarmで接続とSQLite stateを完全削除
- 本番CORSとWebSocket Originは`ALLOWED_ORIGINS`完全一致のみ。`*`は使用しない

Room作成APIは公開Frontendから利用するため、Origin制限とRate LimitだけではHost本人認証になりません。自動作成への追加防御が必要な運用では、Cloudflare TurnstileまたはAccessを別途導入してください。

### Host permissions

初期値は `CUE 1–9` のみ許可です。Hostの `AUDIENCE ALLOW` から `TAP / SYNC`、`RECORD`、`CLEAR` を追加できます。Controller UIのdisableに加え、Durable ObjectとHostでも最終検証します。

### RTT

Hostから各Controllerへ1.5秒間隔でpingし、Hostの`performance.now()`だけでWS Relay RTTを計算します。Host UIにはControllerごとの `RTT` と `One-way ~RTT/2`、Controller UIにはRTTを表示します。

### Frontend dependencies

- `partysocket`: reconnect対応WebSocket client
- `zod`: network protocol runtime validation
- `qrcode`: Host QR生成
- `@types/qrcode`: TypeScript型（development）

### Worker dependencies

- `hono`
- `hono-party`
- `partyserver`
- `zod`
- development: `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `typescript`

### New files

- `controller.html`
- `src/controller/ControllerApp.ts`
- `src/controller/ControllerConnection.ts`
- `src/controller/main.ts`
- `src/controller/style.css`
- `src/app/remote/RemoteProtocol.ts`
- `src/app/remote/RemotePermissions.ts`
- `src/app/remote/RemoteStats.ts`
- `src/app/remote/RemoteInputAdapter.ts`
- `src/app/remote/RemoteManager.ts`
- `src/app/remote/WebSocketTransport.ts`
- `remote-worker/` 以下のWorker、Room、設定、生成型、テスト
- `remote-worker/.npmrc`: Worker生成型を使い、依存package間のoptional Workers型peer差異を分離
- `.env.example`
- `tests/RemoteInputAdapter.test.ts`

### Changed files

- `src/app/types.ts`: `InputSource`へ`remote`を追加
- `src/app/VJApp.ts`: Remoteを既存`AppAction`経路へ接続
- `src/app/ui/*`、`src/style.css`: Host REMOTE、permissions、QR、RTT UI
- `vite.config.ts`: `controller.html`をmulti-page entryへ追加
- `package.json`、`package-lock.json`: Frontend依存とRemote testを追加
- `.github/workflows/deploy.yml`: 既存Pages buildへ公開Worker URLだけを渡す
- `README.md`: Remoteの構成と運用手順を追加

GitHub PagesのActions、artifact upload、Pages deploy方法は変更していません。

### Cloudflareで手動設定する項目

1. Cloudflare accountでWorkersを利用可能にする
2. `remote-worker/wrangler.jsonc` の `ALLOWED_ORIGINS` を実際のGitHub Pages Originへ設定する
   - このrepositoryの既定値は `https://tsut-ps.github.io`
   - `/character-vj-vite/` のようなpathはOriginへ含めない
   - localhostを本番値へ追加しない
3. `ratelimits` の `namespace_id`（`41001`〜`41005`）が同じaccount内の別bindingと重複しないことを確認する
4. `npx wrangler login` でdeploy先accountを選択する

Durable Object binding、SQLite migration、Rate Limiting bindingは`wrangler.jsonc`で宣言済みです。VITE環境変数やsourceへCloudflare API tokenなどのsecretを置かないでください。

### GitHubで設定する環境変数

Repositoryの `Settings` → `Secrets and variables` → `Actions` → `Variables` で次を設定します。

```text
VITE_REMOTE_BASE_URL=https://character-vj-remote.<YOUR_SUBDOMAIN>.workers.dev
```

公開URLなのでsecretではなくActions Variableです。末尾pathは付けません。既存Pages workflowのBuild stepだけがこの値をViteへ渡します。

### Local development

初回のみ両packageをinstallします。

```bash
npm install
cd remote-worker
npm install
```

Terminal 1でWorkerを起動します。`npm run dev` はlocalhost Originだけを明示許可します。

```bash
cd remote-worker
npm run dev
```

Project rootへ`.env.local`を作ります（`.env.example`をコピーできます）。

```text
VITE_REMOTE_BASE_URL=http://localhost:8787
```

Terminal 2でFrontendを起動します。

```bash
npm run dev
```

同一PCでは `http://localhost:5173/character-vj-vite/` を開きます。実機スマホでlocal frontendを試す場合はHTTPSで到達可能なOriginを用意し、その完全なOriginをWorkerの`ALLOWED_ORIGINS`へ明示追加してください。

### Worker deploy

```bash
cd remote-worker
npm run typecheck
npm test
npx wrangler deploy --dry-run
npm run deploy
```

初回deploy時に`Room`のSQLite-backed Durable Object migrationが適用されます。deploy後の`workers.dev` OriginをGitHubの`VITE_REMOTE_BASE_URL`へ設定し、Pagesを再buildします。

### Production verification

1. GitHub PagesのVJ画面を開き、既存のKeyboard、Gamepad、MIDI、D&D、SFX操作を確認
2. `REMOTE` → `SHOW QR` でACK後にQRが表示されることを確認
3. 2台以上のスマホでJOINし、Controller数と個別RTTが表示されることを確認
4. 1〜9のtap/holdで既存Cue/Hold/AUTOが動作することを確認
5. `CLOSE JOIN` 後に保存済みの古いQRから新規JOINできず、接続済みControllerは操作を継続できることを確認
6. Permissionsを変更し、Controller UIとserver-side拒否の両方が反映されることを確認
7. Cue hold中にスマホの通信を切り、Hostでholdが解放されることを確認
8. Worker logでOrigin拒否、Rate limit、予期しないexceptionがないことを確認

### Automated verification

```bash
npm run build
npm run typecheck:test
npm test
cd remote-worker
npm run typecheck
npm test
```

## ライセンス

開発の息抜きにCodexに書いてもらっただけなので、Unlicenseとします。自由に使ってOKです

そのため、使用・再配布・魔改造に関して特に許諾も不要です

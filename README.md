# md-collab

Google Apps Script（GAS）上で動く、Markdown ドキュメントの共同編集 Web アプリ。
ドキュメントは Google Drive 上の `.md` ファイルとして保存され、ステータス管理・担当者割り当て・インラインコメント（メンション／通知）・メンバー管理に加え、AI レビュー／修正反映やリポジトリ参照レビューまでをブラウザだけで行えます。

## 主な機能

- 📝 **Markdown 編集 / プレビュー** — GitHub 風スタイル、シンタックスハイライト、Mermaid 図対応
- 🗂 **フォルダ（タブ）** ごとのドキュメント整理
- 🏷 **ステータス管理** — 作成中 / レビュー中 / 作成完了（＋カスタム追加・改名・削除）、タブで絞り込み
- 👤 **担当者の割り当て** — メンバーから1名を割り当て、「自分の担当」タブで絞り込み
- 🗄 **アーカイブ** — 通常表示から隠し、アーカイブタブでのみ表示
- 💬 **インラインコメント** — 選択範囲にコメント、`@表示名` でメンション、返信・解決・再開
- 🔔 **アプリ内通知** — メンション / 返信 / 解決をベルアイコンで通知（※メール送信はしません）
- 🤖 **AI レビュー** — Claude / OpenAI / Gemini から選択して文書をレビュー。結果は履歴として保存され、`.md` でダウンロード可。観点プリセット＋追加指示に対応
- 🛠 **AI による修正反映** — レビュー指摘を AI が本文へ反映した下書きを作成 → 編集画面で**元本文との行差分**を見ながら確認・手直し → 保存（下書きは永続化され、ブラウザを閉じても再開可）
- 🔎 **リポジトリ参照レビュー** — GitHub リポジトリの実コードを文脈に取り込み、計画・設計文書が実コードと整合・実現可能かを判定（GitHub PAT 利用・読み取りのみ）
- 📥 **アップロード / ダウンロード** — ローカルの `.md` を取り込み（複数・ドラッグ&ドロップ・同名は自動リネーム）、本文やレビューを `.md` で書き出し
- ✅ **表の集計** — `<!-- 集計 -->` マーカー付きパイプ表に合否チェックボックスと集計（担当者別の合格率など）を付与
- 👥 **メンバー管理** と権限制御（ワークスペースのアクセス制限）
- 🌙 ダークモード

## 技術スタック

- **ランタイム**: Google Apps Script（Web アプリ）
- **言語 / ビルド**: TypeScript + [Vite](https://vitejs.dev/)（`gas-vite-plugin`）
- **スタイル**: Tailwind CSS v4（ビルド時にコンパイルして `index.html` へインライン）
- **クライアントライブラリ**（CDN）: marked / DOMPurify / highlight.js / Mermaid
- **外部連携**: AI プロバイダ（Claude / OpenAI / Gemini）・GitHub REST（リポジトリ参照レビュー）
- **パッケージマネージャ**: [Bun](https://bun.sh/)
- **デプロイ**: [clasp](https://github.com/google/clasp)

## アーキテクチャ概要

```
ブラウザ (static/index.html のインラインJS)
   │  google.script.run
   ▼
GAS サーバ (src/Code.ts)
   ├─ ドキュメント本体 …… Google Drive 上の .md ファイル
   ├─ メタデータ／DB  …… Google スプレッドシート（threads / comments / members /
   │                      notifications / folders / statuses / doc_meta /
   │                      reviews / revisions シート）
   ├─ 秘密情報        …… PropertiesService（AI APIキー・GitHub PAT を利用者ごとに保管）
   └─ 外部 API        …… AI プロバイダ（Claude / OpenAI / Gemini）・GitHub REST
```

- サーバの公開 API は `src/Code.ts` で実装し、`src/main.ts` から re-export（GAS のエントリ）。
- フロントエンドは `static/index.html` 内のインラインスクリプト。
- 速度対策として、小さく変更頻度の低いデータ（members / statuses / doc_meta）は `CacheService` に、DB スプレッドシート ID 等は `PropertiesService` にキャッシュしています（書き込み時に無効化）。

### データモデル

ドキュメント本体は Drive 上の `.md` ファイル、それ以外のメタデータは 1 つのスプレッドシート（`md-collab-db`）の各シートに、**ヘッダ行なし**で 1 行 1 レコードとして保存します（列定義は `src/config.ts`）。

| シート | 1 行の意味 | 主な列 |
|---|---|---|
| `folders` | フォルダ（タブ） | id / 名前 / Drive フォルダ ID / 作成日時 / 作成者 |
| `doc_meta` | ドキュメントのメタ情報 | ドキュメント ID（Drive ファイル ID）/ ステータス ID / アーカイブ / 担当者メール |
| `statuses` | カスタムステータス | id / ラベル / 並び順 |
| `threads` | コメントスレッド（アンカー） | スレッド ID / ドキュメント ID / 選択テキスト・前後文脈 / open\|resolved / 作成・解決情報 |
| `comments` | スレッド内のコメント | コメント ID / スレッド ID / 本文 / 投稿者 / メンション / 日時 / 削除フラグ |
| `members` | ワークスペースのメンバー | メール / 表示名 / 追加日時 / 追加者 |
| `notifications` | アプリ内通知 | id / 宛先 / 種別 / スレッド・コメント・ドキュメント ID / 既読 / 日時 / メッセージ |
| `reviews` | 保存された AI レビュー（履歴・新しい順） | id / ドキュメント ID / プロバイダ / モデル / 本文 / 作成者 / 日時 |
| `revisions` | 未保存の AI 修正ドラフト（ドキュメント×利用者で 1 件） | ドキュメント ID / 利用者 / 本文 / 生成時の lastUpdated / プロバイダ / モデル / 日時 |

補足:

- `doc_meta` の行はステータス等を変更したときに初めて作成されます。行が無いドキュメントは「先頭のステータス・未アーカイブ・未割り当て」として扱われます。
- ステータスを削除しても各ドキュメントの再書き込みは行わず、参照先が消えたものは読み取り時に先頭ステータスへフォールバックします。
- コメント本文中のメンションは `@メールアドレス`（照合・通知に安定）で保存し、画面表示・入力時のみ `@表示名` に変換します。
- アーカイブはステータスとは独立したフラグで、元のステータスを保持したまま一覧から隠せます。

### セキュリティ / 認可モデル

- **アクセス制御**: すべての公開 API は冒頭で `requireMember()` を通します。メンバー未登録の間は誰でも許可（ブートストラップ）、登録後はメンバーとデプロイ者のみ許可します。
- **IDOR 対策**: ドキュメントは `getManagedFile()` を介し、ワークスペース管理下のフォルダに属するファイルのみ読み書きできます（任意の Drive ファイル ID を渡しての操作を防止）。
- **排他制御**: スプレッドシートにトランザクションが無いため、すべての書き込みは `LockService`（`withLock`）で直列化します。
- **競合検知**: ドキュメント保存は `expectedLastUpdated` で楽観ロックし、他者の更新を検知したら上書きか再読込をユーザーに選ばせます。
- **XSS 対策**: Markdown は DOMPurify でサニタイズし、ユーザー入力（コメント・メンバー名・通知文など）は `innerHTML` 前に必ずエスケープします。Mermaid は `securityLevel: 'strict'` で描画します。
- **編集権限**: コメントの編集・削除は投稿者本人（またはデプロイ者）のみ可能です。
- **秘密情報**: AI APIキー・GitHub PAT は `PropertiesService` に**利用者ごと（メールで名前空間化）**で保管し、**クライアントへは一切返しません**（存在の有無のみ返す）。共有 PAT と対象リポジトリの設定はデプロイ者（オーナー）のみ変更できます。リポジトリ参照レビューでは、GitHub PAT は GAS→GitHub の取得にのみ使い AI には渡しません（取得したファイル内容は選択中の AI プロバイダにプロンプトとして送られます）。

### AI レビュー / リポジトリ参照

- **プロバイダ**: Claude / OpenAI / Gemini を利用者ごとに選択。APIキーとモデルは利用者ごとに保管し、設定画面の「取得」で利用可能なモデル一覧を引けます。レビュー結果は `reviews` シートに履歴として保存され（新しい順）、`.md` でダウンロードできます。
- **AI による修正反映**: レビュー指摘を反映した改訂版を AI が生成 →（永続化された）下書きとして編集画面に読み込み、**元本文との行差分**を見ながら確認・手直し → 通常の保存経路（楽観ロック）で確定。下書きは `revisions` シートに保持され、ブラウザを閉じても再開できます。
- **リポジトリ参照レビュー**: 対象 GitHub リポジトリの**ファイルツリーと主要ファイルの中身を GAS が GitHub REST 経由で取得し、プロンプトに文脈として注入**して 1 回の通常呼び出しでレビューします。
  - 当初は Anthropic の MCP コネクタ（モデルがリポを自律巡回）で実装しましたが、GAS の 6 分同期実行上限に対しエージェントループが長すぎタイムアウトしたため、REST で文脈を組み立てる方式に切り替えました。これにより全プロバイダで動作し、PAT は GAS→GitHub のみで AI には渡りません。
  - **ファイル選定は適応的**: 候補が予算（既定 40 ファイル / 12 万字）に収まればすべて投入、超える大規模リポではモデルにツリーを見せて読むべきパスを選ばせます（実在パスのみ採用）。
  - レビュー末尾に**参照したファイル一覧**（選定方式・件数・予算到達の有無）を必ず付与し、何を AI に渡したかを可視化します。
  - **GitHub PAT** は利用者ごとを基本とし、オーナーが設定する共有 PAT へフォールバックします。対象リポジトリはワークスペース既定＋レビュー時の上書きに対応。**read-only・対象リポ限定の fine-grained PAT** を推奨します。

### ビルドパイプライン

`bun run build` で以下を順に実行します。

1. `vite build` … `src/main.ts` を `dist/Code.js` にバンドル
2. `tailwindcss` … `src/tailwind.css` を `dist/.tw.css` にコンパイル
3. `scripts/inline-css.ts` … `static/index.html` の `<!--TAILWIND_CSS-->` を `<style>` として差し込み、`dist/index.html` を生成（`.tw.css` は削除）

`dist/` は成果物なので git 管理外です。clasp は `dist/` の中身だけを Apps Script に push します（`.clasp.json` の `rootDir`、および `.claspignore` で制御）。

## セットアップ

### 必要なもの

- [Bun](https://bun.sh/)
- Google アカウント（Apps Script を作成・デプロイできる権限）
- clasp（devDependency に含まれ、`bun run` スクリプト経由で実行します）

### 手順

```bash
# 1. 依存をインストール
bun install

# 2. clasp にログイン
bun run clasp:login

# 3a. 新規に Apps Script プロジェクトを作る場合
bun run clasp:create     # standalone プロジェクトを作成し .clasp.json を生成

# 3b. 既存の Apps Script を使う場合
cp .clasp.json.example .clasp.json
#    → .clasp.json の scriptId を自分のものに書き換える

# 4. ビルドして push
bun run push             # = bun run build && clasp push
```

> **Note**: `.clasp.json` は `scriptId` を含むため git 管理外です。各自で用意してください（`.clasp.json.example` をコピー）。

### デプロイ（Web アプリ公開）

Apps Script エディタ（`bun run clasp:open` で開けます）、または clasp の deploy コマンドから Web アプリとしてデプロイします。
公開設定（`static/appsscript.json` で定義）は次の通りです。

- **実行ユーザー**: デプロイした本人（`USER_DEPLOYING`）
- **アクセスできるユーザー**: 同一ドメイン（`DOMAIN`）

> 最初にアクセスしたユーザーは、メンバーが1人も登録されていない間は全員許可（ブートストラップ）されます。メンバーを登録すると、以後はメンバー（とデプロイ者）のみアクセス可能になります。

## 開発

```bash
bun run dev        # vite build --watch（CSS の再インラインは含まれないので注意）
bun run build      # 本番ビルド（CSS インラインまで実施。push 前に必須）
bun run push       # build + clasp push
bun run clasp:open # Apps Script エディタを開く
```

### 依存関係のバージョン方針

`package.json` のバージョンは手書きせず、必ず `bun add` / `bun add -d` で追加・更新してください。

## ディレクトリ構成

```
.
├── src/
│   ├── Code.ts          # GAS サーバ実装（API・認可・Drive/Sheets アクセス・キャッシュ）
│   ├── main.ts          # GAS エントリ（Code.ts の re-export）
│   ├── config.ts        # シート名・列定義・デフォルト値
│   ├── types.ts         # 共有型
│   └── tailwind.css     # Tailwind v4 エントリ
├── static/
│   ├── index.html       # フロントエンド（インラインJS／Tailwind 差し込み先）
│   └── appsscript.json  # GAS マニフェスト（スコープ・Web アプリ設定）
├── scripts/
│   └── inline-css.ts    # ビルド後処理（CSS インライン）
├── dist/                # ビルド成果物（git 管理外・clasp の push 対象）
├── .clasp.json.example  # clasp 設定テンプレート
└── vite.config.ts
```

## ライセンス

[MIT License](LICENSE) © 2026 plzsave

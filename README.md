# md-collab

Google Apps Script（GAS）上で動く、Markdown ドキュメントの共同編集 Web アプリ。
ドキュメントは Google Drive 上の `.md` ファイルとして保存され、ステータス管理・担当者割り当て・インラインコメント（メンション／通知）・メンバー管理などをブラウザだけで行えます。

## 主な機能

- 📝 **Markdown 編集 / プレビュー** — GitHub 風スタイル、シンタックスハイライト、Mermaid 図対応
- 🗂 **フォルダ（タブ）** ごとのドキュメント整理
- 🏷 **ステータス管理** — 作成中 / レビュー中 / 作成完了（＋カスタム追加・改名・削除）、タブで絞り込み
- 👤 **担当者の割り当て** — メンバーから1名を割り当て、「自分の担当」タブで絞り込み
- 🗄 **アーカイブ** — 通常表示から隠し、アーカイブタブでのみ表示
- 💬 **インラインコメント** — 選択範囲にコメント、`@表示名` でメンション、返信・解決・再開
- 🔔 **アプリ内通知** — メンション / 返信 / 解決をベルアイコンで通知（※メール送信はしません）
- 👥 **メンバー管理** と権限制御（ワークスペースのアクセス制限）
- 🌙 ダークモード

## 技術スタック

- **ランタイム**: Google Apps Script（Web アプリ）
- **言語 / ビルド**: TypeScript + [Vite](https://vitejs.dev/)（`gas-vite-plugin`）
- **スタイル**: Tailwind CSS v4（ビルド時にコンパイルして `index.html` へインライン）
- **クライアントライブラリ**（CDN）: marked / DOMPurify / highlight.js / Mermaid
- **パッケージマネージャ**: [Bun](https://bun.sh/)
- **デプロイ**: [clasp](https://github.com/google/clasp)

## アーキテクチャ概要

```
ブラウザ (static/index.html のインラインJS)
   │  google.script.run
   ▼
GAS サーバ (src/Code.ts)
   ├─ ドキュメント本体 …… Google Drive 上の .md ファイル
   └─ メタデータ／DB  …… Google スプレッドシート（threads / comments / members /
                          notifications / folders / statuses / doc_meta シート）
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

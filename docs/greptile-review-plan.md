# 次期開発計画: リポジトリ索引型 AI レビュー（Greptile）

> ステータス: **未着手 / 設計段階**
> 前提: 現行の Gemini レビュー機能（PR #1, `feat/gemini-review`）がマージ済みであること。
> このドキュメントは後から AI（または人）が実装に着手できるよう、背景・API・統合設計・未決事項を1か所にまとめたもの。

## 1. 背景と目的

現行の AI レビュー（Gemini）は **ドキュメント本文だけ** を LLM に渡す単発レビュー。
技術文書の多くは「リポジトリの実装」と整合していることが重要なので、**GitHub リポジトリ全体を文脈に含めたレビュー**を行いたい。

採用候補として [Greptile](https://www.greptile.com/) を選定（検討経緯は §6）。Greptile はリポジトリをグラフ索引化し、diff だけでなく呼び出し元・共有モジュール・内部 API まで踏まえて回答する。REST API（Genius API）が公開されており、GAS の `UrlFetchApp` から叩ける。

**ゴール**: エディタでドキュメントを開き「リポジトリ参照レビュー」を押すと、紐付けたリポジトリの実装を文脈に、ドキュメントとコードの整合性・齟齬を指摘するレビューが返る。

## 2. 採用 API の概要（要・公式ドキュメント再確認）

> ⚠️ 下記は調査時点（2026-06）の検索ベース要約。実装前に必ず公式（https://docs.greptile.com/ , https://www.greptile.com/docs/api-reference ）で最新仕様を確認すること。Gemini 同様、API は変わりうる。

- ベース URL: `https://api.greptile.com/v2/`
- 認証ヘッダ: `Authorization: Bearer <GREPTILE_API_KEY>` ＋ `X-GitHub-Token: <GitHub PAT>`（リポジトリ取得用）
- **索引作成（一度）**: `POST /repositories`
  body 例: `{ "remote": "github", "repository": "owner/repo", "branch": "main" }`
- **索引状態確認**: `GET /repositories/{id}`（`id` は `remote:branch:owner/repository` を URL エンコード）
- **問い合わせ（毎回）**: `POST /query`（OpenAI chat 形式の `messages` 配列）→ 回答＋関連ファイル/関数
- 課金: Genius API $0.45/リクエスト、または Pro $30/user/月（要・最新確認）

## 3. 現行アーキテクチャとのギャップ（実装より先に決めること）

現行 Gemini 機能は「メンバー各自が無料キーを登録／本文送信はオプトイン」という設計（`build-and-security-model` メモリ参照）。Greptile は前提が変わるため、**実装着手前に以下を確定する**こと。

1. **資格情報の粒度**: Greptile APIキー＋GitHub PAT をメンバー個別に持たせるか、**ワークスペース共通**にするか。
   - 索引は共有資源なので **ワークスペース共通が自然**（推奨）。→ 現行の「各自キー（メール名前空間）」とは別の保存場所が要る。
2. **課金主体**: 「各自が無料Geminiキー」→「ワークスペースがGreptileに課金」。誰が払うか。
3. **プライバシー**: Greptile は **リポジトリを自社サーバに索引・保持** する（Gitingest のメモリ処理・非保持とは異なる）。コードベースを外部索引に預けることの承認。現行のオプトイン方針との整合。
4. **リポジトリ紐付けの粒度**: ワークスペース単位／フォルダ単位／ドキュメント単位のいずれか。

> 補足: 上記が重すぎる場合の軽量代替として **Gitingest**（`github.com`→`gitingest.com` でリポジトリをLLM向けテキスト化、`UrlFetchApp` で取得してプロンプトに同梱、OSSで自前ホスト可）も検討した。プライバシー要件が厳しい／既存コード最小改修を優先するなら Gitingest 案に切り替える判断もあり（§6）。

## 4. 統合設計（案）

現行 `reviewDocument`（単発）と違い **索引（一度）→ 問い合わせ（毎回）** の2段階。

```
[設定UI] 対象リポジトリ(owner/repo, branch) と Greptile APIキー・GitHub PAT を登録（ワークスペース共通を推奨）
   │
   ▼
[索引キック] POST /repositories  ── GASの6分制限を避けるため同期待ちしない
   │             （別コール GET /repositories/{id} で完了をポーリング/状態表示）
   ▼
[レビュー] reviewDocument を POST /query に差し替え
   messages = [{role:"user", content:"次のドキュメントをリポジトリ実装と照合してレビュー: <本文>"}]
   → 回答 + 根拠ファイルを受け取り Markdown 表示
```

### バックエンド（`src/Code.ts`）に追加する想定の関数
- `getRepoReviewSettings()` → 索引対象リポジトリ・キー登録状態（キー本体は返さない）
- `saveRepoReviewSettings(repo, branch, greptileKey, githubToken)` → ワークスペース設定として保存
- `indexRepository()` → `POST /repositories` をキック
- `getIndexStatus()` → `GET /repositories/{id}` で索引状態
- `reviewDocumentWithRepo(fileId, instructions)` → `getManagedFile` で対象検証後 `POST /query`

### フロント（`static/index.html`）
- 設定モーダルに「リポジトリ参照レビュー」セクション（リポジトリ/ブランチ/キー、索引状態表示・再索引ボタン）
- レビュー結果モーダルを再利用、または「リポジトリ参照」トグルを追加

### マニフェスト
- `UrlFetchApp` は既存（Gemini）で導入済みのため追加スコープ不要の見込み。要確認。

## 5. リスク・制約

- **GASの実行時間6分**: 索引は非同期キック＋ポーリングで回避。query は比較的軽い。
- **GitHub PAT の取り扱い**: トークン保管はキーと同等に厳重に（クライアントへ返さない、ScriptProperties保存、最小スコープのPAT）。
- **コスト暴走**: query 回数に課金。連打防止（ボタン無効化）やレート制御を入れる。
- **索引の鮮度**: リポジトリ更新後は再索引が必要。ブランチ/コミット固定の運用方針を決める。
- **API変動**: モデル名・エンドポイントは変わりうる前提で、設定で上書き可能にする（Gemini 機能と同方針）。

## 6. 検討した代替案（記録）

| 方向 | 代表 | 長所 | 短所 |
|---|---|---|---|
| リポジトリをテキスト化して同梱 | [Gitingest](https://gitingest.com/) / [Repomix](https://repomix.com/) | 既存コード最小改修、LLM自由、自前ホストで非保持運用可 | リポジトリ全体はトークン超過しがち、対象を絞る必要、スナップショットが静的 |
| **リポジトリ全体をAPIで索引参照（採用）** | [Greptile Genius API](https://www.greptile.com/pricing) | 呼び出し元/共有モジュールまで文脈込みで深い | 有料・チーム課金、外部索引保持、キー/課金/プライバシーモデルの作り替え |
| GitHub連携PRレビューBot | CodeRabbit / Copilot / OpenAI Codex | リポジトリ文脈で強力、運用が楽 | エディタ内ではなくPRベースの別ワークフロー |

## 7. 着手時の最初のステップ

1. §3 の4つの未決事項を確定（特に資格情報の粒度・課金・プライバシー承認）。
2. 公式ドキュメントで §2 の API 仕様を再確認（特に `/query` の request/response 形）。
3. 別ブランチ `feat/greptile-review` を切る。
4. バックエンドの設定保存＋索引キック＋query を実装 → 型チェック → `bun run push` で実機確認。

## 参考リンク

- Greptile: https://www.greptile.com/ / API Ref: https://www.greptile.com/docs/api-reference / Docs: https://docs.greptile.com/
- Gitingest: https://gitingest.com/ （OSS: https://github.com/coderamp-labs/gitingest ）
- Repomix: https://repomix.com/
- ai-review（マルチプロバイダOSS）: https://github.com/Nikita-Filonov/ai-review

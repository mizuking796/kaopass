# KaoPass（顔パス認証）リファレンス

## 概要

顔貌認証 + 表情シーケンス + 筋肉パターン照合（ブレンドシェイプバイオメトリクス）の多層認証デモアプリ。
全処理がクライアント完結（サーバーなし）で、登録データはIndexedDBに保存。
バニラJS / 静的HTML / ダークテーマの構成。

- **URL**: https://mizuking796.github.io/kaopass/
- **GitHub**: mizuking796/kaopass
- **ソース**: /Users/mizukishirai/claude/services/kaopass/

---

## 技術スタック

| 技術 | 用途 |
|------|------|
| **MediaPipe Face Landmarker** (@mediapipe/tasks-vision@0.10.18) | 478ランドマーク + 52ブレンドシェイプ + 虹彩追跡。ESM dynamic import |
| **@vladmandic/face-api@1.7.14** | 128次元顔特徴ベクトル抽出・照合 |
| **IndexedDB (KaoDB)** | faces, expressions, settings の3ストア |
| **CSS Variables** | ダークテーマ |

---

## ファイル構成（総計2,282行）

```
kaopass/
├── index.html                 (272行) SPA エントリ、全7画面
├── css/
│   └── style.css              (572行) ダークテーマ、CSS Variables
├── js/
│   ├── app.js                 (923行) 状態マシン、全画面ロジック
│   ├── face-engine.js         (148行) MediaPipe + face-api.js ラッパー
│   ├── expression-detector.js (275行) 表情分類・視線・深度・バイオメトリクス
│   └── db.js                  (92行)  IndexedDB CRUD
└── assets/
    └── expressions/           (10 SVGアイコン)
```

---

## 画面フロー（7画面）

```
consent → tutorial(3スライド) → register_face(5アングル) → register_expression(選択)
→ register_recording(録画) → auth_face → auth_expression → auth_success
```

1. **consent**: 同意画面
2. **tutorial**: 3スライドのチュートリアル
3. **register_face**: 5アングルで顔を登録（正面・左・右・上・下）
4. **register_expression**: 表情シーケンスの選択
5. **register_recording**: 選択した表情シーケンスの録画
6. **auth_face**: 顔貌認証
7. **auth_expression**: 表情シーケンス認証 → **auth_success**

---

## 表情6種

| ID | 日本語名 | 表情 |
|----|---------|------|
| smile | 笑顔 | 笑顔 |
| mouth_open | 口開け | 口を開ける |
| kiss | キス | キスの口 |
| wink_left | 左ウィンク | 左目ウィンク |
| wink_right | 右ウィンク | 右目ウィンク |
| brow_raise | 眉上げ | 眉を上げる |

---

## セキュリティ機能

### 1. 顔貌認証（128次元）
- face-api.js SSD MobileNet + FaceRecognitionNet
- 128次元顔特徴ベクトルによるユークリッド距離照合
- 閾値: 0.6

### 2. 常時顔照合
- 表情認証中も1.5秒ごとにface-api.jsで顔を再照合
- 認証中の別人入れ替えを検出
- `FACE_RECHECK_INTERVAL = 1500`（ms）
- `FACE_RECHECK_THRESHOLD = 0.45`

### 3. 表情バイオメトリクス
- 登録時に52次元ブレンドシェイプベクトルを保存
- 認証時にコサイン類似度で照合
- `EXPR_BIOMETRIC_WEIGHT = 0.3`（配合比率）

### 4. Z深度アンチスプーフィング
- 鼻先と耳のZ座標差で写真/画面による攻撃を検出

### 5. 30秒タイムアウト
- 顔認証 + 表情認証の合計30秒制限
- `AUTH_TIMEOUT_MS = 30000`

### 6. クールダウン
- 3回失敗 → 10秒待機
- 5回失敗 → 30秒待機

---

## 調整可能な定数（app.js上部）

| 定数名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `ANGLE_HOLD_MS` | 300 | 顔登録のアングル保持時間（ms） |
| `RECORDING_HOLD_MS` | 500 | 表情録画の保持時間（ms） |
| `RECORDING_MIN_PCT` | 30 | 表情一致最低%（下回ると不合格） |
| `RECORDING_STABLE_RANGE` | 20 | 安定判定の変動許容幅 |
| `FACE_RECHECK_INTERVAL` | 1500 | 常時顔照合の間隔（ms） |
| `FACE_RECHECK_THRESHOLD` | 0.45 | 顔照合の閾値（ユークリッド距離） |
| `EXPR_BIOMETRIC_WEIGHT` | 0.3 | バイオメトリクスの配合比率 |
| `AUTH_TIMEOUT_MS` | 30000 | 認証タイムアウト（ms） |

---

## IndexedDB スキーマ（KaoDB）

### faces ストア
- 顔登録データ（128次元特徴ベクトル、5アングル分）

### expressions ストア
- 表情シーケンス（選択順序 + 52次元ブレンドシェイプベクトル）

### settings ストア
- アプリ設定

---

## 構築履歴

| 日付 | 内容 |
|------|------|
| 2026-02-15 | Phase 1 全機能構築（同意/チュートリアル/顔登録/表情登録/認証フロー） |
| 2026-02-15 | 表情6種に変更、カメラ目線オーバーレイ、上下感度改善 |
| 2026-02-15 | 常時顔照合（表情認証中の顔再照合）実装 |
| 2026-02-15 | 表情バイオメトリクス（52次元ブレンドシェイプベクトル照合）実装 |
| 2026-02-15 | 視線方向機能削除、表情のみのシンプルUIに |
| 2026-02-15 | 30秒タイムアウト追加 |
| 2026-02-15 | GitHub Pages公開 |

---

## デプロイ

- GitHub Pagesで公開（mainブランチ直接）
- **更新時はgit pushまで実施すること**

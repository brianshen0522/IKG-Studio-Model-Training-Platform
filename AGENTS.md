# AGENTS.md — 本專案 coding agent 規範

任何 coding agent（opencode 等）在本 repo 工作都必須遵守以下規範。

## 權威來源
- **程式碼本身是權威**。`dev_docs/`（原本的 `full/01`–`19` 設計規格、IMPLEMENTATION_PLAN、DEVELOPMENT_WORKFLOW、HANDOVER）已於 2026-07-31 整個移除——內容嚴重落後於實作，反覆誤導 agent 往錯的方向做。**不要嘗試還原或參照它們。**
- 這份 `AGENTS.md` 與 `CLAUDE.md` 是唯一的敘述性權威；其餘一切以 DB schema（`database/migrations/`）、型別（`packages/shared-types`）與實際程式碼為準。
- 原始碼註解裡形如 `doc 08 §12`、`doc 11 §26.1` 的引用指向那批已刪除的文件。**當成歷史出處看待即可，不要去找**——註解本文已說明意圖，程式碼才是現況。
- 部署細節：`deploy/README.md`（平台 / GPU / TLS / day-2 ops）。
- 規格與實作衝突時，以實作 + 使用者當下的決定為準。例如 `Unclassified` dataset type 原規格寫「系統內建、不可刪除」，實際已於 `003` 移除且不再重建。

## 指令與環境
- **Node 22**（`.nvmrc`）、**pnpm 9.15.0**。根目錄 `pnpm install`。`.npmrc` 開 `shamefully-hoist=true`。
- 開發：`pnpm dev`（turbo 跑 web/api/scheduler，皆 persistent）。全域 build / typecheck：`pnpm build` / `pnpm typecheck`。單包：`pnpm --filter @model-trainer/<pkg> <task>`（workspace 名：`api`、`web`、`scheduler`、`db`、`shared-types`、`api-client`）。
- **`lint` == `typecheck` == `tsc --noEmit`**（全 repo 無 ESLint）。二者等價；別預期 lint 報 style 警告。Prettier 設定見 `.prettierrc`。
- **無單元 / 整合測試框架**（沒有 `pnpm test`）。唯一測試是 `qa/` 的 Playwright 瀏覽器 smoke：`node qa/run.mjs`（預設打 dev stack `http://localhost:8080`、admin/admin，需 stack 已起；路徑用 `QA_DATA_ROOT` 覆寫）。腳本可重跑：dataset type / user / source dataset 會沿用既有的，只有 training dataset / job / run 帶時間戳。`qa/allengines.sh` 用 `deploy/docker-compose.qa.yml` 逐引擎（chromium/firefox/webkit）各跑一份、每引擎重建 DB，並改打 QA stack 的 8088。改動後驗證主要靠 typecheck + qa smoke。
- Migration：`pnpm --filter @model-trainer/db migrate`（=`tsx src/migrate.ts`）。連線用 `POSTGRES_MIGRATION_USER`/`POSTGRES_MIGRATION_PASSWORD`（migration 用的 superuser/owner role，非 app role）；以**完整檔名**記於 `app.schema_migrations`，可安全重跑。
- **Schema 是單一 baseline**：`database/migrations/001_initial_schema.sql`（extensions → types/tables/indexes/triggers → seed → roles/grants）。系統從未部署過，原本 55 個開發期 migration 有大量自我抵銷的步驟，已合併成這一個檔案。**往後的變更一律新增 `002_`、`003_`… 增量檔，不改 `001`。** 由 node-pg 執行，因此檔內不得出現 psql 反斜線指令（`\restrict` 等）。
- Bootstrap admin（一次性、idempotent）：`scripts/create-admin.ts`，需 `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`。

## 工作區邊界（非直觀處）
- **Dataset 只有兩種**：`source_datasets`（DM archive 來的唯讀來源）與 `training_datasets`（訓練 / benchmark 唯一能指向的東西）。`datasets` 與 `dataset_versions` 兩張表都已不存在。`training_datasets.origin` 決定它怎麼來的：`BUILT`（由 source datasets 合併 + split + 產 data.yaml）或 `REGISTERED`（指向已備好的 YOLO 目錄，只驗證不重建）。兩者都由使用者 `POST /training-datasets/:id/submit` 觸發，**沒有任何輪詢**。
- **路徑歸屬**：訓練資料集（不論 origin）一律在 `dataset_types.training_dataset_path` 底下；`dataset_types.model_path` **只放模型檔**。別再讓 dataset 解析到 model root——開發期一度誤植成 model root，三個 worker 都要用 `training_dataset_path`。
- **Root 重疊規則（三個 root 共用一條原則：最深的 root 擁有該路徑）**。共用工具在 `apps/api/src/common/roots.ts`。
  - `model_path` **完全不得重疊**（相同／包含／被包含皆擋）。它是遞迴掃描 + 自動註冊的，外層 type 會把深層 type 的 `.pt` 再註冊一份。API 在 create 與**變更 model_path** 時擋（`assertModelRootNotNested`）；`ModelScanner` 走到巢狀 root 直接跳過整個 subtree。既有重複已由 migration `004` 清除。
  - `training_dataset_path` **允許巢狀**（現況 Card 的 `/training-datasets` 就包著 QA Dice 的 `/training-datasets/qa`），但深層 root 的內容歸深層 type：`BrowseService` 把別的 type 的 root 從 `folders` 抽出來放進 `delegated`（前端顯示為鎖住不可選），`TrainingDatasetsService.assertNotInsideAnotherTypesRoot` 擋掉直接輸入的 `relative_path`。
  - `dataset_path` 同樣走 browse 的 `delegated` 規則；它只列候選、由使用者按 `Register & scan`，不會自動註冊。
  - 只在該欄位**真的變更**時才驗證，否則既有重疊會讓改名、改顏色之類的無關編輯全部失敗。
- **Service 對應不是一個 worker 一個任務**：`training-worker` 跑**訓練 + benchmark**；`dataset-worker` 跑**scan/build + model-ingest + registered dataset 驗證**。沒有獨立 benchmark / model-ingest 服務。`workers/common` 為 Python 共用 lib。
- `apps/scheduler` 是 **Node/TS**（非 Python），重用 `packages/db` + `shared-types`；純 DB 編排、不跑 ML。
- `packages/api-client` 與其他 lib 不同：`main`/`types` 直接指向 **`src/index.ts`**（免 build），僅 web 消費。

## 基礎設施 / 本地開發
- 全棧（3 app + workers + postgres/redis/minio/nginx + tls-proxy）跑 Docker：`cd deploy && ./up.sh up -d --build`（wrapper：展開 `DATA_ROOT` 成 bind mount、自動偵測 GPU 疊 `docker-compose.gpu.yml`；**一律用 `up.sh`，不要直接呼叫 `docker compose`**，靜態 compose 檔沒有掛載規則）。強制 CPU：`DEPLOY_FORCE_CPU=1 ./up.sh up -d --build`。
- `web` 已無對外 port，唯一對外容器是 `tls-proxy`（TLS termination + HTTP/2，自簽憑證，見 `deploy/README.md` §7）。
- `migrate` 與 `bootstrap` 是 one-shot 服務，**每次 `up` 自動跑**，皆 idempotent，重跑無害。
- **新增 migration 檔後必須先 build 再 recreate**：`./up.sh build migrate && ./up.sh up -d --force-recreate migrate`。migrate 是從 `Dockerfile.api` 把 `database/migrations/` **COPY 進 image**（不是 bind mount），只 `--force-recreate` 會拿舊 image 重跑，log 仍印 `All migrations applied` 但新檔根本不在容器裡。以 `app.schema_migrations` 的內容為準，不要相信那行 log。
- 設定：`cp deploy/env.example deploy/.env`，填滿所有 `CHANGE_ME_*`；`DATA_ROOT` 取代舊的四個路徑變數（可逗號分隔多路徑）。所有服務讀同一份 `.env`。
- 5 個 least-privilege DB role（migration / backend / worker / scheduler / readonly，於 `001_initial_schema.sql` 尾段建立）；per-service 密碼由 `scripts/set-db-roles.ts` 在 `migrate` 階段注入。
- 本機裸跑單一 app（非 Docker）需先有 postgres/redis/minio 可連，env 指過去。

## 不可違反的鐵則
1. **禁止 Mock Data**：正式頁面 / API / Worker 一律用真實資料與真實後端；不得用 Timer 假裝進度或狀態。
2. **Source Dataset 唯讀**：不得改寫 / 移動 / 刪除來源檔，不得在來源路徑產生 split 或 data.yaml，禁 Symlink。
3. **Artifact 不可變**：只能由系統建立；不可修改 / 改名 / 覆蓋 / 由使用者刪除。Binary 存 MinIO，PG 只存 metadata。
4. **Audit append-only**：只能 INSERT/SELECT；任何 role（含 Admin）不可 UPDATE/DELETE（三層保護：DB 權限 + Trigger + Service）。
5. **best.pt 雙存**：MinIO（不可變 Artifact）+ Model Root（正式模型）；**last.pt 不保留、不建 Artifact、訓練後刪除**。
6. **PostgreSQL 為真相來源**：Redis 只是 Queue/協調/快取，可清空重建。
7. **前端不碰基礎設施**：不直接存取 PostgreSQL/Redis/MinIO，不用 MinIO credential，不讀 server path；權限僅 UX，Backend 為授權權威；狀態語意來自 API Enum，不從顯示字串推斷。
8. **跨服務一致性**：狀態轉換用條件式 Update（帶前置狀態）；長任務走 Queue+Worker；用 Outbox + Idempotency + Reconciliation。

## 技術棧（不得擅自更換）
- 後端 NestJS + Kysely + **手寫 SQL migration**（不用 ORM auto-sync）。
- 前端 Vite + React + TS + TanStack Query + Zustand。
- 共用型別 / 驗證 Zod（`packages/shared-types`）。
- Queue：Redis Streams。Scheduler：Node/TS。Monorepo：pnpm + Turborepo。Python worker：uv。
- 第一階段 Task Type 只做 **OBB + DETECT**（schema 保留五種）。

引入任何新套件或偏離上述，需先說明理由，不得默默改動。

## 執行期慣例（實作已定，勿違反）
- **DB 注入**：`DB_PROVIDER` 提供 `Kysely<Database>`（直接 `db.insertInto/selectFrom/...`）；`DB_INSTANCE` 才是 `{ db, pool }`（僅關閉 pool 用）。
- **時間戳是字串**：`createDb` 已設 pg type parser 讓 TIMESTAMP/TIMESTAMPTZ 回傳字串（對應 `Generated<string>`）；勿假設是 `Date`；比較時間戳用字串相等或先 `new Date().getTime()`。
- **Schema / search_path**：所有表在 `app` schema，連線已設 `search_path=app,public`，Kysely 用未加 schema 的表名即可（`gen_random_uuid` 等在 public）。
- **Lib 產物**：`packages/*` 編成 dist、main/types 指向 dist；改 `shared-types`/`db` 後要先 build 再 typecheck/run api（`pnpm --filter "@model-trainer/api..." build`）。**例外：`api-client` 指向 src 免 build**（見工作區邊界）。
- **Kysely 細節**：`UpdateResult` 用 `numUpdatedRows`（bigint）；查詢回傳型別用 `Selectable<XxxTable>`（Generated 已解開）。
- **NestJS 全域**：`AuthGuard` 為 `APP_GUARD`，新端點預設需登入；公開端點加 `@Public()`；admin 端點加 `@Roles('ADMIN')`；寫入（POST/PUT/PATCH/DELETE）需帶 `x-csrf-token` header。
- **用 AuditService 的 feature module 需 `imports: [AuditModule]`**；業務變更 + audit + outbox 盡量同一 `db.transaction()`。
- `cookie-parser` 用 default import（`import cookieParser from 'cookie-parser'`）。
- **回應不要手動包 `{ data }`**：全域 `ResponseEnvelopeInterceptor` 已把 controller 回傳值包成 `{ data: <回傳值> }`；controller 直接回原始 payload（雙重包裝會變成 `{data:{data:...}}`）。
- **選填 body 要防 undefined**：`@Body()` 在無 body 請求時可能是 undefined，用 `@Body() body: {...} = {}` 或 `body?.field`。

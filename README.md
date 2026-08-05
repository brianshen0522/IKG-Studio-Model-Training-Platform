# IKG Studio — Model Training Platform

Self-hosted platform for training and benchmarking YOLO (**OBB + DETECT**) models through a web UI.
Bring your own annotated datasets and a base model; the platform builds/validates the YOLO dataset,
runs training on CPU or GPU, tracks every artifact, and lets you benchmark trained models across
model × dataset combinations.

> **Docs authority**: the code is the source of truth. See [`AGENTS.md`](./AGENTS.md) for the full
> engineering rulebook (workspace boundaries, infra conventions, non-negotiable rules). This README
> is a getting-started map, not a spec.

---

## What it does

- **Datasets** — two kinds only:
  - *Source datasets*: read-only folders discovered on disk (images + labels), scanned/validated, never modified.
  - *Training datasets*: either **built** by merging + splitting source datasets into a YOLO layout
    (train/val/test + `data.yaml`), or **registered** by pointing at an already-prepared YOLO directory.
- **Models** — discovered by scanning each dataset type's model root, or produced by a training run.
  `best.pt` is stored both as an immutable artifact (MinIO) and copied into the model root; `last.pt`
  is discarded after training.
- **Training** — submit a job (base model + training dataset + hyperparameters), it queues to a
  worker, runs Ultralytics YOLO training, and produces charts/logs/metrics as artifacts.
- **Benchmarking** — evaluate N models against M training datasets in one run; compare mAP/precision/
  recall/F1 in a matrix or chart view.
- **Audit** — every state-changing action is recorded append-only (DB-, trigger-, and service-enforced;
  not even Admin can update/delete audit rows).

---

## Architecture

```
apps/
  web/         Vite + React + TS + TanStack Query + Zustand — the UI (only service that talks to the browser)
  api/         NestJS + Kysely — REST API, auth, business rules, audit, outbox
  scheduler/   Node/TS — DB-driven reconcile/retry/promote/offline-detect loop (no ML, no direct browser access)

workers/       Python (uv) — pull jobs from Redis Streams, do the actual work
  training-worker/       Ultralytics training AND benchmark runs (one worker, two job types)
  dataset-worker/        dataset scan/build AND model-ingest AND registered-dataset validation
  model-ingest-worker/   (see dataset-worker — model discovery is folded into it)
  benchmark-worker/      (see training-worker — benchmark runs there, not a separate service)
  cleanup-worker/        housekeeping (stale artifact / workspace cleanup)
  common/                shared Python lib (DB access, storage, queue helpers)

packages/
  shared-types/  Zod schemas + TS types shared by api/web/scheduler/db
  db/            Kysely `Database` type + migration runner (`pnpm --filter @model-trainer/db migrate`)
  api-client/    typed fetch wrapper for web (no build step — web imports straight from src/)

database/
  migrations/    hand-written SQL migrations; 001_initial_schema.sql is the baseline, never edited —
                 all further changes are new numbered files (002_, 003_, …)

deploy/          docker-compose stacks (prod, GPU overlay, QA), Dockerfiles, nginx config
qa/              Playwright browser smoke tests (the only test suite in this repo)
```

**Storage model**: PostgreSQL is the single source of truth. Redis is disposable (queue +
coordination + cache only — safe to flush and rebuild). Binaries (models, datasets, artifacts) live
on disk / MinIO; Postgres only stores metadata.

**No mocks, no ORM auto-sync, no client-side authorization**: the backend is the authority for every
state transition; the frontend renders API-provided enums, never infers status from strings.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | NestJS + Kysely (hand-written SQL migrations, no ORM auto-sync) |
| Frontend | Vite + React + TypeScript + TanStack Query + Zustand |
| Shared types/validation | Zod (`packages/shared-types`) |
| Queue | Redis Streams |
| Scheduler | Node/TS (reuses `packages/db` + `shared-types`) |
| ML workers | Python + uv + Ultralytics YOLO |
| Monorepo | pnpm workspaces + Turborepo |
| DB | PostgreSQL (single `app` schema) |
| Object storage | MinIO (artifacts only) |

First-phase task types: **OBB + DETECT** only (schema reserves five, only two are wired up).

---

## Quick start (local dev, no Docker)

Requires **Node 22** (see `.nvmrc`) and **pnpm 9.15.0**, plus a reachable Postgres/Redis/MinIO
(point env vars at them — see `deploy/env.example` for the full variable list).

```sh
pnpm install
pnpm --filter @model-trainer/db migrate   # apply database/migrations/*.sql
PORT=8080 pnpm dev                        # turbo: runs web + api + scheduler together (persistent)
```

`PORT=8080` matters: the API defaults to `3000` (`apps/api/src/config/config.schema.ts`), but
`apps/web/vite.config.ts` proxies `/api` to a hardcoded `http://localhost:8080` — without it the
web dev server can't reach the API.

Workers (`workers/*`) are Python/uv — run separately, see each worker's own README.

Common commands:

```sh
pnpm build          # build all workspaces
pnpm typecheck       # == pnpm lint (this repo has no ESLint; both are `tsc --noEmit`)
pnpm --filter @model-trainer/<pkg> <task>   # target one workspace: api | web | scheduler | db | shared-types | api-client
```

There is **no unit/integration test framework**. The only test suite is the Playwright smoke test:

```sh
node qa/run.mjs                 # runs against a dev stack on http://localhost:8080, admin/admin
bash qa/allengines.sh            # chromium/firefox/webkit, each against a fresh QA stack on :8088
```

---

## Quick start (full stack, Docker)

This is the realistic way to run everything (3 apps + workers + postgres/redis/minio/nginx +
tls-proxy):

```sh
cd deploy
cp env.example .env        # fill in every CHANGE_ME_* value
./up.sh up -d --build      # wraps docker compose: expands DATA_ROOT, auto-detects GPU
```

Open `https://localhost:<WEB_HTTPS_PORT>/` (`WEB_HTTPS_PORT` defaults to `443` in `env.example` —
set it to e.g. `8443` if 443 is taken) and log in with the `BOOTSTRAP_ADMIN_USERNAME` /
`BOOTSTRAP_ADMIN_PASSWORD` you set in `.env`. The certificate is self-signed (auto-generated on
first start) — click through the browser warning once.

### With an NVIDIA GPU (CUDA)

Docker on macOS has no GPU passthrough — CUDA only applies on a **Linux host** (bare metal or
Windows/WSL2) with an NVIDIA GPU.

1. Install the **[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)**
   and confirm it works: `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`.
2. In `.env` set `TRAINING_DEVICE=0` (the CUDA device index; use `1`, `2`, … for other GPUs).
   Optionally pin `TORCH_CUDA` to match your driver (`cu121` / `cu124` (default) / `cu128`).
3. Deploy the same way as CPU — `up.sh` auto-detects the GPU and applies the overlay for you:
   ```sh
   cd deploy
   ./up.sh up -d --build
   ```

Benchmark runs share the same `training-worker`, so they're GPU-accelerated too. To force CPU on a
GPU box, `DEPLOY_FORCE_CPU=1 ./up.sh up -d --build`.

For platform-specific notes, TLS/passkey setup, backups, and troubleshooting, see the full
**[deploy/README.md](./deploy/README.md)**.

---

## Repo conventions worth knowing before you touch code

- `lint` **is** `typecheck` (`tsc --noEmit`) — there's no separate style linter.
- `packages/*` compile to `dist/`; after editing `shared-types` or `db`, build before typechecking
  downstream (`pnpm --filter "@model-trainer/api..." build`). `api-client` is the exception — it
  points straight at `src/`.
- Timestamps come back from Postgres as **strings**, not `Date` objects (custom pg type parser).
- Every table lives in the `app` schema; the connection's `search_path` already includes it, so
  Kysely queries use bare table names.
- Writes (`POST`/`PUT`/`PATCH`/`DELETE`) require an `x-csrf-token` header.
- Full rulebook, non-negotiables, and workspace boundaries: **[AGENTS.md](./AGENTS.md)**.

---

## License

Internal / proprietary — not currently licensed for external distribution.


# Deployment Guide

Production deployment for the **Model Training Platform** — a self-hosted platform for training and
benchmarking YOLO (OBB + DETECT) models through a web UI.

Everything runs in Docker via `docker compose`. This guide covers **macOS, Linux (CPU), Linux
+ NVIDIA GPU, and Windows (WSL2)**.

---

## 1. What gets deployed

| Service | Role | Exposed |
|---|---|---|
| `postgres` | source of truth (all state) | internal only |
| `redis` | job queue (streams) + sessions | internal only |
| `minio` | artifact object store | internal only |
| `migrate` *(one-shot)* | applies DB migrations + injects role passwords | — |
| `bootstrap` *(one-shot)* | creates the first admin (idempotent) | — |
| `backend` | NestJS API (`backend_role`) | internal only |
| `web` | nginx: serves the UI + proxies `/api` (SSE, 500 MB uploads) | internal only |
| `tls-proxy` | nginx: TLS termination (self-signed, HTTP/2) | **public** |
| `scheduler` | reconcile / retry / promote / offline-detect loop | internal only |
| `training-worker` | Ultralytics **training + benchmark** (`worker_role`) | internal only |
| `dataset-worker` | dataset scan/build + **model ingest** (`worker_role`) | internal only |

`tls-proxy` is the only service that publishes a host port. Benchmark runs inside
`training-worker` and model-ingest inside `dataset-worker` — there are no separate services for
them.

---

## 2. Prerequisites (all platforms)

- **Docker Engine 24+** and **Docker Compose v2** (`docker compose`, not `docker-compose`).
  - **macOS**: [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev/).
  - **Linux**: Docker Engine + the `docker-compose-plugin` package.
  - **Windows**: Docker Desktop with the **WSL2** backend.
- ~8 GB RAM free and ~10 GB disk (the training-worker image is ~2 GB; models/datasets add more).
- Host directories for your datasets and models (see §4).

For **GPU** deployments, additionally: an NVIDIA GPU + recent driver + the **NVIDIA Container
Toolkit** (see §6).

---

## 3. Configure

```sh
cd deploy
cp env.example .env
```

Edit `.env` and set **every `CHANGE_ME_*`** value:

- **Database** — one password per least-privilege role:
  `POSTGRES_MIGRATION_PASSWORD`, `BACKEND_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `SCHEDULER_DB_PASSWORD`.
- **MinIO** — `MINIO_SECRET_KEY`. **Session** — `SESSION_SECRET` (e.g. `openssl rand -hex 32`).
- **First admin** — `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` (≥ 12 chars).
- **Storage root(s)** — one or more host paths (comma-separated), each bind-mounted at the same
  absolute path into every service that needs it (create them first, writable by the container
  user):
  ```
  DATA_ROOT=/srv/yolo
  # or multiple:
  DATA_ROOT=/srv/yolo,/mnt/nas/datasets,/mnt/fast-disk/models
  ```
  Lay out whatever's under each path however you like — the deploy layer just mounts it, the app
  doesn't assume any subfolder names. **Always deploy via `./up.sh`, not `docker compose`
  directly** — it reads `DATA_ROOT` and generates the bind mounts (a static compose file can't
  turn one variable into N mount lines).
- **Web port** — `WEB_HTTPS_PORT` (default 443, the only published port — HTTPS/HTTP2 only,
  there is no plain-HTTP listener or redirect).
- **Training device** — `TRAINING_DEVICE=cpu` (default) or a CUDA index like `0` for GPU.
- **TLS / passkeys** — `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `COOKIE_SECURE` (see §7).

---

## 4. Deploy — pick your platform

### 4a. macOS (Apple Silicon or Intel) — CPU

Docker on macOS has **no GPU passthrough**, so training runs on CPU. This is the default; the
training-worker image ships **CPU-only torch** (no multi-GB CUDA download).

```sh
cd deploy
./up.sh up -d --build
```

Keep `TRAINING_DEVICE=cpu` in `.env`.

### 4b. Linux — CPU only

Identical to macOS:

```sh
cd deploy
./up.sh up -d --build
```

### 4c. Linux — NVIDIA GPU (CUDA)

1. Install the **[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)**
   and confirm `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` works.
2. *(Optional)* pick the CUDA torch build to match your driver with `TORCH_CUDA` in `.env`
   (`cu121`, `cu124` (default), `cu128`, …). *(Optional)* set `TRAINING_DEVICE` to a specific CUDA
   index if you have more than one GPU (default `0`).
3. Deploy the same way as CPU:
   ```sh
   cd deploy
   ./up.sh up -d --build
   ```
   `up.sh` auto-detects a usable NVIDIA GPU on the host (`nvidia-smi` + the Docker NVIDIA runtime)
   and applies `docker-compose.gpu.yml` for you — no flag needed, and nothing to remember to
   change when moving the same `.env` between a CPU box and a GPU box.

To force CPU on a machine that does have a GPU, run `DEPLOY_FORCE_CPU=1 ./up.sh up -d --build`.

### 4d. Windows (WSL2)

Run everything from inside a **WSL2** distro (Ubuntu). CPU works out of the box (§4b). For GPU,
install the NVIDIA driver on Windows + the CUDA-on-WSL setup + the NVIDIA Container Toolkit inside
WSL, then follow §4c.

> Put the repo and the storage-root paths **inside the WSL filesystem** (e.g. `/home/you/...`),
> not `/mnt/c/...`, for acceptable I/O performance.

---

## 5. First login

Startup order is enforced automatically: `postgres` → `migrate` → `bootstrap` → `backend` → `web`
→ `tls-proxy`. Once up, open `https://<host>:<WEB_HTTPS_PORT>/` and log in with
`BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`.

The certificate is **self-signed** (generated automatically on first start, see §7) — the browser
will show a warning; click through it once. This is expected and does not indicate a problem.

Check progress with:
```sh
./up.sh ps
./up.sh logs -f migrate bootstrap backend
```

---

## 6. GPU details

- The training-worker Dockerfile takes a `TORCH_BACKEND` build arg. Default `cpu` uses the
  CPU-only torch pinned in `uv.lock`; the GPU overlay sets it to `cu124` (override via `TORCH_CUDA`),
  which re-installs the matching CUDA `torch`/`torchvision` at build time.
- The GPU overlay also adds the `deploy.resources.reservations.devices` GPU reservation +
  `NVIDIA_VISIBLE_DEVICES=all`.
- Set `TRAINING_DEVICE` to the CUDA index the worker should use (`0`, `1`, …).
- Benchmark uses the same worker, so it is GPU-accelerated too.

---

## 7. TLS

`tls-proxy` terminates TLS and speaks HTTP/2, sitting in front of `web` (which is now internal
only). On first start it generates a **self-signed certificate** (RSA 2048, 10-year validity,
`CN=localhost`, SAN `DNS:localhost, IP:127.0.0.1`) into the `tls-certs` volume — it is **not**
regenerated on redeploy, only if you delete that volume.

There is no such thing as a TLS certificate valid for "any IP address" — the SAN field is an
explicit list, not a wildcard, for self-signed or CA-issued certs alike. Practical effect:

- Connecting via `https://localhost` or `https://127.0.0.1` — browser trusts the cert's SAN,
  still warns because it's self-signed (unknown CA). Click through once.
- Connecting via any other IP or hostname — browser warns for the SAN mismatch *and* the
  self-signed CA. Still click through; the connection is still encrypted.
- **Passkeys (WebAuthn) need a real hostname** — the spec has no IP-address RP ID, so
  `WEBAUTHN_RP_ID` must be a DNS name you actually connect through. If you only access the site
  by IP, skip passkeys; password login works fine over the self-signed HTTPS regardless.

To use your own certificate (a real CA, or one covering more SANs) instead of the auto-generated
one: drop `cert.pem` + `key.pem` into the `tls-certs` volume before first start (or after,
followed by `./up.sh restart tls-proxy`) — the entrypoint only generates when the files are
missing.

Config:
- `COOKIE_SECURE=true` (default — the site is always served over HTTPS via `tls-proxy`)
- `WEBAUTHN_RP_ID=your-domain` (host only — no scheme/port/path) if using passkeys
- `WEBAUTHN_ORIGIN=https://your-domain:<WEB_HTTPS_PORT>`

**`WEBAUTHN_RP_ID` is permanent** — changing it later invalidates every already-registered
passkey.

---

## 8. Day-2 operations

**Upgrade / redeploy:**
```sh
git pull
./up.sh up -d --build          # GPU overlay applied automatically when a GPU is present
```
`migrate` only applies migrations not already in `app.schema_migrations`, and `bootstrap` skips
when an admin exists — both are safe to re-run on every deploy.

**Data & backups:** state lives in the `postgres-data`, `redis-data`, `minio-data` Docker volumes
plus the bind-mounted storage roots. A plain `up`/`down` (without `-v`) preserves everything. Back
up with `pg_dump` (Postgres) + the MinIO bucket + the model/dataset roots. **Never** run
`docker compose down -v` in production — it deletes the volumes.

**Scale workers:** `./up.sh up -d --scale dataset-worker=2 --scale training-worker=2`
(each worker self-registers and appears under Admin → Workers; the scheduler uses a DB advisory
lock so multiple schedulers are safe too).

**Logs / health:** `./up.sh logs -f <service>`; live worker/queue health is on the
dashboard (System Health) and Admin → Workers.

---

## 9. Troubleshooting

- **502 Bad Gateway right after redeploying `backend`** — nginx caches the backend's IP at start.
  If you recreate only the backend container, restart web too: `./up.sh restart web`.
  (A full `up -d --build` recreates web anyway, so this only bites incremental redeploys.)
- **Slow/heavy training-worker build** — the ML stack (torch + ultralytics + opencv) is ~1.2 GB.
  It's cached after the first build; source-only changes rebuild fast.
- **GPU not used** — confirm `nvidia-smi` works in a container (§4c step 1). `up.sh` prints
  `NVIDIA GPU detected — applying docker-compose.gpu.yml` when it picks up the overlay; if you
  don't see that line, `docker info | grep -i nvidia` is probably empty (NVIDIA Container Toolkit
  not installed/configured). `./up.sh exec training-worker uv run python -c "import torch;
  print(torch.cuda.is_available())"` should print `True`.
- **Login "Session expired" / cookie not set** — confirm you're hitting `tls-proxy` on
  `WEB_HTTPS_PORT`, not `web` directly (it has no published port). `COOKIE_SECURE=true` requires
  HTTPS end-to-end, which `tls-proxy` provides.
- **Browser certificate warning** — expected, the cert is self-signed (§7). Click through, or
  install your own certificate into the `tls-certs` volume.
- **Login 429 (rate limited)** — login is throttled per IP / username / IP+username. Wait for the
  window (`RL_LOGIN_WINDOW_S`, default 300 s) or tune the `RL_LOGIN_*` limits in `.env`.

---

## 10. Files

- `docker-compose.yml` — the production stack.
- `docker-compose.gpu.yml` — GPU overlay (build CUDA torch + reserve the GPU).
- `docker-compose.data-roots.yml` — **generated** by `up.sh` from `DATA_ROOT`; not committed, don't
  edit it by hand.
- `up.sh` — wrapper around `docker compose` that expands `DATA_ROOT` into bind mounts. Use this
  instead of calling `docker compose` directly.
- `env.example` — all configuration, copy to `.env`.
- `docker-compose.qa.yml` — a self-contained QA stack (hardcoded creds, plain HTTP, a test asset
  server) used by the `qa/` browser tests. **Not for production.**
- `Dockerfile.*` — per-service images.
- `nginx/tls-proxy.conf` / `nginx/tls-entrypoint.sh` — `tls-proxy`'s nginx config and the
  self-signed cert generation script (see §7).
- `nginx/nginx.conf` — `web`'s internal nginx config.

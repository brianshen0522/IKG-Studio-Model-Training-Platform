# IKG Studio — Model Training Platform User Manual

This manual documents the web UI of **IKG Studio Model Training Platform**, a browser-based tool for managing image datasets, training/converting/benchmarking computer-vision models, and monitoring background jobs. It does **not** cover deployment or infrastructure setup.

All screenshots below were captured against a live instance at `https://192.168.20.10` and are stored in `docs/manual-screenshots/`.

---

## Table of Contents

1. [Sign In](#1-sign-in)
2. [Roles: Admin vs. User](#2-roles-admin-vs-user)
3. [Navigation](#3-navigation)
4. [Home (Dashboard)](#4-home-dashboard)
5. [Datasets](#5-datasets)
   - [5.1 Source Datasets](#51-source-datasets)
   - [5.2 Training Datasets](#52-training-datasets)
6. [Models](#6-models)
7. [Training](#7-training)
8. [Benchmarks](#8-benchmarks)
9. [Jobs](#9-jobs)
10. [Notifications](#10-notifications)
11. [Admin](#11-admin)
    - [11.1 Users](#111-users)
    - [11.2 Dataset Types](#112-dataset-types)
    - [11.3 Audit](#113-audit)
    - [11.4 System Settings](#114-system-settings)
    - [11.5 Workers](#115-workers)
    - [11.6 Backup](#116-backup)
12. [Account & Security](#12-account--security)
13. [Error & Edge Cases](#13-error--edge-cases)

---

## 1. Sign In

Navigate to the platform URL. You will land on the login screen with a username/password form and an optional passkey (WebAuthn) sign-in button.

![Login page](manual-screenshots/01-login.png)

Enter valid credentials and click **Sign in**. On failure (wrong username/password), an inline error message is shown and the form remains editable:

![Login error](manual-screenshots/02-login-error.png)

> **Note:** the platform enforces account lockout after repeated failed logins (configurable — see [System Settings](#114-system-settings), `auth_failed_login_threshold` / `auth_lockout_minutes`).

---

## 2. Roles: Admin vs. User

There are two roles:

| Role | Nav items visible | Admin section | Notes |
|---|---|---|---|
| **ADMIN** | Home, Datasets, Models, Training, Benchmarks, Jobs, Notifications, **Admin** | Full access | Can manage users, dataset types, system settings, workers, audit log, backups |
| **USER** | Home, Datasets, Models, Training, Benchmarks, Jobs, Notifications | Not shown | Full read/write access to datasets, models, training, benchmarks — same as admin except no `Admin` tab |

In this build, the **USER** role could perform every dataset/model/training/benchmark action tested (register/rescan datasets, launch training, etc.) — the only observed restriction is the missing **Admin** nav entry and administrative account controls. There is no client-side route guard on top-level URLs; the app simply never renders admin-only components for non-admin sessions.

![User dashboard](manual-screenshots/54-user-dashboard.png)
![User account page](manual-screenshots/56-user-account.png)

---

## 3. Navigation

The top app bar (visible on every page once signed in) contains:

- **Logo / brand** (top-left)
- **Primary nav**: Home, Datasets, Models, Training, Benchmarks, Jobs, Notifications, (Admin — admin only)
- **Role badge** (`ADMIN` / `USER`)
- **Account button** — opens [Account & Security](#12-account--security)
- **Sign Out**

Some pages support deep-linking via URL query parameters, e.g. `?modelId=...`, `?trainingDatasetId=...`, `?trainingJobId=...`, `?sourceDatasetId=...`, `?jobId=...`, `?benchmarkRunId=...`. When a `modelId` is present it takes priority and the Model detail page is shown regardless of the active nav tab.

---

## 4. Home (Dashboard)

The Dashboard (Home) summarizes platform state at a glance:

- Counters: Source Datasets, Training Datasets, Models, Training Jobs, Benchmarks
- **System Health**: Workers Online/Offline/Total, Active Executions, Pending Outbox, Dead-Letter Outbox
- **Active Jobs** — currently running/queued jobs
- **Recent Models** table
- **Recent Benchmarks** table
- **Recent Activity** — latest audit events

![Admin dashboard](manual-screenshots/03-admin-dashboard.png)

---

## 5. Datasets

The Datasets page has two sub-tabs: **Source** (read-only disk scanning/registration) and **Training** (curated, split datasets built from one or more sources).

### 5.1 Source Datasets

Source datasets represent raw image folders discovered on disk, grouped by **dataset type** (e.g. `cards`, `dice`, `roulette` — configured in [Admin → Dataset Types](#112-dataset-types)).

![Source datasets grouped list](manual-screenshots/04-datasets-source.png)

Expand a dataset type group to see individual folders, each showing scan status (READY/INVALID), image/pair counts, class count, last-scan timestamp, and a per-folder **Rescan** action. Group-level actions include **Rescan type**, **Select all**, and **Scan & register all** (registers every unregistered folder and rescans already-registered ones).

![Expanded source dataset type with folder list](manual-screenshots/05-datasets-source-expanded.png)

Click a folder to open its detail page, showing scan history/statistics:

![Source dataset detail](manual-screenshots/06-source-dataset-detail.png)

From the detail page you can preview sample images in a modal (image + annotation overlay):

![Sample image preview modal](manual-screenshots/07-sample-modal.png)

### 5.2 Training Datasets

Training datasets are built by combining one or more source datasets, defining classes, and splitting into train/val/test sets.

![Training datasets list](manual-screenshots/08-datasets-training.png)

Click an entry to view its build configuration and status:

![Training dataset detail](manual-screenshots/09-training-dataset-detail.png)

**Build a new Training Dataset** — a 5-step wizard:

1. **Origin** — choose dataset type and name the new training dataset.
   ![Step 1: Origin](manual-screenshots/10-new-training-dataset-step1.png)
2. **Details** — description and metadata.
   ![Step 2: Details](manual-screenshots/11-new-training-dataset-step2.png)
3. **Sources** — pick which source dataset folders to include.
   ![Step 3: Sources](manual-screenshots/12-new-training-dataset-step3.png)
4. **Classes** — select/label the object classes to keep.
   ![Step 4: Classes](manual-screenshots/13-new-training-dataset-step4.png)
5. **Split** — configure train/val/test ratios and submit.
   ![Step 5: Split](manual-screenshots/14-new-training-dataset-step5.png)

Submitting triggers a background **Dataset Build** job (see [Jobs](#9-jobs)).

---

## 6. Models

Models are listed grouped by dataset type, each entry showing task (e.g. DETECT), source (TRAINING/imported), status, and creation date. A **Scan Model Roots** action re-indexes model files on disk.

![Models list](manual-screenshots/15-models-list.png)

Click a model to open its detail page: training curves, metrics, and hyperparameters used.

![Model detail page](manual-screenshots/16-model-detail.png)

Click a training curve chart to enlarge it in a lightbox:

![Enlarged training curve chart](manual-screenshots/17-model-chart-enlarged.png)

From the model detail page you can also:
- **Convert to OpenVINO** — opens a conversion wizard (device/precision options, then launches a Model Conversion job).
  ![Convert to OpenVINO wizard](manual-screenshots/18-model-convert-openvino.png)
- **Delete** the model.

---

## 7. Training

The Training page lists all training jobs with search and filters (status, type, model, dataset).

![Training jobs list](manual-screenshots/20-training-jobs-list.png)

Click a job to view its detail page — status, run configuration/hash, and live training curves (once running/completed):

![Training job detail](manual-screenshots/19-training-job-detail.png)

**Launch a New Training Job** — a 4-step wizard:

1. **Model source** — start from an existing model (fine-tune) or a base architecture.
   ![Step 1: Model source](manual-screenshots/21-new-training-job-step1.png)
2. **Dataset** — pick the training dataset to train against.
   ![Step 2: Dataset](manual-screenshots/22-new-training-job-step2.png)
3. **Review** — confirm model + dataset selection.
   ![Step 3: Review](manual-screenshots/23-new-training-job-step3.png)
4. **Hyperparameters** — Basic (epochs, batch size, image size, etc.) and Advanced (optimizer, augmentation, etc.) parameter groups, plus a GPU **Device Picker**.
   ![Step 4: Hyperparameters (Basic)](manual-screenshots/25-new-training-job-step4-basic.png)
   ![Step 4: Hyperparameters (full)](manual-screenshots/24-new-training-job-step4.png)

The Device Picker dropdown lists Auto-detect, CPU, and any available GPUs with live utilization/memory stats:

![GPU device picker dropdown](manual-screenshots/26-device-picker.png)

Submitting queues a **Training** job, trackable in [Jobs](#9-jobs) and [Notifications](#10-notifications).

---

## 8. Benchmarks

Benchmarks evaluate one or more trained models against one or more training datasets, producing comparable metrics (mAP50, mAP50-95, precision, recall, F1).

![Benchmarks list](manual-screenshots/27-benchmarks-list.png)

### Benchmark Run Detail

Clicking a run opens its detail page with three view modes:

- **Matrix Table** — model × dataset grid of scores.
  ![Matrix table view](manual-screenshots/28-benchmark-detail-matrix.png)
- **Visual Result Chart** — bar chart comparing metrics (mAP50, F1, Precision, Recall) across model/dataset pairs.
  ![Visual chart view](manual-screenshots/29-benchmark-detail-chart.png)
- **Detailed List** — a filterable/sortable table of individual evaluations, each with a **View Charts** action opening evaluation artifacts (confusion matrix, PR curves, per-class charts, log files):
  ![Detailed list view](manual-screenshots/30-benchmark-detail-list.png)
  ![Evaluation artifact charts modal](manual-screenshots/31-benchmark-eval-charts-modal.png)

### Compare Models

**Compare Models** opens a 3-step wizard (Dataset Type → Select Models → Compare) to side-by-side compare multiple models sharing a dataset type. Dataset types with fewer than 2 available models are disabled.

![Compare Models wizard](manual-screenshots/32-compare-models-wizard.png)

### New Benchmark Run

**+ New Benchmark Run** opens a 5-step wizard:

1. **Dataset Type & Name** — pick dataset type, name and describe the run.
   ![Step 1](manual-screenshots/33-new-benchmark-step1.png)
2. **Select Model** — choose the model to evaluate.
   ![Step 2](manual-screenshots/34-new-benchmark-step2-model.png)
3. **Select Dataset** — choose the training dataset (its test/val split) to evaluate against.
   ![Step 3](manual-screenshots/35-new-benchmark-step3-dataset.png)
4. **Device** — Auto-detect, CPU, or a specific GPU (with live worker stats).
   ![Step 4](manual-screenshots/36-new-benchmark-step4-device.png)
   ![Device dropdown](manual-screenshots/37-new-benchmark-device-dropdown.png)
5. **Review** — final summary plus an **Workers online** table showing which workers are available to run the evaluation, then **Create & Launch Benchmark**.
   ![Step 5: Review](manual-screenshots/38-new-benchmark-step5-review.png)

---

## 9. Jobs

The Jobs page is a system-wide view of every background job across all subsystems (Training, Dataset Build, Dataset Validate, Dataset Scan, Benchmark Eval, Model Ingest, Model Conversion), independent of which page originally launched them.

![Jobs list](manual-screenshots/39-jobs-list.png)

Use the **type filter** to narrow by job kind, and the All/Active/Completed/Failed quick filters.

![Job type filter dropdown](manual-screenshots/40-jobs-type-filter.png)

Each row shows job kind, name, technical status (e.g. `SUCCEEDED`) with the resulting business status in parentheses (e.g. `(COMPLETED)`), progress %, duration, and timestamp. Clicking a row opens an inline detail panel with a log/error excerpt. Example — a job whose worker execution was lost mid-run:

![Job detail: LOST status with error log](manual-screenshots/41-job-detail-lost-error.png)

---

## 10. Notifications

Notifications are system-generated events (job completions, failures, scan problems, etc.) surfaced per-user. The nav badge shows the unread count.

![Notifications list](manual-screenshots/42-notifications-list.png)

Controls: **Mark all read**, per-item **Mark read**, an **Unread only** checkbox, and a severity filter. A ✓ icon marks success events (e.g. "Dataset Scan Completed"); a ✕ icon marks problem events (e.g. "Dataset Scan Found Problems" for an INVALID scan result).

![Unread-only filter applied](manual-screenshots/43-notifications-unread-filter.png)

---

## 11. Admin

Visible only to users with the **ADMIN** role. Contains six sub-tabs: Users, Dataset Types, Audit, System Settings, Workers, Backup.

### 11.1 Users

Manage platform accounts: role (USER/ADMIN), active/disabled state, and password resets.

![Admin Users tab](manual-screenshots/44-admin-users.png)

**+ New User** opens a form for username, display name, email (optional), role, and password mode (Manual or Generated):

![New User modal](manual-screenshots/45-admin-new-user-modal.png)

Per-user row actions: **Disable/Enable**, **Make Admin/Make User** (disabled for your own account — you cannot demote yourself), **Reset Password**.

### 11.2 Dataset Types

Dataset types are the top-level categories (e.g. `cards`, `dice`, `roulette`) that scope Source Datasets, Training Datasets, and Models. Each has a dataset root path, model root path, and enabled state, plus usage counts.

![Admin Dataset Types tab](manual-screenshots/46-admin-dataset-types.png)

**Edit** opens a form to change the name, description, and the three filesystem paths (dataset path, model path, training dataset path), each validated live for existence:

![Edit Dataset Type modal](manual-screenshots/47-admin-edit-dataset-type.png)

**New Root Type** creates a new dataset type; **Disable** deactivates one without deleting its data.

### 11.3 Audit

A searchable, filterable, paginated log of every auditable platform action (logins, resource creation, job lifecycle events, etc.), each entry showing actor, action code, resource type/id, result (SUCCESS/FAILURE), and a correlation id linking related events. Supports filtering by action, resource type, result, actor type, and date range, plus **Export CSV**.

![Admin Audit Log tab](manual-screenshots/48-admin-audit-log.png)

### 11.4 System Settings

Platform-wide configuration grouped by category:

- **Authentication** — failed-login threshold, lockout duration, session absolute/idle timeouts.
- **Models** — allow non-TLS/private download URLs (SSRF-risk toggles), minimum accepted file size, global model root path, max browser-upload size.
- **Datasets** — max dataset type tree depth, global managed-dataset root path.
- **Workers & Queue** — queue wait warning threshold, worker offline timeout.
- **Storage** — MinIO storage limit, usage warning threshold, workspace file retention hours, workspace root path.

Changes are applied platform-wide and take effect on the next operation that reads the setting.

![Admin System Settings tab](manual-screenshots/50-admin-system-settings.png)

### 11.5 Workers

Lists registered background workers (dataset-worker, training-worker, …) with online/offline status, hostname/container id, active job count, runtime versions (Python/torch/ultralytics/CUDA), and heartbeat/registration timestamps.

![Admin Workers tab](manual-screenshots/49-admin-workers.png)

### 11.6 Backup

Export/import the full platform state (users incl. password hashes & passkeys, dataset types, system settings incl. secrets) as a JSON file. **Import** only works on a fresh/empty system since it overwrites these tables.

![Admin Backup tab](manual-screenshots/51-admin-backup.png)

---

## 12. Account & Security

Reached via the account button in the top-right (shows your username). Displays username, display name, and role (read-only), plus:

- **Change password** — current password + new password + confirmation form.
- **Passkeys** — register WebAuthn passkeys for passwordless sign-in.

![Account & Security page](manual-screenshots/52-account-security.png)

Change-password form expanded:

![Change password form](manual-screenshots/53-account-change-password.png)

---

## 13. Error & Edge Cases

- **Invalid login** — shows an inline "Invalid credentials" message on the login form (see [§1](#1-sign-in), screenshot 02). Repeated failures trigger account lockout per `auth_failed_login_threshold` / `auth_lockout_minutes` in [System Settings](#114-system-settings).
- **Unknown/non-existent resource id in URL** (e.g. `?modelId=<random-uuid>`) — the app does not show a dedicated 404 page; it silently falls back to the default page for the active nav tab (Datasets → Source, in this build).
- **Non-admin navigating to admin-only state** — there is no client-side route guard; the Admin nav item and its sub-pages are simply never rendered for a USER-role session (see [§2](#2-roles-admin-vs-user)).
- **Lost job execution** — if a worker stops sending heartbeats mid-job, the job is marked `LOST` (technical status) while its business status remains at its last known value (e.g. `READY`); the job detail log shows the last processed item and an `Execution lost: no heartbeat within timeout` error (see [§9](#9-jobs), screenshot 41).
- **Dataset scan problems** — a source folder scan can complete with status `INVALID` (e.g. malformed annotations), which is reported via a ✕ "Dataset Scan Found Problems" notification instead of a ✓ success notification (see [§10](#10-notifications)).

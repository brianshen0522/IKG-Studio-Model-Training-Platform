-- Inference runs: re-infer source datasets with a registered model and keep the
-- images whose predictions disagree with the existing labels, so they can be
-- previewed and downloaded (docs/inference-compare-plan.md).
--
-- One run is one model over one or more source datasets of the same dataset
-- type. Each (run, source dataset) pair is one job, dispatched to the
-- training-worker as job_type INFERENCE. Only differing images get a row in
-- inference_diffs; on production most of ~900k images are expected to agree, so
-- the matching ones are only counted.
--
-- Shaped after the benchmark tables (benchmark_runs / benchmark_evaluations), so
-- the status vocabulary and the stop / retry / LOST handling carry over.

-- Not used in this file, so it can be added inside the migration's transaction.
ALTER TYPE app.job_type ADD VALUE IF NOT EXISTS 'INFERENCE';

CREATE TYPE app.inference_run_status AS ENUM (
    'QUEUED',
    'RUNNING',
    'COMPLETED',
    'PARTIALLY_FAILED',
    'FAILED',
    'CANCELLED',
    'STOPPING',
    'STOPPED'
);

CREATE TYPE app.inference_run_dataset_status AS ENUM (
    'QUEUED',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'STOPPING',
    'STOPPED'
);

CREATE TABLE app.inference_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    dataset_type_id uuid NOT NULL,
    model_id uuid NOT NULL,
    -- The model file the run was asked to use. The worker refuses a file whose
    -- checksum no longer matches, so a run's results always describe one model.
    model_checksum_snapshot text NOT NULL,
    -- Thresholds are stored per run: if they ever become adjustable, an old
    -- run's results still say which values produced them.
    conf_threshold double precision NOT NULL,
    iou_threshold double precision NOT NULL,
    -- '' = worker default (TRAINING_DEVICE), else 'cpu' or GPU indices, as for
    -- benchmark_runs.device.
    device text DEFAULT ''::text NOT NULL,
    status app.inference_run_status DEFAULT 'QUEUED'::app.inference_run_status NOT NULL,
    dataset_count integer DEFAULT 0 NOT NULL,
    completed_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    queued_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    stop_requested_at timestamp with time zone,
    stop_requested_by_user_id uuid,
    stopped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inference_runs_pkey PRIMARY KEY (id),
    CONSTRAINT chk_inference_runs_conf CHECK (conf_threshold > 0 AND conf_threshold <= 1),
    CONSTRAINT chk_inference_runs_iou CHECK (iou_threshold > 0 AND iou_threshold <= 1),
    CONSTRAINT inference_runs_dataset_type_id_fkey
        FOREIGN KEY (dataset_type_id) REFERENCES app.dataset_types(id) ON DELETE RESTRICT,
    CONSTRAINT inference_runs_model_id_fkey
        FOREIGN KEY (model_id) REFERENCES app.models(id) ON DELETE RESTRICT,
    CONSTRAINT inference_runs_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT,
    CONSTRAINT inference_runs_stop_requested_by_user_id_fkey
        FOREIGN KEY (stop_requested_by_user_id) REFERENCES app.users(id) ON DELETE RESTRICT
);

-- Same rule as benchmark runs (005): a name is unique within its dataset type.
CREATE UNIQUE INDEX uq_inference_runs_dataset_type_name
    ON app.inference_runs (dataset_type_id, lower(name));
CREATE INDEX idx_inference_runs_created_at ON app.inference_runs (created_at DESC);
CREATE INDEX idx_inference_runs_model ON app.inference_runs (model_id);

CREATE TABLE app.inference_run_datasets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inference_run_id uuid NOT NULL,
    source_dataset_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    -- The scan the source looked like when the run was created. The compare
    -- page warns when the source has been rescanned since, because its images
    -- may no longer be the ones that were inferred.
    source_scan_id_snapshot uuid,
    status app.inference_run_dataset_status DEFAULT 'QUEUED'::app.inference_run_dataset_status NOT NULL,
    image_count integer DEFAULT 0 NOT NULL,
    processed_count integer DEFAULT 0 NOT NULL,
    diff_image_count integer DEFAULT 0 NOT NULL,
    missing_count integer DEFAULT 0 NOT NULL,
    extra_count integer DEFAULT 0 NOT NULL,
    class_mismatch_count integer DEFAULT 0 NOT NULL,
    zip_artifact_id uuid,
    failure_code text,
    failure_message text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    stopped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inference_run_datasets_pkey PRIMARY KEY (id),
    CONSTRAINT uq_inference_run_datasets_source UNIQUE (inference_run_id, source_dataset_id),
    CONSTRAINT inference_run_datasets_inference_run_id_fkey
        FOREIGN KEY (inference_run_id) REFERENCES app.inference_runs(id) ON DELETE RESTRICT,
    CONSTRAINT inference_run_datasets_source_dataset_id_fkey
        FOREIGN KEY (source_dataset_id) REFERENCES app.source_datasets(id) ON DELETE RESTRICT,
    CONSTRAINT inference_run_datasets_zip_artifact_id_fkey
        FOREIGN KEY (zip_artifact_id) REFERENCES app.artifacts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_inference_run_datasets_run_status
    ON app.inference_run_datasets (inference_run_id, status);

CREATE TABLE app.inference_diffs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inference_run_dataset_id uuid NOT NULL,
    -- Relative to the source dataset's images directory.
    image_relative_path text NOT NULL,
    -- Snapshots, not references: the source's labels can change after the run
    -- (Dataset Manager re-archives into the same folder), and the preview and
    -- the ZIP must keep showing what was actually compared.
    original_boxes jsonb DEFAULT '[]'::jsonb NOT NULL,
    predicted_boxes jsonb DEFAULT '[]'::jsonb NOT NULL,
    -- Per-box verdicts and pairings from the IoU matching.
    matches jsonb DEFAULT '[]'::jsonb NOT NULL,
    missing_count integer DEFAULT 0 NOT NULL,
    extra_count integer DEFAULT 0 NOT NULL,
    class_mismatch_count integer DEFAULT 0 NOT NULL,
    -- The source label file could not be parsed; the image counts as different.
    label_invalid boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inference_diffs_pkey PRIMARY KEY (id),
    -- Also what makes a retried batch idempotent: the worker upserts on it.
    CONSTRAINT uq_inference_diffs_image UNIQUE (inference_run_dataset_id, image_relative_path),
    CONSTRAINT inference_diffs_inference_run_dataset_id_fkey
        FOREIGN KEY (inference_run_dataset_id) REFERENCES app.inference_run_datasets(id) ON DELETE RESTRICT
);

-- Status changes reach the browser over SSE, as benchmark runs do.
CREATE TRIGGER trg_inference_runs_sse AFTER UPDATE ON app.inference_runs
    FOR EACH ROW EXECUTE FUNCTION app.notify_sse_job('inference');

-- Audit / artifact owner types, and the artifact type for the diff ZIP.
INSERT INTO app.resource_types (code, display_name, supports_artifacts, supports_audit, supports_notification, enabled)
VALUES
    ('INFERENCE_RUN', 'Inference Run', 'f', 't', 't', 't'),
    ('INFERENCE_RUN_DATASET', 'Inference Run Dataset', 't', 't', 'f', 't')
ON CONFLICT (code) DO NOTHING;

INSERT INTO app.artifact_types (code, display_name, category, allowed_owner_type_code, mime_type_pattern, supports_preview, sort_order, enabled)
VALUES ('INFERENCE_DIFF_ZIP', 'Inference Diff ZIP', 'OUTPUTS', 'INFERENCE_RUN_DATASET', '.zip', 'f', 18, 't')
ON CONFLICT (code) DO NOTHING;

-- Grants mirror the benchmark tables. The worker writes progress and diffs; the
-- scheduler finalises runs whose execution was lost.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.inference_runs TO backend_role;
GRANT SELECT ON TABLE app.inference_runs TO readonly_role;
GRANT SELECT, UPDATE ON TABLE app.inference_runs TO scheduler_role;
GRANT SELECT, UPDATE ON TABLE app.inference_runs TO worker_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.inference_run_datasets TO backend_role;
GRANT SELECT ON TABLE app.inference_run_datasets TO readonly_role;
GRANT SELECT, UPDATE ON TABLE app.inference_run_datasets TO scheduler_role;
GRANT SELECT, UPDATE ON TABLE app.inference_run_datasets TO worker_role;

GRANT SELECT ON TABLE app.inference_diffs TO backend_role;
GRANT SELECT ON TABLE app.inference_diffs TO readonly_role;
GRANT SELECT, INSERT, UPDATE ON TABLE app.inference_diffs TO worker_role;

-- Within a dataset type, model names must be unique (case-insensitive) and
-- benchmark run names must be unique (case-insensitive). Models already carry
-- dataset_type_id; benchmark runs did not, so backfill it from the run's first
-- linked model and make it mandatory going forward.
CREATE UNIQUE INDEX uq_models_dataset_type_name ON app.models (dataset_type_id, lower(name));

ALTER TABLE app.benchmark_runs ADD COLUMN dataset_type_id uuid;

UPDATE app.benchmark_runs b
SET dataset_type_id = q.dt
FROM (
    SELECT DISTINCT ON (brm.benchmark_run_id) brm.benchmark_run_id AS run_id, m.dataset_type_id AS dt
    FROM app.benchmark_run_models brm
    JOIN app.models m ON m.id = brm.model_id
    ORDER BY brm.benchmark_run_id, brm.sort_order
) q
WHERE b.id = q.run_id;

ALTER TABLE app.benchmark_runs ALTER COLUMN dataset_type_id SET NOT NULL;
ALTER TABLE app.benchmark_runs
    ADD CONSTRAINT benchmark_runs_dataset_type_id_fkey
    FOREIGN KEY (dataset_type_id) REFERENCES app.dataset_types(id);

CREATE UNIQUE INDEX uq_benchmark_dataset_type_name ON app.benchmark_runs (dataset_type_id, lower(name));

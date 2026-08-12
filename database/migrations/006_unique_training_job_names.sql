-- Within a dataset type, training job names must be unique (case-insensitive),
-- mirroring models and benchmark runs (see 005). training_jobs carries no
-- dataset_type_id; derive it from the linked training dataset and make it
-- mandatory going forward.
ALTER TABLE app.training_jobs ADD COLUMN dataset_type_id uuid;

UPDATE app.training_jobs j
SET dataset_type_id = d.dataset_type_id
FROM app.training_datasets d
WHERE d.id = j.training_dataset_id;

ALTER TABLE app.training_jobs ALTER COLUMN dataset_type_id SET NOT NULL;
ALTER TABLE app.training_jobs
    ADD CONSTRAINT training_jobs_dataset_type_id_fkey
    FOREIGN KEY (dataset_type_id) REFERENCES app.dataset_types(id);

CREATE UNIQUE INDEX uq_training_jobs_dataset_type_name
    ON app.training_jobs (dataset_type_id, lower(name));

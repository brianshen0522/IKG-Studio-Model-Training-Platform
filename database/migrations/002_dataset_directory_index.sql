--
-- Background directory index for Source Datasets (migration 002)
--
-- discoverDatasetFolders() used to walk CIFS synchronously inside browseByType() /
-- available() / rescanType(), blocking the API for seconds per dataset type. These
-- tables let a dataset-worker job do the walk once and upsert the result; the API
-- then reads the index and returns in milliseconds.
--
-- dataset_directory_index : one row per discovered dataset folder (dir holding both
--   images/ and labels/) under a type's effective dataset_path. Sub_path is relative
--   to that path and matches source_datasets.sub_path, so registration joins line up.
--
-- dataset_type_reindexes  : per-type reindex job status. PK = dataset_type_id so a
--   type has at most one in-flight reindex; the API reads this to disable the Rescan
--   button and the worker flips RUNNING -> COMPLETED/FAILED when the walk is done.
--

CREATE TABLE app.dataset_directory_index (
    dataset_type_id uuid NOT NULL REFERENCES app.dataset_types(id) ON DELETE CASCADE,
    sub_path text NOT NULL,
    image_count integer NOT NULL DEFAULT 0,
    label_count integer NOT NULL DEFAULT 0,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dataset_directory_index_pkey PRIMARY KEY (dataset_type_id, sub_path)
);


CREATE TABLE app.dataset_type_reindexes (
    dataset_type_id uuid NOT NULL REFERENCES app.dataset_types(id) ON DELETE CASCADE,
    status text NOT NULL,
    correlation_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    error_message text,
    CONSTRAINT dataset_type_reindexes_pkey PRIMARY KEY (dataset_type_id),
    CONSTRAINT dataset_type_reindexes_status_chk CHECK (status IN ('RUNNING','COMPLETED','FAILED'))
);


-- Index for listing folders by type (PK already covers this, but explicit for clarity
-- of the access path used by browseByType / available).
CREATE INDEX idx_dataset_directory_index_type
    ON app.dataset_directory_index USING btree (dataset_type_id);


--
-- Name: TABLE dataset_directory_index; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE app.dataset_directory_index TO backend_role;
GRANT SELECT ON TABLE app.dataset_directory_index TO readonly_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE app.dataset_directory_index TO worker_role;


--
-- Name: TABLE dataset_type_reindexes; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.dataset_type_reindexes TO backend_role;
GRANT SELECT ON TABLE app.dataset_type_reindexes TO readonly_role;
GRANT SELECT,INSERT,UPDATE ON TABLE app.dataset_type_reindexes TO worker_role;

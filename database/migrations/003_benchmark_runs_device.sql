-- Per-run compute device for benchmark evaluations, mirroring training's
-- per-job `device` in hyperparameters. Empty string = worker default
-- (TRAINING_DEVICE env); otherwise 'cpu' or a comma-separated GPU index list.
ALTER TABLE app.benchmark_runs
    ADD COLUMN device text NOT NULL DEFAULT '';

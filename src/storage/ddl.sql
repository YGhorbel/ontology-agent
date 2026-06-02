-- Ontology store schema. Applied idempotently by ontology-store.ts on each run.

CREATE TABLE IF NOT EXISTS ontology_fragment (
    id              BIGSERIAL PRIMARY KEY,
    datasource_id   TEXT NOT NULL,
    fragment_iri    TEXT NOT NULL,
    fragment_kind   TEXT NOT NULL,       -- 'Class' | 'DatatypeProperty' | ...
    pref_label      TEXT,
    alt_labels      TEXT[],
    content_jsonld  JSONB NOT NULL,      -- the JSON-LD node
    maps_to_table   TEXT,
    maps_to_column  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(datasource_id, fragment_iri)
);

CREATE INDEX IF NOT EXISTS idx_ontology_fragment_datasource
    ON ontology_fragment(datasource_id);
CREATE INDEX IF NOT EXISTS idx_ontology_fragment_label
    ON ontology_fragment(pref_label);

CREATE TABLE IF NOT EXISTS ontology_run (
    id              BIGSERIAL PRIMARY KEY,
    datasource_id   TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ,
    fragment_count  INTEGER,
    status          TEXT NOT NULL,       -- 'success' | 'failed' | 'partial'
    error           TEXT
);

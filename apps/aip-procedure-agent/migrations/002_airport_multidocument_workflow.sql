-- Product workflow v2: airport task -> documents -> packages -> plans -> versioned results.
CREATE TABLE IF NOT EXISTS airport_recognition_tasks (
  id uuid PRIMARY KEY,
  task_name text NOT NULL,
  airport_icao text,
  airport_name text,
  status text NOT NULL,
  current_stage text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE aip_documents ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES airport_recognition_tasks(id);
ALTER TABLE aip_documents ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE aip_documents ADD COLUMN IF NOT EXISTS page_count integer NOT NULL DEFAULT 0;
ALTER TABLE aip_documents ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'UPLOADED';
CREATE INDEX IF NOT EXISTS aip_documents_task_idx ON aip_documents(task_id);

ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS procedure_category text;
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS procedure_name text;
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS runways jsonb NOT NULL DEFAULT '[]';
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS navigation_type text;
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS grouping_confidence numeric(5,4);
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS grouping_reason text;
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'GROUPED';
ALTER TABLE procedure_packages ADD COLUMN IF NOT EXISTS recognition_plan_json jsonb;

ALTER TABLE procedure_package_pages ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE procedure_package_pages ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES aip_documents(id);
ALTER TABLE procedure_package_pages ADD COLUMN IF NOT EXISTS page_number integer;
ALTER TABLE procedure_package_pages ADD COLUMN IF NOT EXISTS page_role text;
ALTER TABLE procedure_package_pages ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false;
ALTER TABLE procedure_package_pages ADD COLUMN IF NOT EXISTS confidence numeric(5,4);
CREATE INDEX IF NOT EXISTS procedure_package_pages_document_idx ON procedure_package_pages(document_id, page_number);

CREATE TABLE IF NOT EXISTS procedure_recognition_results (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES procedure_packages(id),
  pir_json jsonb,
  geojson jsonb,
  arinc424_text text,
  status text NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(package_id, version)
);

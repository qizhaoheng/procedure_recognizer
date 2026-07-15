-- PIR 1.1.0 + Plan Executor + 质量门（与文件存储 normalizeStoredTask 语义一致）。
-- 当前运行时持久化为文件系统；本脚本供 PostgreSQL 部署时保持同构 schema。

-- 程序类别放开 APPROACH，禁止将进近伪装为 STAR
ALTER TABLE procedure_packages DROP CONSTRAINT IF EXISTS procedure_packages_category_check;
ALTER TABLE procedure_packages ADD CONSTRAINT procedure_packages_category_check
  CHECK (procedure_category IN ('SID','STAR','APPROACH'));

-- PIR 版本与新增语义集合
ALTER TABLE procedure_results ADD COLUMN IF NOT EXISTS pir_schema_version text NOT NULL DEFAULT '1.1.0';
ALTER TABLE procedure_results ADD COLUMN IF NOT EXISTS approach_type text;
ALTER TABLE procedure_results ADD COLUMN IF NOT EXISTS runway_data_json jsonb NOT NULL DEFAULT '[]';
ALTER TABLE procedure_results ADD COLUMN IF NOT EXISTS minima_json jsonb NOT NULL DEFAULT '[]';
ALTER TABLE procedure_results ADD COLUMN IF NOT EXISTS conflicts_json jsonb NOT NULL DEFAULT '[]';
ALTER TABLE procedure_results ADD COLUMN IF NOT EXISTS quality_gate text; -- COMPLETED / COMPLETED_WITH_WARNINGS / REQUIRES_REVIEW

-- Plan 执行审计：动作级模型调用与工具调用记录
CREATE TABLE IF NOT EXISTS plan_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_id uuid NOT NULL,
  package_id uuid NOT NULL,
  sequence integer NOT NULL,
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETED','FAILED','SKIPPED')),
  appended boolean NOT NULL DEFAULT false,
  model_call_ids jsonb NOT NULL DEFAULT '[]',
  tool_call_count integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_step_exec_procedure_idx ON plan_step_executions(procedure_id);

-- 字段级证据：documentId/bbox/裁剪图/来源模型调用与计划动作
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS document_id uuid;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS bbox jsonb;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS image_crop_path text;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS model_call_id uuid;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS plan_action text;

-- 原图叠加校验轮次
CREATE TABLE IF NOT EXISTS overlay_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_id uuid NOT NULL,
  round integer NOT NULL,
  status text NOT NULL CHECK (status IN ('VERIFIED','NOT_GEOREFERENCED','NOT_COMPARABLE','FAILED')),
  control_points integer,
  mean_residual_px numeric(8,2),
  overlay_image_path text,
  deviations_json jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Jeppesen 参考对比报告
CREATE TABLE IF NOT EXISTS jeppesen_compare_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_id uuid NOT NULL,
  match_rate numeric(5,3),
  total_legs integer NOT NULL,
  matched_legs integer NOT NULL,
  partial_legs integer NOT NULL,
  mismatched_legs integer NOT NULL,
  report_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

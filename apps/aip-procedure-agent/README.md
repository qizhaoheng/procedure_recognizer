# AIP AD-2 自主识别引擎

面向“机场文件集”的 AD-2 识别流程，挂载在现有 Express 服务的 `/api/agent` 下。任务支持一次上传多个 PDF，先由 AI 在全部文件范围内形成逻辑飞行程序包，经用户确认后为每个程序包单独制定识别计划，最后产出 PIR、GeoJSON 和 ARINC 424 Candidate。

## 运行

```bash
npm run dev
```

- 前端：`http://localhost:3307/autonomous-recognition`
- 后端：`http://localhost:3317/api/agent`
- 本地持久化：`server/data/aip-procedure-agent`
- PostgreSQL 部署：依次执行 `migrations/001_agent_recognition.sql` 和 `migrations/002_airport_multidocument_workflow.sql`

复用现有 `LLM_PROVIDER`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`LLM_ENDPOINT_TYPE`、`LLM_TIMEOUT_MS`、`LLM_MAX_RETRIES`、`LLM_STRUCTURED_OUTPUT_MODE` 与 `LLM_IMAGE_MODE`。可选限制为 `AGENT_MAX_MODEL_CALLS` 和 `AGENT_MAX_IMAGES`。

## 产品流程

1. 新建机场识别任务，选择或拖入多个 PDF。
2. 在上传页确认文件，可继续追加或在分析前删除。
3. AI 跨文件分析页面关系，生成 SID、STAR、APPROACH 程序包；此阶段不会自动执行程序识别。
4. 用户调整程序名、类型、跑道和页面归属，或重新分析。
5. AI 针对选定程序包生成独立识别计划，再执行 PIR 识别、校验、GeoJSON 和 424 编译。
6. 结果页联动显示程序包、地图航段、结构化字段和 424 Candidate；原始 GeoJSON 只在次级弹窗中提供。

## 主要 API

- `POST /tasks`：multipart 多文件创建任务，文件字段可使用 `files`（兼容 `file`）。
- `POST /tasks/:id/documents`、`DELETE /tasks/:id/documents/:documentId`：追加/删除 PDF。
- `POST /tasks/:id/analyze`：跨文件程序包分析。
- `GET /tasks/:id/packages`：读取程序包。
- `PATCH /packages/:id`、`POST /packages/:id/merge`、`POST /packages/:id/split`：人工调整。
- `POST /packages/:id/plan`：生成该程序包的 AI 识别计划。
- `POST /packages/:id/recognize`、`POST /tasks/:id/packages/recognize`：单包或批量识别；包级失败互相隔离。
- `GET /packages/:id/result|geojson|424`：读取结果与导出物。

## 验证

```bash
npm test
npx tsc -p tsconfig.server.json
npm run build
```

424 输出是候选数据，并执行编译后解析回读；缺少必填字段时返回 `424_INCOMPLETE` 和具体原因，不伪造记录。

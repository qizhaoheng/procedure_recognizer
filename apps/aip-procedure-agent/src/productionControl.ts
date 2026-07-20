import crypto from "node:crypto";
import type {
  AgentProcedure,
  AgentTask,
  BusinessProcedurePackage,
  ProcedurePIR,
  ProductionExceptionDecision,
  ProductionRelease,
  ValidationResult,
} from "./domain";

export type ProductionDisposition =
  | "PENDING"
  | "AUTO_PASS"
  | "HUMAN_CONFIRMED"
  | "REVIEW_REQUIRED"
  | "BLOCKED";

export type ProductionExceptionOwner = "DATA_CODER" | "CHART_SPECIALIST";

export interface ProductionException {
  exceptionId: string;
  packageId: string;
  procedureId?: string;
  procedureName: string;
  code: string;
  severity: "BLOCKER" | "REVIEW" | "WARNING";
  source: "WORKFLOW" | "PREFLIGHT" | "VALIDATION" | "CONFLICT" | "QUALITY" | "OUTPUT" | "EVIDENCE";
  owner: ProductionExceptionOwner;
  fieldPath?: string;
  message: string;
  evidence: string[];
  decision?: ProductionExceptionDecision;
}

export interface PackageProductionAssessment {
  packageId: string;
  procedureId?: string;
  procedureName: string;
  category: BusinessProcedurePackage["procedureCategory"];
  disposition: ProductionDisposition;
  autoPassEligible: boolean;
  evidenceCoverage: number | null;
  exceptions: ProductionException[];
}

export interface TaskProductionSummary {
  taskId: string;
  airportIcao?: string | null;
  totalPackages: number;
  pendingPackages: number;
  autoPassPackages: number;
  humanConfirmedPackages: number;
  reviewPackages: number;
  blockedPackages: number;
  completedPackages: number;
  autoPassRate: number | null;
  releaseReady: boolean;
  openExceptionCount: number;
  fingerprint: string;
  latestRelease?: ProductionRelease;
  releaseCurrent: boolean;
  assessments: PackageProductionAssessment[];
}

/**
 * V4 production gate. This is deliberately deterministic: model confidence and
 * lifecycle labels may contribute evidence, but neither can declare a package
 * production-ready by itself.
 */
export function assessTaskForProduction(task: AgentTask): TaskProductionSummary {
  const latest = latestProcedures(task.procedures);
  const decisions = latestExceptionDecisions(task);
  const assessments = task.packages.map((pkg) =>
    assessPackageForProduction(pkg, latest.get(pkg.packageId), decisions),
  );
  const completed = assessments.filter((item) => item.disposition !== "PENDING");
  const autoPassPackages = assessments.filter((item) => item.disposition === "AUTO_PASS").length;
  const humanConfirmedPackages = assessments.filter((item) => item.disposition === "HUMAN_CONFIRMED").length;
  const reviewPackages = assessments.filter((item) => item.disposition === "REVIEW_REQUIRED").length;
  const blockedPackages = assessments.filter((item) => item.disposition === "BLOCKED").length;
  const fingerprint = productionFingerprint(task);
  const latestRelease = [...(task.production?.releases ?? [])]
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt))[0];
  return {
    taskId: task.taskId,
    airportIcao: task.airportIcao ?? task.airportAnalysis?.airport.icao ?? null,
    totalPackages: assessments.length,
    pendingPackages: assessments.filter((item) => item.disposition === "PENDING").length,
    autoPassPackages,
    humanConfirmedPackages,
    reviewPackages,
    blockedPackages,
    completedPackages: completed.length,
    autoPassRate: completed.length ? Math.round((autoPassPackages / completed.length) * 1000) / 10 : null,
    releaseReady:
      assessments.length > 0 &&
      assessments.every((item) => ["AUTO_PASS", "HUMAN_CONFIRMED"].includes(item.disposition)),
    openExceptionCount: assessments.reduce(
      (count, item) => count + item.exceptions.filter((issue) =>
        issue.severity === "BLOCKER" || (issue.severity === "REVIEW" && issue.decision?.decision !== "CONFIRMED_CORRECT"),
      ).length,
      0,
    ),
    fingerprint,
    latestRelease,
    releaseCurrent: !!latestRelease && latestRelease.fingerprint === fingerprint,
    assessments,
  };
}

export function assessPackageForProduction(
  pkg: BusinessProcedurePackage,
  procedure?: AgentProcedure,
  decisions = new Map<string, ProductionExceptionDecision>(),
): PackageProductionAssessment {
  const exceptions: ProductionException[] = [];
  const add = (
    code: string,
    severity: ProductionException["severity"],
    source: ProductionException["source"],
    message: string,
    fieldPath = "",
    evidence: string[] = [],
  ) => {
    const exceptionId = `${pkg.packageId}:${code}:${fieldPath}`;
    exceptions.push({
    exceptionId,
    packageId: pkg.packageId,
    procedureId: procedure?.procedureId,
    procedureName: pkg.procedureName,
    code,
    severity,
    source,
    owner: ownerFor(code, fieldPath),
    fieldPath: fieldPath || undefined,
    message,
    evidence,
    decision: decisions.get(exceptionId)?.procedureVersion === procedure?.version
      ? decisions.get(exceptionId)
      : undefined,
  });
  };

  if (pkg.status === "FAILED" || procedure?.status === "FAILED") {
    add("RECOGNITION_FAILED", "BLOCKER", "WORKFLOW", "程序识别失败，必须修复或重新识别后才能生产。");
  }
  for (const issue of pkg.preflight?.blockingIssues ?? []) {
    add(issue.code, "BLOCKER", "PREFLIGHT", issue.message, issue.page ? `pages[${issue.page}]` : "");
  }
  for (const warning of pkg.preflight?.warnings ?? []) {
    add(warning.code, "WARNING", "PREFLIGHT", warning.message, warning.page ? `pages[${warning.page}]` : "");
  }

  if (!procedure || procedure.status === "PENDING" || procedure.status === "RUNNING") {
    return result(
      pkg,
      procedure,
      exceptions.some((item) => item.severity === "BLOCKER") ? "BLOCKED" : "PENDING",
      null,
      exceptions,
    );
  }
  if (!procedure.pir) {
    add("PIR_MISSING", "BLOCKER", "OUTPUT", "识别完成但没有Canonical PIR产物。");
    return result(pkg, procedure, "BLOCKED", null, exceptions);
  }

  addValidationExceptions(procedure.validations, add);
  const pir = procedure.pir;
  for (const conflict of pir.conflicts.filter((item) => item.status === "OPEN")) {
    add("OPEN_CONFLICT", "REVIEW", "CONFLICT", conflict.reason || "字段存在多个未解决候选值。", conflict.fieldPath, conflict.candidates.flatMap((item) => item.evidence));
  }
  for (const fieldPath of pir.quality.unresolvedFields) {
    add("UNRESOLVED_FIELD", "REVIEW", "QUALITY", "关键字段尚未解决。", fieldPath);
  }
  if (pir.quality.reviewRequired) {
    add("QUALITY_REVIEW_REQUIRED", "REVIEW", "QUALITY", "Canonical结果要求人工复核。");
  }
  if (pir.quality.confidence < 0.9) {
    add("LOW_CONFIDENCE", "REVIEW", "QUALITY", `整体质量置信度 ${pir.quality.confidence.toFixed(2)} 低于V4生产门槛0.90。`, "quality.confidence");
  }

  const evidenceCoverage = criticalEvidenceCoverage(pir);
  if (evidenceCoverage < 1) {
    add("CRITICAL_EVIDENCE_INCOMPLETE", "REVIEW", "EVIDENCE", `关键航段与航路点证据覆盖率为 ${(evidenceCoverage * 100).toFixed(1)}%，生产门要求100%。`, "sourceEvidence");
  }

  const candidate = procedure.candidate424;
  if (!candidate || candidate.status === "424_INCOMPLETE" || !candidate.text.trim()) {
    add("ARINC424_INCOMPLETE", "BLOCKER", "OUTPUT", candidate?.missingFields.join("；") || "没有可导入的424文本。", "candidate424");
  } else {
    if (!['424_CANDIDATE', '424_CONFIRMED'].includes(candidate.status)) {
      add("ARINC424_NOT_ROUNDTRIP_CLEAN", "BLOCKER", "OUTPUT", `424产物状态为${candidate.status}，尚未通过字段级往返校验。`, "candidate424.status");
    }
    if (candidate.generatedBy === "AI") {
      add("ARINC424_AI_GENERATED", "BLOCKER", "OUTPUT", "最终424文本由模型直接生成；V4放行只接受确定性编译产物。", "candidate424.generatedBy");
    }
    const roundTrip = candidate.roundTrip as { matched?: boolean; fieldMismatches?: unknown[] } | undefined;
    if (roundTrip && (roundTrip.matched === false || (roundTrip.fieldMismatches?.length ?? 0) > 0)) {
      add("ARINC424_ROUNDTRIP_MISMATCH", "BLOCKER", "OUTPUT", "424编译后回读存在字段差异。", "candidate424.roundTrip");
    }
  }

  const disposition = exceptions.some((item) => item.severity === "BLOCKER")
    ? "BLOCKED"
    : exceptions.some((item) => item.severity === "REVIEW" && item.decision?.decision !== "CONFIRMED_CORRECT")
      ? "REVIEW_REQUIRED"
      : exceptions.some((item) => item.severity === "REVIEW")
        ? "HUMAN_CONFIRMED"
        : "AUTO_PASS";
  return result(pkg, procedure, disposition, evidenceCoverage, exceptions);
}

function addValidationExceptions(
  validations: ValidationResult[],
  add: (code: string, severity: ProductionException["severity"], source: ProductionException["source"], message: string, fieldPath?: string, evidence?: string[]) => void,
) {
  for (const validation of validations) {
    if (validation.severity === "INFO") continue;
    add(
      validation.ruleCode,
      validation.severity === "BLOCKER" ? "BLOCKER" : validation.severity === "ERROR" ? "REVIEW" : "WARNING",
      "VALIDATION",
      validation.message,
      validation.fieldPath,
      validation.evidence,
    );
  }
}

function criticalEvidenceCoverage(pir: ProcedurePIR) {
  const evidenceIds = new Set(pir.sourceEvidence.map((item) => item.evidenceId));
  const required = [
    ...pir.legs.map((leg) => leg.evidence),
    ...pir.fixes.filter((fix) => fix.allowFor424 !== false).map((fix) => fix.evidence),
  ];
  if (!required.length) return 0;
  const covered = required.filter((refs) => refs.length > 0 && refs.some((id) => evidenceIds.has(id))).length;
  return covered / required.length;
}

function result(
  pkg: BusinessProcedurePackage,
  procedure: AgentProcedure | undefined,
  disposition: ProductionDisposition,
  evidenceCoverage: number | null,
  exceptions: ProductionException[],
): PackageProductionAssessment {
  return {
    packageId: pkg.packageId,
    procedureId: procedure?.procedureId,
    procedureName: pkg.procedureName,
    category: pkg.procedureCategory,
    disposition,
    autoPassEligible: ["AUTO_PASS", "HUMAN_CONFIRMED"].includes(disposition),
    evidenceCoverage,
    exceptions,
  };
}

export function productionFingerprint(task: AgentTask) {
  const latest = latestProcedures(task.procedures);
  const value = {
    airportIcao: task.airportIcao ?? task.airportAnalysis?.airport.icao ?? null,
    packages: task.packages.map((pkg) => ({
      packageId: pkg.packageId,
      status: pkg.status,
      preflight: pkg.preflight,
      procedure: latest.has(pkg.packageId)
        ? {
            procedureId: latest.get(pkg.packageId)!.procedureId,
            version: latest.get(pkg.packageId)!.version,
            status: latest.get(pkg.packageId)!.status,
            pir: latest.get(pkg.packageId)!.pir,
            candidate424: latest.get(pkg.packageId)!.candidate424,
            validations: latest.get(pkg.packageId)!.validations,
          }
        : null,
    })),
    decisions: [...latestExceptionDecisions(task).values()]
      .map(({ exceptionId, packageId, procedureId, procedureVersion, decision }) => ({ exceptionId, packageId, procedureId, procedureVersion, decision }))
      .sort((a, b) => a.exceptionId.localeCompare(b.exceptionId)),
  };
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function latestExceptionDecisions(task: AgentTask) {
  const latest = new Map<string, ProductionExceptionDecision>();
  for (const decision of task.production?.exceptionDecisions ?? []) {
    const current = latest.get(decision.exceptionId);
    if (!current || decision.decidedAt >= current.decidedAt) latest.set(decision.exceptionId, decision);
  }
  return latest;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function latestProcedures(procedures: AgentProcedure[]) {
  const latest = new Map<string, AgentProcedure>();
  for (const procedure of procedures) {
    const current = latest.get(procedure.packageId);
    if (!current || procedure.version > current.version) latest.set(procedure.packageId, procedure);
  }
  return latest;
}

function ownerFor(code: string, fieldPath: string): ProductionExceptionOwner {
  return /CHART|GEOMETRY|COURSE|DISTANCE|RF|AF|HOLD|FIX|LEG|ROUTE|TOPOLOGY/i.test(`${code} ${fieldPath}`)
    ? "CHART_SPECIALIST"
    : "DATA_CODER";
}

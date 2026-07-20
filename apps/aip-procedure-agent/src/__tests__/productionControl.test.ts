import assert from "node:assert/strict";
import test from "node:test";
import { compile424Candidate } from "../compiler";
import type {
  AgentProcedure,
  AgentTask,
  BusinessProcedurePackage,
  ProcedurePIR,
} from "../domain";
import {
  assessPackageForProduction,
  assessTaskForProduction,
} from "../productionControl";

test("a recognized package is not production-ready merely because its lifecycle says completed", () => {
  const pkg = samplePackage();
  const result = assessPackageForProduction(pkg, undefined);
  assert.equal(result.disposition, "PENDING");
  assert.equal(result.autoPassEligible, false);
});

test("source preflight blockers surface before recognition starts", () => {
  const pkg = samplePackage();
  pkg.preflight = {
    preflightPassed: false,
    checkedAt: "2026-07-20T00:00:00.000Z",
    blockingIssues: [{ code: "CHART_MISSING", message: "缺少程序图" }],
    warnings: [],
  };
  const result = assessPackageForProduction(pkg, undefined);
  assert.equal(result.disposition, "BLOCKED");
  assert.ok(result.exceptions.some((item) => item.code === "CHART_MISSING"));
});

test("deterministically compiled, evidenced and clean output is eligible for auto-pass", () => {
  const pir = samplePir();
  const procedure = sampleProcedure(pir);
  const result = assessPackageForProduction(samplePackage(), procedure);
  assert.equal(result.disposition, "AUTO_PASS", JSON.stringify(result.exceptions));
  assert.equal(result.evidenceCoverage, 1);
});

test("model-authored 424 text is routed to review instead of auto-pass", () => {
  const pir = samplePir();
  const procedure = sampleProcedure(pir);
  procedure.candidate424!.generatedBy = "AI";
  const result = assessPackageForProduction(samplePackage(), procedure);
  assert.equal(result.disposition, "REVIEW_REQUIRED");
  assert.ok(result.exceptions.some((item) => item.code === "ARINC424_AI_GENERATED"));
});

test("a blocker prevents production even when a 424 artifact exists", () => {
  const pir = samplePir();
  const procedure = sampleProcedure(pir);
  procedure.validations.push({
    ruleCode: "ALT_RANGE",
    severity: "BLOCKER",
    fieldPath: "legs[0].altitudeConstraint",
    message: "高度非法",
    evidence: ["e3"],
    autoRepairable: false,
  });
  const result = assessPackageForProduction(samplePackage(), procedure);
  assert.equal(result.disposition, "BLOCKED");
});

test("task production summary measures automatic coverage and release readiness", () => {
  const task = sampleTask();
  const readyPir = samplePir();
  const reviewPir = samplePir();
  reviewPir.quality.reviewRequired = true;
  const ready = samplePackage("ready");
  const review = samplePackage("review");
  task.packages = [ready, review];
  task.procedures = [sampleProcedure(readyPir, "ready"), sampleProcedure(reviewPir, "review")];
  const summary = assessTaskForProduction(task);
  assert.equal(summary.autoPassPackages, 1);
  assert.equal(summary.reviewPackages, 1);
  assert.equal(summary.autoPassRate, 50);
  assert.equal(summary.releaseReady, false);
});

function sampleTask(): AgentTask {
  return {
    taskId: "task",
    taskType: "AGENT_AD2_RECOGNITION",
    taskName: "production",
    status: "COMPLETED",
    stage: "RESULTS_READY",
    progress: 100,
    completedProcedures: 0,
    totalProcedures: 0,
    warningCount: 0,
    errorCount: 0,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    documents: [],
    pages: [],
    packages: [],
    procedures: [],
    steps: [],
    modelCalls: [],
  };
}

function samplePackage(id = "pkg"): BusinessProcedurePackage {
  return {
    packageId: id,
    procedureKey: id,
    category: "SID",
    procedureCategory: "SID",
    procedureName: `TEST ${id.toUpperCase()}`,
    runways: ["02L"],
    packagePages: [],
    groupingConfidence: 1,
    groupingReason: "test",
    status: "COMPLETED",
    sources: {
      primaryCharts: [], procedureTables: [], coordinateTables: [], runwayPages: [],
      navaidPages: [], sharedNotes: [], profilePages: [], minimaPages: [], relatedPages: [],
    },
    confidence: 1,
    warnings: [],
  };
}

function sampleProcedure(pir: ProcedurePIR, packageId = "pkg"): AgentProcedure {
  return {
    procedureId: `procedure-${packageId}`,
    packageId,
    version: 1,
    pir,
    geojson: { type: "FeatureCollection", features: [] },
    candidate424: compile424Candidate(pir),
    validations: [],
    status: "COMPLETED",
  };
}

function samplePir(): ProcedurePIR {
  return {
    schemaVersion: "1.1.0",
    airport: { icao: "WSSS", name: "Singapore" },
    procedure: { category: "SID", identifier: "TEST1A", name: "TEST ONE ALPHA", runways: ["02L"] },
    routes: [{ routeId: "r1", routeType: "RUNWAY_TRANSITION", identifier: "RW02L", runway: "02L", legIds: ["l1"], sequence: 1 }],
    fixes: [
      { fixId: "a", identifier: "AAAAA", type: "WAYPOINT", latitude: 1.3, longitude: 103.8, coordinateSourceType: "EXPLICIT_TABLE", evidence: ["e1"], confidence: 0.99, status: "CONFIRMED", allowFor424: true },
      { fixId: "b", identifier: "BBBBB", type: "WAYPOINT", latitude: 1.4, longitude: 103.9, coordinateSourceType: "EXPLICIT_TABLE", evidence: ["e2"], confidence: 0.99, status: "CONFIRMED", allowFor424: true },
    ],
    legs: [{ legId: "l1", sequence: 10, routeId: "r1", pathTerminator: "TF", fromFixId: "a", toFixId: "b", course: 45, courseReference: "MAGNETIC", distanceNm: 8, openEnded: false, evidence: ["e3"], confidence: 0.99, fieldStatus: { pathTerminator: "CONFIRMED" }, warnings: [] }],
    runwayData: [],
    minima: [],
    notes: [],
    sourceEvidence: [
      { evidenceId: "e1", pageNumber: 1, sourceType: "TABLE", extractionMethod: "NATIVE_TEXT", confidence: 1 },
      { evidenceId: "e2", pageNumber: 1, sourceType: "TABLE", extractionMethod: "NATIVE_TEXT", confidence: 1 },
      { evidenceId: "e3", pageNumber: 2, sourceType: "CHART", extractionMethod: "VISION", confidence: 1 },
    ],
    conflicts: [],
    validation: { results: [] },
    quality: { confidence: 0.99, reviewRequired: false, unresolvedFields: [] },
  };
}

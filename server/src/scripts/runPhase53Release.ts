import { runPhase52GoldenPipelines } from '../services/recognition-v2/evaluation/phase52GoldenPipelineRunner';

const args = new Set(process.argv.slice(2));
const useModel = args.has('--use-model');
const selected = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const { report, reportDir } = await runPhase52GoldenPipelines({
  baseUrl: process.env.RECOGNITION_V2_BASE_URL,
  useModel,
  model: process.env.RECOGNITION_V2_MODEL,
  caseIds: selected.length ? selected : undefined,
  phase: 'phase5.3',
});

console.log(JSON.stringify({
  reportDir,
  summary: report.summary,
  cases: report.cases.map((item) => ({
    caseId: item.caseId,
    score: item.score,
    topologyPassed: item.topologyPassed,
    releaseDecision: item.releaseDecision,
    reviewIssueCount: item.reviewIssueCount,
    runId: item.runId,
    blockers: item.failureReasons.map((failure) => failure.code),
  })),
}, null, 2));

import { callModel } from './modelGateway';
import type { AgentTask, BusinessProcedurePackage, PageAsset, ProcedurePIR, ValidationResult } from './domain';
import type { AiInputImage } from '../../../server/src/services/llm/llmClient';

/**
 * 结果完整性核查：拿源页图像直接问"源上有什么、结果里没有什么"。
 *
 * 与 chart-overlay-verifier 的分工：那个把识别出的航迹叠回原图比几何，依赖配准
 * （WMKJ 实测 0 个控制点直接放弃）；这个不依赖配准，直接读页面，覆盖程序/航路/腿/
 * 约束/等待/最低标准的有无。确定性校验查的是"值合不合规"，这里查的是"东西缺没缺"——
 * 后者代码做不到，因为它要求看得懂源页。
 *
 * 有意不把它的结论当作推翻识别的依据：它与被查对象同源（都是模型），
 * 因此产出一律进 validations 供人复核，最高只到 ERROR，不直接判 BLOCKER。
 */

export interface CompletenessFinding {
  kind: string;
  severity: 'BLOCKER' | 'ERROR' | 'WARNING' | 'INFO';
  subject: string;
  detail: string;
  pageNumber?: number | null;
  legId?: string | null;
  fixIdentifier?: string | null;
}

export interface CompletenessAudit {
  findings: CompletenessFinding[];
  readablePages: Array<{ pageNumber: number; readable: boolean; note?: string | null }>;
  completeness: 'COMPLETE' | 'INCOMPLETE' | 'NOT_ASSESSABLE';
  decisionSummary: string;
}

export async function auditResultCompleteness(
  task: AgentTask,
  pkg: BusinessProcedurePackage,
  pir: ProcedurePIR,
  pages: PageAsset[],
  images: AiInputImage[],
  context: { arinc424Text?: string; geometrySummary?: unknown; procedureId?: string },
  signal: AbortSignal,
): Promise<CompletenessAudit> {
  const sourcePages = pages.map((page) => {
    const ref = pkg.packagePages.find((item) => item.documentId === page.documentId && item.pageNumber === page.pageNumber);
    return { pageNumber: page.pageNumber, role: ref?.pageRole || 'RELATED' };
  });
  const { parsed } = await callModel(
    task,
    'result-completeness-verifier',
    {
      // 页面是共享的，被审对象必须点名，否则核查器会按整页要求结果——
      // 实测它因此报出"SABKA 1J 缺失"，而 SABKA 1J 本就属于另一个包。
      procedureUnderAudit: { name: pir.procedure.name, identifier: pir.procedure.identifier, category: pir.procedure.category, runways: pir.procedure.runways },
      airport: pir.airport,
      sourcePages,
      pir,
      arinc424: context.arinc424Text || '(no records were generated)',
      geometrySummary: context.geometrySummary ?? {},
    },
    images,
    `RESULT_COMPLETENESS_AUDIT:${pkg.procedureKey}`,
    signal,
    { planAction: 'VALIDATE_AGAINST_SOURCE_CHART', procedureId: context.procedureId },
  );

  return {
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    readablePages: Array.isArray(parsed.readablePages) ? parsed.readablePages : [],
    completeness: parsed.completeness === 'COMPLETE' || parsed.completeness === 'NOT_ASSESSABLE' ? parsed.completeness : 'INCOMPLETE',
    decisionSummary: String(parsed.decisionSummary || ''),
  };
}

export function completenessFindingsToValidations(audit: CompletenessAudit): ValidationResult[] {
  // 页面读不了就等于"不知道"，不是"结果有问题"——这种情况下模型不该报 finding，
  // 万一报了也降为提示，避免拿看不清的页去否定识别结果。
  const unreadable = new Set(audit.readablePages.filter((page) => !page.readable).map((page) => page.pageNumber));
  return audit.findings.map((finding) => ({
    ruleCode: `SOURCE_COMPLETENESS_${finding.kind}`,
    // 同源校验不得直接拒出：最高 ERROR，BLOCKER 留给确定性规则。
    severity: unreadable.has(finding.pageNumber ?? -1) ? 'WARNING' : downgradeBlocker(finding.severity),
    fieldPath: finding.legId ? `legs.${finding.legId}` : finding.fixIdentifier ? `fixes.${finding.fixIdentifier}` : '',
    message: `${finding.subject}: ${finding.detail}${finding.pageNumber ? ` (source page ${finding.pageNumber})` : ''}`,
    evidence: [],
    autoRepairable: false,
  }));
}

function downgradeBlocker(severity: CompletenessFinding['severity']): ValidationResult['severity'] {
  return severity === 'BLOCKER' ? 'ERROR' : severity;
}

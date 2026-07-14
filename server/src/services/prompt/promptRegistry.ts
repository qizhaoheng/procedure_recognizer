import type { PromptTemplate } from './promptTypes';

const VERSION = '1.7.0';
const DATE = '2026-07-13T00:00:00.000Z';

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  template('generic_procedure_v1', 'Generic Procedure Understanding', 'GENERIC', ['UNKNOWN'], 'generic-procedure.prompt.md'),
  template('rnav_star_v1', 'RNAV STAR Procedure Understanding', 'STAR', ['RNAV'], 'rnav-star.prompt.md'),
  template('dme_arc_star_v1', 'DME ARC STAR Procedure Understanding', 'STAR', ['DME_ARC'], 'dme-arc-star.prompt.md', 'dme-arc-star-wmkj-example.md'),
  template('rnav_sid_v1', 'RNAV SID Procedure Understanding', 'SID', ['RNAV'], 'rnav-sid.prompt.md', 'rnav-sid-wmkj-example.md'),
  template('conventional_sid_v1', 'Conventional SID Procedure Understanding', 'SID', ['CONVENTIONAL'], 'conventional-sid.prompt.md', 'conventional-sid-wmkj-example.md'),
  template('ils_loc_approach_v1', 'ILS/LOC Approach Procedure Understanding', 'APPROACH', ['ILS', 'LOC', 'ILS_LOC'], 'ils-loc-approach.prompt.md'),
  template('vor_approach_v1', 'VOR Approach Procedure Understanding', 'APPROACH', ['VOR'], 'vor-approach.prompt.md'),
  template('rnp_approach_v1', 'RNP Approach Procedure Understanding', 'APPROACH', ['RNP'], 'rnp-approach.prompt.md'),
  template('rnp_ar_approach_v1', 'RNP AR Approach Procedure Understanding', 'APPROACH', ['RNP_AR'], 'rnp-ar-approach.prompt.md'),
];

export function listPromptTemplates() {
  return PROMPT_TEMPLATES.filter((template) => template.status === 'ACTIVE');
}

export function getPromptTemplate(id: string) {
  const found = PROMPT_TEMPLATES.find((template) => template.id === id);
  if (!found) throw new Error(`Prompt template not found: ${id}`);
  return found;
}

function template(
  id: string,
  name: string,
  packageType: PromptTemplate['packageType'],
  navigationTypes: string[],
  templatePath: string,
  examplePath?: string,
): PromptTemplate {
  return {
    id,
    name,
    version: VERSION,
    packageType,
    navigationTypes,
    templatePath,
    examplePath,
    outputSchemaName: 'procedure-understanding.schema.json',
    outputSchemaVersion: VERSION,
    status: 'ACTIVE',
    createdAt: DATE,
    updatedAt: DATE,
  };
}

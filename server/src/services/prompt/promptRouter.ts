import type { ProcedureGroup } from '../../types/procedure';
import { getPromptTemplate } from './promptRegistry';

export function routePromptTemplate(procedurePackage: ProcedureGroup, templateOverrideId?: string) {
  if (templateOverrideId) return getPromptTemplate(templateOverrideId);

  const packageType = packageTypeFor(procedurePackage);
  const navigationType = String(procedurePackage.navigationType || 'UNKNOWN').toUpperCase();

  if (packageType === 'STAR' && navigationType === 'RNAV') return getPromptTemplate('rnav_star_v1');
  if (packageType === 'STAR' && navigationType === 'DME_ARC') return getPromptTemplate('dme_arc_star_v1');
  if (packageType === 'SID' && navigationType === 'RNAV') return getPromptTemplate('rnav_sid_v1');
  if (packageType === 'SID' && navigationType === 'CONVENTIONAL') return getPromptTemplate('conventional_sid_v1');
  if (packageType === 'APPROACH' && ['ILS', 'LOC', 'ILS_LOC'].includes(navigationType)) return getPromptTemplate('ils_loc_approach_v1');
  if (packageType === 'APPROACH' && navigationType === 'VOR') return getPromptTemplate('vor_approach_v1');
  if (packageType === 'APPROACH' && navigationType === 'RNP') return getPromptTemplate('rnp_approach_v1');
  if (packageType === 'APPROACH' && navigationType === 'RNP_AR') return getPromptTemplate('rnp_ar_approach_v1');

  return getPromptTemplate('generic_procedure_v1');
}

function packageTypeFor(procedurePackage: ProcedureGroup) {
  if (procedurePackage.packageType === 'STAR' || procedurePackage.packageType === 'SID' || procedurePackage.packageType === 'APPROACH') {
    return procedurePackage.packageType;
  }
  if (procedurePackage.procedureCategory === 'ARRIVAL') return 'STAR';
  if (procedurePackage.procedureCategory === 'DEPARTURE') return 'SID';
  if (procedurePackage.procedureCategory === 'APPROACH') return 'APPROACH';
  return 'GENERIC';
}

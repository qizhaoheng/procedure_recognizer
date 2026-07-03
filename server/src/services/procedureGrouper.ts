import type { PdfPageAsset } from '../types/procedure';
import { groupProcedurePackages } from './procedurePackageGrouper';

export function groupProcedures(pages: PdfPageAsset[]) {
  return groupProcedurePackages(pages);
}

export function regroupPages(pages: PdfPageAsset[]) {
  return groupProcedurePackages(pages);
}

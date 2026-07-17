export interface ProcedureTitleObservation {
  name: string;
  rawText: string;
}

export function extractProcedureNamesFromText(text: string): ProcedureTitleObservation[] {
  const normalized = text.toUpperCase().replace(/\s+/g, ' ');
  const matches: ProcedureTitleObservation[] = [];
  const patterns = [
    /TABULAR\s+DESCRIPTION\s*:\s*([A-Z][A-Z0-9]{1,7})\s+(\d{1,2}[A-Z])\s+RWY\s*\d{2}[LCR]?/g,
    /(?:RNAV(?:\s*\([^)]*\))?\s+)?([A-Z][A-Z0-9]{1,7})\s+(\d{1,2}[A-Z])\s+(?:SID|STAR)\s+RWY\s*\d{2}[LCR]?/g,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      matches.push({ name: `${match[1]} ${match[2]}`, rawText: match[0] });
    }
  }
  return [...new Map(matches.map((item) => [item.name, item])).values()];
}

# Output Rules — ProcedureUnderstanding JSON

- Output exactly ONE JSON object conforming to the supplied ProcedureUnderstanding JSON Schema.
- No markdown fences, no comments, no prose, no extra top-level keys.
- Fill ALL of these top-level fields — never output only procedures/fixes:
  procedureClassification, chartTexts, tableLegs, geometrySemantics, labelPlan, supportObjects,
  procedures, fixes, navaids, sourceEvidence, warnings, confidence, reviewRequired.
- Do NOT return GeoJSON or final map coordinates; return procedure semantics only.
- Keep procedure-package boundaries strict: do not mix procedures from other packages.
- Every key operational field must cite sourceEvidenceIds; each sourceEvidence item includes
  pageNo, evidenceType, fieldName, and rawText or visualDescription.
- Units: courses are MAG unless stated TRUE; distances are NM unless stated otherwise;
  altitudes are FT unless stated otherwise.

# Few-shot Example — WMKJ RWY16 11 DME ARC STAR

This example shows how a DME ARC STAR chart should be read. Learn the reading pattern and the
level of detail; do NOT copy these values into another chart's output.

## Input

- One CHART page: "RWY16 11 DME ARC STAR" for WMKJ (Senai/Johor Bahru), procedures EMTUV 1G / OMKOM 1G / PIMOK 1G / ADLOV 1G.
- One TABULAR page describing the same arrival legs.
- Supporting summaries: AD 2.19 navaids (VJB VOR/DME, JR NDB, IJB ILS/LOC), AD 2.12 runway data, AD 2.18 communications.

## Correct Stage 1 — procedureClassification

```json
{
  "packageType": "STAR",
  "procedureCategory": "ARRIVAL",
  "navigationType": "DME_ARC",
  "runway": "RWY16",
  "chartPurpose": "Conventional DME ARC standard arrival to RWY16 based on the VJB 11 DME arc",
  "procedureNames": ["EMTUV 1G", "OMKOM 1G", "PIMOK 1G", "ADLOV 1G"],
  "confidence": 0.95
}
```

## Correct Stage 2 — chartTexts

chartTexts must be EXHAUSTIVE: one entry per printed label instance. Note especially that every
transition's entry radial label and every printed "13D VJB" turn-point tag is listed — dropping
any of them is an error:

```json
[
  { "text": "11 DME ARC", "normalizedText": "11 DME ARC", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "13D VJB", "normalizedText": "13D VJB", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "13D VJB", "normalizedText": "13D VJB", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "13D VJB", "normalizedText": "13D VJB", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "13D VJB", "normalizedText": "13D VJB", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "VJB", "normalizedText": "VJB", "role": "NAVAID", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "RDL016 VJB", "normalizedText": "RDL016 VJB", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "RDL114 VJB", "normalizedText": "RDL114 VJB", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "RDL236 VJB", "normalizedText": "RDL236 VJB", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "RDL275 VJB", "normalizedText": "RDL275 VJB", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "RDL295 VJB", "normalizedText": "RDL295 VJB", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "RDL340 / 160", "normalizedText": "RDL340/160", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "L-R332", "normalizedText": "L-R332", "role": "LEAD_RADIAL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "L-R348", "normalizedText": "L-R348", "role": "LEAD_RADIAL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "EMTUV 1G", "normalizedText": "EMTUV 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "OMKOM 1G", "normalizedText": "OMKOM 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "PIMOK 1G", "normalizedText": "PIMOK 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "ADLOV 1G", "normalizedText": "ADLOV 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 }
]
```

(Plus the altitude/speed labels of each transition and any notes/MSA — list them all; this
example stops here only for brevity. The RDL / 13D entries above are NOT optional.)

## Correct Stage 4 — geometrySemantics

EVERY RDL label from chartTexts becomes one RADIAL entry — for this chart that means SIX RADIAL
entries (016 / 114 / 236 / 275 / 295 / 340), each with relatedProcedures naming the transition(s)
that use it. Two of them are shown; the remaining four follow the same shape:

```json
[
  {
    "type": "DME_ARC",
    "labelText": "11 DME ARC",
    "centerNavaid": "VJB",
    "radiusNm": 11,
    "radialDeg": null,
    "inboundTrackDeg": null,
    "direction": "UNKNOWN",
    "relatedProcedures": ["EMTUV 1G", "OMKOM 1G", "PIMOK 1G", "ADLOV 1G"],
    "sourcePageNo": 55,
    "confidence": 0.9,
    "reviewRequired": false
  },
  {
    "type": "RADIAL",
    "labelText": "RDL016 VJB",
    "centerNavaid": "VJB",
    "radiusNm": null,
    "radialDeg": 16,
    "inboundTrackDeg": 196,
    "direction": null,
    "relatedProcedures": ["ADLOV 1G"],
    "sourcePageNo": 55,
    "confidence": 0.9,
    "reviewRequired": false
  },
  {
    "type": "RADIAL",
    "labelText": "RDL340 / 160",
    "centerNavaid": "VJB",
    "radiusNm": null,
    "radialDeg": 340,
    "inboundTrackDeg": 160,
    "direction": null,
    "relatedProcedures": ["EMTUV 1G", "OMKOM 1G", "PIMOK 1G", "ADLOV 1G"],
    "sourcePageNo": 55,
    "confidence": 0.9,
    "reviewRequired": false
  },
  {
    "type": "LEAD_RADIAL",
    "labelText": "L-R332",
    "centerNavaid": "VJB",
    "radiusNm": null,
    "radialDeg": 332,
    "inboundTrackDeg": null,
    "direction": null,
    "relatedProcedures": ["EMTUV 1G", "OMKOM 1G"],
    "sourcePageNo": 55,
    "confidence": 0.85,
    "reviewRequired": false
  },
  {
    "type": "LEAD_RADIAL",
    "labelText": "L-R348",
    "centerNavaid": "VJB",
    "radiusNm": null,
    "radialDeg": 348,
    "inboundTrackDeg": null,
    "direction": null,
    "relatedProcedures": ["PIMOK 1G", "ADLOV 1G"],
    "sourcePageNo": 55,
    "confidence": 0.85,
    "reviewRequired": false
  },
  {
    "type": "COMMON_SEGMENT",
    "labelText": "RDL340 / 160 inbound to RWY16",
    "centerNavaid": "VJB",
    "radiusNm": null,
    "radialDeg": 340,
    "inboundTrackDeg": 160,
    "direction": null,
    "relatedProcedures": ["EMTUV 1G", "OMKOM 1G", "PIMOK 1G", "ADLOV 1G"],
    "sourcePageNo": 55,
    "confidence": 0.85,
    "reviewRequired": false
  }
]
```

## Correct Stage 3 — tableLegs (ADLOV 1G excerpt)

Every row of the tabular description page becomes one tableLeg. For the ADLOV 1G transition the
table describes: entry at ADLOV, track to the 13 DME fix on RDL016, intercept of the 11 DME arc,
the arc itself to RDL340, then the common inbound segment to OSRUP:

```json
[
  { "procedureName": "ADLOV 1G", "sequence": 10, "pathTerminator": "IF", "fromFix": null, "toFix": "ADLOV", "courseDeg": null, "distanceNm": null, "altitudeConstraint": "-6000", "turnDirection": null, "recommendedNavaid": "VJB", "remarks": "entry fix", "sourcePageNo": 56, "confidence": 0.9 },
  { "procedureName": "ADLOV 1G", "sequence": 20, "pathTerminator": "TF", "fromFix": "ADLOV", "toFix": "D016M", "courseDeg": null, "distanceNm": 12.0, "altitudeConstraint": "+3200", "turnDirection": null, "recommendedNavaid": null, "remarks": "to 13 DME fix on RDL016", "sourcePageNo": 56, "confidence": 0.85 },
  { "procedureName": "ADLOV 1G", "sequence": 30, "pathTerminator": "CI", "fromFix": "D016M", "toFix": null, "courseDeg": 196, "distanceNm": 2.0, "altitudeConstraint": null, "turnDirection": null, "recommendedNavaid": null, "remarks": "intercept 11 DME arc", "sourcePageNo": 56, "confidence": 0.8 },
  { "procedureName": "ADLOV 1G", "sequence": 40, "pathTerminator": "AF", "fromFix": null, "toFix": "D340K", "courseDeg": null, "distanceNm": 6.9, "altitudeConstraint": null, "turnDirection": "L", "recommendedNavaid": "VJB", "remarks": "11 DME arc VJB to RDL340", "sourcePageNo": 56, "confidence": 0.85 },
  { "procedureName": "ADLOV 1G", "sequence": 50, "pathTerminator": "TF", "fromFix": "D340K", "toFix": "OSRUP", "courseDeg": 160, "distanceNm": 2.3, "altitudeConstraint": "+2000", "turnDirection": null, "recommendedNavaid": null, "remarks": "common inbound RDL340/160", "sourcePageNo": 56, "confidence": 0.85 }
]
```

## Correct Stage 5 — the leg chain your tableLegs must describe (ADLOV 1G)

The pipeline assembles procedures[].legs from your tableLegs rows, so procedures[].legs may be
left as [] — but every leg below must exist as a tableLegs row. Note: D-fix names encode
radial + DME distance (D016M = RDL016 at 13 DME, D340K = RDL340 at 11 DME); the CI course is the
inbound course of the entry radial (016 + 180 = 196); the AF leg carries the arc turn direction
(L = counterclockwise around VJB). turnDirection stays null on IF/TF legs because the table
states no turn:

```json
{
  "procedureName": "ADLOV 1G",
  "runway": "RWY16",
  "navigationSpec": null,
  "legs": [
    { "sequence": 10, "pathTerminator": "IF", "fromFix": null, "fixIdentifier": "ADLOV", "courseDegMag": null, "distanceNm": null, "turnDirection": null, "altitudeConstraint": { "type": "AT_OR_BELOW", "altitudeFt": 6000, "lowerFt": null, "upperFt": null, "rawText": "-6000" }, "speedLimitKias": null, "navigationSpec": null, "recommendedNavaid": "VJB", "derivationMethod": "table row 1 + chart entry fix label", "sourceEvidenceIds": ["ev_table_adlov1g_010"], "confidence": 0.9, "reviewRequired": false },
    { "sequence": 20, "pathTerminator": "TF", "fromFix": "ADLOV", "fixIdentifier": "D016M", "courseDegMag": null, "distanceNm": 12.0, "turnDirection": null, "altitudeConstraint": { "type": "AT_OR_ABOVE", "altitudeFt": 3200, "lowerFt": null, "upperFt": null, "rawText": "+3200" }, "speedLimitKias": null, "navigationSpec": null, "derivationMethod": "table row 2; D-fix named from RDL016 at the 13 DME label", "sourceEvidenceIds": ["ev_table_adlov1g_020"], "confidence": 0.85, "reviewRequired": false },
    { "sequence": 30, "pathTerminator": "CI", "fromFix": "D016M", "fixIdentifier": null, "courseDegMag": 196, "distanceNm": 2.0, "turnDirection": null, "altitudeConstraint": null, "speedLimitKias": null, "navigationSpec": null, "derivationMethod": "course = RDL016 inbound (016+180); distance = 13 DME − 11 DME", "sourceEvidenceIds": ["ev_table_adlov1g_030"], "confidence": 0.8, "reviewRequired": false },
    { "sequence": 40, "pathTerminator": "AF", "fromFix": null, "fixIdentifier": "D340K", "courseDegMag": null, "distanceNm": 6.9, "turnDirection": "L", "altitudeConstraint": null, "speedLimitKias": null, "navigationSpec": null, "recommendedNavaid": "VJB", "derivationMethod": "11 DME arc around VJB from RDL016 intercept to RDL340; arc drawn counterclockwise", "sourceEvidenceIds": ["ev_chart_arc", "ev_table_adlov1g_040"], "confidence": 0.85, "reviewRequired": false },
    { "sequence": 50, "pathTerminator": "TF", "fromFix": "D340K", "fixIdentifier": "OSRUP", "courseDegMag": 160, "distanceNm": 2.3, "turnDirection": null, "altitudeConstraint": { "type": "AT_OR_ABOVE", "altitudeFt": 2000, "lowerFt": null, "upperFt": null, "rawText": "+2000" }, "speedLimitKias": null, "navigationSpec": null, "derivationMethod": "common segment RDL340/160 inbound", "sourceEvidenceIds": ["ev_table_adlov1g_050"], "confidence": 0.85, "reviewRequired": false }
  ],
  "sourceEvidenceIds": ["ev_chart_adlov1g", "ev_table_adlov1g"],
  "confidence": 0.85,
  "reviewRequired": false
}
```

The other transitions follow the same pattern with their own radials (EMTUV via RDL275, OMKOM via
RDL114, PIMOK via RDL236).

IMPORTANT — values are per transition, do not copy them across:
- "+3200" belongs to ADLOV 1G's leg 020 ONLY. The other transitions have their own value on that
  leg position (possibly a different number, possibly none). Read each from its own table row.
- The entry-fix (IF) altitude also differs per transition; some entry fixes have no altitude at all.

Arc split example — EMTUV 1G crosses RDL295 where a "+3400" constraint is printed on the arc, so
its arc is coded as TWO consecutive AF legs (clockwise, so turnDirection "R"), ending at the
constrained radial's D-fix first:

```json
[
  { "sequence": 40, "pathTerminator": "AF", "fromFix": null, "fixIdentifier": "D295K", "courseDegMag": null, "distanceNm": 3.8, "turnDirection": "R", "altitudeConstraint": { "type": "AT_OR_ABOVE", "altitudeFt": 3400, "lowerFt": null, "upperFt": null, "rawText": "+3400" }, "speedLimitKias": null, "navigationSpec": null, "recommendedNavaid": "VJB", "derivationMethod": "11 DME arc clockwise to RDL295 where +3400 is charted", "sourceEvidenceIds": ["ev_chart_arc_295"], "confidence": 0.85, "reviewRequired": false },
  { "sequence": 50, "pathTerminator": "AF", "fromFix": "D295K", "fixIdentifier": "D340K", "courseDegMag": null, "distanceNm": 8.6, "turnDirection": "R", "altitudeConstraint": null, "speedLimitKias": null, "navigationSpec": null, "recommendedNavaid": "VJB", "derivationMethod": "11 DME arc clockwise from RDL295 to RDL340 exit", "sourceEvidenceIds": ["ev_chart_arc_340"], "confidence": 0.85, "reviewRequired": false }
]
```

PIMOK 1G crosses the same constrained radial and splits the same way. ADLOV 1G and OMKOM 1G do
NOT pass RDL295, so each keeps a single AF leg. The CI legs carry turnDirection=null.

## Correct support filtering — supportObjects

VJB is the arc center, so it is part of the procedure. JR (NDB) and IJB (ILS/LOC) appear only in
the AD 2.19 supporting page and are NOT referenced by this DME ARC STAR chart or table, so they
must NOT appear in `navaids`, `fixes`, or any leg:

```json
[
  { "ident": "VJB", "type": "NAVAID", "sourcePageNo": 55, "usedInProcedure": true, "supportOnly": false, "reason": "VOR/DME center of the 11 DME ARC; shown on the chart and referenced by radials and lead radials.", "confidence": 0.95 },
  { "ident": "JR", "type": "NAVAID", "sourcePageNo": 20, "usedInProcedure": false, "supportOnly": true, "reason": "Appears only in the AD 2.19 navaid support page; not referenced by the current DME ARC STAR chart or table.", "confidence": 0.9 },
  { "ident": "IJB", "type": "NAVAID", "sourcePageNo": 20, "usedInProcedure": false, "supportOnly": true, "reason": "ILS/LOC ident belongs to the ILS approach, not to this DME ARC STAR.", "confidence": 0.9 }
]
```

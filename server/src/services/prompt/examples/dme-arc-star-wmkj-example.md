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

## Correct Stage 2 — chartTexts (excerpt)

```json
[
  { "text": "11 DME ARC", "normalizedText": "11 DME ARC", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "13 DME", "normalizedText": "13 DME", "role": "DME_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "VJB", "normalizedText": "VJB", "role": "NAVAID", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "RDL340 / 160", "normalizedText": "RDL340/160", "role": "RADIAL_LABEL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "L-R332", "normalizedText": "L-R332", "role": "LEAD_RADIAL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "L-R348", "normalizedText": "L-R348", "role": "LEAD_RADIAL", "region": "MAIN_CHART", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.9 },
  { "text": "EMTUV 1G", "normalizedText": "EMTUV 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "OMKOM 1G", "normalizedText": "OMKOM 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "PIMOK 1G", "normalizedText": "PIMOK 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 },
  { "text": "ADLOV 1G", "normalizedText": "ADLOV 1G", "role": "PROCEDURE_NAME", "region": "HEADER", "sourcePageNo": 55, "usedInProcedure": true, "confidence": 0.95 }
]
```

## Correct Stage 4 — geometrySemantics (excerpt)

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

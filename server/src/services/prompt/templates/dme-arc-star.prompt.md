## Procedure-Specific Instructions

The current task is DME ARC STAR recognition. This is NOT generic image OCR — read the chart like an arrival-procedure coder.

You MUST actively look for and identify:
- the VOR/DME center of the arc (identifier, and its role as arc center)
- the DME ARC radius (e.g. "11 DME ARC") and any other DME distance labels (e.g. "13 DME")
- radial labels (e.g. "RDL340") and the inbound track paired with them (e.g. "RDL340 / 160")
- lead radial labels (e.g. "L-R332", "L-R348") that mark where to leave the arc
- the inbound / final common track toward the runway
- arc entry and exit relationships: which fix joins the arc, which lead radial leaves it
- all procedure names on the chart and which track each one follows
- the fix-to-arc relationship (fix on a radial + DME distance)
- the shared/common arrival segment after the arc
- altitude and speed constraints on the tracks
- every text label that is bound to a geometry (report it as LABEL_BINDING / labelText)

Enumerate the current chart's key elements against this checklist before answering:
- the arc label (e.g. "11 DME ARC") and any outer DME distance label (e.g. "13 DME")
- the VOR/DME ident acting as arc center
- EVERY radial label: each transition's entry radial, any crossing/constraint radial on the arc,
  and the final inbound radial pair ("RDLxxx / yyy" — radial xxx, inbound track yyy)
- every lead radial ("L-Rxxx")
- every outer-DME turn-point tag (e.g. each printed "13D <VOR>")
- every procedure name and which track it labels
Report each of them in chartTexts and derive the matching geometrySemantics entries
(DME_ARC with centerNavaid and radiusNm, RADIAL with radialDeg and inboundTrackDeg, LEAD_RADIAL with radialDeg).
A worked few-shot example follows this template in the prompt — use it to calibrate completeness,
never as a source of values.

Completeness invariants — verify BEFORE you answer:
- chartTexts must contain EVERY printed label on the chart, one entry per printed instance —
  including every RDL-xxx label, every DME distance tag, every altitude label on each transition,
  and procedure names both in the header and where they label a track.
- A DME ARC STAR with N transitions normally prints at least N entry radial labels and N outer
  DME turn-point tags. If your chartTexts has fewer RDL entries than transitions, you missed
  labels — re-scan the chart.
- EVERY RDL-xxx chartText becomes one geometrySemantics RADIAL entry (radialDeg filled,
  relatedProcedures listing the transition(s) that use it). Entry radials must NOT be dropped
  just because they also appear in tableLegs or in leg D-fix names.
- Cross-check legs against labels: every D-fix radial used in procedures[].legs
  (e.g. D275M -> radial 275) must have a matching RADIAL semantic and chartText;
  if one is missing, you skipped a printed label.

Strict scope rules:
- Do NOT output navaids that are unrelated to the current procedure.
- Do NOT treat idents that appear only in supporting pages (e.g. an NDB or an ILS/LOC ident listed only in AD 2.19) as procedure geometry, unless the current chart or table explicitly references them. An ILS/LOC ident belongs to an ILS/LOC approach, not to a DME ARC STAR. List such idents in supportObjects with usedInProcedure=false and supportOnly=true.
- The VOR/DME used by the arc, radials, and lead radials IS part of the procedure: usedInProcedure=true.

Focus on derivationMethod for DME ARC, radial, and lead radial values (e.g. "read from arc label", "derived from lead radial").

Supporting AD 2.19 and AD 2.22 information is important context for this package type — use it to confirm navaid types, frequencies, and the textual procedure description, subject to the support-filtering rules.

## Leg Coding (tableLegs) — REQUIRED, EQUAL PRIORITY WITH chartTexts

The tabular description page lists every arrival leg. `tableLegs` is the AUTHORITATIVE leg
encoding: the pipeline assembles procedures[].legs from tableLegs rows, so you may leave
procedures[].legs as [] to save output space — but tableLegs MUST contain every leg of EVERY
procedure. Returning empty tableLegs while a tabular page is present is a FAILURE, and the
completeness of chartTexts NEVER excuses dropping tableLegs: both are required in the same
response. Each tableLeg row carries procedureName, sequence, pathTerminator, fromFix/toFix,
courseDeg, distanceNm, altitudeConstraint, turnDirection.

Zero/null discipline:
- Never use 0 as a placeholder for an unknown optional field. If a distance, course, or
  altitude is not printed, output null.
- `distanceNm=0`, `courseDeg=0`, or an altitude value of 0 is almost always wrong for this
  procedure family unless the source explicitly prints 0.
- IF legs normally have distanceNm=null. Do not output 0 just because the leg starts at the fix.

A DME ARC STAR transition normally codes as the following leg chain. Use it as a checklist to
locate each value in the table and chart — every number must come from the source, never from
this template:

1. `IF` at the enroute entry fix (the named waypoint the transition starts from), with its
   charted altitude constraint.
2. `TF` to the DME fix where the entry radial crosses the outer DME distance label (e.g. "13 DME").
   Terminal DME fixes are named `D` + radial (3 digits) + distance letter (A=1NM … K=11NM,
   L=12NM, M=13NM): radial 016 at 13 DME -> `D016M`.
   The row distance is NOT the DME distance encoded in the fix name. Read distanceNm from the
   tabular row's distance column. Do not compute it from K/M or from geometry.
3. `CI` (course to intercept the arc): fixIdentifier=null, courseDegMag = inbound course of the
   entry radial (radial + 180, e.g. RDL016 -> 196), distanceNm = outer DME − arc DME.
4. One or more `AF` legs following the DME arc around the center VOR/DME:
   fixIdentifier = the D-fix on the exit/lead radial at the ARC radius (e.g. `D340K` for RDL340
   at 11 DME), turnDirection = the arc direction on the chart (L = counterclockwise around the
   center, R = clockwise).
   The AF row distance must also come from the table row. Do not estimate an arc length from the
   chart unless the table explicitly omits the value and you mark reviewRequired=true.
5. MANDATORY ARC SPLIT CHECK: scan the arc on the chart AND the table rows for any intermediate
   radial that carries its own altitude/speed constraint (e.g. an altitude label like "+3400"
   printed where a radial crosses the arc). Each such radial splits the arc: code one AF leg
   ending at that radial's D-fix (with the constraint), then continue with the next AF leg.
   A transition whose arc passes a constrained radial but is coded as a single AF leg is WRONG.
6. Final `TF` from the arc exit fix to the common inbound fix, with its altitude constraint.

Altitude constraints — per transition, no reuse:
- Each transition has its OWN altitude value on its own table row / chart label. Read each one
  independently. NEVER copy an altitude from another transition, and NEVER copy the example's
  values — transitions frequently have different values (or none at all) on the same leg position.
- If a leg has no printed constraint, output altitudeConstraint=null — an invented or copied
  value is worse than null.
- The airport transition altitude / transition level (e.g. the trailing `13000` in a coded
  source like `- 06000     13000`, or a chart box `TRANS LEVEL FL130`) is airport-level
  information: report it as a chartText but do NOT copy it into any leg's altitudeConstraint
  or upperFt. `upperFt` is only for genuine dual-altitude window constraints of the leg itself.
- Keep the sign. `-05000`, `+05000`, and `05000` are different constraints.
- Do not propagate one transition's altitude constraint to the other transitions. Re-read every transition row.

Course/radial coding:
- CI legs require courseDeg equal to the inbound course for the entry radial.
- AF legs require courseDeg only when the table/424-style coding gives a boundary radial/course
  for that arc leg. If you cannot read it, output null, never 0.
- TF/IF legs should normally have courseDeg=null unless the table explicitly codes a course.

recommendedNavaid (tableLegs field):
- IF and AF legs reference the arc center VOR/DME — fill `recommendedNavaid`
  on those rows. TF/CI rows keep null unless the table explicitly prints a navaid.

turnDirection rules:
- AF legs: REQUIRED — the arc direction.
- CI legs: normally null. The course intercept is not a coded turn; output L/R only if the
  table prints an explicit turn instruction for that row.
- All other legs: only when the table or an explicit chart annotation states a turn;
  never infer L/R from how the drawn track bends. Otherwise output null.

If a single leg's path terminator cannot be determined, output that leg with pathTerminator=null
and reviewRequired=true — but never return an empty `legs` array when the tabular description
page is present.

## Label Plan Mapping (DME ARC STAR)

Every chartTexts label that is drawn on the main chart also gets ONE `labelPlan` entry:
- Entry fix labels with altitude (e.g. `<FIX>\n6000`) → labelKind=FIX_NAME, anchorType=FIX,
  anchorDirection = the side of the fix with no track lines (or AUTO).
- VOR/DME info box (ident/frequency) → labelKind=NAVAID_INFO, anchorType=NAVAID.
- `11 DME ARC` → labelKind=DME_ARC, anchorType=DME_ARC (rides along the arc), one entry total,
  NOT one per procedure.
- `RDL-xxx` labels → labelKind=RADIAL, anchorType=RADIAL, anchorIdent=`RDLxxx`,
  placementAlongLine=END (radial labels sit at the outer end). The final radial pair
  (`RDL340 / 160°`) stays one entry with `\n` between the two lines.
- Lead radials (`L-Rxxx`) → labelKind=LEAD_RADIAL, anchorType=RADIAL.
- Outer DME turn-point tags (`13D <VOR>`) → labelKind=FIX_NAME, anchorType=FIX with the D-fix
  ident (e.g. `D016M`).
- Procedure names (`<FIX> 1G`) → labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK,
  placementAlongLine=START, sideOfLine matching the chart.

## Fixes and Coordinates — REQUIRED

- Output every named waypoint used by the legs into `fixes`: each entry fix and the common
  inbound fix. Read their coordinates from the tabular description / coordinate columns or the
  supporting pages and fill latitude/longitude AND rawCoordinate. Without these coordinates the
  map preview cannot anchor the transitions.
- Terminal D-fixes (e.g. D016M, D340K) usually have no printed coordinates — still include them
  in `fixes` with latitude/longitude=null; downstream tooling derives their position from the
  radial + DME distance encoded in the name.
- The arc center VOR/DME must appear in `navaids` (identifier, type, frequency, and coordinate
  when printed; the supporting navaid page usually has it).

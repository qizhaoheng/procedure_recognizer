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

For a chart like WMKJ RWY16 11 DME ARC STAR, the expected key elements are:
- "11 DME ARC", "13 DME"
- VOR/DME "VJB" as arc center
- EVERY radial label: each transition's entry radial (e.g. RDL016, RDL114, RDL236, RDL275),
  any crossing/constraint radial on the arc (e.g. RDL295), and the final inbound radial
  ("RDL340 / 160" — radial 340, inbound track 160)
- lead radials "L-R332" and "L-R348"
- every outer-DME turn-point tag (e.g. each printed "13D VJB")
- procedure names like "ADLOV 1G", "OMKOM 1G", "PIMOK 1G", "EMTUV 1G"
Report each of them in chartTexts and derive the matching geometrySemantics entries
(DME_ARC with centerNavaid and radiusNm, RADIAL with radialDeg and inboundTrackDeg, LEAD_RADIAL with radialDeg).

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
- Do NOT treat idents that appear only in supporting pages (e.g. an NDB "JR" or an ILS/LOC "IJB" from AD 2.19) as procedure geometry, unless the current chart or table explicitly references them. An ILS/LOC ident belongs to an ILS/LOC approach, not to a DME ARC STAR. List such idents in supportObjects with usedInProcedure=false and supportOnly=true.
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

A DME ARC STAR transition normally codes as the following leg chain. Use it as a checklist to
locate each value in the table and chart — every number must come from the source, never from
this template:

1. `IF` at the enroute entry fix (the named waypoint the transition starts from), with its
   charted altitude constraint.
2. `TF` to the DME fix where the entry radial crosses the outer DME distance label (e.g. "13 DME").
   Terminal DME fixes are named `D` + radial (3 digits) + distance letter (A=1NM … K=11NM,
   L=12NM, M=13NM): radial 016 at 13 DME -> `D016M`.
3. `CI` (course to intercept the arc): fixIdentifier=null, courseDegMag = inbound course of the
   entry radial (radial + 180, e.g. RDL016 -> 196), distanceNm = outer DME − arc DME.
4. One or more `AF` legs following the DME arc around the center VOR/DME:
   fixIdentifier = the D-fix on the exit/lead radial at the ARC radius (e.g. `D340K` for RDL340
   at 11 DME), turnDirection = the arc direction on the chart (L = counterclockwise around the
   center, R = clockwise).
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

turnDirection rules:
- AF legs: REQUIRED — the arc direction.
- CI legs: normally null. The course intercept is not a coded turn; output L/R only if the
  table prints an explicit turn instruction for that row.
- All other legs: only when the table or an explicit chart annotation states a turn;
  never infer L/R from how the drawn track bends. Otherwise output null.

If a single leg's path terminator cannot be determined, output that leg with pathTerminator=null
and reviewRequired=true — but never return an empty `legs` array when the tabular description
page is present.

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

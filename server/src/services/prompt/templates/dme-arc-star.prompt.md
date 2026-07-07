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
- "RDL340 / 160" (radial 340, inbound track 160)
- lead radials "L-R332" and "L-R348"
- procedure names like "ADLOV 1G", "OMKOM 1G", "PIMOK 1G", "EMTUV 1G"
Report each of them in chartTexts and derive the matching geometrySemantics entries
(DME_ARC with centerNavaid and radiusNm, RADIAL with radialDeg and inboundTrackDeg, LEAD_RADIAL with radialDeg).

Strict scope rules:
- Do NOT output navaids that are unrelated to the current procedure.
- Do NOT treat idents that appear only in supporting pages (e.g. an NDB "JR" or an ILS/LOC "IJB" from AD 2.19) as procedure geometry, unless the current chart or table explicitly references them. An ILS/LOC ident belongs to an ILS/LOC approach, not to a DME ARC STAR. List such idents in supportObjects with usedInProcedure=false and supportOnly=true.
- The VOR/DME used by the arc, radials, and lead radials IS part of the procedure: usedInProcedure=true.

Focus on derivationMethod for DME ARC, radial, and lead radial values (e.g. "read from arc label", "derived from lead radial").

Supporting AD 2.19 and AD 2.22 information is important context for this package type — use it to confirm navaid types, frequencies, and the textual procedure description, subject to the support-filtering rules.

If the path terminator cannot be determined, output procedure understanding with reviewRequired=true instead of forcing hard-coded ARINC 424 coding.

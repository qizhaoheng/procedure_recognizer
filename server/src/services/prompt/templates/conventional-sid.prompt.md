## Procedure-Specific Instructions

The current task is Conventional / RADAR SID recognition.

Read the SID as an ARINC 424-style departure procedure, not as generic chart text. A conventional
SID may be flown from runway alignment, VOR/DME radials, DME distances, ATC radar headings, or a
mix of those references.

Core SID elements to extract:
- runway-specific designators: keep RWY16 and RWY34 variants separate even when the chart title is shared
- initial climb track/course from the runway, including `TRACK 160`, `TRACK 340`, `RWY HDG`, and "until DER"
- climb-to-altitude legs, especially 424-like CA legs such as runway track to 1000/1500 ft
- DME conditions from a navaid, such as `0.5 DME VJB`, `2.6 DME VJB`, `5.7 DME VJB`, `13D VJB`
- VOR/DME radials and cross-radials, such as `RDL 195 VJB`, `RDL-114 VJB`, and radial intercepts
- turn direction and trigger: left/right turn, turn at altitude, turn at DME, turn after DER, or turn to assigned heading
- path terminator candidates: CA, CI, CF, CR, DF, TF; preserve the chart wording that justifies the code
- altitude constraints, transition altitude, climb gradients, speed limits, and max IAS in turn
- communication/radar requirements and ATC-dependent instructions
- dependency on VOR/DME/NDB/ILS facilities, but only when used by this SID

Expected path-terminator reading:
- CA: course/track from runway until an altitude, e.g. `track 160 until 1000 ft`; output fixIdentifier=null,
  courseDegMag=160, altitudeConstraint with the printed altitude, and recommendedNavaid only if printed.
  A compact plan-view label like `160° 1000` is also a CA trigger: course/track 160 until 1000 ft,
  then the published turn/DF/CI/CF continuation.
- CI: course/track to intercept a later course/radial; output the course in courseDegMag and describe the
  intercept target in remarks when no named fix exists.
- CF: course to a fix/radial/DME fix; use when the row or chart gives a course plus a terminating fix or
  radial/DME reference.
- CR: course to intercept a radial; include center navaid and radial label in remarks and geometrySemantics.
- DF: direct to a named fix; output fixIdentifier as the target fix and distance when printed.
- TF: track between two named fixes; do not use TF when the target is only an altitude/DME condition.

RADAR SID rules:
- If the instruction is "turn to assigned heading", output a leg with pathTerminator=null or CI only when a
  chart/table gives an actual intercept course. Do NOT invent the assigned heading.
- Preserve ATC/radar wording in chartTexts and remarks; this is operationally significant even when it
  cannot become a deterministic geometry leg.
- If a radar SID has no named waypoint after takeoff, still output the runway-specific initial legs from
  the table/notes. Do not return an empty procedures array.

Navaid and support rules:
- Use AD 2.19 navaid summaries when sent; `VJB` used in DME or radial text is a usedInProcedure navaid.
- A VOR/DME that only appears in support pages is supportOnly unless the chart/table references its ident,
  DME, radial, or frequency.
- Set derivationMethod on each leg: examples include `table CA leg`, `chart DME trigger`,
  `radial intercept label`, `radar assigned-heading note`, or `424-coded SID reference`.

Label plan mapping (Conventional / RADAR SID):
- runway labels -> labelKind=RUNWAY, anchorType=RUNWAY
- procedure names -> labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK
- track/course and DME text -> labelKind=COURSE_DISTANCE, anchorType=LEG
- runway-alignment climb labels such as `160° 1000` -> labelKind=COURSE_DISTANCE, anchorType=LEG,
  anchored to the CA leg
- radial labels -> labelKind=RADIAL, anchorType=RADIAL
- navaid boxes/frequencies -> labelKind=NAVAID_INFO, anchorType=NAVAID
- radar/ATC notes and climb-gradient notes -> labelKind=NOTE, anchored to the relevant leg or track

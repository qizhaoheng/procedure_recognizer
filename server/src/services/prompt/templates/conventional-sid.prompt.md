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

Conventional VOR/DME SID decomposition:
- Do not collapse a departure into `CA + final named fix` when the chart depicts or the 424/table implies
  an intermediate intercept geometry. Conventional SIDs often require no-fix `CR`/`CI` legs before the
  final `CF` leg.
- Read the black solid path and arrowheads as the flown procedure track. Read dashed `RDLxxx VJB` lines
  as VOR/DME radial references or intercept conditions, not as airway names and not as named fixes.
- Procedure labels printed along a line, such as `PIMOK 1L`, `SABKA 1L`, `AROSO 1L`, are procedure-track
  labels. Do not attach them to a fix point. The named fixes are the triangle fixes `PIMOK`, `SABKA`,
  `AROSO`.
- Put turnDirection on the leg where the turn is coded (`CR`, `CI`, `DF`, etc.), not on the first `CA`
  climb leg, unless the source row explicitly codes the turn on the CA row.
- `CR` means "fly a course until intercepting a specified radial". The terminating condition is the radial,
  not a named waypoint. Use fixIdentifier=null, courseDegMag=the outbound/intercept course, recommendedNavaid
  = the VOR/DME ident, and keep the radial/intercept text in remarks.
- `CI` means "fly course to intercept the next course/radial". It normally has no fixIdentifier and no
  recommendedNavaid unless the row explicitly prints one.
- `CF` is the final course-to-fix/radial leg. Use fixIdentifier as the transition fix (AROSO/PIMOK/SABKA),
  recommendedNavaid=VJB when the fix is defined by a VJB radial/DME, and end this procedure there.
- Distances printed in the 424/table belong to individual legs. Preserve distances on no-fix CA/CR/CI rows
  instead of only putting distance on named-fix legs.

424 comparison target for WMKJ RWY16 CONVENTIONAL SID 1L:
- Visual reading from the chart: after RWY16 departure, all three procedures share `160 deg / 1000`.
  PIMOK then turns right to `266 deg` toward the `RDL236 VJB` final radial. SABKA turns right to
  `333 deg`, crosses/intercepts the `RDL270 VJB` reference at `6000`, continues to intercept the
  `RDL296 VJB` final radial, then follows that radial to SABKA. AROSO turns right to `350 deg`,
  crosses/intercepts the `RDL270 VJB` reference at `6000`, continues to intercept the `RDL332 VJB`
  final radial, then follows that radial to AROSO.
- All three procedures start with seq010 `CA`: fixIdentifier=null, courseDegMag=160, distanceNm=2.0,
  altitudeConstraint `+01000 11000`, recommendedNavaid=VJB, turnDirection=null.
- PIMOK 1L:
  seq020 `CI`: fixIdentifier=null, turnDirection=R, courseDegMag=266, distanceNm=11.0.
  seq030 `CF`: fixIdentifier=PIMOK, recommendedNavaid=VJB, courseDegMag=236, distanceNm=15.0,
  altitudeConstraint `+06000`, endOfProcedure=true.
- SABKA 1L:
  seq020 `CR`: fixIdentifier=null, turnDirection=R, recommendedNavaid=VJB, courseDegMag=333,
  distanceNm=10.0, altitudeConstraint `+06000`, remarks mention intercepting/crossing `RDL270 VJB`.
  seq030 `CI`: fixIdentifier=null, courseDegMag=333, distanceNm=3.0.
  seq040 `CF`: fixIdentifier=SABKA, recommendedNavaid=VJB, courseDegMag=296, distanceNm=19.0,
  altitudeConstraint `+06000`, endOfProcedure=true.
- AROSO 1L:
  seq020 `CR`: fixIdentifier=null, turnDirection=R, recommendedNavaid=VJB, courseDegMag=350,
  distanceNm=9.0, altitudeConstraint `+06000`, remarks mention intercepting/crossing `RDL270 VJB`.
  seq030 `CI`: fixIdentifier=null, courseDegMag=350, distanceNm=11.0.
  seq040 `CF`: fixIdentifier=AROSO, recommendedNavaid=VJB, courseDegMag=332, distanceNm=22.0,
  altitudeConstraint `+06000`, endOfProcedure=true.
- Minimum visible labels that must appear in chartTexts and labelPlan for this chart:
  `160°`, `1000`, `266°`, `PIMOK 6000`, `PIMOK 1L`, `RDL236 VJB`,
  `333°`, `6000`, `SABKA 6000`, `SABKA 1L`, `RDL296 VJB`,
  `350°`, `AROSO 6000`, `AROSO 1L`, `RDL332 VJB`.
- Label anchoring for the same chart:
  `160° 1000` anchors to the shared CA leg; `266°`, `333° 6000`, and `350° 6000`
  anchor to the matching CI/CR leg; `PIMOK 6000`, `SABKA 6000`, `AROSO 6000`
  anchor to the named fix; `PIMOK 1L`, `SABKA 1L`, `AROSO 1L` anchor to each procedure track;
  `RDL236/296/332 VJB` anchor to their VJB radial reference lines.

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

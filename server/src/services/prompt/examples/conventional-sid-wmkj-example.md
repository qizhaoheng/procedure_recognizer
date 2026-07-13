# Few-shot Example — WMKJ RWY16 CONVENTIONAL SID 1L (PIMOK / SABKA / AROSO)

This example shows how a conventional VOR/DME SID chart should be decomposed into 424-style legs.
Learn the reading pattern and the level of detail; do NOT copy these values into another chart's
output — every course, distance, altitude, radial, and navaid ident below is specific to this
chart and MUST be re-read from the current chart's own labels and table rows.

## Visual reading from the chart

After RWY16 departure, all three procedures share `160 deg / 1000`. PIMOK then turns right to
`266 deg` toward the `RDL236 VJB` final radial. SABKA turns right to `333 deg`, crosses/intercepts
the `RDL270 VJB` reference at `6000`, continues to intercept the `RDL296 VJB` final radial, then
follows that radial to SABKA. AROSO turns right to `350 deg`, crosses/intercepts the `RDL270 VJB`
reference at `6000`, continues to intercept the `RDL332 VJB` final radial, then follows that
radial to AROSO.

## Correct leg decomposition (424 comparison target)

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

Note the pattern, not the numbers: a conventional SID from a runway-alignment climb is
`CA` + (`CI`/`CR` intercept legs, no fix) + final `CF` at the named transition fix. The number of
intercept legs, their courses, and whether a `CR` crossing-radial leg exists all come from the
current chart.

## Minimum visible labels that must appear in chartTexts and labelPlan for this chart

`160°`, `1000`, `266°`, `PIMOK 6000`, `PIMOK 1L`, `RDL236 VJB`,
`333°`, `6000`, `SABKA 6000`, `SABKA 1L`, `RDL296 VJB`,
`350°`, `AROSO 6000`, `AROSO 1L`, `RDL332 VJB`.

## Label anchoring for the same chart

`160° 1000` anchors to the shared CA leg; `266°`, `333° 6000`, and `350° 6000`
anchor to the matching CI/CR leg; `PIMOK 6000`, `SABKA 6000`, `AROSO 6000`
anchor to the named fix; `PIMOK 1L`, `SABKA 1L`, `AROSO 1L` anchor to each procedure track;
`RDL236/296/332 VJB` anchor to their VJB radial reference lines.

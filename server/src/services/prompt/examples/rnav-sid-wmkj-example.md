# Few-shot Example — WMKJ RNAV SID (RWY16 1J / RWY34 1K)

This example shows how an RNAV SID chart + table should be decomposed into 424-style legs.
Learn the reading pattern and the level of detail; do NOT copy these values into another chart's
output — every course, distance, altitude, fix name, and navaid ident below is specific to this
chart and MUST be re-read from the current chart's own labels and table rows.

## Reference navaid on this chart

The `MSA 25 NM VJB` box and the aeronautical data tabulation identify `VJB` as this airport's
reference VOR/DME. The correct output uses `recommendedNavaid="VJB"` on the first no-fix CA leg
only, and leaves later ordinary DF/TF legs with `recommendedNavaid=null` because their table rows
do not reference a navaid.

## Correct leg decomposition — RWY16 RNAV SID 1J (424 comparison target)

- Sequence 010 is a no-fix CA leg: course 160, distance 2.0 NM, altitude `+01000 11000`,
  recommended navaid `VJB`, and no fix identifier.
- ADLOV/AROSO 1J then use DF to `INVOV` with distance 12.0 NM, followed by TF legs to the common
  intermediate fix and then to the named transition fix.
- PIMOK 1J uses a DF leg directly to `PIMOK` with distance 24.0 NM.
- SABKA 1J uses DF to `KJ706` with distance 13.0 NM, then TF to `SABKA`.
- The final named transition fix in each procedure must not carry `turnDirection` unless the table
  explicitly codes one.

## Correct leg decomposition — RWY34 RNAV SID 1K (424 comparison target)

- Sequence 010 is a no-fix CA leg: course 340, distance 3.0 NM, altitude `+01500 11000`,
  recommended navaid `VJB`, and no fix identifier.
- AROSO 1K uses a DF leg to `AROSO` with distance 32.0 NM.
- ADLOV 1K uses a DF leg to `ADLOV` with distance 25.0 NM.
- PIMOK 1K uses a DF leg to `PIMOK` with distance 25.0 NM.
- SABKA 1K uses a DF leg to `SABKA` with distance 25.0 NM.
- OMKOM 1K uses DF to `KJ707` with distance 10.0 NM, then TF to `OMKOM` if the table shows the
  extra terminal-fix row.
- Do not infer `turnDirection` on ADLOV/AROSO/PIMOK/SABKA/OMKOM terminal transition-fix legs from
  the visible path bend. Only copy L/R when the table `TURN DIR` column explicitly contains it for
  that same row.

Note the pattern, not the numbers: the runway-alignment CA leg exists even when the table's fix
cell is blank; each runway variant is a separate procedure; intermediate computer fixes (here the
`KJ7xx` idents) and final enroute transition fixes are preserved as named legs with their printed
distances.

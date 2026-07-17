# Recognition V2 Phase 5.3 - Release blocker reduction

Phase 5.3 converts the six Phase 5 topology cases from topology-only success into complete V2 runs with no hard semantic-validation blockers. It does not auto-approve OCR-derived data: every final run remains `REVIEW_REQUIRED` until a human confirms the review evidence.

## Reproduce

```powershell
npm run eval:phase5.3
```

Reports are written to `server/data/recognition-v2/evaluations/phase5.3/<timestamp>/`, with `latest.json` pointing to the newest run.

## Final baseline (2026-07-16)

| Case | Topology score | Release decision | Blocking issues |
| --- | ---: | --- | ---: |
| VHHH BEKOL 1X RF | 1.000 | REVIEW_REQUIRED | 0 |
| WSSS RNP 02L holding | 1.000 | REVIEW_REQUIRED | 0 |
| WSSS ASUNA 2B vector | 1.000 | REVIEW_REQUIRED | 0 |
| WSSS RNP 02L missed approach | 1.000 | REVIEW_REQUIRED | 0 |
| WMKJ four DME-arc STARs | 1.000 | REVIEW_REQUIRED | 0 |
| WMKJ four-branch merge | 1.000 | REVIEW_REQUIRED | 0 |

## What changed

- A page may contribute both a waypoint-coordinate table and one or more procedure-leg table sections. WSSS page 255 now produces separate SAMKO and SANAT transition legs.
- Publisher prose DME-arc descriptions are materialized into procedure-scoped IF/CF/AF legs. WMKJ page 56 now produces four independent STAR branches instead of topology-only edges.
- Raster coordinate tables are recovered as labeled rows. DME radial/distance pseudo-fixes are deterministically derived from the printed VJB coordinate and kept review-required.
- Chart-index package identity is accepted as an auditable high-confidence source when the package grouping itself is high confidence. Implausibly long title-parser values are rejected.
- Leg sequence uniqueness and topology continuity are checked inside procedure/transition scope, not across unrelated branches.
- HOLD self-loops and two semantic relations sharing the same endpoints no longer create false topology blockers.
- A present but review-required value produces `REVIEW_REQUIRED`; missing, invalid, or conflicting required values still produce `BLOCKED`.

## Safety boundary

`REVIEW_REQUIRED` is intentionally not `READY`. Local raster OCR and deterministic geometry remain visible in provenance and must be confirmed before publication. Phase 5.3 removes false hard blockers and materializes evidence; it does not silently promote uncertain evidence to approved 424 data.

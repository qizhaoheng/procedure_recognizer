# Phase 5.1 topology golden cases

This directory contains manually reviewed topology truth, not prompt examples.

Each `*.golden.json` file records:

- the source authority, PDF name, SHA-256 fingerprint and exact AIP page;
- immutable printed or visual evidence;
- expected nodes, edges, special geometry and branch/merge points;
- fields that must remain unknown when the AIP does not publish them.

The source PDFs live under `server/data/` and are intentionally ignored by Git. The evidence excerpts and source fingerprints remain checked in so CI can validate the corpus contract without copying large AIP documents into the repository. When a source PDF is present locally, `recognitionV2Phase51Golden.test.ts` also verifies its SHA-256 fingerprint.

Current cases:

| Category | Airport / procedure | Source pages | Key assertion |
|---|---|---|---|
| DME Arc | WMKJ four RWY 16 STARs | AD 2-WMKJ-7-5/6 | VJB centre, 11 NM radius, published arc direction |
| RF | VHHH BEKOL 1X | AD 2-VHHH-SID-BEKOL-X/-1 | two RF legs with centres HH941/HH942 and printed radii |
| Holding | WSSS RNP RWY 02L | AD-2-WSSS-IAC-9 | AKOMA left hold, 176° inbound, one minute, minimum 4000 ft |
| Vector | WSSS ASUNA 2B | AD-2-WSSS-STAR-4 | open-ended vector from NYLON; destination must stay null |
| Missed approach | WSSS RNP RWY 02L | AD-2-WSSS-IAC-9 | RW02L → ENSUN → AKOMA missed-approach chain |
| Multi-route merge | WMKJ four RWY 16 STARs | AD 2-WMKJ-7-5/6 | four arc entries share the RDL340 VJB exit toward OSRUP |

Do not copy airport identifiers or expected values from these files into prompts or production rules. Production logic must remain generic; these cases only measure it.

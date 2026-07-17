import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareArinc424Fields } from '../jeppesen424/arinc424FieldComparator';

describe('ARINC 424 fixed-field comparator', () => {
  it('separates standard differences from supplier record metadata', () => {
    const base = 'SPACP VHHHVHDBEKO5ANRW07R 080BEKOLZGEA1EE      TF                                 + FL157                              D   973322412';
    const metadataOnly = `${base.slice(0, 123)}000000000`;
    const metadata = compareArinc424Fields(metadataOnly, base);
    assert.equal(metadata.records[0].status, 'METADATA_ONLY');
    assert.equal(metadata.standardDifferenceCount, 0);
    assert.ok(metadata.supplierMetadataDifferenceCount > 0);

    const wrongAltitude = `${base.slice(0, 84)}04800${base.slice(89)}`;
    const business = compareArinc424Fields(wrongAltitude, base);
    assert.equal(business.records[0].status, 'DIFFERENT');
    assert.ok(business.records[0].fields.some((field) => field.field === 'altitude1' && !field.matched));
  });

  it('reports missing continuation records by logical record key', () => {
    const primary = 'SPACP VHHHVHDBEKO5ANRW07R 080BEKOLZGEA1EE      TF                                 + FL157                              D   973322412';
    const continuation = 'SPACP VHHHVHDBEKO5ANRW07R 080BEKOLZGEA2P                                  0136                                             973332412';
    const result = compareArinc424Fields(primary, `${primary}\n${continuation}`);
    assert.equal(result.missingSystemCount, 1);
    assert.equal(result.records.find((record) => record.status === 'MISSING_SYSTEM')?.recordKey.includes('2P'), true);
  });

  it('classifies a 2P continuation value as supplier-derived instead of an AIP semantic error', () => {
    const system = 'SPACP VHHHVHDBEKO5ANRW07R 010HH301VHPC2P                                                                                         ';
    const reference = 'SPACP VHHHVHDBEKO5ANRW07R 010HH301VHPC2P                                  0040                                             973182412';
    const result = compareArinc424Fields(system, reference);
    const distance = result.records[0].fields.find((field) => field.field === 'distance');
    assert.equal(distance?.severity, 'SUPPLIER_METADATA');
    assert.equal(distance?.matched, false);
    assert.equal(result.records[0].status, 'METADATA_ONLY');
  });

  it('still pairs records when area, subsection, route type, or fix region differs', () => {
    const system = 'SSPAP VHHHVHEBEKO5A2RW07R 080BEKOLVHEA1EE      TF                                 + 04800                              D            ';
    const reference = 'SPACP VHHHVHDBEKO5ANRW07R 080BEKOLZGEA1EE   010TF                                 + FL157                              D   973322412';
    const result = compareArinc424Fields(system, reference);
    assert.equal(result.missingSystemCount, 0);
    assert.equal(result.missingReferenceCount, 0);
    assert.equal(result.records[0].status, 'DIFFERENT');
    assert.ok(result.records[0].fields.some((field) => field.field === 'routeType' && !field.matched));
  });
});

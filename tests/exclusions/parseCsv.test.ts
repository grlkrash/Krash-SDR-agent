import { describe, expect, it } from 'vitest';
import { parseCsv, rowToRecord } from '../../src/pipeline/exclusions/parseCsv.js';
import { normalizeImportRow } from '../../src/pipeline/exclusions/normalizeRow.js';

describe('parseCsv', () => {
  it('parses quoted commas', () => {
    const { headers, rows } = parseCsv('name,city\n"Aspire, LLC",Orlando\n');
    expect(headers).toEqual(['name', 'city']);
    expect(rows[0]).toEqual(['Aspire, LLC', 'Orlando']);
  });
});

describe('normalizeImportRow', () => {
  it('maps flexible headers and skips inactive', () => {
    const rec = rowToRecord(
      ['facility_name', 'website', 'status'],
      ['Test Center', 'https://test.org', 'inactive'],
    );
    expect(normalizeImportRow(rec)).toBeNull();
  });

  it('accepts active directory row', () => {
    const rec = rowToRecord(
      ['name', 'city', 'state', 'website', 'tier'],
      ['Test Center', 'Miami', 'FL', 'https://test.org', 'premium'],
    );
    const row = normalizeImportRow(rec);
    expect(row?.name).toBe('Test Center');
    expect(row?.domain).toBe('test.org');
    expect(row?.tier).toBe('premium');
  });
});

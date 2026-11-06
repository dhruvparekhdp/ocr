import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeText } from '../analyze.js';
import { extractTextFromBuffer } from '../pdfIngest.js';
import { renderTextPdf } from '../scripts/textPdf.js';
import {
  AMOUNT_TOLERANCE,
  amountsDiffer,
  gstinCheckCharacter,
  inspectGstin,
  inspectPan,
  parsePrintedDate,
  resolveSupplyState,
  validateIndianGst,
} from '../gstValidate.js';

const fixtures = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'fixtures', 'gst-invoices.json'), 'utf8'),
);

const codes = (warnings) => warnings.map((warning) => warning.code);

test('GSTIN check character matches the published worked example and rejects a bad one', () => {
  // Published modulus-36 example. Not a customer document and not used as a fixture.
  assert.equal(gstinCheckCharacter('27AAACR5055K1Z'), '7');
  assert.deepEqual(inspectGstin('27AAACR5055K1Z7').warnings, []);
  assert.deepEqual(codes(inspectGstin('27aaacr5055k1z7').warnings), []);
  assert.deepEqual(codes(inspectGstin('27AAACR5055K1Z5').warnings), ['gstin_checksum']);
  assert.equal(gstinCheckCharacter('27ABCCE1234F1Z'), '2');
});

test('GSTIN format failures are not reported as checksum failures', () => {
  assert.deepEqual(codes(inspectGstin('27ABCCE1234F').warnings), ['gstin_format']);
  assert.deepEqual(codes(inspectGstin('25ABCCE1234F1Z2').warnings), ['gstin_format']);
  assert.deepEqual(codes(inspectGstin('27ABCCE1234F1A2').warnings), ['gstin_format']);
  assert.deepEqual(inspectGstin(null).warnings, []);
});

test('PAN format accepts the structural pattern and rejects a bad one', () => {
  assert.deepEqual(inspectPan('ABCCE1234F'), []);
  assert.deepEqual(codes(inspectPan('ab cce1234f')), ['pan_format']);
  assert.deepEqual(codes(inspectPan('ABCCE12345')), ['pan_format']);
  assert.deepEqual(codes(inspectPan('1234')), ['pan_format']);
});

test('printed dates accept real calendar days and reject impossible ones', () => {
  assert.deepEqual(parsePrintedDate('10/05/2024'), { year: 2024, month: 5, day: 10 });
  assert.deepEqual(parsePrintedDate('2024-05-10'), { year: 2024, month: 5, day: 10 });
  assert.equal(parsePrintedDate('31/02/2024'), null);
  assert.equal(parsePrintedDate('00/01/2024'), null);
  assert.equal(parsePrintedDate('not a date'), null);
});

test('place of supply resolves state names and codes', () => {
  assert.equal(resolveSupplyState('Maharashtra'), '27');
  assert.equal(resolveSupplyState('27'), '27');
  assert.equal(resolveSupplyState('Karnataka'), '29');
  assert.equal(resolveSupplyState('Orissa'), '21');
  assert.equal(resolveSupplyState('Narnia'), null);
});

test('amount tolerance is one rupee and does not treat a larger gap as equal', () => {
  assert.equal(AMOUNT_TOLERANCE, 1);
  assert.equal(amountsDiffer(14160, 14160.5), false);
  assert.equal(amountsDiffer(14160, 14161.01), true);
});

test('synthetic GST invoices extract the printed fields and the expected warnings', () => {
  for (const doc of fixtures.documents) {
    const result = analyzeText(doc.lines.join('\n'));
    assert.equal(result.documentType, 'Invoice', doc.id);
    for (const [name, expected] of Object.entries(doc.fields)) {
      assert.equal(result.fields[name], expected, `${doc.id} ${name}`);
    }
    assert.deepEqual(codes(result.warnings), doc.warningCodes, doc.id);
  }
});

test('a wide text PDF keeps GST lines intact and does not invent warnings', async () => {
  const doc = fixtures.documents.find((item) => item.id === 'intra-valid');
  const buffer = await renderTextPdf(doc.lines, { wide: true });
  const extracted = await extractTextFromBuffer(buffer);
  const result = analyzeText(extracted.text);
  assert.equal(extracted.source, 'text');
  assert.equal(result.fields.gstin, '27ABCCE1234F1Z2');
  assert.equal(result.fields.amount, '14,160.00');
  assert.match(result.fields.lineItems, /HSN: 84713010/);
  assert.deepEqual(codes(result.warnings), []);
});

test('a wrong invoice total is kept and reported, not replaced', () => {
  const doc = fixtures.documents.find((item) => item.id === 'bad-hsn-and-total');
  const before = doc.lines.join('\n');
  const result = analyzeText(before);
  assert.equal(result.fields.amount, '99,999.00');
  assert.equal(result.fields.hsnSac, '12AB, 84713010');
  assert.ok(codes(result.warnings).includes('line_total_mismatch'));
  assert.ok(codes(result.warnings).includes('invoice_total_mismatch'));
  assert.equal(JSON.stringify(result.fields).includes('11800'), false);
});

test('validation does not mutate the field bag', () => {
  const fields = {
    documentNumber: 'INV-1',
    gstin: '27ABCCE1234F1Z5',
    pan: 'ABCCE1234F',
    date: '10/05/2024',
    hsnSac: '84713010',
    placeOfSupply: 'Maharashtra',
    taxableValue: '10.00',
    cgst: '1.00',
    sgst: '1.00',
    igst: '0.00',
    amount: '12.00',
    lineItems: null,
  };
  const snapshot = structuredClone(fields);
  const fieldConfigs = Object.keys(fields).map((name) => ({
    name,
    role: {
      documentNumber: 'invoiceNumber',
      gstin: 'gstin',
      pan: 'pan',
      date: 'invoiceDate',
      hsnSac: 'hsnSac',
      placeOfSupply: 'placeOfSupply',
      taxableValue: 'taxableValue',
      cgst: 'cgst',
      sgst: 'sgst',
      igst: 'igst',
      amount: 'total',
      lineItems: 'lineItems',
    }[name],
  }));
  const warnings = validateIndianGst({
    fields,
    fieldConfigs,
    text: 'GSTIN TAX INVOICE',
  });
  assert.deepEqual(fields, snapshot);
  assert.ok(codes(warnings).includes('gstin_checksum'));
});

test('CGST/SGST mismatch and an inter-state local tax are warnings', () => {
  const fieldConfigs = [
    ['gstin', 'gstin'],
    ['pan', 'pan'],
    ['documentNumber', 'invoiceNumber'],
    ['date', 'invoiceDate'],
    ['hsnSac', 'hsnSac'],
    ['placeOfSupply', 'placeOfSupply'],
    ['taxableValue', 'taxableValue'],
    ['cgst', 'cgst'],
    ['sgst', 'sgst'],
    ['igst', 'igst'],
    ['amount', 'total'],
    ['lineItems', 'lineItems'],
  ].map(([name, role]) => ({ name, role }));
  const base = {
    documentNumber: 'INV-9',
    gstin: '27ABCCE1234F1Z2',
    pan: 'ABCCE1234F',
    date: '10/05/2024',
    hsnSac: '84713010',
    placeOfSupply: 'Karnataka',
    taxableValue: '1000.00',
    cgst: '90.00',
    sgst: '90.00',
    igst: '0.00',
    amount: '1180.00',
    lineItems: null,
  };
  const interstate = validateIndianGst({ fields: base, fieldConfigs, text: 'GSTIN CGST' });
  assert.ok(codes(interstate).includes('tax_split_inconsistent'));
  assert.equal(base.cgst, '90.00');

  const mismatch = validateIndianGst({
    fields: { ...base, placeOfSupply: 'Maharashtra', cgst: '90.00', sgst: '40.00', igst: '0.00', amount: '1130.00' },
    fieldConfigs,
    text: 'GSTIN CGST SGST',
  });
  assert.ok(codes(mismatch).includes('cgst_sgst_mismatch'));
});

test('an invoice with no GST signal is not given GST warnings', () => {
  const result = analyzeText([
    'Nowhere Trading Co',
    'COMMERCIAL INVOICE',
    'Invoice Number: INV-2024-999',
    'Invoice Date: 22/06/2024',
    'Grand Total: 3,300.00',
  ].join('\n'));
  assert.equal(result.documentType, 'Invoice');
  assert.equal(result.fields.amount, '3,300.00');
  assert.deepEqual(result.warnings, []);
});

test('the existing sample GSTIN is preserved when its checksum fails', () => {
  const result = analyzeText([
    'Acme Exports Pvt Ltd',
    '12 Industrial Estate, Andheri East, Mumbai 400069',
    'GSTIN: 27ABCDE1234F1Z5',
    'TAX INVOICE',
    'Invoice No.: INV-2024-001',
    'Invoice Date: 10/05/2024',
    'PO Ref: PO-7788',
    'Bill To: Global Traders Inc',
    'Subtotal: 11,000.00',
    'Grand Total: 12,500.00',
  ].join('\n'));
  assert.equal(result.fields.gstin, '27ABCDE1234F1Z5');
  assert.equal(result.fields.amount, '12,500.00');
  assert.equal(result.fields.documentNumber, 'INV-2024-001');
  assert.ok(codes(result.warnings).includes('gstin_checksum'));
  assert.equal(result.warnings.some((warning) => warning.message.includes('27ABCCE1234F1Z2')), false);
});

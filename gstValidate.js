/**
 * Indian GST invoice checks.
 *
 * These functions never rewrite an extracted value. A bad checksum, an
 * impossible date, or a total that does not add up comes back as a warning
 * `{ code, message }`. The printed field is left as it was.
 *
 * The check character is the GST modulus-36 sum (Luhn-style, alphabet
 * 0-9A-Z, weights 1,2,1,2… from the left). Confirmed against the published
 * worked example 27AAACR5055K1Z7, whose last character is 7. That example is
 * an algorithm test vector, not a customer document.
 *
 * Money comparisons use a tolerance of one rupee. Indian invoices often
 * print a rounding-off of less than that. The tolerance decides whether to
 * warn. It is not used to replace the printed total.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Absolute rupee gap allowed before a cross-check warns. */
export const AMOUNT_TOLERANCE = 1;

/**
 * GST state codes used in the first two characters of a GSTIN.
 * 25 is unassigned (Daman and Diu was merged into 26). 28 is unused.
 * 96 / 97 / 99 are the non-state codes the GSTIN format allows.
 */
export const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '96': 'Other Country',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

const STATE_ALIASES = {
  orissa: '21',
  pondicherry: '34',
  puducherry: '34',
  'new delhi': '07',
  'jammu and kashmir': '01',
  'dadra and nagar haveli': '26',
  'daman and diu': '26',
  'andaman and nicobar': '35',
};

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const warn = (code, message) => ({ code, message });

const normalizeToken = (value) => (value == null ? '' : String(value).trim().toUpperCase());

/**
 * Check character for the first 14 characters of a GSTIN.
 * Returns '' when the input is not 14 alphabet characters.
 *
 * @param {string} first14
 * @returns {string}
 */
export const gstinCheckCharacter = (first14) => {
  const body = normalizeToken(first14);
  if (!/^[0-9A-Z]{14}$/.test(body)) return '';
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const weight = i % 2 === 0 ? 1 : 2;
    const product = ALPHABET.indexOf(body[i]) * weight;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
};

/**
 * @param {string|null} value
 * @returns {{ warnings: Array<{code: string, message: string}>, normalized: string }}
 */
export const inspectGstin = (value) => {
  const normalized = normalizeToken(value);
  const warnings = [];
  if (!normalized) return { warnings, normalized };
  const shape = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])([A-Z])([0-9A-Z])$/;
  const match = normalized.match(shape);
  if (!match || !GST_STATE_CODES[match[1]] || match[4] !== 'Z') {
    warnings.push(warn('gstin_format', `GSTIN ${normalized} is not a 15-character GSTIN (state code, PAN, entity, Z, check character).`));
    return { warnings, normalized };
  }
  const expected = gstinCheckCharacter(normalized.slice(0, 14));
  if (expected !== normalized[14]) {
    warnings.push(warn('gstin_checksum', `GSTIN ${normalized} fails the modulus-36 check. The printed value was kept.`));
  }
  return { warnings, normalized };
};

/**
 * Structural PAN: five letters, four digits, one letter.
 * The fourth-character holder type is not rejected. Real PANs use letters
 * outside the short public list, so a type mismatch would be a false warning.
 *
 * @param {string|null} value
 * @returns {Array<{code: string, message: string}>}
 */
export const inspectPan = (value) => {
  const normalized = normalizeToken(value);
  if (!normalized) return [];
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(normalized)) {
    return [warn('pan_format', `PAN ${normalized} is not five letters, four digits, and a letter. The printed value was kept.`)];
  }
  return [];
};

/**
 * Parses a printed date. Numeric dates are day-first when both numbers could
 * be a day or a month, which is the usual Indian invoice order. Returns null
 * when the calendar date is impossible (31/02/2024) or the shape is unknown.
 * Does not reformat the original string.
 *
 * @param {string|null} value
 * @returns {{ year: number, month: number, day: number }|null}
 */
export const parsePrintedDate = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  let day;
  let month;
  let year;
  let match = text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if ((match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/))) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    year = Number(match[3]);
    if (first > 12) {
      day = first;
      month = second;
    } else if (second > 12) {
      month = first;
      day = second;
    } else {
      day = first;
      month = second;
    }
  } else if ((match = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{2,4})$/))) {
    day = Number(match[1]);
    month = MONTHS[match[2].slice(0, 3).toLowerCase()];
    year = Number(match[3]);
  } else if ((match = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/))) {
    month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    day = Number(match[2]);
    year = Number(match[3]);
  } else {
    return null;
  }
  if (!month || !day || !year) return null;
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
};

/**
 * @param {string|null} value
 * @returns {number|null}
 */
export const parseMoney = (value) => {
  if (value == null) return null;
  const text = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

/**
 * @param {number} left
 * @param {number} right
 */
export const amountsDiffer = (left, right) =>
  Math.abs(Math.round(left * 100) - Math.round(right * 100)) > Math.round(AMOUNT_TOLERANCE * 100);

/**
 * @param {string|null} value
 * @returns {string|null} State code, or null when it cannot be resolved.
 */
export const resolveSupplyState = (value) => {
  if (value == null || !String(value).trim()) return null;
  const text = String(value).trim();
  const leadingCode = text.match(/^(\d{2})\b/);
  if (leadingCode && GST_STATE_CODES[leadingCode[1]]) return leadingCode[1];
  const normalized = text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (STATE_ALIASES[normalized]) return STATE_ALIASES[normalized];
  let best = null;
  const names = [
    ...Object.entries(GST_STATE_CODES).map(([code, name]) => [code, name.toLowerCase()]),
    ...Object.entries(STATE_ALIASES).map(([name, code]) => [code, name]),
  ];
  for (const [code, name] of names) {
    if (normalized === name || normalized.includes(name)) {
      if (!best || name.length > best.length) best = { code, length: name.length };
    }
  }
  return best ? best.code : null;
};

const HSN_RE = /^(?:\d{4}|\d{6}|\d{8})$/;

/**
 * One invoice line as printed by the synthetic GST fixtures:
 * HSN, Taxable, CGST, SGST, IGST, Line Total.
 *
 * @param {string} line
 * @returns {{ hsn: string, taxable: number, cgst: number, sgst: number, igst: number, total: number }|null}
 */
export const parseGstLine = (line) => {
  const match = line.match(
    /HSN(?:\/SAC)?\s*[:.]?\s*(\S+)\s+Taxable\s*[:.]?\s*([\d,]+(?:\.\d{1,2})?)\s+CGST\s*[:.]?\s*([\d,]+(?:\.\d{1,2})?)\s+SGST\s*[:.]?\s*([\d,]+(?:\.\d{1,2})?)\s+IGST\s*[:.]?\s*([\d,]+(?:\.\d{1,2})?)\s+Line\s+Total\s*[:.]?\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
  if (!match) return null;
  const taxable = parseMoney(match[2]);
  const cgst = parseMoney(match[3]);
  const sgst = parseMoney(match[4]);
  const igst = parseMoney(match[5]);
  const total = parseMoney(match[6]);
  if ([taxable, cgst, sgst, igst, total].some((n) => n == null)) return null;
  return { hsn: match[1], taxable, cgst, sgst, igst, total };
};

const valueForRole = (fields, fieldConfigs, role) => {
  const field = fieldConfigs.find((item) => item.role === role);
  if (!field) return undefined;
  return fields[field.name] ?? null;
};

const requireMoney = (warnings, role, value, missingCode, invalidCode, label) => {
  if (value == null || value === '') {
    warnings.push(warn(missingCode, `${label} was not found.`));
    return null;
  }
  const parsed = parseMoney(value);
  if (parsed == null) {
    warnings.push(warn(invalidCode, `${label} "${value}" is not a number. The printed value was kept.`));
    return null;
  }
  return parsed;
};

/**
 * @param {{ fields: Record<string, string|null>, fieldConfigs: object[], text: string }} input
 * @returns {Array<{code: string, message: string}>}
 */
export const validateIndianGst = ({ fields, fieldConfigs, text }) => {
  const gstSignal = /\b(?:GSTIN|CGST|SGST|UTGST|IGST|HSN|SAC)\b/i.test(text || '');
  if (!gstSignal) return [];

  const warnings = [];
  const gstin = valueForRole(fields, fieldConfigs, 'gstin');
  const pan = valueForRole(fields, fieldConfigs, 'pan');
  const invoiceNumber = valueForRole(fields, fieldConfigs, 'invoiceNumber');
  const invoiceDate = valueForRole(fields, fieldConfigs, 'invoiceDate');
  const hsnSac = valueForRole(fields, fieldConfigs, 'hsnSac');
  const place = valueForRole(fields, fieldConfigs, 'placeOfSupply');
  const lineItems = valueForRole(fields, fieldConfigs, 'lineItems');

  if (gstin == null || gstin === '') warnings.push(warn('gstin_missing', 'GSTIN was not found.'));
  else warnings.push(...inspectGstin(gstin).warnings);

  if (pan == null || pan === '') warnings.push(warn('pan_missing', 'PAN was not found.'));
  else warnings.push(...inspectPan(pan));

  if (gstin && pan && normalizeToken(gstin).length >= 12) {
    const embedded = normalizeToken(gstin).slice(2, 12);
    if (embedded !== normalizeToken(pan)) {
      warnings.push(warn('pan_gstin_mismatch', `PAN ${normalizeToken(pan)} does not match the PAN inside GSTIN ${normalizeToken(gstin)}. Neither value was changed.`));
    }
  }

  if (invoiceNumber == null || invoiceNumber === '') {
    warnings.push(warn('invoice_number_missing', 'Invoice number was not found.'));
  } else if (String(invoiceNumber).trim().length < 3 || !/\d/.test(String(invoiceNumber))) {
    warnings.push(warn('invoice_number_format', `Invoice number "${invoiceNumber}" does not look like an identifier. The printed value was kept.`));
  }

  if (invoiceDate == null || invoiceDate === '') {
    warnings.push(warn('invoice_date_missing', 'Invoice date was not found.'));
  } else if (!parsePrintedDate(invoiceDate)) {
    warnings.push(warn('invoice_date_invalid', `Invoice date "${invoiceDate}" is not a real calendar date. The printed value was kept.`));
  }

  if (hsnSac == null || hsnSac === '') {
    warnings.push(warn('hsn_missing', 'No HSN or SAC code was found.'));
  } else {
    for (const code of String(hsnSac).split(',').map((part) => part.trim()).filter(Boolean)) {
      if (!HSN_RE.test(code)) {
        warnings.push(warn('hsn_format', `HSN/SAC "${code}" is not 4, 6, or 8 digits. The printed value was kept.`));
      }
    }
  }

  let supplyCode = null;
  if (place == null || place === '') {
    warnings.push(warn('place_of_supply_missing', 'Place of supply was not found.'));
  } else {
    supplyCode = resolveSupplyState(place);
    if (!supplyCode) {
      warnings.push(warn('place_of_supply_unknown', `Place of supply "${place}" is not a known GST state or code. The printed value was kept.`));
    }
  }

  const taxable = requireMoney(warnings, 'taxableValue', valueForRole(fields, fieldConfigs, 'taxableValue'), 'taxable_value_missing', 'taxable_value_invalid', 'Taxable value');
  const cgst = requireMoney(warnings, 'cgst', valueForRole(fields, fieldConfigs, 'cgst'), 'cgst_missing', 'cgst_invalid', 'CGST');
  const sgst = requireMoney(warnings, 'sgst', valueForRole(fields, fieldConfigs, 'sgst'), 'sgst_missing', 'sgst_invalid', 'SGST');
  const igst = requireMoney(warnings, 'igst', valueForRole(fields, fieldConfigs, 'igst'), 'igst_missing', 'igst_invalid', 'IGST');
  const total = requireMoney(warnings, 'total', valueForRole(fields, fieldConfigs, 'total'), 'total_missing', 'total_invalid', 'Invoice total');

  if (cgst != null && sgst != null && amountsDiffer(cgst, sgst) && (cgst > AMOUNT_TOLERANCE || sgst > AMOUNT_TOLERANCE)) {
    warnings.push(warn('cgst_sgst_mismatch', `CGST ${cgst.toFixed(2)} and SGST ${sgst.toFixed(2)} differ by more than ${AMOUNT_TOLERANCE}. Neither amount was changed.`));
  }
  if (cgst != null && sgst != null && ((cgst > AMOUNT_TOLERANCE && sgst <= AMOUNT_TOLERANCE) || (sgst > AMOUNT_TOLERANCE && cgst <= AMOUNT_TOLERANCE))) {
    warnings.push(warn('cgst_sgst_incomplete', 'Only one of CGST and SGST is charged. Intra-state GST is split across both. Neither amount was changed.'));
  }
  if (igst != null && igst > AMOUNT_TOLERANCE && ((cgst != null && cgst > AMOUNT_TOLERANCE) || (sgst != null && sgst > AMOUNT_TOLERANCE))) {
    warnings.push(warn('tax_split_conflict', 'IGST is charged together with CGST or SGST. Those are different supplies. Neither amount was changed.'));
  }

  const supplierCode = gstin && inspectGstin(gstin).warnings.every((item) => item.code !== 'gstin_format')
    ? normalizeToken(gstin).slice(0, 2)
    : null;
  if (supplierCode && supplyCode && cgst != null && sgst != null && igst != null) {
    const intra = supplierCode === supplyCode;
    const localTax = cgst > AMOUNT_TOLERANCE || sgst > AMOUNT_TOLERANCE;
    const integrated = igst > AMOUNT_TOLERANCE;
    if (intra && integrated && !localTax) {
      warnings.push(warn('tax_split_inconsistent', 'Place of supply matches the GSTIN state, but IGST is charged instead of CGST and SGST. Amounts were not changed.'));
    }
    if (!intra && localTax && !integrated) {
      warnings.push(warn('tax_split_inconsistent', 'Place of supply differs from the GSTIN state, but CGST/SGST is charged instead of IGST. Amounts were not changed.'));
    }
  }

  if (taxable != null && total != null && cgst != null && sgst != null && igst != null) {
    const computed = taxable + cgst + sgst + igst;
    if (amountsDiffer(computed, total)) {
      warnings.push(warn(
        'invoice_total_mismatch',
        `Taxable value plus CGST, SGST, and IGST is ${computed.toFixed(2)}, which differs from the invoice total ${total.toFixed(2)} by more than ${AMOUNT_TOLERANCE}. The printed total was kept.`,
      ));
    }
  }

  if (lineItems) {
    const lines = String(lineItems).split(' | ').map((line) => line.trim()).filter(Boolean);
    let lineTaxable = 0;
    let lineTotal = 0;
    let parsed = 0;
    for (const line of lines) {
      const row = parseGstLine(line);
      if (!row) {
        warnings.push(warn('line_unparsed', `Line "${line}" has a line total but could not be read. It was left as printed.`));
        continue;
      }
      parsed += 1;
      lineTaxable += row.taxable;
      lineTotal += row.total;
    }
    if (parsed > 0 && taxable != null && amountsDiffer(lineTaxable, taxable)) {
      warnings.push(warn('line_taxable_mismatch', `Line taxable amounts sum to ${lineTaxable.toFixed(2)}, which differs from the invoice taxable value ${taxable.toFixed(2)}. Neither value was changed.`));
    }
    if (parsed > 0 && total != null && amountsDiffer(lineTotal, total)) {
      warnings.push(warn('line_total_mismatch', `Line totals sum to ${lineTotal.toFixed(2)}, which differs from the invoice total ${total.toFixed(2)}. The printed total was kept.`));
    }
  }

  return warnings;
};

const VALIDATORS = {
  indianGst: validateIndianGst,
};

/**
 * Runs the validator named by a document type's `validate` field.
 * Unknown names warn once. They do not throw and do not change fields.
 *
 * @param {string|undefined} name
 * @param {{ fields: Record<string, string|null>, fieldConfigs: object[], text: string }} input
 */
export const runSchemaValidator = (name, input) => {
  if (!name) return [];
  const validator = VALIDATORS[name];
  if (!validator) return [warn('unknown_validator', `Schema validator "${name}" is not implemented.`)];
  return validator(input);
};

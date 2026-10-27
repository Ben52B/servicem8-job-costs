/**
 * Fixed list of screw-up reasons. Codes are stored in the database and used in
 * reports, so never rename a code. Labels can change, and new reasons can be
 * added at the end.
 */
const MISTAKE_REASONS = [
  { code: 'wrong_measurement', label: 'Wrong measurement' },
  { code: 'wrong_size', label: 'Wrong size ordered' },
  { code: 'wrong_colour', label: 'Wrong colour / finish' },
  { code: 'wrong_product', label: 'Wrong product / model' },
  { code: 'wrong_quantity', label: 'Wrong quantity' },
  { code: 'damaged', label: 'Damaged on site / install' },
  { code: 'rework', label: 'Return visit / rework' },
  { code: 'supplier_error', label: 'Supplier error' },
  { code: 'other', label: 'Other' },
];

const REASON_CODES = new Set(MISTAKE_REASONS.map((r) => r.code));
const reasonLabel = (code) => (MISTAKE_REASONS.find((r) => r.code === code) || {}).label || code;

module.exports = { MISTAKE_REASONS, REASON_CODES, reasonLabel };

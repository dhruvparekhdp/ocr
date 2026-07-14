/** Document type constants — used consistently across the classifier, LLM prompt, and batching logic. */
export const DOC_TYPES = Object.freeze({
  PO: 'PO',
  INVOICE: 'Invoice',
  AWB_BL: 'AWB_BL',
  SHIPPING_BILL: 'Shipping Bill',
  UNKNOWN: 'Unknown',
});

/**
 * Error the HTTP layer may show to a client. `publicMessage` is the only
 * text that should leave the process — not stack traces or file paths.
 */
export class ServiceError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string} publicMessage
   */
  constructor(code, status, publicMessage) {
    super(publicMessage);
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

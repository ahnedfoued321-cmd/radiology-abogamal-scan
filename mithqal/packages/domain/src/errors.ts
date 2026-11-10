/** A business-rule violation (bad input or a state the rules forbid). APIs map it to HTTP 422, never 500. */
export class DomainError extends Error {
  override name = "DomainError";
}

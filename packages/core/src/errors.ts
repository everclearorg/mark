export class MarkError extends Error {
  constructor(
    public readonly type: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

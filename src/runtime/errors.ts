export type RuntimeCommandErrorOptions = {
  code: string;
  message: string;
  hint: string;
  path: string;
};

export class RuntimeCommandError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly path: string;

  constructor(options: RuntimeCommandErrorOptions) {
    super(options.message);
    this.name = "RuntimeCommandError";
    this.code = options.code;
    this.hint = options.hint;
    this.path = options.path;
  }
}

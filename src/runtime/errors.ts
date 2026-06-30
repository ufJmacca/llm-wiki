export type RuntimeCommandIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
  hint: string;
};

export type RuntimeCommandErrorOptions = {
  code: string;
  message: string;
  hint: string;
  path: string;
  issues?: RuntimeCommandIssue[];
};

export class RuntimeCommandError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly path: string;
  readonly issues?: RuntimeCommandIssue[];

  constructor(options: RuntimeCommandErrorOptions) {
    super(options.message);
    this.name = "RuntimeCommandError";
    this.code = options.code;
    this.hint = options.hint;
    this.path = options.path;
    this.issues = options.issues;
  }
}

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
  executable?: string;
  exitCode?: number | null;
  stderrTail?: string;
  timedOut?: boolean;
  workspaceMutationsObserved?: boolean;
};

export class RuntimeCommandError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly path: string;
  readonly issues?: RuntimeCommandIssue[];
  readonly executable?: string;
  readonly exitCode?: number | null;
  readonly stderrTail?: string;
  readonly timedOut?: boolean;
  readonly workspaceMutationsObserved?: boolean;

  constructor(options: RuntimeCommandErrorOptions) {
    super(options.message);
    this.name = "RuntimeCommandError";
    this.code = options.code;
    this.hint = options.hint;
    this.path = options.path;
    this.issues = options.issues;
    this.executable = options.executable;
    this.exitCode = options.exitCode;
    this.stderrTail = options.stderrTail;
    this.timedOut = options.timedOut;
    this.workspaceMutationsObserved = options.workspaceMutationsObserved;
  }
}

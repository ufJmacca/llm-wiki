import type { WikiRootError } from "./repo.js";
import type { RuntimeCommandError } from "./errors.js";

export type RuntimeIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
  hint: string;
};

export type RuntimeErrorEnvelope = {
  code: string;
  message: string;
  hint: string;
  executable?: string;
  exit_code?: number | null;
  stderr_tail?: string;
  timed_out?: boolean;
  workspace_mutations_observed?: boolean;
};

export type RuntimeSuccessEnvelope<Command extends string, Data> = {
  ok: true;
  command: Command;
  repo: string;
  data: Data;
  warnings: string[];
};

export type RuntimeFailureEnvelope<Command extends string> = {
  ok: false;
  command: Command;
  repo: string | null;
  error: RuntimeErrorEnvelope;
  issues: RuntimeIssue[];
};

export type RuntimePartialFailureEnvelope<Command extends string, Data> = {
  ok: false;
  command: Command;
  repo: string;
  data: Data;
  warnings: string[];
  error: RuntimeErrorEnvelope;
  issues: RuntimeIssue[];
};

export function buildRuntimeSuccessEnvelope<Command extends string, Data>(
  command: Command,
  repo: string,
  data: Data,
  warnings: string[] = [],
): RuntimeSuccessEnvelope<Command, Data> {
  return {
    ok: true,
    command,
    repo,
    data,
    warnings,
  };
}

export function buildRuntimeFailureEnvelope<Command extends string>(
  command: Command,
  error: WikiRootError,
  repo: string | null = null,
): RuntimeFailureEnvelope<Command> {
  return {
    ok: false,
    command,
    repo,
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint,
    },
    issues: [
      {
        severity: "error",
        code: error.code,
        message: error.message,
        path: error.startPath,
        hint: error.hint,
      },
    ],
  };
}

export function buildRuntimeCommandFailureEnvelope<Command extends string>(
  command: Command,
  error: RuntimeCommandError,
  repo: string,
): RuntimeFailureEnvelope<Command> {
  return {
    ok: false,
    command,
    repo,
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...runtimeProcessErrorFields(error),
    },
    issues: error.issues ?? [
      {
        severity: "error",
        code: error.code,
        message: error.message,
        path: error.path,
        hint: error.hint,
      },
    ],
  };
}

function runtimeProcessErrorFields(error: RuntimeCommandError): Partial<RuntimeErrorEnvelope> {
  if (error.executable === undefined) {
    return {};
  }

  return {
    executable: error.executable,
    exit_code: error.exitCode ?? null,
    stderr_tail: error.stderrTail ?? "",
    timed_out: error.timedOut ?? false,
    workspace_mutations_observed: error.workspaceMutationsObserved ?? false,
  };
}

export function buildRuntimePartialFailureEnvelope<Command extends string, Data>(
  command: Command,
  repo: string,
  data: Data,
  error: RuntimeCommandError,
  issues: RuntimeIssue[],
  warnings: string[] = [],
): RuntimePartialFailureEnvelope<Command, Data> {
  return {
    ok: false,
    command,
    repo,
    data,
    warnings,
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...runtimeProcessErrorFields(error),
    },
    issues,
  };
}

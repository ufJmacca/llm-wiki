import type { Command } from "commander";

import { RuntimeCommandError } from "../runtime/errors.js";
import type { PdfExtractionSettingOverrides } from "./config.js";

export type RawPdfExtractionOptions = {
  pdfModel?: unknown;
  pdfReasoningEffort?: unknown;
  pdfDetail?: unknown;
  force?: unknown;
};

export const PDF_EXTRACT_HELP = `
PDF extraction requires the user-managed pdf@openai-primary-runtime Codex plugin. Use llm-wiki status and codex plugin list --json to diagnose readiness.
Settings resolve from the CLI, then pdf_ingestion, then defaults or inheritance; omitting --pdf-model inherits Codex's active model.
Examples:
  llm-wiki extract pdf <source_id>
  llm-wiki extract pdf <source_id> --force
If the queue is blocked, first run llm-wiki queue set-status <source_id> queued.
`;

export const PDF_INGEST_HELP = `
PDF controls apply only when automated ingest uses the configured Codex PDF agent.
Manual, validation, provider, and other-agent modes require a pre-existing validated PDF artifact.
Example: llm-wiki ingest <source_id> --auto --pdf-detail high
`;

export const PDF_QUEUE_HELP = `
PDF controls apply independently to each PDF selected by source, batch, or watch processing; --force creates one new run for each attempted PDF.
Examples:
  llm-wiki queue ingest --auto --source-id <source_id> --pdf-detail high
  llm-wiki queue ingest --auto --limit 5 --pdf-detail high
  llm-wiki queue ingest --auto --watch --pdf-detail high
`;

export const PDF_STATUS_HELP = `
Status reports PDF readiness and keeps Queue status separate from PDF extraction status.
`;

export function addPdfExtractionOptions(command: Command): Command {
  return command
    .option("--pdf-model <model>", "override the Codex model for PDF extraction")
    .option("--pdf-reasoning-effort <effort>", "override Codex reasoning effort for PDF extraction")
    .option("--pdf-detail <detail>", "set PDF plugin detail: auto, low, or high")
    .option("--force", "force one new immutable PDF extraction run", false);
}

export function pdfOverridesFromRawOptions(options: RawPdfExtractionOptions): PdfExtractionSettingOverrides {
  return {
    model: options.pdfModel,
    reasoningEffort: options.pdfReasoningEffort,
    pdfDetail: options.pdfDetail,
    force: options.force,
  };
}

export function hasPdfExtractionOptions(options: RawPdfExtractionOptions): boolean {
  return options.pdfModel !== undefined
    || options.pdfReasoningEffort !== undefined
    || options.pdfDetail !== undefined
    || options.force === true;
}

export function rejectPdfOptionsForNonExtractionMode(
  options: RawPdfExtractionOptions,
  mode: string,
  hint: string,
): void {
  if (!hasPdfExtractionOptions(options)) {
    return;
  }

  throw new RuntimeCommandError({
    code: "PDF_CONFIG_INVALID",
    message: `PDF extraction options cannot be used with ${mode}.`,
    path: firstPdfOption(options),
    hint,
  });
}

function firstPdfOption(options: RawPdfExtractionOptions): string {
  if (options.pdfModel !== undefined) {
    return "--pdf-model";
  }
  if (options.pdfReasoningEffort !== undefined) {
    return "--pdf-reasoning-effort";
  }
  if (options.pdfDetail !== undefined) {
    return "--pdf-detail";
  }
  return "--force";
}

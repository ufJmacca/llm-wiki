import type { Command } from "commander";

import { RuntimeCommandError } from "../runtime/errors.js";
import type { PdfExtractionSettingOverrides } from "./config.js";

export type RawPdfExtractionOptions = {
  pdfModel?: unknown;
  pdfReasoningEffort?: unknown;
  pdfDetail?: unknown;
  force?: unknown;
};

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

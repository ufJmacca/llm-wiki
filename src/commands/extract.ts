import type { Command } from "commander";

import type { CliIo } from "../cli.js";
import { addPdfExtractionOptions, pdfOverridesFromRawOptions, type RawPdfExtractionOptions } from "../pdf/cli.js";
import { extractPdfSource, type PdfExtractionResult } from "../pdf/extraction.js";
import {
  addRuntimeOptions,
  runRuntimeCommand,
  type RawRuntimeCommandOptions,
} from "../runtime/command.js";

type RawExtractPdfOptions = RawRuntimeCommandOptions & RawPdfExtractionOptions;

export function registerExtractCommand(program: Command, io: CliIo): void {
  const extract = program
    .command("extract")
    .description("Create validated private source extraction artifacts");

  addRuntimeOptions(addPdfExtractionOptions(
    extract
      .command("pdf")
      .description("Extract a queued PDF with the configured Codex PDF plugin")
      .argument("<source_id>", "queued PDF source ID"),
  )).action(async (sourceId: string, rawOptions: RawExtractPdfOptions) => {
    await runRuntimeCommand({
      command: "extract pdf",
      rawOptions,
      io,
      run: async ({ repo }) => {
        return {
          data: await extractPdfSource({
            repoRoot: repo.rootDir,
            sourceId,
            overrides: pdfOverridesFromRawOptions(rawOptions),
          }),
        };
      },
      formatHuman: (envelope) => formatHumanExtraction(envelope.data),
    });
  });
}

function formatHumanExtraction(data: PdfExtractionResult): string {
  return [
    `PDF extraction ${data.outcome}`,
    `Source ID: ${data.source_id}`,
    `PDF extraction status: ${data.pdf_extraction.status}`,
    `Extraction ID: ${data.extraction_id}`,
    `Artifact: ${data.artifact_path}`,
    ...(data.recovered_interrupted ? ["Recovered interrupted extraction: yes"] : []),
  ].join("\n");
}

import type { Command } from "commander";

import type { CliIo } from "../cli.js";
import { addPdfExtractionOptions, pdfOverridesFromRawOptions, type RawPdfExtractionOptions } from "../pdf/cli.js";
import { loadPdfIngestionRuntimeConfig, resolvePdfExtractionSettings } from "../pdf/config.js";
import { preflightPdfIngestion, type PdfReadinessError } from "../pdf/readiness.js";
import {
  addRuntimeOptions,
  runRuntimeCommand,
  type RawRuntimeCommandOptions,
} from "../runtime/command.js";
import { RuntimeCommandError } from "../runtime/errors.js";

type RawExtractPdfOptions = RawRuntimeCommandOptions & RawPdfExtractionOptions;

type ExtractPdfReadinessData = {
  status: "ready";
  source_id: string;
  settings: {
    model: string | null;
    reasoning_effort: string;
    pdf_detail: "auto" | "low" | "high";
    force: boolean;
  };
  readiness: {
    codex_agent: string;
    executable_path: string;
    required_plugin: string;
    plugin_version: string | null;
    plugin_descriptor: string | null;
  };
};

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
        const runtime = await loadPdfIngestionRuntimeConfig(repo.rootDir);
        if (!runtime.ok) {
          throw pdfReadinessRuntimeError(runtime.error);
        }

        const settings = resolvePdfExtractionSettings(
          runtime.value.config,
          pdfOverridesFromRawOptions(rawOptions),
        );
        if (!settings.ok) {
          throw pdfReadinessRuntimeError(settings.error);
        }

        const readiness = await preflightPdfIngestion(repo.rootDir);
        if (!readiness.ok) {
          throw pdfReadinessRuntimeError(readiness.error);
        }

        return {
          data: {
            status: "ready" as const,
            source_id: sourceId,
            settings: {
              model: settings.value.model,
              reasoning_effort: settings.value.reasoningEffort,
              pdf_detail: settings.value.pdfDetail,
              force: settings.value.force,
            },
            readiness: {
              codex_agent: readiness.value.runtime.config.codexAgent,
              executable_path: readiness.value.executablePath,
              required_plugin: readiness.value.plugin.id,
              plugin_version: readiness.value.plugin.version,
              plugin_descriptor: readiness.value.plugin.descriptor,
            },
          } satisfies ExtractPdfReadinessData,
        };
      },
      formatHuman: (envelope) => [
        `PDF extraction readiness passed for ${envelope.data.source_id}.`,
        `Codex agent: ${envelope.data.readiness.codex_agent}`,
        `Required plugin: ${envelope.data.readiness.required_plugin}`,
      ].join("\n"),
    });
  });
}

function pdfReadinessRuntimeError(error: PdfReadinessError): RuntimeCommandError {
  return new RuntimeCommandError({
    code: error.code,
    message: error.message,
    hint: error.hint,
    path: error.path,
  });
}

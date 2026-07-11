import { extname } from "node:path";

import type { LocalAgentConfig } from "../runtime/config.js";
import { RuntimeCommandError } from "../runtime/errors.js";
import { assertIngestLockLease, type IngestLockLease } from "../runtime/ingestLock.js";
import { showQueueSource } from "../runtime/queue.js";
import type { PdfExtractionSettingOverrides } from "../pdf/config.js";
import { readPdfIngestionConfig } from "../pdf/config.js";
import {
  ensurePreparedPdfArtifactUnderLock,
  preparePdfExtractionForAutomatedIngest,
  readValidatedPdfArtifact,
  type PreparedPdfExtractionOperation,
  type ValidatedPdfArtifact,
} from "../pdf/extraction.js";
import { readPdfExtractionSourceState } from "../pdf/state.js";
import type { PdfExtractionStatus } from "../pdf/stateSchema.js";

export type CanonicalIngestArtifact = {
  kind: "pdf";
  original_path: string;
  artifact_path: string;
  metadata_path: string;
  extraction_id: string;
  content: string;
};

export type PdfIngestArtifactOutcome =
  | "not_applicable"
  | "existing"
  | "extracted"
  | "reused"
  | "failed"
  | "readiness_rejected";

export type PdfIngestArtifactResult = {
  applicable: boolean;
  outcome: PdfIngestArtifactOutcome;
  status: PdfExtractionStatus | null;
  extraction_id: string | null;
  artifact_path: string | null;
};

export type PreparedIngestArtifact =
  | {
      kind: "not_applicable";
      repoRoot: string;
      sourceId: string;
      includeResult: boolean;
    }
  | {
      kind: "existing";
      repoRoot: string;
      sourceId: string;
      artifact: CanonicalIngestArtifact;
    }
  | {
      kind: "pdf_extraction";
      prepared: PreparedPdfExtractionOperation;
    };

export type EnsuredIngestArtifact = {
  artifact: CanonicalIngestArtifact | null;
  pdf: PdfIngestArtifactResult | null;
};

export async function readRequiredIngestArtifact(
  repoRoot: string,
  sourceId: string,
): Promise<CanonicalIngestArtifact | null> {
  const classification = await classifySource(repoRoot, sourceId);
  if (!classification.pdf) return null;

  const config = await readPdfIngestionConfig(repoRoot);
  if (!config.ok) throw new RuntimeCommandError(config.error);
  if (!config.value.requireArtifactBeforeIngest) return null;

  return toCanonicalArtifact(await readValidatedPdfArtifact(repoRoot, sourceId));
}

export async function sourceRequiresPdfArtifact(repoRoot: string, sourceId: string): Promise<boolean> {
  return (await classifySource(repoRoot, sourceId)).pdf;
}

export async function revalidateCanonicalIngestArtifact(
  repoRoot: string,
  sourceId: string,
  expected: CanonicalIngestArtifact | null,
): Promise<CanonicalIngestArtifact | null> {
  const current = await readRequiredIngestArtifact(repoRoot, sourceId);
  if (expected === null) return current;
  if (
    current === null
    || current.kind !== expected.kind
    || current.original_path !== expected.original_path
    || current.artifact_path !== expected.artifact_path
    || current.metadata_path !== expected.metadata_path
    || current.extraction_id !== expected.extraction_id
    || current.content !== expected.content
  ) {
    throw new RuntimeCommandError({
      code: "PDF_ARTIFACT_INCONSISTENT",
      message: "The canonical PDF artifact changed during curated ingest.",
      path: expected.artifact_path,
      hint: `Run llm-wiki extract pdf ${sourceId} and retry ingest with the newly validated artifact.`,
    });
  }
  return current;
}

export async function prepareAutomatedIngestArtifact(input: {
  repoRoot: string;
  sourceId: string;
  agent: LocalAgentConfig;
  overrides?: PdfExtractionSettingOverrides;
  includeNotApplicableResult?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<PreparedIngestArtifact> {
  const classification = await classifySource(input.repoRoot, input.sourceId);
  const overridesProvided = hasEffectiveOverrides(input.overrides);
  if (!classification.pdf) {
    if (overridesProvided && input.includeNotApplicableResult !== true) {
      throw new RuntimeCommandError({
        code: "PDF_CONFIG_INVALID",
        message: "PDF extraction options cannot be used for a non-PDF source.",
        path: input.sourceId,
        hint: "Remove the PDF options or select an eligible file-backed PDF source.",
      });
    }
    return {
      kind: "not_applicable",
      repoRoot: input.repoRoot,
      sourceId: input.sourceId,
      includeResult: input.includeNotApplicableResult === true && overridesProvided,
    };
  }

  const config = await readPdfIngestionConfig(input.repoRoot);
  if (!config.ok) throw new RuntimeCommandError(config.error);
  if (input.agent.name !== config.value.codexAgent) {
    if (overridesProvided) {
      throw new RuntimeCommandError({
        code: "PDF_CONFIG_INVALID",
        message: `PDF extraction options require agent ${config.value.codexAgent}.`,
        path: input.agent.name,
        hint: `Use agent ${config.value.codexAgent} or run llm-wiki extract pdf ${input.sourceId} first.`,
      });
    }
    return {
      kind: "existing",
      repoRoot: input.repoRoot,
      sourceId: input.sourceId,
      artifact: await readRequiredPdfArtifact(input.repoRoot, input.sourceId),
    };
  }

  return {
    kind: "pdf_extraction",
    prepared: await preparePdfExtractionForAutomatedIngest({
      repoRoot: input.repoRoot,
      sourceId: input.sourceId,
      overrides: input.overrides,
      env: input.env,
    }),
  };
}

export async function ensurePreparedIngestArtifactUnderLock(
  prepared: PreparedIngestArtifact,
  lease: IngestLockLease,
  options: { onReady?: () => Promise<void> } = {},
): Promise<EnsuredIngestArtifact> {
  const repoRoot = prepared.kind === "pdf_extraction" ? prepared.prepared.repoRoot : prepared.repoRoot;
  assertIngestLockLease(lease, repoRoot);
  if (prepared.kind === "not_applicable") {
    await options.onReady?.();
    return {
      artifact: null,
      pdf: prepared.includeResult ? notApplicablePdfResult() : null,
    };
  }

  if (prepared.kind === "existing") {
    await readValidatedPdfArtifact(prepared.repoRoot, prepared.sourceId);
    await options.onReady?.();
    const revalidatedArtifact = toCanonicalArtifact(
      await readValidatedPdfArtifact(prepared.repoRoot, prepared.sourceId),
    );
    return {
      artifact: revalidatedArtifact,
      pdf: pdfResultFromArtifact("existing", revalidatedArtifact),
    };
  }

  const extraction = await ensurePreparedPdfArtifactUnderLock(prepared.prepared, lease, options);
  const artifact = toCanonicalArtifact(
    await readValidatedPdfArtifact(prepared.prepared.repoRoot, prepared.prepared.sourceId),
  );
  return {
    artifact,
    pdf: pdfResultFromArtifact(extraction.outcome, artifact),
  };
}

export async function readPdfIngestFailureResult(
  repoRoot: string,
  sourceId: string,
  outcome: "failed" | "readiness_rejected",
): Promise<PdfIngestArtifactResult> {
  try {
    const source = await readPdfExtractionSourceState(repoRoot, sourceId);
    return {
      applicable: true,
      outcome,
      status: source.state.status,
      extraction_id: source.state.extraction_id,
      artifact_path: source.state.artifact_path,
    };
  } catch {
    return {
      applicable: true,
      outcome,
      status: null,
      extraction_id: null,
      artifact_path: null,
    };
  }
}

function toCanonicalArtifact(validated: ValidatedPdfArtifact): CanonicalIngestArtifact {
  const extractionId = validated.metadata.extraction_id;
  return {
    kind: "pdf",
    original_path: validated.metadata.original_path,
    artifact_path: validated.metadata.artifact_path,
    metadata_path: validated.metadata.artifact_path.replace(/\/document\.md$/u, "/metadata.json"),
    extraction_id: extractionId,
    content: validated.content,
  };
}

async function readRequiredPdfArtifact(repoRoot: string, sourceId: string): Promise<CanonicalIngestArtifact> {
  return toCanonicalArtifact(await readValidatedPdfArtifact(repoRoot, sourceId));
}

async function classifySource(repoRoot: string, sourceId: string): Promise<{ pdf: boolean }> {
  const shown = await showQueueSource(repoRoot, sourceId);
  if (!shown.ok) {
    throw new RuntimeCommandError({
      code: shown.error.code,
      message: shown.error.message,
      path: shown.error.path,
      hint: shown.error.hint,
    });
  }
  return {
    pdf: shown.value.queue_record.source_kind === "file"
      && extname(shown.value.queue_record.original_path).toLowerCase() === ".pdf",
  };
}

function hasEffectiveOverrides(overrides: PdfExtractionSettingOverrides | undefined): boolean {
  return overrides?.model !== undefined
    || overrides?.reasoningEffort !== undefined
    || overrides?.pdfDetail !== undefined
    || overrides?.force === true;
}

function pdfResultFromArtifact(
  outcome: "existing" | "extracted" | "reused",
  artifact: CanonicalIngestArtifact,
): PdfIngestArtifactResult {
  return {
    applicable: true,
    outcome,
    status: "extracted",
    extraction_id: artifact.extraction_id,
    artifact_path: artifact.artifact_path,
  };
}

function notApplicablePdfResult(): PdfIngestArtifactResult {
  return {
    applicable: false,
    outcome: "not_applicable",
    status: null,
    extraction_id: null,
    artifact_path: null,
  };
}

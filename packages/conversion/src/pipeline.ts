import type { ConversionJob, FrameProjectionPlan, TargetTemplatePart, ValidationReport } from '../../core/src/index.js';
import { validateMappingsForExport } from '../../core/src/index.js';
import { renderMappingPreview, type RenderedFrame } from '../../render/src/index.js';
import { validateRenderedFrames } from '../../validation/src/index.js';
import { exportReviewBundle } from '../../export/src/index.js';

export type GoldenFrameProvider = (job: ConversionJob, target: TargetTemplatePart) => RenderedFrame[];

export interface RunConversionPipelineInput {
  job: ConversionJob;
  target: TargetTemplatePart;
  goldenFrames: GoldenFrameProvider;
  templateInventoryRef: string;
  allowedOutputRoot?: string;
}

export interface RunConversionPipelineResult {
  renderedFrames: RenderedFrame[];
  goldenFrames: RenderedFrame[];
  validationReport: ValidationReport;
}

function buffersOverlap(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.buffer !== b.buffer) return false;
  const aStart = a.byteOffset;
  const aEnd = a.byteOffset + a.byteLength;
  const bStart = b.byteOffset;
  const bEnd = b.byteOffset + b.byteLength;
  return aStart < bEnd && bStart < aEnd;
}

function frameKey(action: string, frameIndex: number): string {
  return `${action}\u0000${frameIndex}`;
}

function assertIndependentGoldenFrames(renderedFrames: RenderedFrame[], goldenFrames: RenderedFrame[]): void {
  for (const golden of goldenFrames) {
    const rendered = renderedFrames.find((frame) => frame.action === golden.action && frame.frameIndex === golden.frameIndex);
    if (!rendered) continue;
    if (golden === rendered || golden.rgbaBuffer === rendered.rgbaBuffer || buffersOverlap(golden.rgbaBuffer, rendered.rgbaBuffer)) {
      throw new Error(`Golden frame ${golden.action}:${golden.frameIndex} shares object or buffer identity with rendered output.`);
    }
  }
}

function implicitProjectionFromMatchingKeys(sourceFrames: RenderedFrame[], target: TargetTemplatePart): FrameProjectionPlan {
  const cells = target.frameGrid?.cells;
  if (!cells?.length) throw new Error(`Template ${target.templatePath} has no explicit frameGrid cells.`);
  const sourceKeys = new Set(sourceFrames.map((frame) => frameKey(frame.action, frame.frameIndex)));
  const targetKeys = new Set(cells.map((cell) => frameKey(cell.action, cell.frameIndex)));
  const missing = [...sourceKeys].filter((key) => !targetKeys.has(key));
  const extra = [...targetKeys].filter((key) => !sourceKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error('Rendered source action/frame keys do not match target frameGrid keys and no explicit frameProjectionPlan was supplied.');
  }
  return { cells: cells.map((cell) => ({ sourceAction: cell.action, sourceFrameIndex: cell.frameIndex, targetAction: cell.action, targetFrameIndex: cell.frameIndex })) };
}

export function projectFramesToTargetGrid(sourceFrames: RenderedFrame[], target: TargetTemplatePart, projectionPlan?: FrameProjectionPlan): RenderedFrame[] {
  const cells = target.frameGrid?.cells;
  if (!cells?.length) throw new Error(`Template ${target.templatePath} has no explicit frameGrid cells.`);
  const plan = projectionPlan ?? implicitProjectionFromMatchingKeys(sourceFrames, target);
  if (plan.cells.length !== sourceFrames.length || plan.cells.length !== cells.length) {
    throw new Error(`Frame projection plan must cover source frames (${sourceFrames.length}) and target frameGrid cells (${cells.length}) exactly.`);
  }
  const sourceByKey = new Map(sourceFrames.map((frame) => [frameKey(frame.action, frame.frameIndex), frame]));
  const targetCellKeys = new Set(cells.map((cell) => frameKey(cell.action, cell.frameIndex)));
  const seenSource = new Set<string>();
  const seenTarget = new Set<string>();
  const projected: RenderedFrame[] = [];
  for (const cell of plan.cells) {
    const sourceKey = frameKey(cell.sourceAction, cell.sourceFrameIndex);
    const targetKey = frameKey(cell.targetAction, cell.targetFrameIndex);
    if (seenSource.has(sourceKey)) throw new Error(`Duplicate source frame projection: ${cell.sourceAction}:${cell.sourceFrameIndex}.`);
    if (seenTarget.has(targetKey)) throw new Error(`Duplicate target frame projection: ${cell.targetAction}:${cell.targetFrameIndex}.`);
    if (!targetCellKeys.has(targetKey)) throw new Error(`Projection targets unknown frameGrid cell: ${cell.targetAction}:${cell.targetFrameIndex}.`);
    const source = sourceByKey.get(sourceKey);
    if (!source) throw new Error(`Projection references missing source frame: ${cell.sourceAction}:${cell.sourceFrameIndex}.`);
    seenSource.add(sourceKey);
    seenTarget.add(targetKey);
    projected.push({ ...source, action: cell.targetAction, frameIndex: cell.targetFrameIndex });
  }
  if (seenSource.size !== sourceFrames.length || seenTarget.size !== cells.length) {
    throw new Error('Frame projection did not preserve exact source and target coverage.');
  }
  return projected.sort((a, b) => a.action.localeCompare(b.action) || a.frameIndex - b.frameIndex);
}

export function runConversionPipeline(input: RunConversionPipelineInput): RunConversionPipelineResult {
  validateMappingsForExport(input.job.sourceFrameSet, input.job.mappings);
  const mismatchedTarget = input.job.mappings.find((mapping) => mapping.targetPartId !== input.target.id);
  if (mismatchedTarget) throw new Error(`Mapping ${mismatchedTarget.id} targets ${mismatchedTarget.targetPartId}, not export target ${input.target.id}.`);
  const sourceRenderedFrames = renderMappingPreview(input.job.normalizedFrameSet, input.job.mappings, input.target.width, input.target.height);
  const rawGoldenFrames = input.goldenFrames(input.job, input.target);
  assertIndependentGoldenFrames(sourceRenderedFrames, rawGoldenFrames);
  const sourceValidation = validateRenderedFrames(rawGoldenFrames, sourceRenderedFrames, input.job.validationPolicy);
  if (!sourceValidation.pass) throw new Error(`Conversion validation failed for source action frames in job ${input.job.id}.`);
  const renderedFrames = projectFramesToTargetGrid(sourceRenderedFrames, input.target, input.job.frameProjectionPlan);
  const goldenFrames = projectFramesToTargetGrid(rawGoldenFrames, input.target, input.job.frameProjectionPlan);
  const validationReport = {
    jobId: input.job.id,
    ...validateRenderedFrames(goldenFrames, renderedFrames, input.job.validationPolicy),
  };
  if (!validationReport.pass) throw new Error(`Conversion validation failed for job ${input.job.id}.`);
  exportReviewBundle({
    outputDir: input.job.outputDir,
    allowedOutputRoot: input.allowedOutputRoot,
    target: input.target,
    normalized: input.job.normalizedFrameSet,
    mappings: input.job.mappings,
    renderedFrames,
    expectedFrames: goldenFrames,
    validationReport,
    validationPolicy: input.job.validationPolicy,
    templateInventoryRef: input.templateInventoryRef,
  });
  return { renderedFrames, goldenFrames, validationReport };
}

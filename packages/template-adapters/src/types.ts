import type { PsdManifest } from '../../psd-gate/src/types.js';
import type { TargetTemplatePart } from '../../core/src/index.js';

export interface PsdTemplateReader {
  inventory(templateDir: string): Promise<PsdManifest[]> | PsdManifest[];
  manifestToTargetPart(manifest: PsdManifest): TargetTemplatePart;
}

export interface PsdTemplateWriter {
  readonly backend: string;
  roundtrip(templatePath: string, outputPath: string): Promise<void> | void;
}

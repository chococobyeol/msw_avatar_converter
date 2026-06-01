import path from 'node:path';
import { listTemplatePaths, manifestFor } from '../../psd-gate/src/manifest.js';
import type { PsdManifest } from '../../psd-gate/src/types.js';
import type { TargetPartId, TargetTemplatePart } from '../../core/src/index.js';
import type { PsdTemplateReader } from './types.js';

const targetByFile: Record<string, TargetPartId> = {
  'Avatar_Cap_A1.psd': 'cap-a1',
  'Avatar_Cap_A2.psd': 'cap-a2',
  'Avatar_Cap_Ani.psd': 'cap-ani',
  'Avatar_Cap_B.psd': 'cap-b',
  'Avatar_Cap_C1.psd': 'cap-c1',
  'Avatar_Cap_C2.psd': 'cap-c2',
  'Avatar_Cap_D.psd': 'cap-d',
  'Avatar_Cap_E.psd': 'cap-e',
  'Avatar_Cap_F.psd': 'cap-f',
  'Avatar_Cap_G.psd': 'cap-g',
  'Avatar_Cape.psd': 'cape',
  'Avatar_Cape_balloon.psd': 'cape-balloon',
  'Avatar_Gloves.psd': 'gloves',
  'Avatar_Hair.psd': 'hair',
  'Avatar_Longcoat.psd': 'longcoat',
  'Avatar_Pants.psd': 'pants',
  'Avatar_Shoes.psd': 'shoes',
};

export class AgPsdTemplateReader implements PsdTemplateReader {
  inventory(templateDir: string): PsdManifest[] {
    return listTemplatePaths(templateDir).map((file) => manifestFor(file));
  }

  manifestToTargetPart(manifest: PsdManifest): TargetTemplatePart {
    const file = path.basename(manifest.file);
    const id = targetByFile[file];
    if (!id) throw new Error(`Unknown MSW template file: ${file}`);
    const editableLayers = manifest.layers
      .filter((layer) => layer.path.includes('edithere:'))
      .map((layer) => ({ path: layer.path, left: layer.left ?? 0, top: layer.top ?? 0, right: layer.right ?? 0, bottom: layer.bottom ?? 0, width: layer.width ?? 0, height: layer.height ?? 0 }));
    return {
      id,
      templatePath: manifest.file,
      width: manifest.width,
      height: manifest.height,
      editableLayerPaths: editableLayers.map((layer) => layer.path),
      editableLayers,
      frameGrid: {
        actions: ['template-slot'],
        cells: editableLayers.map((layer, frameIndex) => ({ action: 'template-slot', frameIndex, left: layer.left, top: layer.top, width: layer.width, height: layer.height, layerPath: layer.path })),
      },
    };
  }
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OneBotOutboundImage } from '../../types/onebot.js';

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

export async function resolveLocalOutboundImage(image: OneBotOutboundImage): Promise<OneBotOutboundImage> {
  if (image.kind !== 'file') {
    return image;
  }
  const data = await readFile(image.value);
  return {
    kind: 'base64',
    value: data.toString('base64'),
    mimeType: image.mimeType ?? inferMimeType(image.value),
  };
}

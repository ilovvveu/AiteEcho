import type {
  OneBotOutboundImage,
  PlannedOutboundAction,
  PlannedOutboundPayload,
} from '../../types/onebot.js';

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/giu;

function normalizeWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractMarkdownImageUrls(text: string): {
  cleanedText: string;
  imageUrls: OneBotOutboundImage[];
} {
  const imageUrls: OneBotOutboundImage[] = [];
  const cleanedText = text.replace(MARKDOWN_IMAGE_PATTERN, (_match, rawUrl: string) => {
    const image = parseImageReference(rawUrl);
    if (image) {
      imageUrls.push(image);
    }
    return '';
  });
  return {
    cleanedText: normalizeWhitespace(cleanedText),
    imageUrls,
  };
}

function parseImageReference(value: string): OneBotOutboundImage | null {
  if (/^https?:\/\//i.test(value)) {
    return { kind: 'url', value };
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return { kind: 'file', value: decodeURIComponent(url.pathname) };
    } catch {
      return null;
    }
  }
  if (value.startsWith('/')) {
    return { kind: 'file', value };
  }
  return null;
}

function uniqueHttpUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    next.push(url);
  }
  return next;
}

function mergeOutboundImages(params: {
  mediaUrls?: string[];
  mediaImages?: OneBotOutboundImage[];
  markdownImageUrls: OneBotOutboundImage[];
}): OneBotOutboundImage[] {
  const result: OneBotOutboundImage[] = [];
  const seenUrls = new Set<string>();
  const seenFiles = new Set<string>();

  const pushImage = (image: OneBotOutboundImage): void => {
    if (image.kind === 'url') {
      if (!/^https?:\/\//i.test(image.value) || seenUrls.has(image.value)) {
        return;
      }
      seenUrls.add(image.value);
    }
    if (image.kind === 'file') {
      if (!image.value || seenFiles.has(image.value)) {
        return;
      }
      seenFiles.add(image.value);
    }
    result.push(image);
  };

  for (const image of params.mediaImages || []) {
    pushImage(image);
  }

  for (const url of uniqueHttpUrls(params.mediaUrls || [])) {
    pushImage({ kind: 'url', value: url });
  }

  for (const image of params.markdownImageUrls) {
    pushImage(image);
  }

  return result;
}

export function splitLongText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const result: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      splitIndex = maxLength;
    }
    result.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    result.push(remaining);
  }

  return result.filter(Boolean);
}

export function planOutboundPayload(params: {
  text: string;
  mediaUrls?: string[];
  mediaImages?: OneBotOutboundImage[];
  maxTextLength: number;
}): PlannedOutboundPayload {
  const extracted = extractMarkdownImageUrls(params.text || '');
  const images = mergeOutboundImages({
    mediaUrls: params.mediaUrls,
    mediaImages: params.mediaImages,
    markdownImageUrls: extracted.imageUrls,
  });
  const imageUrls = images
    .filter((image): image is Extract<OneBotOutboundImage, { kind: 'url' }> => image.kind === 'url')
    .map((image) => image.value);

  const actions: PlannedOutboundAction[] = splitLongText(extracted.cleanedText, params.maxTextLength)
    .filter((text) => text.length > 0)
    .map((text) => ({
      kind: 'text' as const,
      text,
    }));

  for (const image of images) {
    actions.push({
      kind: 'image',
      image,
    });
  }

  return {
    actions,
    cleanedText: extracted.cleanedText,
    imageUrls,
  };
}

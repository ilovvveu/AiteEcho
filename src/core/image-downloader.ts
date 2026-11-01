import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type {
  AgentImageInput,
  InboundImageFailureReason,
  InboundImageProcessingReport,
} from '../types/agent.js';
import type { InboundImageReference } from '../types/onebot.js';

const MAX_REDIRECTS = 3;
const TRUSTED_IMAGE_HOST_SUFFIXES = ['.qq.com', '.qq.com.cn', '.qpic.cn', '.gtimg.cn'];

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ResolveHostname = (hostname: string) => Promise<string[]>;

type DownloadedImage = {
  bytes: Buffer;
  mimeType: string;
};

class ImageInputError extends Error {
  constructor(
    readonly reason: InboundImageFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImageInputError';
  }
}

function isTrustedImageHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return TRUSTED_IMAGE_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
  );
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0].replace(/^\[|\]$/gu, '');
  if (isIP(normalized) === 4) {
    return isPrivateOrReservedIpv4(normalized);
  }
  if (isIP(normalized) !== 6) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) !== 4 || isPrivateOrReservedIpv4(mapped);
  }
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

export async function defaultResolveHostname(hostname: string): Promise<string[]> {
  if (isIP(hostname)) {
    return [hostname];
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function assertSafeRemoteUrl(url: URL, resolveHostname: ResolveHostname, trustedPublicIpOrigin?: string): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  // QQ private-file URL APIs can return literal public IPv4 endpoints. This
  // exception is supplied only by the document resolver after a local OneBot
  // action, never from an event's arbitrary URL. Redirects cannot widen it.
  const resolvedIpEndpoint = isIP(hostname) === 4 && url.origin === trustedPublicIpOrigin;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ImageInputError('blocked_source', 'only HTTP(S) image sources are allowed');
  }
  if (url.username || url.password) {
    throw new ImageInputError('blocked_source', 'image URL credentials are not allowed');
  }
  if (url.port && url.port !== '80' && url.port !== '443' && !resolvedIpEndpoint) {
    throw new ImageInputError('blocked_source', 'non-standard image URL ports are not allowed');
  }

  if (!isTrustedImageHostname(hostname) && !resolvedIpEndpoint) {
    throw new ImageInputError('blocked_source', 'image host is not an approved QQ CDN host');
  }

  let addresses: string[];
  try {
    addresses = await resolveHostname(hostname);
  } catch (error) {
    throw new ImageInputError('download_failed', 'failed to resolve image host', { cause: error });
  }
  if (addresses.length === 0 || addresses.some(isPrivateOrReservedIp)) {
    throw new ImageInputError('blocked_source', 'image host resolved to a blocked network address');
  }
}

function detectImageMimeType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const gifHeader = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function validateImageBytes(bytes: Buffer, maxBytes: number): DownloadedImage {
  if (bytes.byteLength > maxBytes) {
    throw new ImageInputError('too_large', 'image exceeds the configured byte limit');
  }
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new ImageInputError('not_image', 'content does not have a supported image signature');
  }
  return { bytes, mimeType };
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new ImageInputError('too_large', 'image content-length exceeds the configured byte limit');
    }
  }

  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('image byte limit exceeded');
        throw new ImageInputError('too_large', 'image stream exceeds the configured byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function fetchQqFileBytes(params: {
  source: string;
  maxBytes: number;
  timeoutMs: number;
  fetchImpl: FetchImplementation;
  resolveHostname: ResolveHostname;
  trustedPublicIpOrigin?: string;
}): Promise<Buffer> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(params.source);
  } catch (error) {
    throw new ImageInputError('invalid_source', 'invalid image URL', { cause: error });
  }

  const signal = AbortSignal.timeout(params.timeoutMs);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertSafeRemoteUrl(currentUrl, params.resolveHostname, params.trustedPublicIpOrigin);
    let response: Response;
    try {
      response = await params.fetchImpl(currentUrl, {
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new ImageInputError('timeout', 'image download timed out', { cause: error });
      }
      throw new ImageInputError('download_failed', 'image request failed', { cause: error });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new ImageInputError('http_error', 'image redirect could not be followed safely');
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    if (!response.ok) {
      throw new ImageInputError('http_error', `image request returned HTTP ${response.status}`);
    }
    const bytes = await readResponseBytes(response, params.maxBytes);
    return bytes;
  }

  throw new ImageInputError('http_error', 'image redirect limit exceeded');
}

function decodeBase64Payload(value: string, maxBytes: number): Buffer {
  const compact = value.trim();
  if (compact.length > Math.ceil(maxBytes / 3) * 4 + 8) {
    throw new ImageInputError('too_large', 'encoded image exceeds the configured byte limit');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
    throw new ImageInputError('invalid_source', 'invalid base64 image payload');
  }
  const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function decodeEmbeddedImage(source: string, maxBytes: number): DownloadedImage | undefined {
  if (source.startsWith('base64://')) {
    return validateImageBytes(decodeBase64Payload(source.slice('base64://'.length), maxBytes), maxBytes);
  }
  const dataUriMatch = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/iu.exec(source);
  if (dataUriMatch) {
    return validateImageBytes(decodeBase64Payload(dataUriMatch[1] ?? '', maxBytes), maxBytes);
  }
  return undefined;
}

function isRemoteSource(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function isSafeOpaqueOneBotFileId(value: string): boolean {
  return /^[A-Za-z0-9._{}()[\]-]{1,512}$/u.test(value) && value !== '.' && value !== '..';
}

export async function readAllowedLocalBytes(
  source: string,
  allowedRoots: string[],
  maxBytes: number,
): Promise<Buffer> {
  let candidatePath: string;
  try {
    candidatePath = source.startsWith('file://') ? fileURLToPath(source) : source;
  } catch (error) {
    throw new ImageInputError('invalid_source', 'OneBot returned an invalid local image path', {
      cause: error,
    });
  }
  if (!path.isAbsolute(candidatePath) || allowedRoots.length === 0) {
    throw new ImageInputError('blocked_source', 'OneBot local image path is outside configured roots');
  }

  let resolvedCandidate: string;
  try {
    resolvedCandidate = await realpath(candidatePath);
  } catch (error) {
    throw new ImageInputError('resolve_failed', 'failed to resolve OneBot local image path', {
      cause: error,
    });
  }
  const rootResults = await Promise.allSettled(
    allowedRoots.map(async (root) => realpath(path.resolve(root))),
  );
  const resolvedRoots = rootResults
    .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
    .map((result) => result.value);
  const insideAllowedRoot = resolvedRoots.some(
    (root) => resolvedCandidate === root || resolvedCandidate.startsWith(`${root}${path.sep}`),
  );
  if (!insideAllowedRoot) {
    throw new ImageInputError('blocked_source', 'OneBot local image path escaped configured roots');
  }

  const fileStat = await stat(resolvedCandidate);
  if (!fileStat.isFile()) {
    throw new ImageInputError('invalid_source', 'OneBot local image source is not a regular file');
  }
  if (fileStat.size > maxBytes) {
    throw new ImageInputError('too_large', 'OneBot local image exceeds the configured byte limit');
  }

  const handle = await open(resolvedCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > maxBytes) {
      throw new ImageInputError('too_large', 'OneBot local image changed or exceeds the byte limit');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new ImageInputError('too_large', 'local file exceeds the byte limit');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function resolveReference(params: {
  reference: InboundImageReference;
  maxBytes: number;
  timeoutMs: number;
  fetchImpl: FetchImplementation;
  resolveHostname: ResolveHostname;
  resolveFile?: (file: string) => Promise<string | undefined>;
  allowedLocalRoots: string[];
}): Promise<DownloadedImage> {
  let lastError: ImageInputError | undefined;
  const directSources = [params.reference.url, params.reference.file]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);

  for (const source of directSources) {
    try {
      const embedded = decodeEmbeddedImage(source, params.maxBytes);
      if (embedded) {
        return embedded;
      }
      if (isRemoteSource(source)) {
        return validateImageBytes(await fetchQqFileBytes({ ...params, source }), params.maxBytes);
      }
    } catch (error) {
      lastError = toImageInputError(error);
    }
  }

  const file = params.reference.file;
  if (file && !isRemoteSource(file) && !decodeEmbeddedImage(file, params.maxBytes)) {
    if (!isSafeOpaqueOneBotFileId(file)) {
      throw new ImageInputError('blocked_source', 'local paths and unsafe OneBot image identifiers are blocked');
    }
    if (!params.resolveFile) {
      throw new ImageInputError('resolve_failed', 'OneBot image resolver is unavailable');
    }
    let resolved: string | undefined;
    try {
      resolved = await params.resolveFile(file);
    } catch (error) {
      throw new ImageInputError('resolve_failed', 'OneBot could not resolve the image identifier', {
        cause: error,
      });
    }
    if (!resolved || resolved === file) {
      throw new ImageInputError('resolve_failed', 'OneBot returned no usable image source');
    }
    const embedded = decodeEmbeddedImage(resolved, params.maxBytes);
    if (embedded) {
      return embedded;
    }
    if (!isRemoteSource(resolved)) {
      return validateImageBytes(await readAllowedLocalBytes(resolved, params.allowedLocalRoots, params.maxBytes), params.maxBytes);
    }
    return validateImageBytes(await fetchQqFileBytes({ ...params, source: resolved }), params.maxBytes);
  }

  if (lastError) {
    throw lastError;
  }
  throw new ImageInputError('invalid_source', 'image segment contained no usable source');
}

function toImageInputError(error: unknown): ImageInputError {
  if (error instanceof ImageInputError) {
    return error;
  }
  return new ImageInputError('download_failed', error instanceof Error ? error.message : String(error));
}

export async function downloadInboundImages(params: {
  references: InboundImageReference[];
  maxImages: number;
  maxBytes: number;
  logger: Logger;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
  resolveHostname?: ResolveHostname;
  resolveFile?: (file: string) => Promise<string | undefined>;
  allowedLocalRoots?: string[];
}): Promise<{ images: AgentImageInput[]; report: InboundImageProcessingReport }> {
  const images: AgentImageInput[] = [];
  const failures: InboundImageProcessingReport['failures'] = [];
  const maxImages = Math.max(0, Math.floor(params.maxImages));
  const selectedReferences = params.references.slice(0, maxImages);
  const omittedByLimit = Math.max(0, params.references.length - selectedReferences.length);

  for (const [index, reference] of selectedReferences.entries()) {
    try {
      const image = await resolveReference({
        reference,
        maxBytes: params.maxBytes,
        timeoutMs: params.timeoutMs ?? 10_000,
        fetchImpl: params.fetchImpl ?? fetch,
        resolveHostname: params.resolveHostname ?? defaultResolveHostname,
        resolveFile: params.resolveFile,
        allowedLocalRoots: params.allowedLocalRoots ?? [],
      });
      images.push({
        mimeType: image.mimeType,
        base64Data: image.bytes.toString('base64'),
      });
    } catch (error) {
      const normalized = toImageInputError(error);
      failures.push({ index, reason: normalized.reason });
      params.logger.warn(
        { imageIndex: index, reason: normalized.reason, detail: normalized.reason === 'blocked_source' ? normalized.message : undefined },
        'inbound image was not delivered to the agent',
      );
    }
  }

  return {
    images,
    report: {
      received: params.references.length,
      delivered: images.length,
      omittedByLimit,
      failures,
    },
  };
}

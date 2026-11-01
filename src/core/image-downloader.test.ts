import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { downloadInboundImages } from './image-downloader.js';

const logger = pino({ enabled: false });
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const publicDns = async (): Promise<string[]> => ['8.8.8.8'];

describe('downloadInboundImages', () => {
  it('downloads a QQ CDN image and trusts its signature instead of the response header', async () => {
    const result = await downloadInboundImages({
      references: [{ url: 'https://multimedia.nt.qq.com.cn/image/1' }],
      maxImages: 3,
      maxBytes: 1024,
      logger,
      resolveHostname: publicDns,
      fetchImpl: async () =>
        new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    });

    expect(result.images).toEqual([
      {
        mimeType: 'image/png',
        base64Data: pngBytes.toString('base64'),
      },
    ]);
    expect(result.report).toEqual({
      received: 1,
      delivered: 1,
      omittedByLimit: 0,
      failures: [],
    });
  });

  it('resolves an opaque OneBot file id without accepting a local path', async () => {
    const resolveFile = vi.fn(async () => 'https://gchat.qpic.cn/download/image.png');
    const result = await downloadInboundImages({
      references: [{ file: '{A1B2-C3}.image' }, { file: '/example/private.png' }],
      maxImages: 3,
      maxBytes: 1024,
      logger,
      resolveHostname: publicDns,
      resolveFile,
      fetchImpl: async () => new Response(pngBytes, { status: 200 }),
    });

    expect(resolveFile).toHaveBeenCalledTimes(1);
    expect(resolveFile).toHaveBeenCalledWith('{A1B2-C3}.image');
    expect(result.images).toHaveLength(1);
    expect(result.report.failures).toEqual([{ index: 1, reason: 'blocked_source' }]);
  });

  it('accepts bounded base64 images without network access', async () => {
    const fetchImpl = vi.fn();
    const result = await downloadInboundImages({
      references: [{ file: `base64://${pngBytes.toString('base64')}` }],
      maxImages: 1,
      maxBytes: 1024,
      logger,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.images[0]?.mimeType).toBe('image/png');
  });

  it('keeps Fake-IP blocked and falls back to the verified OneBot image stream', async () => {
    const fetchImpl = vi.fn();
    const resolveFile = vi.fn(async () => `base64://${pngBytes.toString('base64')}`);
    const result = await downloadInboundImages({
      references: [{ url: 'https://multimedia.nt.qq.com.cn/image/1', file: '{QQ-CACHE}.image' }],
      maxImages: 1,
      maxBytes: 1024,
      logger,
      resolveHostname: async () => ['198.18.0.124', '::ffff:0:c612:7c'],
      fetchImpl,
      resolveFile,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveFile).toHaveBeenCalledWith('{QQ-CACHE}.image');
    expect(result.report).toEqual({ received: 1, delivered: 1, omittedByLimit: 0, failures: [] });
    expect(result.images[0]?.mimeType).toBe('image/png');
  });

  it('reads only get_image results inside configured cache roots and blocks symlink escape', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qq-image-local-'));
    const cacheRoot = path.join(root, 'cache');
    const insideImage = path.join(cacheRoot, 'inside.png');
    const outsideImage = path.join(root, 'outside.png');
    const escapeLink = path.join(cacheRoot, 'escape.png');
    await mkdir(cacheRoot);
    await writeFile(insideImage, pngBytes);
    await writeFile(outsideImage, pngBytes);
    await symlink(outsideImage, escapeLink);

    try {
      const resolveFile = vi.fn(async (file: string) => {
        if (file === '{LOCAL}.image') {
          return pathToFileURL(insideImage).href;
        }
        if (file === '{ESCAPE}.image') {
          return escapeLink;
        }
        return undefined;
      });
      const result = await downloadInboundImages({
        references: [
          { file: outsideImage },
          { file: '{LOCAL}.image' },
          { file: '{ESCAPE}.image' },
        ],
        maxImages: 3,
        maxBytes: 1024,
        logger,
        allowedLocalRoots: [cacheRoot],
        resolveFile,
      });

      expect(result.images).toHaveLength(1);
      expect(result.report.failures).toEqual([
        { index: 0, reason: 'blocked_source' },
        { index: 2, reason: 'blocked_source' },
      ]);
      expect(resolveFile).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks redirects away from the approved QQ CDN boundary', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/internal' },
      }),
    );
    const result = await downloadInboundImages({
      references: [{ url: 'https://multimedia.nt.qq.com.cn/redirect' }],
      maxImages: 1,
      maxBytes: 1024,
      logger,
      resolveHostname: publicDns,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.report.failures).toEqual([{ index: 0, reason: 'blocked_source' }]);
  });

  it('rejects oversized and non-image responses before sending them to the agent', async () => {
    const responses = [
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-length': '4096' },
      }),
      new Response('not an image', { status: 200 }),
    ];
    const result = await downloadInboundImages({
      references: [
        { url: 'https://gchat.qpic.cn/oversized' },
        { url: 'https://gchat.qpic.cn/not-image' },
      ],
      maxImages: 2,
      maxBytes: 1024,
      logger,
      resolveHostname: publicDns,
      fetchImpl: async () => responses.shift()!,
    });

    expect(result.images).toHaveLength(0);
    expect(result.report.failures).toEqual([
      { index: 0, reason: 'too_large' },
      { index: 1, reason: 'not_image' },
    ]);
  });

  it('reports HTTP errors, timeouts, and images omitted by the count limit', async () => {
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(timeoutError);
    const result = await downloadInboundImages({
      references: [
        { url: 'https://gchat.qpic.cn/missing' },
        { url: 'https://gchat.qpic.cn/slow' },
        { url: 'https://gchat.qpic.cn/omitted' },
      ],
      maxImages: 2,
      maxBytes: 1024,
      logger,
      resolveHostname: publicDns,
      fetchImpl,
    });

    expect(result.report).toEqual({
      received: 3,
      delivered: 0,
      omittedByLimit: 1,
      failures: [
        { index: 0, reason: 'http_error' },
        { index: 1, reason: 'timeout' },
      ],
    });
  });
});

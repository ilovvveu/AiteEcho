import { describe, expect, it } from 'vitest';
import { ImageStreamDecoder } from './image-stream.js';
const frame = (data: Record<string, unknown>) => ({ status: 'ok', retcode: 0, data });
const info = (size: number) => frame({ data_type: 'file_info', file_size: size });
const chunk = (index: number, text: string) => frame({ data_type: 'file_chunk', index, data: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) });
const done = (bytes: number, count: number) => frame({ data_type: 'file_complete', total_bytes: bytes, total_chunks: count });

describe('bounded NapCat image stream', () => {
  it('assembles only a complete, ordered stream', () => {
    const d = new ImageStreamDecoder(20);
    d.accept(info(6));d.accept(chunk(0, 'abc'));d.accept(chunk(1, 'def'));
    expect(d.accept(done(6, 2))).toBe(Buffer.from('abcdef').toString('base64'));
    expect(() => d.accept(done(6, 2))).toThrow();
  });
  it('rejects oversize or invalid metadata before buffering chunks', () => {
    for (const size of [0, -1, 11, Number.NaN, 1.5]) expect(() => new ImageStreamDecoder(10).accept(info(size))).toThrow();
  });
  it('accepts a cached variant with different size while enforcing the actual byte cap', () => {
    for (const size of [2, 8]) {
      const d = new ImageStreamDecoder(10);
      d.accept(info(size)); d.accept(chunk(0, 'abcdef'));
      expect(d.accept(done(6, 1))).toBe(Buffer.from('abcdef').toString('base64'));
    }
    const d = new ImageStreamDecoder(5); d.accept(info(2));
    expect(() => d.accept(chunk(0, 'abcdef'))).toThrow('byte limit');
  });
  it('rejects missing metadata, duplicate, missing and out-of-order chunks', () => {
    expect(() => new ImageStreamDecoder(10).accept(chunk(0, 'abc'))).toThrow();
    for (const index of [-1, 1, '0']) { const d = new ImageStreamDecoder(10);d.accept(info(3));expect(() => d.accept({ data: { data_type: 'file_chunk', index, data: 'YWJj', size: 3 } })).toThrow(); }
    const d = new ImageStreamDecoder(10);d.accept(info(3));d.accept(chunk(0, 'abc'));expect(() => d.accept(chunk(0, 'abc'))).toThrow();
  });
  it('checks canonical base64, declared chunk length and total byte limit', () => {
    for (const data of ['!!!!', 'YQ', 'YR==']) {const d = new ImageStreamDecoder(10);d.accept(info(3));expect(() => d.accept(frame({ data_type: 'file_chunk', index: 0, data, size: 1 }))).toThrow();}
    const d = new ImageStreamDecoder(3);d.accept(info(3));expect(() => d.accept(chunk(0, 'abcd'))).toThrow();
  });
  it('rejects truncated streams and server errors instead of returning partial bytes', () => {
    const d = new ImageStreamDecoder(10);d.accept(info(6));d.accept(chunk(0, 'abc'));expect(() => d.accept(done(6, 2))).toThrow();
    expect(() => new ImageStreamDecoder(10).accept({ status: 'failed', retcode: 1200 })).toThrow();
  });
});

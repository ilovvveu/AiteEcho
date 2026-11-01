// NapCat's image stream reads an opaque media ID through the authenticated QQ
// transport. It does not grant the bot filesystem access to QQ's native cache.
export class ImageStreamDecoder {
  private announcedBytes: number | undefined;
  private receivedBytes = 0;
  private nextIndex = 0;
  private readonly chunks: Buffer[] = [];
  private complete = false;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid image stream byte limit');
  }

  accept(frame: Record<string, unknown>): string | undefined {
    if (this.complete) throw new Error('image stream already complete');
    if (frame.status === 'failed' || (frame.retcode !== undefined && frame.retcode !== 0)) throw new Error('OneBot image stream failed');
    const data = frame.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') throw new Error('missing image stream data');
    switch (data.data_type) {
      case 'file_info': {
        if (this.announcedBytes !== undefined) throw new Error('duplicate image stream metadata');
        const size = Number(data.file_size);
        if (!Number.isSafeInteger(size) || size < 1 || size > this.maxBytes) throw new Error('image stream exceeds byte limit');
        this.announcedBytes = size;
        return;
      }
      case 'file_chunk': {
        if (this.announcedBytes === undefined || data.index !== this.nextIndex || this.nextIndex >= 4096) throw new Error('invalid image stream chunk order');
        const encoded = data.data;
        if (typeof encoded !== 'string' || encoded.length < 4 || encoded.length > 87384 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('invalid image stream base64');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || bytes.length > 65536 || bytes.length !== data.size) throw new Error('invalid image stream chunk size');
        // QQ may report the original image's size but stream a different cached
        // variant. Independently cap actual bytes, not that advisory size.
        if (this.receivedBytes + bytes.length > this.maxBytes) throw new Error('image stream exceeds byte limit');
        this.chunks.push(bytes);
        this.receivedBytes += bytes.length;
        this.nextIndex++;
        return;
      }
      case 'file_complete': {
        if (this.announcedBytes === undefined || this.receivedBytes < 1 || data.total_bytes !== this.receivedBytes || data.total_chunks !== this.nextIndex) throw new Error('incomplete image stream');
        this.complete = true;
        return Buffer.concat(this.chunks).toString('base64');
      }
      default: throw new Error('unsupported image stream frame');
    }
  }
}

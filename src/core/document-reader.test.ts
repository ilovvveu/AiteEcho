import { execFileSync } from 'node:child_process';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildDocumentContextLines, extractDocumentText, readInboundDocuments } from './document-reader.js';
import { documentTestPython as pythonCommand, documentPythonAvailable as canParse } from '../test-support/python.js';

const logger = pino({ enabled: false });
const limits = { maxFiles: 2, maxBytes: 1024 * 1024, maxChars: 1000, timeoutMs: 10000, pythonCommand, logger };
const parse = (bytes: Buffer, extension: string, maxChars = 1000) => extractDocumentText({ bytes, extension, maxChars, timeoutMs: 10000, pythonCommand });
function fixture(extension: string): Buffer {
  return execFileSync(pythonCommand, ['-I', '-B', '-c', `
import io,sys
out=io.BytesIO()
ext=sys.argv[1]
if ext=='docx':
 from docx import Document
 doc=Document(); doc.add_paragraph('DOC-731 文档测试'); doc.add_table(rows=1, cols=1).cell(0,0).text='表格内容'; doc.save(out)
elif ext=='xlsx':
 import openpyxl
 book=openpyxl.Workbook(); sheet=book.active; sheet.append(['XLS-731',42,'=1+2']); book.save(out)
elif ext=='pdf':
 from pypdf import PdfWriter
 from pypdf.generic import DecodedStreamObject,DictionaryObject,NameObject
 writer=PdfWriter(); page=writer.add_blank_page(width=300,height=300)
 font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
 page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
 stream=DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 20 200 Td (PDF-731) Tj ET'); page[NameObject('/Contents')]=writer._add_object(stream); writer.write(out)
elif ext=='bomb':
 import zipfile
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('word/document.xml',b'A'*1000000)
sys.stdout.buffer.write(out.getvalue())
`, extension]);
}
describe('inbound document boundaries', () => {
  it('rejects unsupported, oversized, raw local paths and private-address URLs before parsing', async () => {
    const resolveFile = vi.fn();
    const fetchImpl = vi.fn();
    const results = await readInboundDocuments({ ...limits, maxFiles: 5, references: [
      { name: 'a.exe', url: 'https://gchat.qpic.cn/a' },
      { name: 'b.pdf', size: 99999999, fileId: 'file-id' },
      { name: 'c.txt', url: '/example/private.txt' },
      { name: 'd.txt', url: 'http://127.0.0.1/private' },
    ], resolveFile, fetchImpl, resolveHostname: async () => ['127.0.0.1'] });
    expect(results.every((r) => r.status === 'failed')).toBe(true);
    expect(resolveFile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(buildDocumentContextLines(results).join('\n')).toContain('不得假装已读');
  });
  it('reports omitted files and total character exhaustion', async () => {
    const results = await readInboundDocuments({ ...limits, maxFiles: 1, references: [{ name: 'a.exe' }, { name: 'b.txt' }], resolveFile: vi.fn() });
    expect(results[1]?.status).toBe('omitted');
  });
  it.runIf(canParse)('decodes Chinese text, reports truncation and resolves file ids through QQ', async () => {
    const resolveFile = vi.fn(async () => ({ source: 'https://gchat.qpic.cn/notes.txt' }));
    const results = await readInboundDocuments({ ...limits, maxChars: 100, references: [{ name: 'notes.txt', fileId: 'file-id' }], resolveFile,
      resolveHostname: async () => ['8.8.8.8'], fetchImpl: async () => new Response('中文文本'.repeat(100)) });
    expect(results[0]?.text).toContain('中文文本');
    expect(results[0]?.truncated).toBe(true);
    expect(resolveFile).toHaveBeenCalledTimes(1);
  });
  it.runIf(canParse)('extracts real PDF, DOCX and XLSX fixtures without executing formulas', async () => {
    expect((await parse(fixture('pdf'), 'pdf')).text).toContain('PDF-731');
    const word = await parse(fixture('docx'), 'docx');
    expect(word.text).toContain('DOC-731 文档测试');
    expect(word.text).toContain('表格内容');
    const sheet = await parse(fixture('xlsx'), 'xlsx');
    expect(sheet.text).toContain('XLS-731');
    expect(sheet.text).toContain('=1+2');
  });
  it.runIf(canParse)('permits only public-IP file endpoints proven by a local QQ URL action', async () => {
    const fetchImpl = vi.fn(async () => new Response('QQ private file'));
    const resolved = await readInboundDocuments({ ...limits, references: [{ name: 'notes.txt', fileId: 'file-id', url: 'http://8.8.8.8:8080/ftn_handler/a' }],
      resolveFile: async () => ({ source: 'http://8.8.8.8:8080/ftn_handler/a' }), fetchImpl, resolveHostname: async () => ['8.8.8.8'] });
    expect(resolved[0]?.text).toContain('QQ private file');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    const blocked = await readInboundDocuments({ ...limits, references: [{ name: 'notes.txt', fileId: 'file-id' }],
      resolveFile: async () => ({ source: 'http://127.0.0.1:8080/private' }), fetchImpl, resolveHostname: async () => ['127.0.0.1'] });
    expect(blocked[0]?.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.runIf(canParse)('rejects format spoofing, binary text and zip bombs', async () => {
    await expect(parse(Buffer.from('not a pdf'), 'pdf')).rejects.toThrow('签名');
    await expect(parse(Buffer.from([0, 1, 2, 3]), 'txt')).rejects.toThrow('文本');
    await expect(parse(fixture('bomb'), 'docx')).rejects.toThrow('压缩');
  });
});

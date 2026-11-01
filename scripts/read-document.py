"""Bounded, read-only attachment text extraction. Bytes in; JSON out; no files."""
import io
import json
import resource
import sys
import zipfile

MAX_BYTES = 10 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024


def main():
    def cap(kind, requested):
        _, hard = resource.getrlimit(kind)
        value = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
        resource.setrlimit(kind, (value, value))

    cap(resource.RLIMIT_CPU, 15)
    cap(resource.RLIMIT_FSIZE, 0)
    # macOS rejects RLIMIT_DATA for this bundled runtime. Do not claim a hard
    # memory sandbox there: bound input, archive expansion, CPU, wall time,
    # concurrency and output instead. Linux additionally enforces address space.
    if sys.platform == "linux":
        cap(resource.RLIMIT_AS, 768 * 1024 * 1024)
    ext = sys.argv[1].lower()
    limit = max(100, min(60000, int(sys.argv[2])))
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("文件超过解析器 10 MiB 限制")
    parts = []
    used = 0
    truncated = False
    warnings = []

    def add(text):
        nonlocal used, truncated
        text = str(text).replace("\x00", "")
        available = limit - used
        if len(text) > available:
            truncated = True
        if available > 0:
            piece = text[:available]
            parts.append(piece)
            used += len(piece) + 1

    if ext in ("txt", "md", "csv", "tsv", "json", "log"):
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = raw.decode("utf-16")
        else:
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = raw.decode("gb18030")
        if "\x00" in text or sum(ord(c) < 32 and c not in "\r\n\t" for c in text) > 10:
            raise ValueError("文件不像可读取的文本")
        add(text)
    elif ext == "pdf":
        if not raw.startswith(b"%PDF-"):
            raise ValueError("PDF 文件签名不匹配")
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            raise ValueError("暂不读取加密 PDF，请先提供解密副本")
        if len(reader.pages) > 80:
            warnings.append("仅读取前 80 页")
            truncated = True
        for index, page in enumerate(reader.pages):
            if index >= 80 or used >= limit:
                truncated = True
                break
            add("[第 %d 页]\n%s" % (index + 1, page.extract_text() or "（此页没有可提取文本，可能为扫描页）"))
        warnings.append("仅提取 PDF 文字层；扫描图片、图表和版式未做 OCR 或视觉分析")
    elif ext in ("docx", "xlsx"):
        if not raw.startswith(b"PK\x03\x04"):
            raise ValueError("Office 文件签名不匹配")
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > 2048 or sum(e.file_size for e in entries) > MAX_EXPANDED:
                raise ValueError("Office 压缩包展开体积或条目数超限")
            if any(e.flag_bits & 1 or e.file_size > 16 * 1024 * 1024 or e.file_size > max(1, e.compress_size) * 200 for e in entries):
                raise ValueError("Office 压缩包加密或压缩比例超限")
            required = "word/document.xml" if ext == "docx" else "xl/workbook.xml"
            if required not in archive.namelist():
                raise ValueError("Office 内容与扩展名不一致")
        if ext == "docx":
            from docx import Document
            from docx.table import Table
            document = Document(io.BytesIO(raw))
            for item in document.iter_inner_content():
                if isinstance(item, Table):
                    for row in item.rows:
                        add(" | ".join(cell.text for cell in row.cells))
                        if used >= limit:
                            break
                else:
                    add(item.text)
                if used >= limit:
                    truncated = True
                    break
            warnings.append("读取正文和表格；嵌入图片、批注、页眉页脚未解析")
        else:
            import openpyxl
            workbook = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=False, keep_links=False)
            try:
                if len(workbook.worksheets) > 10:
                    truncated = True
                for sheet in workbook.worksheets[:10]:
                    add("[工作表：%s]" % sheet.title)
                    if sheet.max_row and sheet.max_row > 2000 or sheet.max_column and sheet.max_column > 30:
                        truncated = True
                    for row in sheet.iter_rows(max_row=min(sheet.max_row or 2000, 2000), max_col=min(sheet.max_column or 30, 30), values_only=True):
                        add(" | ".join("" if cell is None else str(cell)[:2000] for cell in row))
                        if used >= limit:
                            break
                    if used >= limit:
                        truncated = True
                        break
            finally:
                workbook.close()
            warnings.append("最多 10 表、每表 2000 行/30 列；保留公式原文，不执行公式、宏或外部链接")
    else:
        raise ValueError("不支持的文件格式")
    text = "\n".join(parts).strip()
    if not text:
        warnings.append("没有提取到可读取的文字")
    print(json.dumps({"ok": True, "text": text[:limit], "truncated": truncated, "warnings": warnings}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # No tracebacks, local paths, document bytes, or secrets on stderr.
        message = str(exc)[:200] if isinstance(exc, (ValueError, UnicodeError, zipfile.BadZipFile)) else "文档解析失败或缺少解析依赖"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        sys.exit(1)

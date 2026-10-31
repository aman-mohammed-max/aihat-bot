import { Inflate } from "fflate";
import type { PDFDocumentProxy } from "unpdf/pdfjs";
import { AppError } from "./errors.js";

export const TELEGRAM_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
export const EXTRACTED_DOCUMENT_MAX_CHARS = 60_000;
export const PDF_DOCUMENT_MAX_PAGES = 20;
export const DOCX_DOCUMENT_XML_MAX_BYTES = 1024 * 1024;
const DOCX_ARCHIVE_MAX_ENTRIES = 256;
const PDF_PARSE_TIMEOUT_MS = 5_000;
const DOCX_DEFLATE_CHUNK_BYTES = 1024;
const TRUNCATION_NOTICE = "\n[Document text truncated at the safe extraction limit.]";

export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type ExtractableDocumentContentType = "application/pdf" | typeof DOCX_CONTENT_TYPE;

/** Extracts bounded, malware-scanned PDF or DOCX content in Bun and Workers. */
export async function extractAgentDocumentText(
  bytes: Uint8Array,
  contentType: ExtractableDocumentContentType,
): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > TELEGRAM_DOCUMENT_MAX_BYTES) {
    throw invalidDocument();
  }
  if (contentType === "application/pdf") {
    if (!hasPdfSignature(bytes)) throw invalidDocument();
    return extractPdfText(bytes);
  }
  if (contentType === DOCX_CONTENT_TYPE) {
    const xml = extractDocxXml(bytes);
    return extractDocxText(xml);
  }
  throw invalidDocument();
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  let document: PDFDocumentProxy | undefined;
  let timedOut = false;
  let extractionFinished = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (document) void document.loadingTask.destroy().catch(() => undefined);
      reject(invalidDocument());
    }, PDF_PARSE_TIMEOUT_MS);
  });
  const loading = import("unpdf")
    .then(({ getDocumentProxy }) =>
      getDocumentProxy(bytes, {
        enableXfa: false,
        maxImageSize: 0,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
        stopAtErrors: true,
      }),
    )
    .then((loaded) => {
      if (timedOut || extractionFinished) void loaded.loadingTask.destroy().catch(() => undefined);
      else document = loaded;
      return loaded;
    });

  try {
    document = await Promise.race([loading, timeoutPromise]);
    if (document.numPages < 1 || document.numPages > PDF_DOCUMENT_MAX_PAGES) throw invalidDocument();
    const output = new BoundedDocumentText();
    for (let pageNumber = 1; pageNumber <= document.numPages && !output.truncated; pageNumber += 1) {
      const page = await Promise.race([document.getPage(pageNumber), timeoutPromise]);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      try {
        while (!output.truncated) {
          const chunk = await Promise.race([reader.read(), timeoutPromise]);
          if (chunk.done) break;
          const items = (chunk.value as { readonly items?: readonly unknown[] } | undefined)?.items ?? [];
          for (const item of items) {
            if (!isPdfTextItem(item)) continue;
            output.append(item.str);
            if (item.hasEOL) output.append("\n");
            else output.append(" ");
            if (output.truncated) break;
          }
        }
      } catch (cause) {
        await reader.cancel().catch(() => undefined);
        throw cause;
      } finally {
        reader.releaseLock();
        page.cleanup();
      }
    }
    const text = output.toString();
    if (!text.trim()) throw invalidDocument();
    return text;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw invalidDocument();
  } finally {
    extractionFinished = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    await document?.loadingTask.destroy().catch(() => undefined);
  }
}

function isPdfTextItem(value: unknown): value is { readonly str: string; readonly hasEOL: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof value.str === "string" &&
    "hasEOL" in value &&
    typeof value.hasEOL === "boolean"
  );
}

function extractDocxXml(bytes: Uint8Array): Uint8Array {
  if (!hasZipSignature(bytes) || bytes.byteLength < 22) throw invalidDocument();
  const endOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readU16(bytes, endOffset + 4);
  const centralDiskNumber = readU16(bytes, endOffset + 6);
  const entriesOnDisk = readU16(bytes, endOffset + 8);
  const entryCount = readU16(bytes, endOffset + 10);
  const centralSize = readU32(bytes, endOffset + 12);
  const centralOffset = readU32(bytes, endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount < 1 ||
    entryCount > DOCX_ARCHIVE_MAX_ENTRIES ||
    centralOffset + centralSize > endOffset
  ) {
    throw invalidDocument();
  }

  let cursor = centralOffset;
  let mainDocument:
    | {
        readonly compressedSize: number;
        readonly uncompressedSize: number;
        readonly crc: number;
        readonly method: number;
        readonly flags: number;
        readonly localOffset: number;
      }
    | undefined;
  for (let entry = 0; entry < entryCount; entry += 1) {
    requireRange(bytes, cursor, 46);
    if (readU32(bytes, cursor) !== 0x02014b50) throw invalidDocument();
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const crc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const fileNameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const diskStart = readU16(bytes, cursor + 34);
    const localOffset = readU32(bytes, cursor + 42);
    const next = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (
      next > centralOffset + centralSize ||
      diskStart !== 0 ||
      (flags & 1) !== 0 ||
      (flags & 0x40) !== 0 ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw invalidDocument();
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + fileNameLength);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      throw invalidDocument();
    }
    if (name === "word/document.xml") {
      if (mainDocument || uncompressedSize < 1 || uncompressedSize > DOCX_DOCUMENT_XML_MAX_BYTES) {
        throw invalidDocument();
      }
      mainDocument = { compressedSize, uncompressedSize, crc, method, flags, localOffset };
    }
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize || !mainDocument) throw invalidDocument();

  const local = mainDocument.localOffset;
  requireRange(bytes, local, 30);
  if (readU32(bytes, local) !== 0x04034b50) throw invalidDocument();
  const localFlags = readU16(bytes, local + 6);
  const localMethod = readU16(bytes, local + 8);
  const localNameLength = readU16(bytes, local + 26);
  const localExtraLength = readU16(bytes, local + 28);
  const dataOffset = local + 30 + localNameLength + localExtraLength;
  requireRange(bytes, local + 30, localNameLength + localExtraLength);
  requireRange(bytes, dataOffset, mainDocument.compressedSize);
  if (
    (localFlags & 1) !== 0 ||
    (localFlags & 0x40) !== 0 ||
    localMethod !== mainDocument.method ||
    (localFlags & 0x9) !== (mainDocument.flags & 0x9) ||
    dataOffset + mainDocument.compressedSize > centralOffset
  ) {
    throw invalidDocument();
  }
  const localName = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(local + 30, local + 30 + localNameLength),
  );
  if (localName !== "word/document.xml") throw invalidDocument();
  const compressed = bytes.subarray(dataOffset, dataOffset + mainDocument.compressedSize);
  let xml: Uint8Array;
  if (mainDocument.method === 0) {
    if (compressed.byteLength !== mainDocument.uncompressedSize) throw invalidDocument();
    xml = compressed.slice();
  } else {
    xml = inflateRawBounded(compressed, mainDocument.uncompressedSize);
  }
  if (xml.byteLength !== mainDocument.uncompressedSize || crc32(xml) !== mainDocument.crc) throw invalidDocument();
  return xml;
}

function inflateRawBounded(compressed: Uint8Array, expectedSize: number): Uint8Array {
  if (expectedSize < 1 || expectedSize > DOCX_DOCUMENT_XML_MAX_BYTES) throw invalidDocument();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > DOCX_DOCUMENT_XML_MAX_BYTES || total > expectedSize) throw invalidDocument();
    if (chunk.byteLength) chunks.push(chunk.slice());
  });
  try {
    if (compressed.byteLength === 0) inflater.push(compressed, true);
    for (let offset = 0; offset < compressed.byteLength; offset += DOCX_DEFLATE_CHUNK_BYTES) {
      const end = Math.min(offset + DOCX_DEFLATE_CHUNK_BYTES, compressed.byteLength);
      inflater.push(compressed.subarray(offset, end), end === compressed.byteLength);
    }
  } catch {
    throw invalidDocument();
  }
  if (total !== expectedSize) throw invalidDocument();
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractDocxText(xmlBytes: Uint8Array): string {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
  } catch {
    throw invalidDocument();
  }
  if (!/<(?:[A-Za-z_][\w.-]*:)?document\b/.test(xml) || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw invalidDocument();
  }
  const root = xml.match(/<(?:([A-Za-z_][\w.-]*):)?document\b/);
  const wordPrefix = root?.[1] ?? "";
  const output = new BoundedDocumentText();
  const tagPattern = /<\/?[^>]+>/g;
  let cursor = 0;
  let inText = false;
  for (const match of xml.matchAll(tagPattern)) {
    const tag = match[0];
    const tagIndex = match.index;
    if (inText) {
      if (tag.startsWith("</")) {
        const text = xml.slice(cursor, tagIndex);
        output.append(decodeXmlText(text));
      } else {
        throw invalidDocument();
      }
    }
    const nameMatch = tag.match(/^<\/?\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s|\/?>)/);
    if (nameMatch) {
      const qualifiedName = nameMatch[1] ?? "";
      const parts = qualifiedName.split(":");
      const prefix = parts.length === 2 ? (parts[0] ?? "") : "";
      const localName = parts.at(-1) ?? "";
      const isWordElement = prefix === wordPrefix;
      const closing = tag.startsWith("</");
      if (isWordElement && localName === "t") {
        if (closing) inText = false;
        else if (!tag.endsWith("/>")) inText = true;
      } else if (isWordElement && closing && localName === "p") {
        output.append("\n");
      } else if (isWordElement && !closing && localName === "tab") {
        output.append("\t");
      } else if (isWordElement && !closing && localName === "br") {
        output.append("\n");
      }
    }
    cursor = tagIndex + tag.length;
    if (output.truncated) break;
  }
  if (inText) throw invalidDocument();
  const text = output.toString().trim();
  if (!text) throw invalidDocument();
  return text;
}

function decodeXmlText(value: string): string {
  if (value.includes("<") || value.includes(">")) throw invalidDocument();
  if (!/^(?:[^&]|&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)*$/i.test(value)) throw invalidDocument();
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_entity, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const numeric =
      code.startsWith("#x") || code.startsWith("#X")
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) {
      throw invalidDocument();
    }
    return String.fromCodePoint(numeric);
  });
  return decoded;
}

class BoundedDocumentText {
  readonly #parts: string[] = [];
  #length = 0;
  truncated = false;

  append(value: string): void {
    if (!value || this.truncated) return;
    const limit = EXTRACTED_DOCUMENT_MAX_CHARS - TRUNCATION_NOTICE.length;
    const remaining = limit - this.#length;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const bounded = value.slice(0, remaining);
    this.#parts.push(bounded);
    this.#length += bounded.length;
    if (bounded.length < value.length || this.#length === limit) this.truncated = true;
  }

  toString(): string {
    const value = this.#parts.join("");
    return this.truncated ? `${value}${TRUNCATION_NOTICE}` : value;
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const earliest = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) !== 0x06054b50) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw invalidDocument();
}

function readU16(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 2);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  requireRange(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function requireRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw invalidDocument();
  }
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function invalidDocument(): AppError {
  return new AppError("VALIDATION_ERROR", "Document could not be read within safe extraction limits.", 415);
}

import { describe, expect, test } from "bun:test";
import {
  DOCX_CONTENT_TYPE,
  DOCX_DOCUMENT_XML_MAX_BYTES,
  EXTRACTED_DOCUMENT_MAX_CHARS,
  extractAgentDocumentText,
} from "../../packages/core/src/document-extraction.js";
import { createDocx, createPdf } from "../helpers/document-fixtures.js";

describe("shared PDF and DOCX text extraction", () => {
  test("extracts text from a PDF without running its document actions", async () => {
    const text = await extractAgentDocumentText(createPdf("Quarterly report"), "application/pdf");
    expect(text).toContain("Quarterly report");
  });

  test("extracts DOCX text, paragraph breaks, tabs, and XML entities", async () => {
    const bytes = createDocx(
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t xml:space="preserve">Fish &amp; chips</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Menu</w:t></w:r></w:p><w:p><w:r><w:t>Today</w:t></w:r></w:p></w:body></w:document>',
    );
    const text = await extractAgentDocumentText(bytes, DOCX_CONTENT_TYPE);
    expect(text).toBe("Fish & chips\tMenu\nToday");
  });

  test("rejects malformed, encrypted-style, and oversized DOCX archives safely", async () => {
    const invalidZip = new TextEncoder().encode("PK\u0003\u0004not a Word document");
    const entityXml = '<!DOCTYPE w:document [<!ENTITY x "unsafe">]><w:document><w:t>&x;</w:t></w:document>';
    const oversizedXml = `<w:document><w:t>${"x".repeat(DOCX_DOCUMENT_XML_MAX_BYTES + 1)}</w:t></w:document>`;
    await expect(extractAgentDocumentText(invalidZip, DOCX_CONTENT_TYPE)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(extractAgentDocumentText(createDocx(entityXml), DOCX_CONTENT_TYPE)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(extractAgentDocumentText(createDocx(oversizedXml), DOCX_CONTENT_TYPE)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("stops DOCX decompression when archive size metadata understates the actual output", async () => {
    const bytes = createDocx(`<w:document><w:t>${"x".repeat(100_000)}</w:t></w:document>`).slice();
    const centralOffset = findSignature(bytes, 0x02014b50);
    if (centralOffset < 0) throw new Error("The DOCX fixture has no central directory entry.");
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(centralOffset + 24, 8, true);
    await expect(extractAgentDocumentText(bytes, DOCX_CONTENT_TYPE)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("bounds extracted text returned from large but structurally valid DOCX files", async () => {
    const bytes = createDocx(`<w:document><w:p><w:r><w:t>${"word ".repeat(20_000)}</w:t></w:r></w:p></w:document>`);
    const text = await extractAgentDocumentText(bytes, DOCX_CONTENT_TYPE);
    expect(text.length).toBeLessThanOrEqual(EXTRACTED_DOCUMENT_MAX_CHARS);
    expect(text).toContain("truncated at the safe extraction limit");
  });

  test("rejects invalid or oversized PDF input without exposing parser details", async () => {
    await expect(
      extractAgentDocumentText(new TextEncoder().encode("not a pdf"), "application/pdf"),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      extractAgentDocumentText(new Uint8Array(2 * 1024 * 1024 + 1), "application/pdf"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(extractAgentDocumentText(createPdf("page", 21), "application/pdf")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

function findSignature(bytes: Uint8Array, signature: number): number {
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    if (
      bytes[offset] === (signature & 0xff) &&
      bytes[offset + 1] === ((signature >>> 8) & 0xff) &&
      bytes[offset + 2] === ((signature >>> 16) & 0xff) &&
      bytes[offset + 3] === ((signature >>> 24) & 0xff)
    ) {
      return offset;
    }
  }
  return -1;
}

import { strToU8, zipSync } from "fflate";

export function createDocx(documentXml: string): Uint8Array {
  return zipSync({ "word/document.xml": strToU8(documentXml) });
}

export function createPdf(text: string, pageCount = 1): Uint8Array {
  const stream = `BT /F1 12 Tf 72 72 Td (${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`;
  const streamLength = new TextEncoder().encode(stream).byteLength;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pagesId = 3;
  const kids = Array.from({ length: pageCount }, (_, index) => `${pagesId + 1 + index * 2} 0 R`).join(" ");
  objects.splice(1, 0, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = pagesId + 1 + index * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
      `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

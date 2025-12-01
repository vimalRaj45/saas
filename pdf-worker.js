import { parentPort, workerData } from 'worker_threads';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from "@pdf-lib/fontkit";

(async () => {
  try {
    const { participant, fields, templateBuffer, fontBuffer, isPdfTemplate, key, index } = workerData;
    
    // Create PDF
    const pdfDoc = await PDFDocument.create();
    
    if (templateBuffer) {
      if (isPdfTemplate) {
        const templateDoc = await PDFDocument.load(templateBuffer);
        const [copiedPage] = await pdfDoc.copyPages(templateDoc, [0]);
        pdfDoc.addPage(copiedPage);
      } else {
        // Check if it's PNG (PNG magic number: 89 50 4E 47)
        const isPng = templateBuffer.slice(0, 4).toString('hex') === '89504e47';
        
        if (isPng) {
          const img = await pdfDoc.embedPng(templateBuffer);
          const page = pdfDoc.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } else {
          // Assume JPG
          const img = await pdfDoc.embedJpg(templateBuffer);
          const page = pdfDoc.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
      }
    } else {
      pdfDoc.addPage([600, 400]);
    }
    
    // Register font and embed
    pdfDoc.registerFontkit(fontkit);
    const customFont = await pdfDoc.embedFont(fontBuffer);
    
    const page = pdfDoc.getPage(0);
    const pageHeight = page.getSize().height;
    
    // Draw fields
    for (const f of fields) {
      const value = (participant[f.field] || "").toString().trim();
      if (!value) continue;
      
      const hex = (f.color || "#000000").replace("#", "").padEnd(6, '0').slice(0, 6);
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      
      page.drawText(value, {
        x: f.x,
        y: pageHeight - f.y - f.size,
        size: f.size,
        font: customFont,
        color: rgb(r, g, b),
      });
    }
    
   const pdfBytes = await pdfDoc.save();

// Convert Uint8Array to Buffer properly
const pdfBuffer = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength);

// Return result to main thread
parentPort.postMessage({
  success: true,
  key,
  index,
  pdfBuffer: pdfBuffer,
  name: participant.name || participant.Name || participant.NAME || `certificate_${index + 1}`
});
  } catch (error) {
    parentPort.postMessage({
      success: false,
      key,
      index,
      error: error.message
    });
  }
})();

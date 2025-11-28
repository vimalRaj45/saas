import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { PDFDocument, rgb } from 'pdf-lib';
import { v2 as cloudinary } from 'cloudinary';
import https from 'https';
import http from 'http';
import dotenv from 'dotenv';
import fetch from "node-fetch"; // npm install node-fetch
import path from 'path';
import { fileURLToPath } from 'url';

import fontkit from '@pdf-lib/fontkit';

// Create PDF document
const pdfDoc = await PDFDocument.create();

// Register fontkit
pdfDoc.registerFontkit(fontkit);

// Now you can embed the dynamic Unicode font
const fontUrl = "https://github.com/googlefonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf?raw=true";
const fontBytes = await fetch(fontUrl).then(res => res.arrayBuffer());
const customFont = await pdfDoc.embedFont(fontBytes);



dotenv.config();


// ====== CONFIGURE CLOUDINARY ======
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});


// Helper: Fetch image from URL as Buffer
function getBufferFromUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch image: ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// Recreate __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 5000;




app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage() // only for handling uploads before sending to Cloudinary
});


// Serve only the homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});



// --- Upload CSV (Parse Only — No Cloudinary Upload) ---
app.post('/upload-csv', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file received" });
    }

    // Parse directly from buffer (NO CLOUDINARY UPLOAD)
    const content = req.file.buffer.toString("utf8");
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: "CSV must have headers and at least one row" });
    }

    const headers = lines[0]
      .split(',')
      .map(h => h.trim().replace(/^"(.*)"$/, '$1'));

    const participants = lines.slice(1).map(line => {
      // Robust CSV parsing (handles quoted fields)
      const values = line.match(/("(?:[^"]|"")*"|[^,]*),?/g)
        ?.map(v => v.replace(/,$/, '').trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"'))
        || line.split(',').map(v => v.trim());
      
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = values[i] || '';
      });
      return obj;
    });

    return res.json({
      columns: headers,
      participants
    });

  } catch (e) {
    console.error("CSV Parse Error:", e);
    return res.status(500).json({ error: "Failed to parse CSV file" });
  }
});

// --- Upload Template Image to Cloudinary ---
app.post("/upload-template", upload.single("template"), async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No file" });

  try {
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'image' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({ templateUrl: uploadResult.secure_url });
  } catch (err) {
    console.error("Template Upload Error:", err);
    return res.status(500).json({ error: "Image upload failed" });
  }
});

// --- PREVIEW: Generate ONE PDF using Cloudinary template URL ---
app.post('/preview-pdf', async (req, res) => {
  console.log("\n-----------------------------------------");
  console.log("📌 PREVIEW API HIT");
  console.log("-----------------------------------------");

  try {
    console.log("➡ Step 1: Extracting body data...");
    const { participant, templateUrl, fields } = req.body;
    console.log("   participant:", participant);
    console.log("   templateUrl:", templateUrl);
    console.log("   fields:", fields);

    console.log("➡ Step 2: Creating new PDF document...");
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit); // <-- ADD THIS HERE
    console.log("   ✔ PDFDocument created");

    console.log("➡ Step 3: Adding page...");
    const page = pdfDoc.addPage([600, 400]);
    console.log("   ✔ Page added (600x400)");

    // -------------------------------
    // Step 4: Load Unicode font dynamically
    console.log("➡ Step 4: Fetching Unicode font from web...");
    const fontUrl = "https://github.com/googlefonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf?raw=true";
    const fontBytes = await fetch(fontUrl).then(res => res.arrayBuffer());
    const customFont = await pdfDoc.embedFont(fontBytes);
    console.log("   ✔ Unicode font loaded & embedded");

    // -------------------------------
    // Step 5: Load template image
    if (templateUrl && templateUrl.startsWith("http")) {
      console.log("➡ Step 5: Downloading template image...");
      try {
        const imageBytes = await getBufferFromUrl(templateUrl);
        console.log("   ✔ Template image fetched");

        let img;
        const lowerUrl = templateUrl.toLowerCase();

        if (lowerUrl.endsWith(".jpg") || lowerUrl.endsWith(".jpeg")) {
          console.log("   ➡ Embedding JPG...");
          img = await pdfDoc.embedJpg(imageBytes);
          console.log("   ✔ JPG embedded");
        } else if (lowerUrl.endsWith(".png")) {
          console.log("   ➡ Embedding PNG...");
          img = await pdfDoc.embedPng(imageBytes);
          console.log("   ✔ PNG embedded");
        }

        if (img) {
          console.log("   ➡ Drawing template image...");
          page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
          console.log("   ✔ Template placed on page");
        }
      } catch (imgErr) {
        console.error("   ❌ Template loading failed:", imgErr);
      }
    } else {
      console.log("   ℹ No template URL provided or not HTTP");
    }

    // -------------------------------
    // Step 6: Draw fields
    console.log("➡ Step 6: Drawing fields...");
    for (const f of fields) {
      console.log(`   ➡ Field: ${f.field}`);

      let value = participant[f.field] ? String(participant[f.field]) : "";
      value = value.trim();
      console.log(`      Raw value: "${value}"`);

      if (!value) {
        console.log("      ⚠ Empty value, skipping...");
        continue;
      }

      let hex = (f.color || "#000000").replace("#", "");
      if (hex.length !== 6) hex = "000000";

      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      console.log(`      ✔ Position: (${f.x}, ${400 - f.y - f.size})`);
      console.log(`      ✔ Font Size: ${f.size}`);
      console.log(`      ✔ Color: rgb(${r}, ${g}, ${b})`);

      try {
        page.drawText(value, {
          x: f.x,
          y: 400 - f.y - f.size,
          size: f.size,
          font: customFont, // <-- Unicode font
          color: rgb(r, g, b)
        });
        console.log("      ✔ Text drawn");
      } catch (drawErr) {
        console.error("      ❌ Error drawing text:", drawErr);
      }
    }

    // -------------------------------
    console.log("➡ Step 7: Saving PDF...");
    const pdfBytes = await pdfDoc.save();
    console.log("   ✔ PDF saved successfully");

    console.log("➡ Step 8: Sending PDF as response...");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=preview.pdf");
    res.send(Buffer.from(pdfBytes));

    console.log("🎉 PREVIEW COMPLETED SUCCESSFULLY");
    console.log("-----------------------------------------\n");

  } catch (err) {
    console.error("🔥 Overall Preview PDF Error:", err);
    res.status(500).json({
      error: "Preview failed: " + (err.message || "Unknown error")
    });
  }
});


// --- Generate ZIP with all certificates (with step-by-step console) ---
app.post('/generate', async (req, res) => {
  console.log("\n-----------------------------------------");
  console.log("📌 GENERATE ZIP API HIT");
  console.log("-----------------------------------------");

  try {
    const { participants, templateUrl, fields } = req.body;
    console.log("➡ Step 1: Extracting body data...");
    console.log("   participants count:", participants.length);
    console.log("   templateUrl:", templateUrl);
    console.log("   fields:", fields);

    // Create archive
    console.log("➡ Step 2: Creating ZIP archive...");
    const archive = archiver('zip', { zlib: { level: 9 } });

    // Set headers BEFORE piping
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=certificates.zip');

    // Pipe archive to response
    archive.pipe(res);
    console.log("   ✔ Archive piped to response");

    // Load template once for speed
    let imageBytes = null;
    if (templateUrl && templateUrl.startsWith('http')) {
      console.log("➡ Step 3: Fetching template image...");
      try {
        imageBytes = await getBufferFromUrl(templateUrl);
        console.log("   ✔ Template image downloaded");
      } catch (e) {
        console.error("   ❌ Template Download Error:", e);
      }
    } else {
      console.log("   ℹ No valid template URL provided");
    }

    // Load Unicode font once
    console.log("➡ Step 4: Loading Unicode font...");
    const fontUrl = "https://github.com/googlefonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf?raw=true";
    const fontBytes = await fetch(fontUrl).then(r => r.arrayBuffer());
    console.log("   ✔ Unicode font loaded");

    // Loop participants
    let count = 1;
    for (const p of participants) {
      console.log(`➡ Step 5: Generating PDF for participant #${count}`);
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);
      const customFont = await pdfDoc.embedFont(fontBytes);
      const page = pdfDoc.addPage([600, 400]);
      console.log("   ✔ PDF document and page created");

      // Embed template image
      if (imageBytes) {
        try {
          let img;
          const lower = templateUrl.toLowerCase();
          if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) img = await pdfDoc.embedJpg(imageBytes);
          else if (lower.endsWith('.png')) img = await pdfDoc.embedPng(imageBytes);

          if (img) {
            page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
            console.log("   ✔ Template image embedded");
          }
        } catch (imgErr) {
          console.error("   ❌ Image Embed Error:", imgErr);
        }
      }

      // Draw fields
      console.log("   ➡ Drawing fields...");
      for (const f of fields) {
        const value = (p[f.field] || "").toString().trim();
        if (!value) {
          console.log(`      ⚠ Field '${f.field}' is empty, skipping`);
          continue;
        }

        let hex = (f.color || "#000000").replace('#', '');
        if (hex.length !== 6) hex = "000000";

        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;

        page.drawText(value, {
          x: f.x,
          y: 400 - f.y - f.size,
          size: f.size,
          font: customFont,
          color: rgb(r, g, b)
        });
        console.log(`      ✔ Field '${f.field}' drawn at (${f.x}, ${400 - f.y - f.size})`);
      }

      // Add PDF to ZIP
      const pdfBytes = await pdfDoc.save();
      const safeName = (p.name || p.Name || 'certificate').toString().replace(/[^a-z0-9_-]/gi, '_');
      archive.append(Buffer.from(pdfBytes), { name: `${safeName}.pdf` });
      console.log(`   ✔ PDF added to ZIP as '${safeName}.pdf'\n`);
      count++;
    }

    // Finalize archive
    console.log("➡ Step 6: Finalizing ZIP archive...");
    archive.finalize();
    console.log("🎉 ZIP generation completed successfully");
    console.log("-----------------------------------------\n");

  } catch (err) {
    console.error("🔥 ZIP Generation Error:", err);
    if (!res.headersSent) res.status(500).json({ error: 'Generation failed' });
  }
});


app.listen(port, () => {
  console.log(`✅ Precise Certificate Generator running at http://localhost:${port}`);
});

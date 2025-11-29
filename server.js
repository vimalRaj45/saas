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


// --- Generate ZIP with Live Progress for Frontend ---
app.post('/generate', async (req, res) => {
  console.log("\n-----------------------------------------");
  console.log("📌 GENERATE ZIP API HIT");
  console.log("-----------------------------------------");

  try {
    const { participants, templateUrl, fields } = req.body;

    const total = participants.length;
    let processedCount = 0;

    // Send initial progress
    sendProgress({
      stage: "start",
      message: "Starting certificate generation...",
      total,
      current: 0,
      percent: 0
    });

    // Create archive
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=certificates.zip');
    archive.pipe(res);

    // Track archive progress
    archive.on('progress', (progressData) => {
      console.log('ZIP Progress:', progressData);
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.log('Archive warning:', err);
      } else {
        throw err;
      }
    });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      sendProgress({
        stage: "error",
        message: "ZIP creation failed: " + err.message
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "ZIP creation failed" });
      }
    });

    // Load template
    sendProgress({
      stage: "processing",
      message: "Loading template image...",
      percent: 5
    });

    let imageBytes = null;
    if (templateUrl && templateUrl.startsWith('http')) {
      try {
        imageBytes = await getBufferFromUrl(templateUrl);
        sendProgress({
          stage: "processing",
          message: "Template loaded successfully",
          percent: 10
        });
      } catch (e) {
        console.error("Template error:", e);
        sendProgress({
          stage: "error",
          message: "Failed to load template image"
        });
      }
    }

    // Load font
    sendProgress({
      stage: "processing",
      message: "Loading fonts...",
      percent: 15
    });

    const fontUrl = "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf";
    let fontBytes;
    try {
      const fontResponse = await fetch(fontUrl);
      fontBytes = await fontResponse.arrayBuffer();
      sendProgress({
        stage: "processing",
        message: "Fonts loaded successfully",
        percent: 20
      });
    } catch (e) {
      console.error("Font loading error:", e);
      sendProgress({
        stage: "error",
        message: "Failed to load font"
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "Font loading failed" });
      }
      return;
    }

    // Process participants
    let index = 1;

    for (const p of participants) {
      processedCount++;

      const progressPercent = 20 + Math.round((processedCount / total) * 75); // 20-95% range for processing
      const estimatedTimeLeft = Math.round((total - processedCount) * 0.1); // Estimate 100ms per certificate

      // --- SEND LIVE PROGRESS ---
      sendProgress({
        stage: "processing",
        current: processedCount,
        total,
        percent: progressPercent,
        name: p.name || p.Name || `Participant ${processedCount}`,
        estTimeLeft: `${estimatedTimeLeft}s`,
        message: `Generating certificate ${processedCount} of ${total}`
      });

      console.log(`📄 Processing ${processedCount}/${total}: ${p.name || p.Name}`);

      try {
        // Create PDF
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const customFont = await pdfDoc.embedFont(fontBytes);
        const page = pdfDoc.addPage([600, 400]);

        // Add image
        if (imageBytes) {
          try {
            const lower = templateUrl.toLowerCase();
            let img;
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
              img = await pdfDoc.embedJpg(imageBytes);
            } else if (lower.endsWith(".png")) {
              img = await pdfDoc.embedPng(imageBytes);
            } else {
              // Try both if extension not clear
              try {
                img = await pdfDoc.embedJpg(imageBytes);
              } catch {
                img = await pdfDoc.embedPng(imageBytes);
              }
            }

            if (img) {
              page.drawImage(img, { 
                x: 0, 
                y: 0, 
                width: 600, 
                height: 400 
              });
            }
          } catch (err) { 
            console.log("Image embedding skipped:", err.message);
          }
        }

        // Draw fields
        for (const f of fields) {
          const value = (p[f.field] || "").trim();
          if (!value) continue;

          let hex = (f.color || "#000000").replace("#", "");
          // Handle 3-digit hex codes
          if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
          }
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
        }

        // Save PDF
        const pdfBytes = await pdfDoc.save();
        const safeName = (p.name || p.Name || 'certificate')
          .replace(/[^a-z0-9_-]/gi, '_')
          .toLowerCase();

        archive.append(Buffer.from(pdfBytes), { name: `${safeName}.pdf` });

        // Small delay to make progress visible and prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (certError) {
        console.error(`Error generating certificate for ${p.name}:`, certError);
        sendProgress({
          stage: "processing",
          message: `Error with certificate ${processedCount}, skipping...`,
          percent: progressPercent
        });
        // Continue with next participant even if one fails
        continue;
      }

      index++;
    }

    // Finalize ZIP
    sendProgress({
      stage: "finalizing",
      message: "Finalizing ZIP file...",
      percent: 96
    });

    console.log("📦 Finalizing ZIP archive...");

    // Handle archive finalization
    archive.finalize();

    // Wait for archive to complete
    await new Promise((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
    });

    sendProgress({
      stage: "completed",
      percent: 100,
      message: "All certificates generated and ZIP ready for download!",
      total: processedCount
    });

    console.log("🎉 ZIP generation completed successfully");
    console.log(`✅ Generated ${processedCount} certificates`);
    console.log("-----------------------------------------\n");

  } catch (err) {
    console.error("🔥 ZIP Generation Error:", err);

    sendProgress({
      stage: "error",
      message: "Generation failed: " + err.message
    });

    if (!res.headersSent) {
      res.status(500).json({ error: "Generation failed: " + err.message });
    }
  }
});

app.listen(port, () => {
  console.log(`✅ Precise Certificate Generator running at http://localhost:${port}`);
});


import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { PDFDocument, rgb } from 'pdf-lib';
import { v2 as cloudinary } from 'cloudinary';
import https from 'https';
import http from 'http';
import dotenv from 'dotenv';
import fetch from "node-fetch";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import fontkit from "@pdf-lib/fontkit";
import cors from "cors";


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


app.use(cors({
  origin: "*"}));


app.use(express.json({ limit: '50mb' }));
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
    // ✅ Fixed
    let pdfBytes = await pdfDoc.save();
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

// --- SSE clients ---
let clients = []; // connected SSE clients

app.get("/progress", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).end("Missing key");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // send an initial comment to establish the connection immediately (helps some proxies)
  // comments start with ':' and are ignored by SSE parsers, but keep connection alive
  res.write(': connected\n\n');

  const clientId = Date.now() + Math.random();
  const newClient = { id: clientId, key, res };
  clients.push(newClient);

  // debug log
  console.log(`➕ SSE client ${clientId} connected for key=${key} (total clients: ${clients.length})`);

  req.on("close", () => {
    clients = clients.filter(c => c.id !== clientId);
    console.log(`➖ SSE client ${clientId} disconnected for key=${key} (remaining: ${clients.length})`);
  });
});


function sendProgress(key, data) {
  clients.forEach(client => {
    if (client.key === key) {
      try {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        clients = clients.filter(c => c.id !== client.id);
      }
    }
  });
}

// --- Queue system ---
let isGenerating = false;
let queue = [];
let currentGenerationStartTime = null;
let currentGenerationTotal = 0;
let stopRequested = false;

// Temporary storage: key → ZIP path
let zipStore = {};

// ----------------------
// Stop Generation
// ----------------------
app.post("/stop-generate", (req, res) => {
  stopRequested = true;
  queue.forEach(q => {
    q.res?.status(409).json({
      error: "Generation cancelled by user",
      message: "Your request was cancelled because the current generation was stopped"
    });
  });
  queue = [];
  sendProgress(null, { stage: "stopped", task: "⛔ Stopped by user" });
  return res.json({ success: true });
});

// ----------------------
// Generate endpoint
// ----------------------
// ----------------------
// Generate endpoint
// ----------------------
app.post("/generate", async (req, res) => {
  const generationKey = "gen_" + Date.now() + "_" + Math.random().toString(36).substring(2,10);
  req.generationKey = generationKey;

  console.log("🔑 New generation key:", generationKey);

  // Return key immediately for progress tracking
  res.json({ success: true, key: generationKey, message: "Tracking initiated." });

  // Add to queue if already generating
  if (isGenerating) {
    queue.push({ req, key: generationKey, timestamp: Date.now() });
    sendProgress(generationKey, { stage: "queued", task: "Waiting in queue..." });
    return;
  }

  // Start immediately
  isGenerating = true;
  currentGenerationStartTime = Date.now();
  currentGenerationTotal = req.body.participants?.length || 0;

  // Generate ZIP in background and store path
  const zipPath = path.join(__dirname, `temp_${generationKey}.zip`);
  await generateHandler(req, generationKey, zipPath);

  // Save ZIP path for download
  zipStore[generationKey] = zipPath;
});

// ----------------------
// Download endpoint
// ----------------------
app.get("/download", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send("Missing key");

  const filePath = zipStore[key];
  console.log(`📥 Download request for key: ${key}, path: ${filePath}`);
  
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`❌ ZIP not found for key: ${key}`);
    return res.status(404).send("ZIP not found or expired. Please generate again.");
  }

  res.download(filePath, `certificates_${key}.zip`, err => {
    if (err) {
      console.error("Download error:", err);
    }
    // Don't delete immediately - give time for download to complete
    setTimeout(() => {
      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, () => {
          delete zipStore[key];
          console.log(`🧹 Cleaned up ZIP for key: ${key}`);
        });
      }
    }, 30000); // 30 second delay before cleanup
  });
});

// ----------------------
// Main generation handler (optimized + fixed SSE disconnect)
// ----------------------
async function generateHandler(req, key, zipPath) {
  console.log(`🚀 Starting generation for key: ${key}`);
  stopRequested = false;

  const { participants, templateUrl, fields } = req.body;
  const total = participants?.length || 0;
  let processedCount = 0;

  // store zip path
  zipStore[key] = zipPath;

  // initial progress
  sendProgress(key, { 
    stage: "started", 
    task: "Generating certificates",
    current: 0,
    total,
    percent: 0 
  });

  // -------------------------------
  // Create ZIP stream
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = fs.createWriteStream(zipPath);

  archive.on("warning", err => {
    if (err.code === "ENOENT") console.warn("Archive warning:", err);
    else throw err;
  });

  archive.on("error", err => {
    console.error("Archive error:", err);
    sendProgress(key, { stage: "error", task: "Archive creation failed" });
  });

  archive.pipe(output);

  // -------------------------------
  // SSE HEARTBEAT FIX (every 3 sec)
  let heartbeat = setInterval(() => {
    sendProgress(key, { type: "ping", ts: Date.now() });
  }, 3000);

  // -------------------------------
  // Load PDF template
  let baseTemplate = null;
  try {
    if (templateUrl) {
      const resp = await fetch(templateUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      const isPdf = buf.slice(0, 4).toString() === "%PDF";

      if (isPdf) {
        baseTemplate = await PDFDocument.load(buf);
      } else {
        const tmpPdf = await PDFDocument.create();
        const img = templateUrl.toLowerCase().endsWith(".png")
          ? await tmpPdf.embedPng(buf)
          : await tmpPdf.embedJpg(buf);

        const page = tmpPdf.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

        baseTemplate = await PDFDocument.load(await tmpPdf.save());
      }
    }
  } catch (err) {
    console.error("Template load error:", err);
  }

  // -------------------------------
  // Load font
  let fontBytes = null;
  try {
    const fontResp = await fetch(
      "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf"
    );
    fontBytes = Buffer.from(await fontResp.arrayBuffer());
  } catch (err) {
    console.error("Font load error:", err);
    sendProgress(key, { stage: "error", task: "Font loading failed" });
    return;
  }

  // -------------------------------
  // Process batches
  const BATCH_SIZE = 10;

  for (let start = 0; start < total; start += BATCH_SIZE) {
    const batch = participants.slice(start, start + BATCH_SIZE);

    for (let i = 0; i < batch.length; i++) {
      if (stopRequested) break;

      const p = batch[i];

      try {
        // Prepare PDF
        let pdfDoc;
        if (baseTemplate) {
          pdfDoc = await PDFDocument.create();
          const pg = await pdfDoc.copyPages(baseTemplate, [0]);
          pdfDoc.addPage(pg[0]);
        } else {
          pdfDoc = await PDFDocument.create();
          pdfDoc.addPage([600, 400]);
        }

        // font
        pdfDoc.registerFontkit(fontkit);
        const customFont = await pdfDoc.embedFont(fontBytes);

        const page = pdfDoc.getPage(0);
        const pageHeight = page.getSize().height;

        // draw fields
        for (const f of fields) {
          const value = (p[f.field] || "").toString().trim();
          if (!value) continue;

          const hex = f.color.replace("#", "");
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

        const safeName = (p.name || `user_${start + i + 1}`)
          .replace(/[^a-z0-9_.-]/gi, "_")
          .toLowerCase();

        archive.append(Buffer.from(pdfBytes), { name: `${safeName}.pdf` });

        processedCount++;
        const percent = Math.round((processedCount / total) * 100);

        // RAM LOG
        const ram = process.memoryUsage();
        sendProgress(key, {
          stage: "processing",
          task: "Generating certificates",
          current: processedCount,
          total,
          percent,
          name: p.name,
          ramUsedMB: (ram.rss / 1024 / 1024).toFixed(1),
          ramLimitMB: 512
        });

      } catch (err) {
        console.error(`Error processing ${start + i}:`, err);
      }
    }

    // batch RAM log
    const ram = process.memoryUsage();
    console.log(`🧠 RAM after batch: ${(ram.rss/1024/1024).toFixed(1)} MB used of 512 MB`);

    await new Promise(r => setTimeout(r, 20));
    if (global.gc) global.gc();
  }

  // -------------------------------
  // Finalize ZIP
  try {
    await archive.finalize();

    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
    });

    const ram = process.memoryUsage();

    sendProgress(key, {
      stage: stopRequested ? "cancelled" : "completed",
      task: stopRequested ? "Cancelled" : "All certificates generated",
      current: processedCount,
      total,
      percent: stopRequested ? Math.round(processedCount / total * 100) : 100,
      downloadUrl: stopRequested ? null : `/download?key=${key}`,
      finalRamMB: (ram.rss/1024/1024).toFixed(1),
      ramLimitMB: 512
    });

  } catch (err) {
    console.error("Finalize error:", err);
    sendProgress(key, { stage: "error", task: "ZIP finalize failed" });
  }

  // cleanup
  clearInterval(heartbeat);
  baseTemplate = null;
  fontBytes = null;
  if (global.gc) global.gc();

  isGenerating = false;

  // queue next job
  if (queue.length > 0 && !stopRequested) {
    const next = queue.shift();
    const nextZip = path.join(__dirname, `temp_${next.key}.zip`);
    setTimeout(() => generateHandler(next.req, next.key, nextZip), 1000);
  }
}

// Also update the stop endpoint to allow partial completion:
app.post("/stop-generate", (req, res) => {
  stopRequested = true;
  
  // Send cancellation to queued requests
  queue.forEach(q => {
    q.res?.status(409).json({
      error: "Generation cancelled",
      message: "Your request was cancelled because the current generation was stopped",
      partial: false
    });
  });
  queue = [];
  
  // Send stop notification to all clients
  sendProgress(null, { 
    stage: "stopped", 
    task: "⏸️ Stopping generation...",
    message: "Stopping current generation. Partial results will be available."
  });
  
  return res.json({ 
    success: true, 
    message: "Stopping generation. Partial results will be saved."
  });
});




// Add cleanup endpoint
app.post("/cleanup", (req, res) => {
  const { key } = req.body;
  if (key && zipStore[key]) {
    const filePath = zipStore[key];
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    delete zipStore[key];
    console.log(`🧹 Manual cleanup for key: ${key}`);
  }
  res.json({ success: true });
});


app.get("/status", (req, res) => {
  const key = req.query.key;

  if (!progressStore[key]) {
    return res.json({ completed: false });
  }

  const record = progressStore[key];
  
  res.json({
    completed: record.stage === "completed",
    downloadUrl: record.downloadUrl || null
  });
});


app.listen(port, () => {
  console.log(`✅ Precise Certificate Generator running at http://localhost:${port}`);
});

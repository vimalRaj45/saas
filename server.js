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
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import fontkit from "@pdf-lib/fontkit";


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

let clients = []; // connected SSE clients

app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on("close", () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

// Function to send progress to all SSE clients
function sendProgress(data) {
  console.log("📊 Sending progress:", data); // Debug log
  clients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      console.error("Error sending progress to client:", error);
      // Remove disconnected clients
      clients = clients.filter(c => c !== client);
    }
  });
}

// ====== GENERATION QUEUE SYSTEM ======
let isGenerating = false;
let queue = [];
let currentGenerationStartTime = null;
let currentGenerationTotal = 0;

// ----------------------
// 1️⃣ Stop Generation
// ----------------------
let stopRequested = false; // global flag

app.post("/stop-generate", (req, res) => {
  stopRequested = true; // set stop flag
  
  // Clear queue if requested
  if (queue.length > 0) {
    queue.forEach(queued => {
      queued.res.status(409).json({ 
        error: "Generation cancelled by user",
        message: "Your request was cancelled because the current generation was stopped"
      });
    });
    queue = [];
  }
  
  sendProgress({
    stage: "stopped",
    task: "⛔ Stopped by user"
  });
  console.log("⛔ Generation stop requested by user");
  return res.json({ success: true, message: "Generation stopped" });
});

// Calculate estimated wait time
function calculateWaitTime() {
  if (!currentGenerationStartTime || !currentGenerationTotal) return "Unknown";
  
  const elapsed = (Date.now() - currentGenerationStartTime) / 1000;
  const progressPercent = Math.min(95, Math.max(5, (elapsed / 30) * 100)); // Estimate based on average time
  const remainingTime = (elapsed / progressPercent) * (100 - progressPercent);
  
  return `${Math.ceil(remainingTime / 60)} minutes ${Math.ceil(remainingTime % 60)} seconds`;
}

// 2️⃣ Generate Certificates (Main endpoint with queue)
app.post("/generate", async (req, res) => {
  // If already generating, add to queue
  if (isGenerating) {
    const position = queue.length + 1;
    const waitTime = calculateWaitTime();
    
    queue.push({ req, res, timestamp: Date.now() });
    
    sendProgress({
      stage: "queued",
      task: "Waiting in queue...",
      position: position,
      waitTime: waitTime,
      log: `Your request is #${position} in queue. Estimated wait time: ${waitTime}`
    });
    
    console.log(`📋 Request added to queue. Position: ${position}, Queue size: ${queue.length}`);
    return;
  }

  // Start generation immediately
  isGenerating = true;
  currentGenerationStartTime = Date.now();
  currentGenerationTotal = req.body.participants?.length || 0;
  
  await generateHandler(req, res);
});

// Main generation logic
async function generateHandler(req, res) {
  stopRequested = false; // reset at start
  console.log("⚡ Generation started");

  let responseEnded = false;
  let processedCount = 0;
  const startTime = Date.now(); // for ETA calculation
  const total = req.body.participants?.length || 0;

  const endResponse = (message = "Generation stopped") => {
    if (responseEnded) return;
    responseEnded = true;

    sendProgress({
      stage: stopRequested ? "stopped" : "completed",
      task: message,
      current: processedCount,
      total
    });

    if (!res.writableEnded) res.end();
  };

  try {
    const { participants, templateUrl, fields } = req.body;

    if (!participants || total === 0) {
      isGenerating = false;
      currentGenerationStartTime = null;
      currentGenerationTotal = 0;
      return res.status(400).json({ error: "No participants" });
    }

    // Send initial progress
    sendProgress({
      stage: "started",
      task: "Starting certificate generation",
      current: 0,
      total,
      percent: 0,
      log: `Starting generation of ${total} certificates...`
    });

    if (stopRequested) {
      isGenerating = false;
      currentGenerationStartTime = null;
      currentGenerationTotal = 0;
      return endResponse("Stopped before starting ZIP");
    }

    // ---- STREAM ZIP ----
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=certificates.zip");
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error("Archiver error:", err);
      sendProgress({ stage: "error", task: "ZIP creation failed", error: err.message });
      if (!responseEnded) res.status(500).end();
    });

    archive.pipe(res);

    // ---- Load Template Once ----
    let templateBuffer = null;
    if (templateUrl) {
      try {
        sendProgress({ stage: "processing", task: "Loading template image", log: "Downloading template from Cloudinary..." });
        const response = await fetch(templateUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        templateBuffer = Buffer.from(await response.arrayBuffer());
        sendProgress({ stage: "processing", task: "Template loaded", log: "✅ Template image loaded successfully" });
      } catch (err) {
        console.warn("⚠️ Template load failed:", err.message);
        sendProgress({ stage: "processing", task: "Template load warning", log: `⚠️ Template loading failed: ${err.message}` });
      }
    }

    // ---- Load Font Once ----
    sendProgress({ stage: "processing", task: "Loading fonts", log: "Downloading Unicode font..." });
    const fontUrl = "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf";
    const fontBytes = Buffer.from(await (await fetch(fontUrl)).arrayBuffer());
    sendProgress({ stage: "processing", task: "Fonts loaded", log: "✅ Unicode font loaded successfully" });

    // ---- MAIN LOOP ----
    sendProgress({ stage: "processing", task: "Generating certificates", log: `Starting PDF generation for ${total} participants...` });

    for (let i = 0; i < total; i++) {
      if (stopRequested) {
        console.log("⛔ STOP REQUESTED — Aborting generation...");
        archive.abort();
        isGenerating = false;
        currentGenerationStartTime = null;
        currentGenerationTotal = 0;
        return endResponse("User stopped generation");
      }

      const p = participants[i];

      // --- Create PDF ---
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);
      const customFont = await pdfDoc.embedFont(fontBytes);
      const page = pdfDoc.addPage([600, 400]);

      // --- Embed template ---
      if (templateBuffer) {
        try {
          const lower = templateUrl.toLowerCase();
          const img = lower.endsWith(".jpg") || lower.endsWith(".jpeg")
            ? await pdfDoc.embedJpg(templateBuffer)
            : await pdfDoc.embedPng(templateBuffer);
          page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
        } catch (imgErr) {
          console.warn(`⚠️ Template embed failed for ${p.name || 'user'}:`, imgErr.message);
        }
      }

      // --- Draw fields ---
      for (const f of fields) {
        const value = (p[f.field] || "").toString().trim();
        if (!value) continue;

        const hex = (f.color || "#000000").replace("#", "").padEnd(6, "0").slice(0, 6);
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;

        page.drawText(value, { x: f.x, y: 400 - f.y - f.size, size: f.size, font: customFont, color: rgb(r, g, b) });
      }

      // --- Save PDF ---
      const pdfBytes = await pdfDoc.save();
      const safeName = (p.name || p.Name || `user_${i + 1}`)
        .replace(/[^a-z0-9_.-]/gi, "_")
        .replace(/_{2,}/g, "_")
        .toLowerCase();

      archive.append(Buffer.from(pdfBytes), { name: `${safeName}.pdf` });
      processedCount++;

      // --- ETA calculation ---
      const elapsed = (Date.now() - startTime) / 1000;
      const avgTimePerPdf = elapsed / processedCount;
      const remainingTime = avgTimePerPdf * (total - processedCount);

      // --- Send live progress to frontend & flush ---
      sendProgress({
        stage: "processing",
        task: "Generating certificates",
        name: p.name || `User ${i + 1}`,
        current: processedCount,
        total,
        percent: Math.round((processedCount / total) * 100),
        eta: `${Math.ceil(remainingTime)}s`,
        log: `✅ Generated PDF for ${p.name || `User ${i + 1}`} (${processedCount}/${total})`
      });

      // allow Node to flush progress
      await new Promise((r) => setTimeout(r, 0));
    }

    // ---- Finalize ZIP ----
    sendProgress({ stage: "finalizing", task: "Creating ZIP file", log: "Finalizing ZIP archive..." });
    await archive.finalize();

    if (!responseEnded) {
      sendProgress({ stage: "completed", task: "All certificates generated", percent: 100, current: total, total, log: `🎉 Successfully generated ${total} certificates!` });
    }

  } catch (err) {
    console.error("❌ Fatal error in /generate:", err);
    sendProgress({ stage: "error", task: "Generation failed", error: err.message, log: `❌ Fatal error: ${err.message}` });
    if (!responseEnded) res.status(500).json({ error: "Server error during generation" });
  } finally {
    // Mark as finished and process next in queue
    isGenerating = false;
    currentGenerationStartTime = null;
    currentGenerationTotal = 0;
    
    // Process next request in queue if any
    if (queue.length > 0) {
      const next = queue.shift();
      console.log(`🔄 Processing next request from queue. Remaining in queue: ${queue.length}`);
      setTimeout(() => {
        generateHandler(next.req, next.res);
      }, 1000); // Small delay before starting next
    }
  }
}
app.listen(port, () => {
  console.log(`✅ Precise Certificate Generator running at http://localhost:${port}`);
});

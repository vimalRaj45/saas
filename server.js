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

// Update the download endpoint to show partial info:
app.get("/download", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send("Missing key");

  const fileInfo = zipStore[key];
  if (!fileInfo || !fs.existsSync(fileInfo.zipPath)) {
    return res.status(404).send("ZIP not found or expired. Please generate again.");
  }

  // Customize filename based on completion status
  const status = fileInfo.completed || "unknown";
  const filename = status === "partial" 
    ? `certificates_partial_${key}.zip` 
    : `certificates_${key}.zip`;

  res.download(fileInfo.zipPath, filename, err => {
    if (err) {
      console.error("Download error:", err);
    }
    // Delayed cleanup
    setTimeout(() => {
      if (fs.existsSync(fileInfo.zipPath)) {
        fs.unlink(fileInfo.zipPath, () => {
          // Clean up temp directory if exists
          if (fileInfo.tempDir && fs.existsSync(fileInfo.tempDir)) {
            fs.rmSync(fileInfo.tempDir, { recursive: true, force: true });
          }
          delete zipStore[key];
          console.log(`🧹 Cleaned up all files for key: ${key}`);
        });
      }
    }, 30000);
  });
});

// ----------------------
// Main generation handler (optimized + fixed SSE disconnect)
// ----------------------
// Update the generateHandler function to save incremental ZIP files
async function generateHandler(req, key, zipPath) {
  console.log(`🚀 Starting generation for key: ${key}`);
  stopRequested = false;

  const { participants, templateUrl, fields } = req.body;
  const total = participants?.length || 0;
  let processedCount = 0;

  // Create a temporary directory for this generation session
  const tempDir = path.join(__dirname, `temp_${key}`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Store paths for cleanup
  zipStore[key] = { zipPath, tempDir, completed: false };

  // Initial progress
  sendProgress(key, { 
    stage: "started", 
    task: "Generating certificates",
    current: 0,
    total,
    percent: 0 
  });

  // -------------------------------
  // Create incremental ZIP
  const archive = archiver("zip", { zlib: { level: 5 } }); // Lower compression for speed
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
  // SSE HEARTBEAT
  let heartbeat = setInterval(() => {
    sendProgress(key, { type: "ping", ts: Date.now() });
  }, 3000);

  // -------------------------------
  // Load resources
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
  // Array to store generated PDF paths for partial completion
  const generatedPdfs = [];

  try {
    // Process batches
    const BATCH_SIZE = 2; // Smaller batch size for 512MB RAM
    let shouldStop = false;

    for (let start = 0; start < total && !shouldStop; start += BATCH_SIZE) {
      // Check if stop was requested
      if (stopRequested) {
        console.log(`⏸️ Stop requested for key: ${key}`);
        shouldStop = true;
        break;
      }

      const batch = participants.slice(start, start + BATCH_SIZE);
      const batchPromises = [];

      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        const index = start + i;

        // Create promise for each PDF generation
        const pdfPromise = (async () => {
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

            // Embed font
            pdfDoc.registerFontkit(fontkit);
            const customFont = await pdfDoc.embedFont(fontBytes);
            const page = pdfDoc.getPage(0);
            const pageHeight = page.getSize().height;

            // Draw fields
            for (const f of fields) {
              const value = (p[f.field] || "").toString().trim();
              if (!value) continue;

              const hex = (f.color || "#000000").replace("#", "");
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
            const pdfBuffer = Buffer.from(pdfBytes);

            // Save to temp file first
            const safeName = (p.name || `certificate_${index + 1}`)
              .replace(/[^a-z0-9_.-]/gi, "_")
              .toLowerCase();
            
            const tempPdfPath = path.join(tempDir, `${safeName}.pdf`);
            fs.writeFileSync(tempPdfPath, pdfBuffer);
            
            // Add to ZIP archive
            archive.append(pdfBuffer, { name: `${safeName}.pdf` });
            generatedPdfs.push(tempPdfPath);

            return { success: true, index, name: p.name };

          } catch (err) {
            console.error(`Error processing ${index}:`, err);
            return { success: false, index, error: err.message };
          }
        })();

        batchPromises.push(pdfPromise);
      }

      // Wait for batch completion
      const results = await Promise.all(batchPromises);
      
      // Update progress
      processedCount += batch.length;
      const percent = Math.round((processedCount / total) * 100);
      
      // RAM monitoring
      const ram = process.memoryUsage();
      const ramUsedMB = ram.rss / 1024 / 1024;
      
      // Check if we're approaching memory limit (512MB)
      if (ramUsedMB > 450) {
        console.warn(`⚠️ High memory usage: ${ramUsedMB.toFixed(1)}MB. Stopping to prevent crash.`);
        shouldStop = true;
        sendProgress(key, {
          stage: "warning",
          task: "Memory limit approaching. Stopping generation.",
          current: processedCount,
          total,
          percent,
          ramUsedMB: ramUsedMB.toFixed(1),
          ramLimitMB: 512
        });
        break;
      }

      // Send progress update
      sendProgress(key, {
        stage: shouldStop ? "partial" : "processing",
        task: shouldStop ? "Stopping early (memory)" : "Generating certificates",
        current: processedCount,
        total,
        percent,
        ramUsedMB: ramUsedMB.toFixed(1),
        ramLimitMB: 512
      });

      // Small delay between batches
      await new Promise(r => setTimeout(r, 50));
      
      // Force garbage collection if available
      if (global.gc) global.gc();
    }

    // -------------------------------
    // Finalize based on completion status
    if (shouldStop || stopRequested) {
      // Partial completion - still finalize with what we have
      console.log(`🔄 Finalizing partial ZIP for key: ${key} (${processedCount}/${total} PDFs)`);
      
      try {
        await archive.finalize();
        
        await new Promise((resolve, reject) => {
          output.on("close", resolve);
          output.on("error", reject);
        });

        // Mark as partially completed
        zipStore[key].completed = "partial";
        
        sendProgress(key, {
          stage: "partial",
          task: "Partial generation completed",
          current: processedCount,
          total,
          percent: Math.round((processedCount / total) * 100),
          message: `Generated ${processedCount} out of ${total} certificates`,
          downloadUrl: `/download?key=${key}`,
          partial: true,
          generatedCount: processedCount,
          totalCount: total
        });

      } catch (err) {
        console.error("Partial finalize error:", err);
        sendProgress(key, { 
          stage: "error", 
          task: "Partial ZIP creation failed",
          message: `Generated ${processedCount} PDFs but failed to create ZIP`
        });
      }

    } else {
      // Full completion
      console.log(`✅ Finalizing complete ZIP for key: ${key}`);
      
      try {
        await archive.finalize();
        
        await new Promise((resolve, reject) => {
          output.on("close", resolve);
          output.on("error", reject);
        });

        // Mark as completed
        zipStore[key].completed = "full";
        
        sendProgress(key, {
          stage: "completed",
          task: "All certificates generated",
          current: total,
          total,
          percent: 100,
          downloadUrl: `/download?key=${key}`,
          partial: false,
          generatedCount: total
        });

      } catch (err) {
        console.error("Finalize error:", err);
        sendProgress(key, { stage: "error", task: "ZIP finalize failed" });
      }
    }

  } catch (err) {
    console.error("Generation handler error:", err);
    sendProgress(key, { 
      stage: "error", 
      task: "Generation failed",
      message: err.message || "Unknown error"
    });
  } finally {
    // Cleanup
    clearInterval(heartbeat);
    
    // Clean up temp directory after 5 minutes
    setTimeout(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log(`🧹 Cleaned temp directory for key: ${key}`);
      }
    }, 5 * 60 * 1000);
    
    // Clean up ZIP file after 30 minutes if not downloaded
    setTimeout(() => {
      if (zipStore[key] && fs.existsSync(zipPath)) {
        fs.unlink(zipPath, () => {
          console.log(`🧹 Cleaned up ZIP for key: ${key} (timeout)`);
          delete zipStore[key];
        });
      }
    }, 30 * 60 * 1000);

    // Release memory
    baseTemplate = null;
    fontBytes = null;
    if (global.gc) global.gc();

    isGenerating = false;

    // Process next in queue
    if (queue.length > 0 && !stopRequested) {
      const next = queue.shift();
      const nextZip = path.join(__dirname, `temp_${next.key}.zip`);
      setTimeout(() => generateHandler(next.req, next.key, nextZip), 2000);
    }
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

app.listen(port, () => {
  console.log(`✅ Precise Certificate Generator running at http://localhost:${port}`);
});

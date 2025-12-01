import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { v2 as cloudinary } from 'cloudinary';
import https from 'https';
import http from 'http';
import dotenv from 'dotenv';
import fetch from "node-fetch";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import os from 'os';

dotenv.config();

// ====== CONFIGURE CLOUDINARY ======
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// Recreate __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker path - pointing to the separate worker file
const workerPath = path.join(__dirname, 'pdf-worker.js');

const app = express();
const port = process.env.PORT || 5000;

// Memory monitoring
let maxMemoryUsed = 0;
const MAX_MEMORY_MB = 450; // Leave some buffer under 512MB
const MEMORY_CHECK_INTERVAL = 1000;

setInterval(() => {
  const used = process.memoryUsage().rss / 1024 / 1024;
  maxMemoryUsed = Math.max(maxMemoryUsed, used);
  if (used > MAX_MEMORY_MB * 0.9) {
    console.warn(`⚠️ High memory usage: ${used.toFixed(1)}MB`);
    if (global.gc) global.gc();
  }
}, MEMORY_CHECK_INTERVAL);

app.use(express.json({ limit: '10mb' })); // Reduced from 50mb
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  }
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

    // Parse directly from buffer
    const content = req.file.buffer.toString("utf8");
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: "CSV must have headers and at least one row" });
    }

    const headers = lines[0]
      .split(',')
      .map(h => h.trim().replace(/^"(.*)"$/, '$1'));

    const participants = lines.slice(1).map(line => {
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
      participants: participants.slice(0, 1000) // Limit to 1000 records for safety
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
  console.log("\n📌 PREVIEW API HIT");
  
  try {
    const { participant, templateUrl, fields } = req.body;
    
    // Load font
    const fontResp = await fetch(
      "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf"
    );
    const fontBuffer = Buffer.from(await fontResp.arrayBuffer());
    
    let templateBuffer = null;
    let isPdfTemplate = false;
    
    if (templateUrl && templateUrl.startsWith("http")) {
      try {
        const imageBytes = await getBufferFromUrl(templateUrl);
        templateBuffer = imageBytes;
        isPdfTemplate = imageBytes.slice(0, 4).toString() === '%PDF';
      } catch (imgErr) {
        console.error("Template loading failed:", imgErr);
      }
    }
    
    const worker = new Worker(workerPath, {
      workerData: {
        participant,
        fields,
        templateBuffer,
        fontBuffer,
        isPdfTemplate,
        key: 'preview',
        index: 0
      }
    });
    
    const result = await new Promise((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
    
    worker.terminate();
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=preview.pdf");
    res.send(result.pdfBuffer);
    
    console.log("🎉 PREVIEW COMPLETED SUCCESSFULLY");
    
  } catch (err) {
    console.error("🔥 Preview PDF Error:", err);
    res.status(500).json({
      error: "Preview failed: " + (err.message || "Unknown error")
    });
  }
});

// --- SSE clients ---
let clients = [];

app.get("/progress", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).end("Missing key");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable proxy buffering
  res.flushHeaders();
  
  // Initial connection message
  res.write(': connected\n\n');
  
  const clientId = Date.now() + Math.random();
  const newClient = { id: clientId, key, res };
  clients.push(newClient);
  
  console.log(`➕ SSE client ${clientId} connected for key=${key}`);
  
  req.on("close", () => {
    clients = clients.filter(c => c.id !== clientId);
    console.log(`➖ SSE client ${clientId} disconnected`);
  });
});

function sendProgress(key, data) {
  const now = Date.now();
  clients.forEach(client => {
    if (client.key === key) {
      try {
        // Add timestamp to help with connection issues
        const dataWithTime = { ...data, _ts: now };
        client.res.write(`data: ${JSON.stringify(dataWithTime)}\n\n`);
      } catch {
        // Client disconnected
        clients = clients.filter(c => c.id !== client.id);
      }
    }
  });
}

// --- Queue system ---
let isGenerating = false;
let queue = [];
let stopRequested = false;

// Temporary storage: key → ZIP path
let zipStore = {};

// Cleanup old files periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, filePath] of Object.entries(zipStore)) {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      // Delete files older than 30 minutes
      if (now - stats.mtimeMs > 30 * 60 * 1000) {
        fs.unlinkSync(filePath);
        delete zipStore[key];
        console.log(`🧹 Cleaned up old ZIP: ${key}`);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

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
  res.json({ success: true });
});

// ----------------------
// Generate endpoint
// ----------------------
app.post("/generate", async (req, res) => {
  const generationKey = "gen_" + Date.now() + "_" + Math.random().toString(36).substring(2,10);
  
  console.log("🔑 New generation key:", generationKey);
  
  // Return key immediately for progress tracking
  res.json({ success: true, key: generationKey, message: "Generation queued" });
  
  // Add to queue
  queue.push({ req, key: generationKey, timestamp: Date.now() });
  sendProgress(generationKey, { stage: "queued", task: "Waiting in queue..." });
  
  // Start processing if not already running
  if (!isGenerating) {
    processQueue();
  }
});

// ----------------------
// Download endpoint
// ----------------------
app.get("/download", (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).send("Missing key");

  const filePath = zipStore[key];
  console.log(`📥 Download request for key: ${key}`);
  
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`❌ ZIP not found for key: ${key}`);
    return res.status(404).send("ZIP not found or expired. Please generate again.");
  }

  res.download(filePath, `certificates_${key}.zip`, err => {
    if (err) {
      console.error("Download error:", err);
    }
  });
});

// ----------------------
// Queue processor
// ----------------------
async function processQueue() {
  if (queue.length === 0) {
    isGenerating = false;
    return;
  }
  
  isGenerating = true;
  const { req, key } = queue.shift();
  
  try {
    await processGeneration(req, key);
  } catch (error) {
    console.error(`❌ Generation failed for key ${key}:`, error);
    sendProgress(key, { stage: "error", task: "Generation failed: " + error.message });
  } finally {
    // Process next in queue
    setTimeout(processQueue, 1000);
  }
}

// ----------------------
// Main generation processor
// ----------------------
async function processGeneration(req, key) {
  console.log(`🚀 Starting generation for key: ${key}`);
  stopRequested = false;
  
  const { participants, templateUrl, fields } = req.body;
  const total = Math.min(participants?.length || 0, 5000); // Hard limit for safety
  let processedCount = 0;
  
  // Initial progress
  sendProgress(key, { 
    stage: "started", 
    task: "Preparing generation...",
    current: 0,
    total,
    percent: 0 
  });
  
  // Create ZIP file
  const zipPath = path.join(__dirname, `temp_${key}.zip`);
  zipStore[key] = zipPath;
  
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { 
    zlib: { level: 6 } // Balanced compression level
  });
  
  // Archive event handlers
  archive.on("warning", err => {
    if (err.code !== "ENOENT") console.warn("Archive warning:", err);
  });
  
  archive.on("error", err => {
    console.error("Archive error:", err);
    sendProgress(key, { stage: "error", task: "Archive creation failed" });
  });
  
  archive.pipe(output);
  
  // Load shared resources
  let templateBuffer = null;
  let isPdfTemplate = false;
  let fontBuffer = null;
  
  try {
    // Load font
    const fontResp = await fetch(
      "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf"
    );
    fontBuffer = Buffer.from(await fontResp.arrayBuffer());
    
    // Load template if provided
    if (templateUrl && templateUrl.startsWith("http")) {
      const imageBytes = await getBufferFromUrl(templateUrl);
      templateBuffer = imageBytes;
      isPdfTemplate = imageBytes.slice(0, 4).toString() === '%PDF';
    }
  } catch (err) {
    console.error("Resource loading error:", err);
    sendProgress(key, { stage: "error", task: "Failed to load resources" });
    return;
  }
  
  // Determine optimal batch size based on available CPUs
  const cpuCount = os.cpus().length;
  const BATCH_SIZE = Math.min(4, cpuCount); // Max 4 workers at a time for 512MB
  const CHUNK_SIZE = 50; // Process 50 certificates per batch cycle
  
  sendProgress(key, {
    stage: "processing",
    task: `Generating with ${BATCH_SIZE} workers...`,
    current: 0,
    total,
    percent: 0
  });
  
  // Process in chunks
  for (let chunkStart = 0; chunkStart < total; chunkStart += CHUNK_SIZE) {
    if (stopRequested) break;
    
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, total);
    const chunk = participants.slice(chunkStart, chunkEnd);
    
    // Process chunk with parallel workers
    const results = await processChunkWithWorkers(
      chunk, 
      fields, 
      templateBuffer, 
      fontBuffer, 
      isPdfTemplate, 
      key, 
      chunkStart,
      BATCH_SIZE
    );
    
    // Add to archive
for (const result of results) {
  if (result.success && result.pdfBuffer) {
    const safeName = (result.name || `certificate_${result.index + 1}`)
      .replace(/[^a-z0-9_.-]/gi, "_")
      .toLowerCase();
    
    // Ensure it's a Buffer
    let bufferToAppend = result.pdfBuffer;
    if (bufferToAppend && bufferToAppend instanceof Uint8Array) {
      bufferToAppend = Buffer.from(bufferToAppend.buffer, bufferToAppend.byteOffset, bufferToAppend.byteLength);
    }
    
    if (bufferToAppend && Buffer.isBuffer(bufferToAppend)) {
      archive.append(bufferToAppend, { name: `${safeName}.pdf` });
    } else {
      console.warn(`⚠️ Invalid buffer for ${safeName}, skipping`);
    }
  }
 }
    
    processedCount += results.length;
    const percent = Math.round((processedCount / total) * 100);
    
    // Memory check
    const memoryUsed = process.memoryUsage().rss / 1024 / 1024;
    if (memoryUsed > MAX_MEMORY_MB * 0.85) {
      console.warn(`⚠️ High memory: ${memoryUsed.toFixed(1)}MB, forcing GC`);
      if (global.gc) global.gc();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    sendProgress(key, {
      stage: "processing",
      task: "Generating certificates...",
      current: processedCount,
      total,
      percent,
      memoryUsedMB: memoryUsed.toFixed(1),
      ramLimitMB: MAX_MEMORY_MB
    });
    
    // Small delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Finalize archive
  try {
    await archive.finalize();
    
    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
    });
    
    const finalMemory = process.memoryUsage().rss / 1024 / 1024;
    
    sendProgress(key, {
      stage: stopRequested ? "cancelled" : "completed",
      task: stopRequested ? "Cancelled" : "All certificates generated",
      current: processedCount,
      total,
      percent: stopRequested ? Math.round(processedCount / total * 100) : 100,
      downloadUrl: stopRequested ? null : `/download?key=${key}`,
      finalMemoryMB: finalMemory.toFixed(1),
      ramLimitMB: MAX_MEMORY_MB
    });
    
    console.log(`✅ Generation completed for key: ${key}`);
    
  } catch (err) {
    console.error("Finalize error:", err);
    sendProgress(key, { stage: "error", task: "ZIP finalize failed" });
  }
  
  // Cleanup resources
  templateBuffer = null;
  fontBuffer = null;
  if (global.gc) global.gc();
}

// ----------------------
// Process chunk with worker threads
// ----------------------
async function processChunkWithWorkers(chunk, fields, templateBuffer, fontBuffer, isPdfTemplate, key, startIndex, batchSize) {
  const results = [];
  
  // Process in batches within the chunk
  for (let i = 0; i < chunk.length; i += batchSize) {
    if (stopRequested) break;
    
    const batch = chunk.slice(i, i + batchSize);
    const workers = [];
    const promises = [];
    
    // Create workers
    for (let j = 0; j < batch.length; j++) {
      const worker = new Worker(workerPath, {
        workerData: {
          participant: batch[j],
          fields,
          templateBuffer,
          fontBuffer,
          isPdfTemplate,
          key,
          index: startIndex + i + j
        }
      });
      
      workers.push(worker);
      
      promises.push(new Promise((resolve) => {
        worker.on('message', (message) => {
          resolve(message);
          worker.terminate();
        });
        
        worker.on('error', (error) => {
          resolve({ 
            success: false, 
            index: startIndex + i + j, 
            error: error.message 
          });
          worker.terminate();
        });
        
        worker.on('exit', (code) => {
          if (code !== 0) {
            resolve({ 
              success: false, 
              index: startIndex + i + j, 
              error: `Worker exited with code ${code}` 
            });
          }
        });
      }));
    }
    
    // Wait for batch completion
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    
    // Force cleanup
    workers.length = 0;
    if (global.gc) global.gc();
  }
  
  return results;
}

// ----------------------
// Cleanup endpoint
// ----------------------
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

// ----------------------
// Health check endpoint
// ----------------------
app.get("/health", (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: "healthy",
    memory: {
      rss: `${(memory.rss / 1024 / 1024).toFixed(1)}MB`,
      heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(1)}MB`,
      heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(1)}MB`,
      external: `${(memory.external / 1024 / 1024).toFixed(1)}MB`
    },
    uptime: process.uptime(),
    queueLength: queue.length,
    activeGenerations: isGenerating ? 1 : 0
  });
});

// Start server
app.listen(port, () => {
  console.log(`✅ Optimized Certificate Generator running on port ${port}`);
  console.log(`📊 Memory limit: ${MAX_MEMORY_MB}MB`);
  console.log(`💾 Available CPUs: ${os.cpus().length}`);
});

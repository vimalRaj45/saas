import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import archiver from 'archiver';
import { PDFDocument, rgb } from 'pdf-lib';
import { fileURLToPath } from 'url';
import { dirname, extname } from 'path';
import { createReadStream, createWriteStream } from 'fs';
import axios from 'axios';


const app = express();
const port = 5000;

app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage() // store uploaded files in RAM
});



// Serve HTML with enhanced UI (Bootstrap 5 + Bold Toggle)
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>🎯 Precise Certificate Generator</title>
  <!-- Bootstrap 5 CSS -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    #template {
      border: 1px solid #dee2e6;
      width: 600px;
      height: 400px;
      position: relative;
      background-size: contain;
      background-repeat: no-repeat;
      margin: 15px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .field {
      position: absolute;
      padding: 3px 6px;
      border: 1px solid #0d6efd;
      background: rgba(255,255,255,0.95);
      cursor: move;
      font-size: 16px;
      color: #000;
      border-radius: 4px;
      user-select: none;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      pointer-events: auto;
      z-index: 10;
      font-weight: normal;
    }
    .field.selected {
      border-color: #fd7e14;
      background: rgba(255,243,224,0.95);
      color: #e64a19;
    }
    .field .coords {
      font-size: 10px;
      color: #6c757d;
      margin-top: 2px;
    }
    #directionPad {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      grid-template-rows: 1fr 1fr 1fr;
      gap: 6px;
      width: 120px;
      z-index: 1000;
    }
    #directionPad button {
      padding: 8px !important;
      font-size: 18px !important;
      border: none !important;
      border-radius: 6px !important;
      cursor: pointer;
    }
    .debug { min-height: 1.3em; }
  </style>
</head>
<body class="bg-light">

<div class="container py-4">
  <h1 class="mb-4 text-center">🎯 Precise Certificate Generator</h1>

  <!-- Step 1 -->
  <div class="card mb-4">
    <div class="card-header bg-primary text-white">Step 1: Upload CSV</div>
    <div class="card-body">
      <input type="file" id="csvFile" accept=".csv" class="form-control">
    </div>
  </div>

  <!-- Step 2 -->
  <div class="card mb-4">
    <div class="card-header bg-success text-white">Step 2: Upload Template (JPG/PNG)</div>
    <div class="card-body">
      <input type="file" id="templateFile" accept="image/*" class="form-control">
    </div>
  </div>

  <!-- Step 3 -->
  <div class="card mb-4">
    <div class="card-header bg-info text-white">Step 3: Add Fields</div>
    <div class="card-body">
      <div id="columns" class="d-flex flex-wrap gap-2"></div>
    </div>
  </div>

  <!-- Step 4 -->
  <div class="card mb-4">
    <div class="card-header bg-warning text-dark">Step 4: Position & Style</div>
    <div class="card-body">
      <div id="template"></div>

      <!-- Field Controls -->
      <div id="fieldControls" class="mt-3 p-3 bg-light border rounded" style="display:none;">
        <h6>🎨 Field Styling</h6>
        <div class="row g-2 align-items-center">
          <!-- Color -->
          <div class="col-md-4">
            <label class="form-label mb-0">Color</label>
            <input type="color" id="colorPicker" value="#000000" class="form-control form-control-color p-1">
          </div>
          <!-- Size -->
          <div class="col-md-5">
            <label class="form-label mb-0">Size (px)</label>
            <div class="d-flex align-items-center">
              <input type="range" id="sizeSlider" min="8" max="48" value="16" class="form-range flex-grow-1">
              <span id="sizeValue" class="ms-2 fw-bold">16</span>
            </div>
          </div>
          <!-- Bold -->
          <div class="col-md-3">
            <label class="form-label mb-0">Bold</label>
            <div class="form-check form-switch mt-1">
              <input class="form-check-input" type="checkbox" id="boldToggle">
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Actions -->
  <div class="d-flex flex-wrap gap-2 mb-3">
    <button id="previewBtn" class="btn btn-outline-primary" disabled>👁️ Preview Sample PDF</button>
    <button id="generateBtn" class="btn btn-outline-success" disabled>📦 Generate All & Download ZIP</button>
  </div>

  <div class="debug text-muted small" id="debugInfo">No field selected</div>
</div>

<!-- Direction Pad (Mobile) -->
<div id="directionPad">
  <button class="btn btn-success up">↑</button>
  <button class="btn btn-primary left">←</button>
  <button class="btn btn-primary right">→</button>
  <button class="btn btn-success down">↓</button>
  <button class="btn btn-danger del" style="grid-column:2; margin-top:6px;">🗑️</button>
</div>

<!-- Bootstrap 5 JS -->
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>

<script>
let participants = [];
let fields = [];
let templateUrl = "";
let selectedField = null;

const colorInput = document.getElementById('colorPicker');
const sizeSlider = document.getElementById('sizeSlider');
const sizeValue = document.getElementById('sizeValue');
const boldToggle = document.getElementById('boldToggle');
const fieldControls = document.getElementById('fieldControls');

document.getElementById("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("csv", file);
  const res = await fetch("/upload-csv", { method: "POST", body: formData });
  const data = await res.json();
  if (data.error) return alert(data.error);
  participants = data.participants;
  updateColumnsUI(data.columns);
  checkReady();
});

document.getElementById("templateFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("template", file);
  const res = await fetch("/upload-template", { method: "POST", body: formData });
  const data = await res.json();
  if (data.error) return alert(data.error);
  templateUrl = data.templateUrl;
  document.getElementById("template").style.backgroundImage = \`url(\${templateUrl})\`;
  checkReady();
});

function updateColumnsUI(columns) {
  const div = document.getElementById("columns");
  div.innerHTML = "";
  columns.forEach(col => {
    const btn = document.createElement("button");
    btn.textContent = col;
    btn.className = "btn btn-sm btn-outline-secondary";
    btn.onclick = () => addField(col);
    div.appendChild(btn);
  });
}

function addField(name) {
  const field = document.createElement("div");
  field.className = "field";
  field.innerHTML = \`\${name}<div class="coords">(50, 50)</div>\`;
  field.style.left = "50px";
  field.style.top = "50px";
  field.dataset.fieldName = name;
  field.style.fontSize = "16px";
  field.style.color = "#000000";
  field.style.fontWeight = "normal";

  field.addEventListener("click", (e) => {
    e.stopPropagation();
    if (selectedField) selectedField.classList.remove("selected");
    selectedField = field;
    field.classList.add("selected");
    updateFieldControls();
    updateDebug();
  });

  field.draggable = true;
  field.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", name);
    field.style.opacity = "0.7";
  });
  field.addEventListener("dragend", () => {
    field.style.opacity = "1";
  });

  // Mobile touch drag
  let touchStartX, touchStartY, elementStartX, elementStartY;
  field.addEventListener("touchstart", (e) => {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    elementStartX = parseInt(field.style.left) || 0;
    elementStartY = parseInt(field.style.top) || 0;
    field.style.transition = "none";
    if (!selectedField || selectedField !== field) {
      if (selectedField) selectedField.classList.remove("selected");
      selectedField = field;
      field.classList.add("selected");
      updateFieldControls();
      updateDebug();
    }
    e.preventDefault();
  });

  field.addEventListener("touchmove", (e) => {
    if (!selectedField || selectedField !== field) return;
    const touch = e.touches[0];
    let x = elementStartX + (touch.clientX - touchStartX);
    let y = elementStartY + (touch.clientY - touchStartY);
    x = Math.max(0, Math.min(590, x));
    y = Math.max(0, Math.min(390, y));
    field.style.left = x + 'px';
    field.style.top = y + 'px';
    field.querySelector('.coords').textContent = \`(\${Math.round(x)}, \${Math.round(y)})\`;
    const f = fields.find(f => f.field === name);
    if (f) { 
      f.x = x; 
      f.y = y; 
    }
    e.preventDefault();
  });

  field.addEventListener("touchend", () => {
    field.style.transition = "";
  });

  document.getElementById("template").appendChild(field);
  fields.push({
    field: name,
    x: 50,
    y: 50,
    size: 16,
    color: "#000000",
    bold: false,
    element: field
  });
  checkReady();
}

document.getElementById("template").addEventListener("click", (e) => {
  if (e.target === document.getElementById("template")) {
    if (selectedField) {
      selectedField.classList.remove("selected");
      selectedField = null;
      hideFieldControls();
      updateDebug();
    }
  }
});

document.getElementById("template").addEventListener("dragover", (e) => e.preventDefault());
document.getElementById("template").addEventListener("drop", (e) => {
  e.preventDefault();
  const fieldName = e.dataTransfer.getData("text/plain");
  const rect = document.getElementById("template").getBoundingClientRect();
  const x = Math.max(0, Math.min(590, e.clientX - rect.left));
  const y = Math.max(0, Math.min(390, e.clientY - rect.top));

  const fieldEl = document.querySelector(\`.field[data-field-name="\${fieldName}"]\`);
  if (fieldEl) {
    fieldEl.style.left = x + 'px';
    fieldEl.style.top = y + 'px';
    fieldEl.querySelector('.coords').textContent = \`(\${Math.round(x)}, \${Math.round(y)})\`;
    const f = fields.find(f => f.field === fieldName);
    if (f) { f.x = x; f.y = y; }
    if (fieldEl === selectedField) updateDebug();
  }
});

// Controls
colorInput.addEventListener('input', () => {
  if (!selectedField) return;
  const color = colorInput.value;
  selectedField.style.color = color;
  const f = fields.find(f => f.element === selectedField);
  if (f) f.color = color;
});

sizeSlider.addEventListener('input', () => {
  if (!selectedField) return;
  const size = sizeSlider.value;
  sizeValue.textContent = size;
  selectedField.style.fontSize = size + 'px';
  const f = fields.find(f => f.element === selectedField);
  if (f) f.size = parseInt(size);
});

boldToggle.addEventListener('change', () => {
  if (!selectedField) return;
  const isBold = boldToggle.checked;
  selectedField.style.fontWeight = isBold ? 'bold' : 'normal';
  const f = fields.find(f => f.element === selectedField);
  if (f) f.bold = isBold;
});

function updateFieldControls() {
  if (!selectedField) {
    hideFieldControls();
    return;
  }
  fieldControls.style.display = 'block';
  const f = fields.find(f => f.element === selectedField);
  if (f) {
    colorInput.value = f.color;
    sizeSlider.value = f.size;
    sizeValue.textContent = f.size;
    boldToggle.checked = f.bold;
  }
}

function hideFieldControls() {
  fieldControls.style.display = 'none';
}

// Arrow keys
document.addEventListener("keydown", (e) => {
  if (!selectedField) return;
  const step = e.shiftKey ? 10 : 1;
  let x = parseInt(selectedField.style.left) || 0;
  let y = parseInt(selectedField.style.top) || 0;

  switch(e.key) {
    case "ArrowLeft":  x = Math.max(0, x - step); break;
    case "ArrowRight": x = Math.min(590, x + step); break;
    case "ArrowUp":    y = Math.max(0, y - step); break;
    case "ArrowDown":  y = Math.min(390, y + step); break;
    case "Delete":
    case "Backspace":
      deleteSelectedField();
      return;
    default: return;
  }

  selectedField.style.left = x + 'px';
  selectedField.style.top = y + 'px';
  selectedField.querySelector('.coords').textContent = \`(\${x}, \${y})\`;
  const f = fields.find(f => f.element === selectedField);
  if (f) { f.x = x; f.y = y; }
  updateDebug();
  e.preventDefault();
});

// Direction pad
function createDirectionPad() {
  const pad = document.getElementById('directionPad');
  pad.querySelector('.up').onclick = () => simulateKey('ArrowUp');
  pad.querySelector('.down').onclick = () => simulateKey('ArrowDown');
  pad.querySelector('.left').onclick = () => simulateKey('ArrowLeft');
  pad.querySelector('.right').onclick = () => simulateKey('ArrowRight');
  pad.querySelector('.del').onclick = deleteSelectedField;
}

function simulateKey(key) {
  if (!selectedField) return;
  const event = new KeyboardEvent("keydown", { key });
  document.dispatchEvent(event);
}

function deleteSelectedField() {
  if (!selectedField) return;
  const fieldName = selectedField.dataset.fieldName;
  selectedField.remove();
  fields = fields.filter(f => f.field !== fieldName);
  selectedField = null;
  hideFieldControls();
  checkReady();
  document.getElementById("debugInfo").textContent = "Field deleted";
}

function updateDebug() {
  if (!selectedField) {
    document.getElementById("debugInfo").textContent = "No field selected";
    return;
  }
  const f = fields.find(f => f.element === selectedField);
  if (f) {
    document.getElementById("debugInfo").textContent = 
      \`Selected: \${f.field} | Pos: (\${f.x}, \${f.y}) | Size: \${f.size}px | Color: \${f.color} | Bold: \${f.bold ? 'Yes' : 'No'}\`;
  }
}

function checkReady() {
  const isReady = participants.length > 0 && templateUrl && fields.length > 0;
  document.getElementById("previewBtn").disabled = !isReady;
  document.getElementById("generateBtn").disabled = !isReady;
}

// Preview
document.getElementById("previewBtn").addEventListener("click", async () => {
  if (!participants.length) return;
  const sample = participants[0];
  const payload = {
    participant: sample,
    templateUrl,
    fields: fields.map(f => ({ 
      field: f.field, 
      x: f.x, 
      y: f.y,
      size: f.size,
      color: f.color,
      bold: f.bold
    }))
  };
  const res = await fetch("/preview-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return alert("Preview failed");
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  window.open(url, '_blank');
});

// Generate ZIP
document.getElementById("generateBtn").addEventListener("click", async () => {
  const payload = {
    participants,
    templateUrl,
    fields: fields.map(f => ({ 
      field: f.field, 
      x: f.x, 
      y: f.y,
      size: f.size,
      color: f.color,
      bold: f.bold
    }))
  };
  const res = await fetch("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return alert("Generation failed");
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "certificates_bulk.zip";
  a.click();
  window.URL.revokeObjectURL(url);
});

// Init
window.addEventListener("load", () => {
  createDirectionPad();
});
</script>
</body>
</html>
  `);
});

// --- Upload CSV (Cloud, No Local Files) ---
app.post('/upload-csv', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No file received" });
    }

    // Convert file buffer → string  
    const content = req.file.buffer.toString("utf8");

    // Split lines
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: "CSV too short" });
    }

    // Extract headers
    const headers = lines[0]
      .split(',')
      .map(h => h.trim().replace(/^"(.*)"$/, '$1'));

    // Parse rows
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
      participants
    });

  } catch (e) {
    console.error("CSV Parse Error:", e);
    return res.status(500).json({ error: "CSV parse failed" });
  }
});


app.post("/upload-template", upload.single("template"), (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No file" });

  // Store in memory for the session
  const templateBuffer = req.file.buffer;

  // Return a temporary URL for preview (base64)
  const base64 = templateBuffer.toString("base64");
  const mime = req.file.mimetype;
  const templateUrl = `data:${mime};base64,${base64}`;

  res.json({ templateUrl });
});


// --- PREVIEW: Generate ONE PDF ---
app.post('/preview-pdf', async (req, res) => {
  try {
    const { participant, templateUrl, fields } = req.body; 
    // templateUrl is now a base64 Data URL like "data:image/png;base64,..."

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 400]);

    if (templateUrl) {
      // Use Base64 from memory (templateUrl already Base64)
  const base64 = templateUrl.split(",")[1];
  const imageBytes = Buffer.from(base64, "base64");
  
  let img;
  if (templateUrl.includes("jpeg") || templateUrl.includes("jpg")) {
    img = await pdfDoc.embedJpg(imageBytes);
  } else if (templateUrl.includes("png")) {
    img = await pdfDoc.embedPng(imageBytes);
  }

  if (img) page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
    }

    fields.forEach(f => {
      const value = (participant[f.field] || "").toString();
      if (value) {
        const hex = f.color.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;

        page.drawText(value, {
          x: f.x,
          y: 400 - f.y - f.size,
          size: f.size,
          color: rgb(r, g, b),
          font: undefined
        });
      }
    });

    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=preview.pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Preview PDF Error:", err);
    res.status(500).json({ error: 'Preview failed' });
  }
});


// --- Generate ZIP ---
app.post('/generate', async (req, res) => {
  try {
    const { participants, templateUrl, fields } = req.body;

    // Create a zip archive in memory
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=certificates.zip');

    // Pipe archive directly to response (no local file)
    archive.pipe(res);

    // Get image bytes from base64 templateUrl
    let imageBytes;
    if (templateUrl) {
      const base64 = templateUrl.split(",")[1];
      imageBytes = Buffer.from(base64, "base64");
    }

    for (const p of participants) {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 400]);

      if (imageBytes) {
        let img;
        if (templateUrl.includes("jpeg") || templateUrl.includes("jpg")) {
          img = await pdfDoc.embedJpg(imageBytes);
        } else if (templateUrl.includes("png")) {
          img = await pdfDoc.embedPng(imageBytes);
        }
        if (img) page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
      }

      fields.forEach(f => {
        const value = (p[f.field] || "").toString();
        if (value) {
          const hex = f.color.replace('#', '');
          const r = parseInt(hex.substring(0, 2), 16) / 255;
          const g = parseInt(hex.substring(2, 4), 16) / 255;
          const b = parseInt(hex.substring(4, 6), 16) / 255;

          page.drawText(value, {
            x: f.x,
            y: 400 - f.y - f.size,
            size: f.size,
            color: rgb(r, g, b)
          });
        }
      });

      const pdfBytes = await pdfDoc.save();
      const name = (p.name || p.Name || 'certificate').replace(/[^a-z0-9_-]/gi, '_');
      archive.append(Buffer.from(pdfBytes), { name: `${name}.pdf` });
    }

    await archive.finalize();

  } catch (err) {
    console.error("ZIP Generation Error:", err);
    res.status(500).json({ error: 'Generation failed' });
  }
});

app.listen(port, () => {
  console.log(`✅ Precise Certificate Generator running at http://localhost:${port}`);
});

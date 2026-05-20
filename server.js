require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const stats = require("./stats");

const PORT = process.env.PORT || 3000;
const DEFAULT_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEFAULT_PROVIDER = "deepseek";
const STATIC = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ico": "image/x-icon",
};
const MAX_BODY = 50 * 1024 * 1024;

const PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o",
    headers(key) {
      return { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "http://localhost:3000", "X-Title": "FlashcardAI" };
    },
    vision: true,
  },
  openai: {
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
    headers(key) { return { "Content-Type": "application/json", Authorization: `Bearer ${key}` }; },
    vision: true,
  },
  groq: {
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "meta-llama/llama-4-maverick-17b-128e-instruct",
    headers(key) { return { "Content-Type": "application/json", Authorization: `Bearer ${key}` }; },
    vision: false,
  },
  qwen: {
    name: "Qwen (Alibaba)",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    headers(key) { return { "Content-Type": "application/json", Authorization: `Bearer ${key}` }; },
    vision: false,
  },
  zhipu: {
    name: "Zhipu (GLM)",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4",
    headers(key) { return { "Content-Type": "application/json", Authorization: `Bearer ${key}` }; },
    vision: false,
  },
  deepseek: {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    headers(key) { return { "Content-Type": "application/json", Authorization: `Bearer ${key}` }; },
    vision: false,
  },
  gemini: {
    name: "Google Gemini",
    endpoint: null,
    model: "gemini-2.0-flash",
    vision: true,
  },
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const type = STATIC[ext] || "application/octet-stream";
  try { res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache, no-store, must-revalidate" }); res.end(fs.readFileSync(filePath)); }
  catch { res.writeHead(404); res.end("Not found"); }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new Error("File too large")); } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function buildPrompt(notes, count, mode) {
  const isStem = mode === "stem";
  const intro = isStem
    ? `You are a flashcard generator for STEM subjects (math, physics, chemistry, engineering, CS). Create ${count} high-quality flashcards that test problem-solving.

Each card:
- "front": a specific problem, calculation, formula derivation, or concept-check question. Include numbers/formulas where relevant.
- "back": step-by-step solution with the final answer. Show reasoning, not just result.`
    : `You are a flashcard generator for humanities, arts, social sciences, and business. Create ${count} high-quality flashcards for concept memory and mental frameworks.

Each card:
- "front": a key concept, term, person, event, theory, or comparison prompt. Specific enough for a definite answer.
- "back": clear definition + context (why it matters) + connection to another concept or real-world example.`;

  return `${intro}

Return ONLY valid JSON array, no markdown, no explanation:
[{"front":"...","back":"..."},{"front":"...","back":"..."}]

Source material:
${notes}`;
}

function parseAIJson(raw) {
  let j = raw.trim();
  j = j.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(j);
}

async function callGeminiText(apiKey, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates[0].content.parts[0].text;
}

async function callGeminiVision(apiKey, base64, mime, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: base64 } }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 4096 } }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates[0].content.parts[0].text;
}

async function callOpenAICompat(pid, apiKey, messages, mt) {
  const p = PROVIDERS[pid];
  const r = await fetch(p.endpoint, {
    method: "POST", headers: p.headers(apiKey),
    body: JSON.stringify({ model: p.model, messages, temperature: 0.7, max_tokens: mt || 4096 }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d.choices[0].message.content;
}

async function handleGenerate(payload, res) {
  const { notes, count, apiKey, provider, mode, file, fileName, fileType } = payload;
  const key = apiKey || DEFAULT_API_KEY;
  const pid = provider || DEFAULT_PROVIDER;
  stats.trackGenStart();

  let success = false;
  try {
    if (!PROVIDERS[pid]) return fail(res, 400, `Unknown provider: ${pid}`);

    const prov = PROVIDERS[pid];
    const n = count || 5;
    const m = mode || "liberal_arts";
    let text = notes || "";

    // PDF
    if (file && fileType === "application/pdf") {
      try {
        const pd = await pdfParse(Buffer.from(file, "base64"));
        text = pd.text.trim();
        if (!text || text.length < 10) return fail(res, 400, "PDF appears empty or scanned (no extractable text).");
      } catch { return fail(res, 400, "Failed to parse PDF."); }
    }

    // Word .docx
    if (file && fileType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      try {
        const result = await mammoth.extractRawText({ buffer: Buffer.from(file, "base64") });
        text = result.value.trim();
        if (!text || text.length < 10) return fail(res, 400, "Word document appears to be empty.");
      } catch { return fail(res, 400, "Failed to parse Word document."); }
    }

    // Image
    if (file && fileType && fileType.startsWith("image/")) {
      if (!prov.vision) return fail(res, 400, `${prov.name} doesn't support images. Use OpenRouter, OpenAI, or Gemini.`);
      const ip = buildPrompt("(extracted from uploaded image)", n, m) + "\n\nCarefully read ALL text visible in the image, then generate flashcards.";

      let result;
      if (pid === "gemini") result = await callGeminiVision(key, file, fileType, ip);
      else result = await callOpenAICompat(pid, key, [{ role: "user", content: [{ type: "text", text: ip }, { type: "image_url", image_url: { url: `data:${fileType};base64,${file}` } }] }], 4096);

      const cards = parseAIJson(result);
      if (!Array.isArray(cards) || cards.length === 0) throw new Error("Could not generate flashcards from this image.");
      success = true;
      return ok(res, { flashcards: cards, extractedFrom: fileName || "image" });
    }

    // Text
    if (!text || text.trim().length < 10) return fail(res, 400, "Paste at least 10 characters or upload a file.");

    const prompt = buildPrompt(text, n, m);
    let result;
    if (pid === "gemini") result = await callGeminiText(key, prompt);
    else result = await callOpenAICompat(pid, key, [{ role: "system", content: "You are a precise JSON generator. Output only a valid JSON array, no markdown, no extra text." }, { role: "user", content: prompt }], 4096);

    const cards = parseAIJson(result);
    if (!Array.isArray(cards) || cards.length === 0) throw new Error("AI returned no flashcards. Try again.");

    success = true;
    return ok(res, { flashcards: cards, extractedFrom: (file && fileType === "application/pdf") ? (fileName || "PDF") : null });
  } finally {
    stats.trackGenEnd(pid, mode, fileType, success);
  }
}

function ok(res, data) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
function fail(res, code, msg) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: msg })); }

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/generate" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => "");
      const payload = JSON.parse(body || "{}");
      await handleGenerate(payload, res);
    } catch (e) {
      console.error("Request error:", e.message);
      if (!res.headersSent) fail(res, 500, e.message);
    }
    return;
  }
  if (req.url === "/api/providers" && req.method === "GET") {
    return ok(res, Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, model: p.model, vision: p.vision })));
  }
  if (req.url === "/api/stats" && req.method === "GET") {
    return ok(res, stats.snapshot());
  }

  // Track visits for main pages
  if (req.url === "/" || req.url === "/admin") {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    stats.trackVisit(ip);
  }

  if (req.url === "/admin") return serveFile(res, path.join(__dirname, "admin.html"));
  serveFile(res, path.join(__dirname, req.url === "/" ? "/index.html" : req.url));
});

server.listen(PORT, () => console.log(`✅ Flashcard AI: http://localhost:${PORT}  |  Providers: ${Object.keys(PROVIDERS).join(", ")}`));

process.on("uncaughtException", (err) => console.error("FATAL:", err.message));
process.on("unhandledRejection", (err) => console.error("REJECTION:", err.message));
process.stdin.resume(); // keep alive on Windows

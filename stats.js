const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SECRET_KEY || ""
);

let stats = {
  startedAt: Date.now(),
  visits: 0,
  sessions: new Set(),
  generations: { total: 0, success: 0, fail: 0 },
  files: { pdf: 0, docx: 0, image: 0 },
  providers: {},
  modes: { stem: 0, liberal_arts: 0 },
  totalGenTime: 0,
  daily: {},
};

// Load stats from Supabase on startup
async function loadStats() {
  try {
    const { data, error } = await supabase
      .from("app_stats")
      .select("data")
      .eq("id", "main")
      .single();
    if (error || !data) return;
    const loaded = data.data;
    stats = { ...stats, ...loaded, sessions: new Set(loaded._sessions || []) };
    stats.startedAt = Date.now();
  } catch {}
}

function today() { return new Date().toISOString().slice(0, 10); }

function ensureDay() {
  const d = today();
  if (!stats.daily[d]) stats.daily[d] = { visits: 0, gens: 0, files: 0, providers: {}, modes: {} };
  return stats.daily[d];
}

// --- Trackers ---
function trackVisit(sessionId) {
  stats.visits++;
  stats.sessions.add(sessionId);
  ensureDay().visits++;
}

let genStart = 0;
function trackGenStart() { genStart = performance.now(); }

function trackGenEnd(provider, mode, fileType, success) {
  stats.generations.total++;
  const day = ensureDay(); day.gens++;
  if (success) stats.generations.success++;
  else stats.generations.fail++;
  if (provider) { stats.providers[provider] = (stats.providers[provider] || 0) + 1; day.providers[provider] = (day.providers[provider] || 0) + 1; }
  if (mode) { stats.modes[mode] = (stats.modes[mode] || 0) + 1; day.modes[mode] = (day.modes[mode] || 0) + 1; }
  if (fileType) {
    day.files++;
    if (fileType === "application/pdf") stats.files.pdf++;
    else if (fileType.startsWith("image/")) stats.files.image++;
    else stats.files.docx++;
  }
  if (success && genStart > 0) {
    stats.totalGenTime += performance.now() - genStart;
  }
  genStart = 0;
  persist();
}

// --- Snapshot for admin ---
function snapshot() {
  const d = today();
  const totalGens = stats.generations.total || 1;
  return {
    startedAt: stats.startedAt,
    uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
    visits: stats.visits,
    activeSessions: stats.sessions.size,
    generations: stats.generations,
    avgGenTime: totalGens ? (stats.totalGenTime / totalGens / 1000).toFixed(2) + "s" : "N/A",
    successRate: totalGens ? Math.round(stats.generations.success / totalGens * 100) + "%" : "N/A",
    files: stats.files,
    providers: stats.providers,
    modes: stats.modes,
    today: stats.daily[d] || { visits: 0, gens: 0, files: 0, providers: {}, modes: {} },
    last7Days: Object.entries(stats.daily).slice(-7).map(([k, v]) => ({ date: k, ...v })),
  };
}

// --- Persist to Supabase ---
let timer = null;
async function persist() {
  try {
    const payload = { ...stats, _sessions: [...stats.sessions], sessions: undefined };
    await supabase.from("app_stats").upsert({ id: "main", data: payload, updated_at: new Date().toISOString() });
  } catch {}
}

// Save on every generation + every 30s for visits
setInterval(persist, 30_000);

// Save on shutdown
process.on("SIGTERM", async () => { await persist(); process.exit(0); });
process.on("SIGINT", async () => { await persist(); process.exit(0); });

// Save on shutdown
process.on("SIGTERM", async () => { await persist(); process.exit(0); });
process.on("SIGINT", async () => { await persist(); process.exit(0); });

module.exports = { loadStats, trackVisit, trackGenStart, trackGenEnd, snapshot };

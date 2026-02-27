import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WTJ_BASE = "https://wheresthejump.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const FETCH_TIMEOUT_MS = 12000;

function normalizeSpaces(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(id) };
}

function isValidWtjUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "wheresthejump.com";
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const { controller, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    if (!resp.ok) return { ok: false, status: resp.status, html: "" };
    return { ok: true, status: resp.status, html: await resp.text() };
  } finally {
    clear();
  }
}

function normalizeToHHMMSS(raw) {
  const parts = String(raw).trim().split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;

  let hh = 0,
    mm = 0,
    ss = 0;

  if (parts.length === 2) {
    mm = Number(parts[0]);
    ss = Number(parts[1]);
  } else {
    hh = Number(parts[0]);
    mm = Number(parts[1]);
    ss = Number(parts[2]);
  }

  if ([hh, mm, ss].some(Number.isNaN) || mm > 59 || ss > 59 || hh > 99) return null;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ---- Health ----
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", source: "wheresthejump" });
});

// ---- Search ----
// Returns: [{ title, url }]
app.get("/api/search", async (req, res) => {
  try {
    const q = normalizeSpaces(req.query.q);
    if (!q || q.length < 2) {
      return res.status(400).json({ error: "Missing or too-short query `q`." });
    }

    const url = `${WTJ_BASE}/?s=${encodeURIComponent(q)}`;
    const fetched = await fetchHtml(url);
    if (!fetched.ok) {
      return res.status(502).json({ error: `WTJ search failed: ${fetched.status}` });
    }

    const $ = cheerio.load(fetched.html);

    const results = [];
    const seen = new Set();

    // WTJ markup varies, so try multiple selectors then fall back to all links.
    const selectors = [
      "article .entry-title a",
      "h2.entry-title a",
      "h3.entry-title a",
      ".entry-title a",
      "article a",
      "a",
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const href = $(el).attr("href");
        const title = normalizeSpaces($(el).text());
        if (!href || !title) return;

        const full = href.startsWith("http") ? href : WTJ_BASE + href;

        // Keep only actual movie pages
        if (!full.includes("/jump-scares-in-")) return;
        if (!isValidWtjUrl(full)) return;

        // Remove obvious junk
        if (full.includes("/tag/") || full.includes("/category/") || full.includes("/?s=")) return;

        if (!seen.has(full)) {
          seen.add(full);
          results.push({ title, url: full });
        }
      });

      if (results.length >= 10) break;
    }

    res.json(results.slice(0, 10));
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "WTJ search timed out." : "Server error during search.",
    });
  }
});

// ---- Timestamps ----
// Returns: { url, title, timestamps: ["HH:MM:SS", ...] }
app.get("/api/timestamps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!isValidWtjUrl(url)) {
      return res.status(400).json({ error: "Invalid WTJ url." });
    }

    const fetched = await fetchHtml(url);
    if (!fetched.ok) {
      return res.status(502).json({ error: `WTJ page failed: ${fetched.status}` });
    }

    const $ = cheerio.load(fetched.html);

    const title =
      normalizeSpaces($("h1.entry-title").first().text()) ||
      normalizeSpaces($("title").text());

    const text = normalizeSpaces($(".entry-content").text() || $("body").text());
    const matches = text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g) || [];

    const out = [];
    const seen = new Set();

    for (const m of matches) {
      const t = normalizeToHHMMSS(m);
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }

    res.json({ url, title, timestamps: out });
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "WTJ timestamps timed out." : "Server error during timestamps.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`WTJ backend running on port ${PORT}`);
});

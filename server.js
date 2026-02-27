import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// --- NotScare config ---
const NOTSCARE_SITE = "https://notscare.me";
const NOTSCARE_SEARCH_API = `${NOTSCARE_SITE}/api/v1/search`;

// Optional: only needed if NotScare requires it for API search
// Set in Render env vars: NOTSCARE_API_KEY=xxxx
const NOTSCARE_API_KEY = process.env.NOTSCARE_API_KEY || "";

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

function isValidNotScareUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "notscare.me";
  } catch {
    return false;
  }
}

function isValidNotScareMovieUrl(url) {
  try {
    const u = new URL(url);
    if (!(u.protocol === "https:" && u.hostname === "notscare.me")) return false;
    return u.pathname.startsWith("/movies/");
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

function extractNotScareTimestampsFromText(text) {
  // NotScare pages show HH:MM:SS; we’ll accept H:MM:SS too.
  const matches = String(text || "").match(/\b(\d{1,2}:\d{2}:\d{2})\b/g) || [];
  const out = [];
  const seen = new Set();
  for (const m of matches) {
    const t = normalizeToHHMMSS(m);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// --- SEARCH ---
// Keeps same response shape as before: [{ title, url }]
app.get("/api/search", async (req, res) => {
  try {
    const q = normalizeSpaces(req.query.q);
    if (!q || q.length < 2) return res.status(400).json({ error: "Missing or too-short query `q`." });

    // Call NotScare API
    const apiUrl = `${NOTSCARE_SEARCH_API}?q=${encodeURIComponent(q)}&limit=10`;

    const headers = {
      "User-Agent": UA,
      Accept: "application/json",
    };
    if (NOTSCARE_API_KEY) headers["x-api-key"] = NOTSCARE_API_KEY;

    const { controller, clear } = withTimeout(FETCH_TIMEOUT_MS);
    let data;
    try {
      const resp = await fetch(apiUrl, { headers, signal: controller.signal });
      if (!resp.ok) {
        // If this happens and you expect search to work, set NOTSCARE_API_KEY in Render.
        return res.status(502).json({ error: `NotScare search failed: ${resp.status}` });
      }
      data = await resp.json();
    } finally {
      clear();
    }

    // Be flexible about response shape:
    // - { results: [...] }
    // - or [...]
    const rawResults = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];

    const results = [];
    const seen = new Set();

    for (const item of rawResults) {
      const titleBase = normalizeSpaces(item?.title || item?.name || "");
      if (!titleBase) continue;

      const year = item?.year ? String(item.year) : "";
      const title = year ? `${titleBase} (${year})` : titleBase;

      // If API includes a URL/slug, use it.
      let url = "";
      if (item?.url && typeof item.url === "string") url = item.url;
      else if (item?.slug && typeof item.slug === "string") url = `${NOTSCARE_SITE}/movies/${item.slug}`;

      // If API does NOT provide a usable URL, skip (client will show no results).
      if (!url || !isValidNotScareUrl(url)) continue;

      if (!seen.has(url)) {
        seen.add(url);
        results.push({ title, url });
      }
      if (results.length >= 10) break;
    }

    res.json(results.slice(0, 10));
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "NotScare search timed out." : "Server error during search.",
    });
  }
});

// --- TIMESTAMPS ---
// Keeps same response shape: { url, title, timestamps: [...] }
app.get("/api/timestamps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!isValidNotScareMovieUrl(url)) return res.status(400).json({ error: "Invalid NotScare movie url." });

    const fetched = await fetchHtml(url);
    if (!fetched.ok) return res.status(502).json({ error: `NotScare page failed: ${fetched.status}` });

    const $ = cheerio.load(fetched.html);

    // Title: try h1 first, then <title>
    const title =
      normalizeSpaces($("h1").first().text()) ||
      normalizeSpaces($("title").text());

    // Pull all visible text; timestamps appear in the page content.
    const text = normalizeSpaces($("body").text());
    const timestamps = extractNotScareTimestampsFromText(text);

    res.json({ url, title, timestamps });
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "NotScare timestamps timed out." : "Server error during timestamps.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`NotScare backend running on port ${PORT}`);
});

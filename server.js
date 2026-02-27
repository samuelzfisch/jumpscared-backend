import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const NOTSCARE_SITE = "https://notscare.me";
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

function pickTitleFromHref(href) {
  // /movies/jump-scares-in-insidious-2010 -> "jump scares in insidious 2010"
  try {
    const u = new URL(href, NOTSCARE_SITE);
    const slug = u.pathname.split("/").filter(Boolean).pop() || "";
    const cleaned = slug
      .replace(/-/g, " ")
      .replace(/\b(jump|scares|in)\b/gi, (m) => m.toLowerCase());
    return normalizeSpaces(cleaned);
  } catch {
    return "";
  }
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", source: "notscare" }));

/**
 * SEARCH (NO API KEY)
 * Scrapes the public NotScare movies results page:
 *   https://notscare.me/movies?q=<q>&search=<q>&page=1
 *
 * Returns: [{ title, url }]
 */
app.get("/api/search", async (req, res) => {
  try {
    const q = normalizeSpaces(req.query.q);
    if (!q || q.length < 2) return res.status(400).json({ error: "Missing or too-short query `q`." });

    const searchUrl =
      `${NOTSCARE_SITE}/movies?q=${encodeURIComponent(q)}&search=${encodeURIComponent(q)}&page=1`;

    const fetched = await fetchHtml(searchUrl);
    if (!fetched.ok) return res.status(502).json({ error: `NotScare search failed: ${fetched.status}` });

    const $ = cheerio.load(fetched.html);

    const results = [];
    const seen = new Set();

    // Prefer anchors that contain '/movies/' and are not just the search page itself.
    $("a[href^='/movies/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Skip the search listing itself
      if (href === "/movies" || href.startsWith("/movies?")) return;

      const full = `${NOTSCARE_SITE}${href}`;
      if (!isValidNotScareMovieUrl(full)) return;

      if (seen.has(full)) return;

      // Title text on these pages can be empty because the card is image-based.
      // If empty, derive from the slug.
      const textTitle = normalizeSpaces($(el).text());
      const title = textTitle || pickTitleFromHref(full);

      if (!title) return;

      seen.add(full);
      results.push({ title, url: full });
      if (results.length >= 10) return false; // break .each
    });

    res.json(results.slice(0, 10));
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "NotScare search timed out." : "Server error during search.",
    });
  }
});

/**
 * TIMESTAMPS
 * Expects a NotScare movie page URL: https://notscare.me/movies/...
 * Returns: { url, title, timestamps: ["HH:MM:SS", ...] }
 */
app.get("/api/timestamps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!isValidNotScareMovieUrl(url)) return res.status(400).json({ error: "Invalid NotScare movie url." });

    const fetched = await fetchHtml(url);
    if (!fetched.ok) return res.status(502).json({ error: `NotScare page failed: ${fetched.status}` });

    const $ = cheerio.load(fetched.html);

    const title =
      normalizeSpaces($("h1").first().text()) ||
      normalizeSpaces($("title").text());

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

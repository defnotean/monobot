// @ts-nocheck — checkJs noise: errors are implicit-any on untyped provider-
// response/config objects and cheerio scrape callbacks; the JSON shapes vary
// per search backend, so annotating each adds churn without catching real bugs.
import { safeFetch, validateUrl } from "../safeFetch.js";

const BRAVE_ANSWERS_URL = "https://api.search.brave.com/res/v1/chat/completions";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

// SearxNG URL is operator-supplied. Validate the template at first use and
// cache the verdict so a per-request URL injection (operator misconfig that
// somehow points at e.g. http://127.0.0.1) can't reach the network even
// before safeFetch's per-call DNS check.
const _searxngVerdict = new Map(); // template -> { ok: boolean, reason?: string }

function isSearxngTemplateSafe(template) {
  if (!template) return { ok: false, reason: "empty" };
  if (_searxngVerdict.has(template)) return _searxngVerdict.get(template);
  let verdict;
  try {
    // Substitute a benign query so the URL is well-formed for validation.
    const sample = template.replace("<query>", "ping");
    validateUrl(sample);
    verdict = { ok: true };
  } catch (e) {
    verdict = { ok: false, reason: e?.message || "invalid url" };
  }
  _searxngVerdict.set(template, verdict);
  return verdict;
}

function compact(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function timeoutFor(config, key, fallbackMs, ceilingMs) {
  const configured = Number(config?.[key]);
  const value = Number.isFinite(configured) && configured > 0 ? configured : fallbackMs;
  return Math.max(500, Math.min(value, ceilingMs));
}

function braveHeaders(apiKey, extra = {}) {
  return {
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "X-Subscription-Token": apiKey,
    ...extra,
  };
}

function stripBraveAnswerMarkup(text) {
  return String(text || "")
    .replace(/<usage>[\s\S]*?<\/usage>/gi, "")
    .replace(/<citation[^>]*>([\s\S]*?)<\/citation>/gi, (_tag, inner) => compact(inner))
    .replace(/<\/?(?:answer|research|summary|sources?|enum_item|brave_search)[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isUnhelpfulBraveAnswer(text) {
  const normalized = compact(text).toLowerCase();
  if (!normalized) return true;
  return [
    /provided (?:search )?results do not contain any information/,
    /provided context (?:does not|doesn't) (?:contain|mention)/,
    /no information (?:is )?available/,
    /no relevant (?:results|information|context)/,
    /could not find/,
    /couldn't find/,
    /cannot provide (?:a )?(?:relevant )?answer/,
  ].some((pattern) => pattern.test(normalized));
}

export function formatBraveAnswerPayload(json) {
  const message = json?.choices?.[0]?.message;
  const content = Array.isArray(message?.content)
    ? message.content.map((part) => part?.text || part?.content || "").join("")
    : message?.content;
  const text = stripBraveAnswerMarkup(content || json?.answer || json?.content || json?.summary || "");
  if (isUnhelpfulBraveAnswer(text)) return "";
  return text ? `Brave Answers:\n${text}` : "";
}

export function formatBraveSearchPayload(json) {
  const candidates = [
    ...(json?.web?.results || []),
    ...(json?.news?.results || []),
    ...(json?.videos?.results || []),
    ...(json?.discussions?.results || []),
    ...(json?.faq?.results || []),
  ];
  const results = candidates.slice(0, 5).map((r, i) => {
    const snippets = [r.description, ...(Array.isArray(r.extra_snippets) ? r.extra_snippets : [])]
      .map(compact)
      .filter(Boolean);
    const title = compact(r.title || r.profile?.name || r.url || "Result");
    const url = compact(r.url || r.profile?.url || r.meta_url?.url || "");
    const snippetBlock = snippets.length ? `\n   ${snippets.join("\n   ")}` : "";
    const urlBlock = url ? `\n   ${url}` : "";
    return `${i + 1}. ${title}${snippetBlock}${urlBlock}`;
  }).filter((entry) => entry.trim());
  return results.length ? results.join("\n\n") : "";
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function performWebSearch(query, config = {}, timeoutMs = 10000) {
  // 1. Brave Answers API: direct web-grounded answer for Discord-style Q&A.
  if (config.braveAnswersApiKey) {
    try {
      const res = await safeFetch(BRAVE_ANSWERS_URL, {
        method: "POST",
        headers: braveHeaders(config.braveAnswersApiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          model: config.braveAnswersModel || "brave",
          messages: [{
            role: "user",
            content: `Answer this web search query concisely and include source URLs when useful:\n\n${query}`,
          }],
          max_tokens: 1024,
          stream: false,
        }),
        timeoutMs: timeoutFor(config, "braveAnswersTimeoutMs", 5000, timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        const json = safeJsonParse(res.text);
        const formatted = formatBraveAnswerPayload(json);
        if (formatted) return formatted;
      }
    } catch (e) {
      // fallback
    }
  }

  // 2. Brave Search API. extra_snippets needs Brave Search Pro but is ignored
  // by lower tiers, so it is safe to request whenever a Brave key is present.
  if (config.braveSearchApiKey) {
    try {
      const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=5&text_decorations=false&extra_snippets=true`;
      const res = await safeFetch(url, {
        headers: braveHeaders(config.braveSearchApiKey),
        timeoutMs: timeoutFor(config, "braveSearchTimeoutMs", 3500, timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        const json = safeJsonParse(res.text);
        const formatted = formatBraveSearchPayload(json);
        if (formatted) return formatted;
      }
    } catch (e) {
      // fallback
    }
  }

  // 3. SearxNG — operator-supplied URL. Validated once at first use; reject
  // here if the template points at a private host so we never even DNS-look-up.
  if (config.searxngQueryUrl) {
    const verdict = isSearxngTemplateSafe(config.searxngQueryUrl);
    if (verdict.ok) {
      try {
        const url = config.searxngQueryUrl.replace("<query>", encodeURIComponent(query));
        const res = await safeFetch(url, {
          timeoutMs: timeoutFor(config, "backendTimeoutMs", 5000, timeoutMs),
        });
        if (res.status >= 200 && res.status < 300) {
          const json = safeJsonParse(res.text);
          const results = (json?.results || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.content || r.snippet}\n   ${r.url}`);
          if (results.length) return results.join("\n\n");
        }
      } catch (e) {
        // fallback
      }
    }
  }

  // 4. Tavily
  if (config.tavilyApiKey) {
    try {
      const res = await safeFetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: config.tavilyApiKey, query, max_results: 5 }),
        timeoutMs: timeoutFor(config, "backendTimeoutMs", 5000, timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        const json = safeJsonParse(res.text);
        const results = (json?.results || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.content}\n   ${r.url}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 5. Serper API
  if (config.serperApiKey) {
    try {
      const res = await safeFetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": config.serperApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num: 5 }),
        timeoutMs: timeoutFor(config, "backendTimeoutMs", 5000, timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        const json = safeJsonParse(res.text);
        const results = (json?.organic || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.link}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 6. Google Custom Search
  if (config.googleSearchKey && config.googleSearchCx) {
    try {
      const res = await safeFetch(`https://www.googleapis.com/customsearch/v1?key=${config.googleSearchKey}&cx=${config.googleSearchCx}&q=${encodeURIComponent(query)}&num=5`, {
        timeoutMs: timeoutFor(config, "backendTimeoutMs", 5000, timeoutMs),
      });
      if (res.status >= 200 && res.status < 300) {
        const json = safeJsonParse(res.text);
        const results = (json?.items || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.link}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 7. DuckDuckGo Lite POST (Built-in Final Fallback)
  try {
    const body = `q=${encodeURIComponent(query)}`;
    const res = await safeFetch(`https://lite.duckduckgo.com/lite/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: body,
      timeoutMs: timeoutFor(config, "ddgTimeoutMs", 5000, timeoutMs),
    });

    if (!(res.status >= 200 && res.status < 300)) throw new Error(`HTTP ${res.status}`);
    const html = res.text;
    const cheerio = await import("cheerio");
    const $ = cheerio.load(html);
    const results = [];
    $("tr").each((i, el) => {
      if (results.length >= 5) return false;
      const snippetEl = $(el).find(".result-snippet");
      if (snippetEl.length) {
        const snippet = snippetEl.text().trim();
        const titleEl = $(el).prevAll("tr").find("a.result-link, a.result-title, .result-title a").first();
        const title = titleEl.text().trim();
        const href = titleEl.attr("href") || "";
        const titleLine = title || "DuckDuckGo result";
        const hrefLine = href ? `\n   ${href}` : "";
        results.push(`${results.length + 1}. ${titleLine}\n   ${snippet}${hrefLine}`);
      }
    });
    return results.length ? results.join("\n\n") : "no results found";
  } catch (e) {
    throw new Error(`search failed: ${e.message}`);
  }
}

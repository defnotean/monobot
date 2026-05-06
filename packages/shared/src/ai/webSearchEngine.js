export async function performWebSearch(query, config = {}, timeoutMs = 10000) {
  // 1. SearxNG
  if (config.searxngQueryUrl) {
    try {
      const url = config.searxngQueryUrl.replace("<query>", encodeURIComponent(query));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = await res.json();
        const results = (json.results || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.content || r.snippet}\n   ${r.url}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 2. Tavily
  if (config.tavilyApiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: config.tavilyApiKey, query, max_results: 5 }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = await res.json();
        const results = (json.results || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.content}\n   ${r.url}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 3. Brave Search API
  if (config.braveSearchApiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&extra_snippets=true`, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": config.braveSearchApiKey
        },
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = await res.json();
        const results = (json.web?.results || []).slice(0, 5).map((r, i) => {
          let snips = [r.description];
          if (r.extra_snippets && r.extra_snippets.length > 0) {
            snips.push(...r.extra_snippets);
          }
          return `${i + 1}. ${r.title}\n   ${snips.join("\n   ")}\n   ${r.url}`;
        });
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 4. Serper API
  if (config.serperApiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": config.serperApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, num: 5 }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = await res.json();
        const results = (json.organic || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.link}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 5. Google Custom Search
  if (config.googleSearchKey && config.googleSearchCx) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${config.googleSearchKey}&cx=${config.googleSearchCx}&q=${encodeURIComponent(query)}&num=5`, {
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = await res.json();
        const results = (json.items || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.link}`);
        if (results.length) return results.join("\n\n");
      }
    } catch (e) {
      // fallback
    }
  }

  // 6. DuckDuckGo Lite POST (Built-in Final Fallback)
  try {
    const body = `q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`https://lite.duckduckgo.com/lite/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Content-Length": Buffer.byteLength(body).toString()
      },
      body: body,
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const cheerio = await import("cheerio");
    const $ = cheerio.load(html);
    const results = [];
    $("tr").each((i, el) => {
      if (results.length >= 5) return false;
      const snippetEl = $(el).find(".result-snippet");
      if (snippetEl.length) {
        const snippet = snippetEl.text().trim();
        const titleEl = $(el).prev("tr").find(".result-title");
        const title = titleEl.text().trim();
        const href = titleEl.attr("href") || "";
        results.push(`${results.length + 1}. ${title}\n   ${snippet}\n   ${href}`);
      }
    });
    return results.length ? results.join("\n\n") : "no results found";
  } catch (e) {
    throw new Error(`search failed: ${e.message}`);
  }
}

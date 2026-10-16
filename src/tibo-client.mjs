const DEFAULT_BASE_URL = "https://codex-reset.com";

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CodexPulse/0.8.1 (+https://github.com/CJaxonJ/codex-pulse)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class TiboResetClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs || 10_000;
  }

  async readSnapshot() {
    const [forecast, feed] = await Promise.all([
      fetchJson(`${this.baseUrl}/api/forecast`, this.timeoutMs),
      fetchJson(`${this.baseUrl}/api/feed`, this.timeoutMs),
    ]);
    return { forecast, feed };
  }
}

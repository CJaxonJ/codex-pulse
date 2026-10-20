import { readXBearerToken } from "./tibo-credentials.mjs";
import { TiboXApiClient } from "./tibo-x-api-client.mjs";

const LEGACY_BASE_URL = "https://codex-reset.com";

async function fetchJson(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CodexPulse/0.9.3 (+https://github.com/CJaxonJ/codex-pulse)",
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

export class CodexResetClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || LEGACY_BASE_URL;
    this.timeoutMs = options.timeoutMs || 10_000;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async readSnapshot() {
    const [forecastResult, feedResult] = await Promise.allSettled([
      fetchJson(`${this.baseUrl}/api/forecast`, this.timeoutMs, this.fetchImpl),
      fetchJson(`${this.baseUrl}/api/feed`, this.timeoutMs, this.fetchImpl),
    ]);
    if (feedResult.status === "rejected") throw feedResult.reason;
    return {
      source: "codex-reset",
      forecast: forecastResult.status === "fulfilled" ? forecastResult.value : {},
      feed: feedResult.value,
      degradedComponents:
        forecastResult.status === "rejected" ? ["forecast"] : [],
    };
  }
}

export class TiboResetClient {
  constructor(options = {}) {
    this.staticSource = options.source || process.env.CODEX_PULSE_TIBO_SOURCE || "auto";
    this.sourceProvider = options.sourceProvider || null;
    this.tokenProvider = options.tokenProvider || readXBearerToken;
    this.fetchImpl = options.fetchImpl || fetch;
    this.xApiBaseUrl = options.xApiBaseUrl;
    this.legacyBaseUrl = options.legacyBaseUrl;
    this.timeoutMs = options.timeoutMs || 10_000;
    this.delegate = null;
    this.delegateSource = null;
    this.delegateToken = null;
  }

  async selectedSource() {
    return this.sourceProvider ? await this.sourceProvider() : this.staticSource;
  }

  async resolveDelegate() {
    let source = await this.selectedSource();
    if (!source || source === "auto") {
      source = "codex-reset";
    }
    if (source === "disabled") {
      this.delegate = null;
      this.delegateSource = source;
      this.delegateToken = null;
      return null;
    }
    if (source === "x-api") {
      const token = await this.tokenProvider();
      if (!token) {
        throw new Error(
          "X API source is enabled but no bearer token is configured; run `codex-pulse tibo-source --configure-x`.",
        );
      }
      if (
        this.delegateSource === source &&
        this.delegateToken === token &&
        this.delegate
      ) {
        return this.delegate;
      }
      this.delegate = new TiboXApiClient({
        bearerToken: token,
        baseUrl: this.xApiBaseUrl,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
      });
      this.delegateSource = source;
      this.delegateToken = token;
      return this.delegate;
    }
    if (source === "codex-reset") {
      if (this.delegateSource === source && this.delegate) return this.delegate;
      this.delegate = new CodexResetClient({
        baseUrl: this.legacyBaseUrl,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      this.delegateSource = source;
      this.delegateToken = null;
      return this.delegate;
    }
    throw new Error(`Unsupported Tibo source: ${source}`);
  }

  async readSnapshot(options = {}) {
    const delegate = await this.resolveDelegate();
    return delegate ? delegate.readSnapshot(options) : null;
  }
}

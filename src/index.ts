/**
 * @veilgate/client — browser SDK
 *
 * Two-liner usage:
 *   await VeilGate.init();
 *   VeilGate.handleAll();
 *
 * Or with npm:
 *   import { init, handleAll } from "@veilgate/client";
 *   await init();
 *   handleAll();
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VeilGateOptions {
  /**
   * Base URL of the VeilGate-protected server.
   * Use when the API lives on a different origin than the SPA.
   * Example: "https://api.example.com"
   * Defaults to "" (same origin).
   */
  baseURL?: string;

  /** sessionStorage key for the cached token. Default: "vg_token" */
  storageKey?: string;

  /**
   * Called whenever a challenge iframe is opened. Use to show a
   * "verifying…" overlay in your UI.
   */
  onChallenge?: () => void;

  /**
   * Called when a token is successfully obtained (either from storage
   * or a fresh solve). Useful for logging or custom token propagation.
   */
  onToken?: (token: string, header: string) => void;

  /**
   * Defensive agent-decoy material for SPA/bundle-mining scanners.
   *
   * When enabled the SDK injects a runtime-randomized metadata block into
   * the DOM and exposes a non-enumerable window hint. Browser users never
   * see it, but agents that scrape DOM/source/bundle content discover
   * realistic endpoint breadcrumbs that route to VeilGate's tarpit.
   *
   * Paths are sourced from the /__veilgate/.well-known tarpit block first
   * (set by the proxy operator) so every breadcrumb maps to a path the
   * server is actively tarpitting. Falls back to built-in defaults when
   * the server hasn't configured decoy_paths.
   *
   * Set false to disable. Default: true.
   */
  agentDecoys?: boolean | AgentDecoyOptions;
}

export interface AgentDecoyOptions {
  /** Enable/disable all decoys. Default: true. */
  enabled?: boolean;

  /** Prefix for bait API paths injected into the manifest. Default: "/api". */
  apiBase?: string;

  /** How many endpoint hints to expose per page load. Default: 5. */
  endpointCount?: number;

  /** DOM id prefix for injected script/meta tags. Random suffix appended per load. */
  elementPrefix?: string;

  /**
   * Override the endpoint pool entirely. When omitted the SDK uses the
   * server-provided tarpit paths from .well-known, or the built-in pool.
   */
  endpoints?: string[];
}

export interface TarpitPathEntry {
  path: string;
  /** Human-readable service label set by the proxy operator, e.g. "vault", "stripe". */
  service?: string;
}

export interface DiscoveryDoc {
  challenge?: {
    verify_path: string;
    start_path?: string;
    token_header: string;
    cookie_name: string;
  };
  credentials?: Array<{
    type: string;
    header?: string;
    scheme?: string;
    name?: string;
    validator?: string;
  }>;
  /**
   * Bait endpoints the proxy is actively tarpitting. When present the SDK
   * uses these paths as DOM decoys so every agent breadcrumb routes to a
   * realistic tarpit response rather than a real 404.
   */
  tarpit?: {
    paths: TarpitPathEntry[];
  };
}

export interface StoredToken {
  value: string;
  header: string;
  /** Epoch milliseconds at which the token expires. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DISCOVERY_PATH = "/__veilgate/.well-known";
const DEFAULT_STORAGE_KEY = "vg_token";
// Renew the token when less than 60 s remain, not at the last moment.
const RENEW_BEFORE_MS = 60_000;

let _opts: Required<VeilGateOptions> = {
  baseURL: "",
  storageKey: DEFAULT_STORAGE_KEY,
  onChallenge: () => undefined,
  onToken: () => undefined,
  agentDecoys: true,
};

let _discovery: DiscoveryDoc | null = null;
let _discoveryPromise: Promise<DiscoveryDoc | null> | null = null;

// Coalescing: multiple concurrent 401s share a single solve.
let _solvePromise: Promise<StoredToken> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the /__veilgate/.well-known discovery document and warm up the
 * internal state. Call once during application start-up.
 *
 * Safe to call multiple times; subsequent calls are no-ops unless the
 * previous call failed.
 */
export async function init(opts?: VeilGateOptions): Promise<void> {
  _mergeOpts(opts);
  _discovery = await _ensureDiscovery();
  _installAgentDecoys();
}

/**
 * Patch the global fetch and XMLHttpRequest so every request:
 *   1. Automatically attaches a valid challenge token when one is cached.
 *   2. On a 401 challenge response, solves the PoW challenge via a hidden
 *      iframe and retries the original request transparently.
 *
 * Call once. Calling again is safe but redundant.
 */
export function handleAll(opts?: VeilGateOptions): void {
  _mergeOpts(opts);
  _patchFetch();
  _patchXHR();
  _installAgentDecoys();
}

/**
 * Returns a valid token, either from the session cache or by solving a
 * fresh challenge. Use this as an escape hatch when you need the raw
 * token value (e.g. to attach it to a non-standard request).
 */
export async function getToken(): Promise<StoredToken> {
  const stored = _loadToken();
  if (stored && stored.expiresAt > Date.now() + RENEW_BEFORE_MS) {
    return stored;
  }
  return _solve();
}

/**
 * Returns the cached discovery document fetched by init(), or null if
 * init() has not been called yet.
 */
export function getDiscovery(): DiscoveryDoc | null {
  return _discovery;
}

/**
 * Enable, disable, or reconfigure agent decoys at runtime.
 *
 * - `updateDecoys(false)` — remove injected DOM elements and disable decoys.
 *   Subsequent calls to init() / handleAll() will not re-inject.
 * - `updateDecoys(true)` — re-enable and (re-)inject decoys immediately.
 * - `updateDecoys({ endpointCount: 8, endpoints: [...] })` — merge new options,
 *   tear down the current DOM elements, and re-inject with the new config.
 *
 * This is safe to call at any time — before or after init() / handleAll().
 *
 * ```ts
 * // Kill the decoys for this session (e.g. authenticated admin user).
 * updateDecoys(false);
 *
 * // Swap in a custom endpoint list at runtime.
 * updateDecoys({ endpoints: ["/internal/rpc", "/v1/secret/data/prod"] });
 * ```
 */
export function updateDecoys(optsOrEnabled: boolean | Partial<AgentDecoyOptions>): void {
  if (optsOrEnabled === false) {
    // Disable: remove DOM elements and update opts so future installs skip.
    _removeAgentDecoys();
    _opts = { ..._opts, agentDecoys: false };
    return;
  }

  if (optsOrEnabled === true) {
    // Re-enable with existing config.
    const current = _opts.agentDecoys;
    _opts = {
      ..._opts,
      agentDecoys: typeof current === "object" ? { ...current, enabled: true } : true,
    };
    _installAgentDecoys();
    return;
  }

  // Partial options: merge, tear down, and reinstall.
  const current = typeof _opts.agentDecoys === "object" && _opts.agentDecoys !== null
    ? _opts.agentDecoys
    : {};
  _opts = { ..._opts, agentDecoys: { ...current, ...optsOrEnabled } };
  _removeAgentDecoys();
  _installAgentDecoys();
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export function _loadToken(): StoredToken | null {
  try {
    const raw = (typeof sessionStorage !== "undefined"
      ? sessionStorage
      : _memStorage).getItem(_opts.storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

export function _saveToken(t: StoredToken): void {
  try {
    (typeof sessionStorage !== "undefined"
      ? sessionStorage
      : _memStorage).setItem(_opts.storageKey, JSON.stringify(t));
  } catch {
    // sessionStorage unavailable — token lives in _memStorage fallback.
  }
}

export function _clearToken(): void {
  try {
    (typeof sessionStorage !== "undefined"
      ? sessionStorage
      : _memStorage).removeItem(_opts.storageKey);
  } catch {}
}

// In-memory fallback for environments where sessionStorage is unavailable
// (e.g. iOS Safari private browsing, some embedded WebViews).
const _memStorage: Storage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
})();

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// Returns the un-intercepted fetch. Before handleAll() is called this is
// just window.fetch (which may be a test mock). After handleAll() it is
// the pre-patch reference captured inside _patchFetch, bypassing the
// interceptor so discovery never triggers a recursive challenge solve.
function _baseFetch(): typeof fetch {
  return _prePatchFetch ?? (typeof window !== "undefined" ? window.fetch.bind(window) : fetch);
}

async function _fetchDiscovery(): Promise<DiscoveryDoc | null> {
  if (_discoveryPromise) return _discoveryPromise;
  _discoveryPromise = (async () => {
    try {
      const url = _opts.baseURL + DISCOVERY_PATH;
      const resp = await _baseFetch()(url, { credentials: "omit" });
      if (!resp.ok) return null;
      return await resp.json() as DiscoveryDoc;
    } catch {
      return null;
    } finally {
      // Allow a retry if the request failed.
      if (_discovery === null) _discoveryPromise = null;
    }
  })();
  return _discoveryPromise;
}

async function _ensureDiscovery(): Promise<DiscoveryDoc | null> {
  if (_discovery) return _discovery;
  _discovery = await _fetchDiscovery();
  return _discovery;
}

// ---------------------------------------------------------------------------
// Challenge solve
// ---------------------------------------------------------------------------

export function _solve(): Promise<StoredToken> {
  if (_solvePromise) return _solvePromise;
  _solvePromise = (async () => {
    try {
      const doc = await _ensureDiscovery();
      if (!doc?.challenge) {
        throw new Error("veilgate: discovery missing challenge config; call init() first");
      }
      const startPath = doc.challenge.start_path ?? "/__veilgate/start";
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const src =
        _opts.baseURL + startPath + "?origin=" + encodeURIComponent(origin);
      _opts.onChallenge();
      const token = await _internal.iframeLoader(src, doc.challenge.token_header);
      _saveToken(token);
      _opts.onToken(token.value, token.header);
      return token;
    } finally {
      _solvePromise = null;
    }
  })();
  return _solvePromise;
}

// _internal holds mutable state that tests can replace without fighting
// ES module read-only binding restrictions.
export const _internal = {
  /** Replaceable in tests to stub the iframe challenge flow. */
  iframeLoader: _defaultIframeLoader as (
    src: string,
    fallbackHeader: string,
  ) => Promise<StoredToken>,
};

function _defaultIframeLoader(
  src: string,
  fallbackHeader: string,
): Promise<StoredToken> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.src = src;
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none";

    const expectedOrigin = (() => {
      try {
        return new URL(src, window.location.href).origin;
      } catch {
        return window.location.origin;
      }
    })();

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("veilgate: challenge iframe timed out after 30s"));
    }, 30_000);

    function onMessage(evt: MessageEvent) {
      if (evt.origin !== expectedOrigin) return;
      const d = evt.data as Record<string, unknown>;
      if (!d || typeof d !== "object") return;
      if (d["type"] === "veilgate-token") {
        cleanup();
        resolve({
          value: d["token"] as string,
          header: (d["header"] as string) || fallbackHeader,
          expiresAt:
            Date.now() + (((d["expires_in"] as number) || 1800) * 1000),
        });
      } else if (d["type"] === "veilgate-error") {
        cleanup();
        reject(
          new Error(
            "veilgate: challenge failed — " + String(d["reason"] ?? "unknown"),
          ),
        );
      }
    }

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    }

    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
  });
}

// ---------------------------------------------------------------------------
// fetch interceptor
// ---------------------------------------------------------------------------

// Captured inside _patchFetch so _baseFetch() can bypass the interceptor.
let _prePatchFetch: typeof fetch | null = null;

let _fetchPatched = false;

function _patchFetch(): void {
  if (_fetchPatched || typeof window === "undefined") return;
  _fetchPatched = true;
  _prePatchFetch = window.fetch.bind(window);
  const raw = _prePatchFetch;

  window.fetch = async function vgFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Attach cached token before sending.
    init = _attachToken(init);

    let resp = await raw(input, init);

    // On 401 with a VeilGate challenge body, solve and retry once.
    if (resp.status === 401) {
      const ct = resp.headers.get("Content-Type") ?? "";
      if (ct.includes("application/json")) {
        let body: { error?: string } | null = null;
        try {
          body = await resp.clone().json();
        } catch { /* ignore */ }
        if (body?.error === "challenge_required") {
          _clearToken();
          const token = await _solve();
          init = _attachSpecific(init, token);
          resp = await raw(input, init);
        }
      }
    }

    return resp;
  };
}

function _attachToken(init?: RequestInit): RequestInit {
  const stored = _loadToken();
  if (!stored || stored.expiresAt <= Date.now()) return init ?? {};
  const headers = new Headers((init ?? {}).headers);
  if (!headers.has(stored.header)) {
    headers.set(stored.header, stored.value);
  }
  return { ...(init ?? {}), headers };
}

function _attachSpecific(init: RequestInit | undefined, token: StoredToken): RequestInit {
  const headers = new Headers((init ?? {}).headers);
  headers.set(token.header, token.value);
  return { ...(init ?? {}), headers };
}

// ---------------------------------------------------------------------------
// XMLHttpRequest interceptor
// ---------------------------------------------------------------------------

interface VGXHRState {
  _vg_method: string;
  _vg_url: string;
  _vg_openArgs: unknown[];
  _vg_body: Document | XMLHttpRequestBodyInit | null | undefined;
}

let _xhrPatched = false;

function _patchXHR(): void {
  if (_xhrPatched || typeof XMLHttpRequest === "undefined") return;
  _xhrPatched = true;

  const proto = XMLHttpRequest.prototype as XMLHttpRequest & VGXHRState;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const origOpen = proto.open;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const origSend = proto.send;

  (proto as unknown as { open: unknown }).open = function vgOpen(
    this: XMLHttpRequest & VGXHRState,
    ...args: Parameters<XMLHttpRequest["open"]>
  ) {
    this._vg_method = args[0];
    this._vg_url = args[1] as string;
    this._vg_openArgs = args;
    return (origOpen as Function).apply(this, args);
  };

  (proto as unknown as { send: unknown }).send = function vgSend(
    this: XMLHttpRequest & VGXHRState,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    this._vg_body = body;

    // Attach cached token as a request header.
    const stored = _loadToken();
    if (stored && stored.expiresAt > Date.now()) {
      try {
        this.setRequestHeader(stored.header, stored.value);
      } catch { /* already sent or open not called — ignore */ }
    }

    this.addEventListener("load", function (this: XMLHttpRequest & VGXHRState) {
      if (this.status !== 401) return;
      const ct = this.getResponseHeader("Content-Type") ?? "";
      if (!ct.includes("application/json")) return;
      let parsed: { error?: string } | null = null;
      try {
        parsed = JSON.parse(this.responseText);
      } catch { return; }
      if (parsed?.error !== "challenge_required") return;

      _clearToken();
      const origXhr = this;
      _solve().then((token) => {
        // Replay the request with the new token.
        const next = new XMLHttpRequest();
        (origOpen as Function).apply(next, origXhr._vg_openArgs);
        next.setRequestHeader(token.header, token.value);
        // Best-effort handler copy.
        if (origXhr.onload) next.onload = origXhr.onload;
        if (origXhr.onerror) next.onerror = origXhr.onerror;
        if (origXhr.onreadystatechange) {
          next.onreadystatechange = origXhr.onreadystatechange;
        }
        (origSend as Function).call(next, origXhr._vg_body);
      }).catch(() => {
        // Challenge failed; leave original 401 in place.
      });
    });

    return (origSend as Function).call(this, body);
  };
}

// ---------------------------------------------------------------------------
// Agent decoys
// ---------------------------------------------------------------------------
//
// Agents that mine SPA bundles or the live DOM look for API paths, tokens,
// and credentials. We inject a runtime-randomized manifest that surfaces
// realistic-looking breadcrumbs. Each breadcrumb maps to a path the proxy
// is actively tarpitting (from /__veilgate/.well-known tarpit.paths), so
// agents that follow the trail receive a convincing fake response while
// burning time in the tarpit instead of probing real endpoints.

interface AgentDecoyManifest {
  build: string;
  apiBase: string;
  endpoints: string[];
  openapi: string;
  debugPanel: string;
  adminToken: string;
  session: string;
}

let _decoysInstalled = false;
// Suffix used for the last install — needed to remove injected elements.
let _decoyElementSuffix: string | null = null;

// Broad pool of realistic bait paths across many service categories.
// The SDK picks a random subset per page load; the proxy operator can
// replace this entirely via decoy_paths in veilgate.yaml.
const DEFAULT_DECOY_ENDPOINTS: string[] = [
  // SSRF / cloud-metadata
  "/api/v1/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "/api/proxy?target=http://169.254.169.254/latest/user-data",
  "/api/v1/ssrf-check?endpoint=http://metadata.google.internal/computeMetadata/v1/",
  // Secrets and config files
  "/.env.local",
  "/.env.production",
  "/config/secrets.yml",
  "/config/master.key",
  "/app/config/database.yml",
  // Git / VCS
  "/.git/config",
  "/.git/HEAD",
  "/.github/workflows/deploy.yml",
  // Admin / debug panels
  "/api/internal/debug",
  "/api/internal/rpc",
  "/api/internal/profiler",
  "/prisma-studio",
  "/graphql?explorer=1",
  "/graphiql",
  "/telescope",
  "/horizon",
  "/django/admin/login/",
  "/rails/info/properties",
  // OpenAPI / API docs
  "/api/docs/openapi.json",
  "/swagger-ui.html",
  "/swagger.json",
  "/api-docs",
  // Spring Boot Actuator
  "/actuator/env",
  "/actuator/heapdump",
  "/actuator/mappings",
  "/actuator/loggers",
  // HashiCorp Vault / Consul
  "/v1/secret/data/prod",
  "/v1/auth/token/lookup-self",
  "/v1/sys/mounts",
  "/consul/v1/kv/?recurse=true",
  // Kubernetes-style
  "/api/v1/secrets",
  "/api/v1/pods",
  // Database / search
  "/_cat/indices?v",
  "/_nodes/stats",
  "/kibana/api/index_patterns",
  // Monitoring / observability
  "/__grafana/api/datasources/proxy/1/query",
  "/prometheus/api/v1/targets",
  "/__webpack_hmr",
  // Payment / OAuth
  "/api/webhooks/stripe/test",
  "/api/billing/stripe-connect",
  "/oauth2/token",
  "/.well-known/jwks.json",
  // AI / ML proxies (common scraping target)
  "/api/ai/completions",
  "/v1/models",
  // CI / deploy artifacts
  "/bitbucket-pipelines.yml",
  "/Jenkinsfile",
  "/deploy/keys/id_rsa",
];

function _installAgentDecoys(): void {
  if (_decoysInstalled || typeof document === "undefined") return;
  const cfg = _resolveDecoyConfig();
  if (!cfg.enabled) return;
  _decoysInstalled = true;

  const manifest = _buildManifest(cfg);
  const suffix = _randomBase64Url(8);
  _decoyElementSuffix = suffix;
  const id = `${cfg.elementPrefix}-${suffix}`;

  // Inject a <script type="application/json"> so DOM-scraping agents see it.
  const script = document.createElement("script");
  script.id = id;
  script.type = "application/json";
  script.setAttribute("data-vg-runtime", suffix);
  script.textContent = JSON.stringify(manifest);
  document.head.appendChild(script);

  // Inject a <meta> tag for agents that scan meta elements.
  const meta = document.createElement("meta");
  meta.name = `${cfg.elementPrefix}-build`;
  meta.setAttribute("data-vg-runtime", suffix);
  meta.content = `${manifest.build}:${manifest.openapi}`;
  document.head.appendChild(meta);

  // Non-enumerable window property: visible to property-enumerating agents
  // but invisible to Object.keys() so it doesn't pollute real code.
  const globalName = `__VG_${suffix.replace(/-/g, "_")}__`;
  try {
    Object.defineProperty(window, globalName, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(manifest),
    });
  } catch {
    // Non-critical; DOM metadata alone is sufficient for most scraping agents.
  }
}

function _removeAgentDecoys(): void {
  if (typeof document === "undefined") return;
  if (_decoyElementSuffix !== null) {
    document.querySelectorAll(`[data-vg-runtime="${_decoyElementSuffix}"]`).forEach((el) => el.remove());
  }
  _decoyElementSuffix = null;
  _decoysInstalled = false;
}

function _resolveDecoyConfig(): Required<AgentDecoyOptions> {
  const raw = _opts.agentDecoys;
  const overrides = typeof raw === "object" && raw !== null ? raw : {};

  // Server-provided tarpit paths take precedence over the built-in pool
  // so every injected breadcrumb maps to a real tarpit endpoint.
  const serverPaths = _discovery?.tarpit?.paths?.map((e) => e.path) ?? [];
  const endpointPool =
    overrides.endpoints ??
    (serverPaths.length > 0 ? serverPaths : DEFAULT_DECOY_ENDPOINTS);

  return {
    enabled: raw !== false && overrides.enabled !== false,
    apiBase: overrides.apiBase ?? "/api",
    endpointCount: Math.max(1, overrides.endpointCount ?? 5),
    elementPrefix: overrides.elementPrefix ?? "vg-app-manifest",
    endpoints: endpointPool,
  };
}

function _buildManifest(cfg: Required<AgentDecoyOptions>): AgentDecoyManifest {
  const endpoints = _pickRandom(cfg.endpoints, cfg.endpointCount);
  const apiBase = cfg.apiBase.replace(/\/$/, "");
  return {
    build: _randomHex(12),
    apiBase,
    endpoints,
    openapi: `${apiBase}/docs/openapi.json`,
    debugPanel: `${apiBase}/internal/debug`,
    adminToken: _fakeJWT("admin"),
    session: _fakeSession(),
  };
}

function _pickRandom(pool: string[], count: number): string[] {
  const src = [...pool];
  const out: string[] = [];
  while (src.length > 0 && out.length < count) {
    const i = _randomInt(src.length);
    out.push(src.splice(i, 1)[0]);
  }
  return out;
}

function _fakeJWT(role: string): string {
  const now = Math.floor(Date.now() / 1000);
  const hdr = _b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const pay = _b64url(JSON.stringify({
    sub: `usr_${_randomBase64Url(10)}`,
    role,
    iat: now - _randomInt(3600),
    exp: now + 86400 + _randomInt(86400),
    jti: _randomHex(16),
  }));
  return `${hdr}.${pay}.${_randomBase64Url(32)}`;
}

function _fakeSession(): string {
  return `s%3A${_randomHex(16)}.${_randomBase64Url(27)}`;
}

function _randomInt(max: number): number {
  if (max <= 0) return 0;
  const b = new Uint32Array(1);
  _crypto().getRandomValues(b);
  return b[0] % max;
}

function _randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  _crypto().getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function _randomBase64Url(bytes: number): string {
  const b = new Uint8Array(bytes);
  _crypto().getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function _b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function _crypto(): Crypto {
  if (typeof crypto !== "undefined") return crypto;
  throw new Error("veilgate: crypto.getRandomValues unavailable");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _mergeOpts(opts?: VeilGateOptions): void {
  if (!opts) return;
  _opts = { ..._opts, ...opts };
}

// ---------------------------------------------------------------------------
// Reset (testing only — not exported in the public API)
// ---------------------------------------------------------------------------

/** @internal */
export function _reset(): void {
  _opts = {
    baseURL: "",
    storageKey: DEFAULT_STORAGE_KEY,
    onChallenge: () => undefined,
    onToken: () => undefined,
    agentDecoys: true,
  };
  _discovery = null;
  _discoveryPromise = null;
  _solvePromise = null;
  if (_fetchPatched && _prePatchFetch && typeof window !== "undefined") {
    window.fetch = _prePatchFetch;
  }
  _prePatchFetch = null;
  _fetchPatched = false;
  _xhrPatched = false;
  _removeAgentDecoys();
  _internal.iframeLoader = _defaultIframeLoader;
  _memStorage.clear();
}

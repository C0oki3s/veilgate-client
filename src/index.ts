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

  /** Inject runtime metadata into the DOM. Set false to disable. Default: true. */
  breadcrumbs?: boolean | BreadcrumbOptions;

  /** Built-in verification overlay. Set false to disable. Default: true. */
  verificationUI?: boolean | VerificationUIOptions;
}

export interface BreadcrumbOptions {
  /** Enable/disable breadcrumb injection. Default: true. */
  enabled?: boolean;

  /** Prefix for injected API paths in the manifest. Default: "/api". */
  apiBase?: string;

  /** How many endpoint hints to expose per page load. Default: 5. */
  endpointCount?: number;

  /** DOM id prefix for injected script/meta tags. Random suffix appended per load. */
  elementPrefix?: string;

  /**
   * Override the endpoint pool entirely. When omitted the SDK uses the
   * server-provided route manifest paths from /_g/config.
   */
  endpoints?: string[];
}

export interface VerificationUIOptions {
  /** Enable/disable the built-in overlay. Default: true. */
  enabled?: boolean;

  /** Main overlay copy. Default: "Verifying your browser". */
  title?: string;

  /** Secondary overlay copy. Default: "This usually takes a moment." */
  message?: string;

  /** Full-screen overlay background. Default: "rgba(255, 255, 255, 0.82)". */
  overlayColor?: string;

  /** Panel background. Default: "#ffffff". */
  panelColor?: string;

  /** Primary text color. Default: "#000000". */
  textColor?: string;

  /** Secondary text color. Default: "#3f3f46". */
  mutedTextColor?: string;

  /** Spinner active segment color. Default: "#000000". */
  spinnerColor?: string;

  /** Spinner track color. Default: "#e4e4e7". */
  spinnerTrackColor?: string;

  /** Panel border color. Default: "#d4d4d8". */
  borderColor?: string;

  /** Overlay z-index. Default: 2147483647. */
  zIndex?: number;
}

export interface RoutePathEntry {
  path: string;
  /** Human-readable service label set by the proxy operator, e.g. "api", "dashboard". */
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
   * Registered routes from the proxy manifest. When present the SDK
   * injects these paths into runtime metadata so linked previews resolve
   * through the configured handler instead of a real 404.
   */
  routes?: {
    paths: RoutePathEntry[];
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

const DISCOVERY_PATH = "/_g/config";
const DEFAULT_STORAGE_KEY = "vg_token";
// Renew the token when less than 60 s remain, not at the last moment.
const RENEW_BEFORE_MS = 60_000;

let _opts: Required<VeilGateOptions> = {
  baseURL: "",
  storageKey: DEFAULT_STORAGE_KEY,
  onChallenge: () => undefined,
  onToken: () => undefined,
  breadcrumbs: true,
  verificationUI: true,
};

let _discovery: DiscoveryDoc | null = null;
let _discoveryPromise: Promise<DiscoveryDoc | null> | null = null;

// Coalescing: multiple concurrent 401s share a single solve.
let _solvePromise: Promise<StoredToken> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the /_g/config discovery document and warm up the
 * internal state. Call once during application start-up.
 *
 * Safe to call multiple times; subsequent calls are no-ops unless the
 * previous call failed.
 */
export async function init(opts?: VeilGateOptions): Promise<void> {
  _mergeOpts(opts);
  _discovery = await _ensureDiscovery();
  _installBreadcrumbs();
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
  _installBreadcrumbs();
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
 * Enable, disable, or reconfigure breadcrumb injection at runtime.
 *
 * - `updateBreadcrumbs(false)` — remove injected DOM elements and disable injection.
 *   Subsequent calls to init() / handleAll() will not re-inject.
 * - `updateBreadcrumbs(true)` — re-enable and (re-)inject immediately.
 * - `updateBreadcrumbs({ endpointCount: 8, endpoints: [...] })` — merge new options,
 *   tear down the current DOM elements, and re-inject with the new config.
 *
 * This is safe to call at any time — before or after init() / handleAll().
 *
 * ```ts
 * // Disable for this session (e.g. authenticated admin user).
 * updateBreadcrumbs(false);
 *
 * // Swap in a custom endpoint list at runtime.
 * updateBreadcrumbs({ endpoints: ["/api/status", "/api/docs/openapi.json"] });
 * ```
 */
export function updateBreadcrumbs(optsOrEnabled: boolean | Partial<BreadcrumbOptions>): void {
  if (optsOrEnabled === false) {
    // Disable: remove DOM elements and update opts so future installs skip.
    _removeBreadcrumbs();
    _opts = { ..._opts, breadcrumbs: false };
    return;
  }

  if (optsOrEnabled === true) {
    // Re-enable with existing config.
    const current = _opts.breadcrumbs;
    _opts = {
      ..._opts,
      breadcrumbs: typeof current === "object" ? { ...current, enabled: true } : true,
    };
    _installBreadcrumbs();
    return;
  }

  // Partial options: merge, tear down, and reinstall.
  const current = typeof _opts.breadcrumbs === "object" && _opts.breadcrumbs !== null
    ? _opts.breadcrumbs
    : {};
  _opts = { ..._opts, breadcrumbs: { ...current, ...optsOrEnabled } };
  _removeBreadcrumbs();
  _installBreadcrumbs();
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
      const startPath = doc.challenge.start_path ?? "/_g/start";
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const src =
        _opts.baseURL + startPath + "?origin=" + encodeURIComponent(origin);
      _showVerificationUI();
      _opts.onChallenge();
      const token = await _internal.iframeLoader(src, doc.challenge.token_header);
      _saveToken(token);
      _hideVerificationUI();
      _opts.onToken(token.value, token.header);
      return token;
    } finally {
      _hideVerificationUI();
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
// Verification UI
// ---------------------------------------------------------------------------

let _verificationEl: HTMLDivElement | null = null;
let _verificationStyleEl: HTMLStyleElement | null = null;

function _resolveVerificationUIConfig(): Required<VerificationUIOptions> {
  const raw = _opts.verificationUI;
  const overrides = typeof raw === "object" && raw !== null ? raw : {};

  return {
    enabled: raw !== false && overrides.enabled !== false,
    title: overrides.title ?? "Verifying your browser",
    message: overrides.message ?? "This usually takes a moment.",
    overlayColor: overrides.overlayColor ?? "rgba(255, 255, 255, 0.82)",
    panelColor: overrides.panelColor ?? "#ffffff",
    textColor: overrides.textColor ?? "#000000",
    mutedTextColor: overrides.mutedTextColor ?? "#3f3f46",
    spinnerColor: overrides.spinnerColor ?? "#000000",
    spinnerTrackColor: overrides.spinnerTrackColor ?? "#e4e4e7",
    borderColor: overrides.borderColor ?? "#d4d4d8",
    zIndex: overrides.zIndex ?? 2147483647,
  };
}

function _showVerificationUI(): void {
  if (typeof document === "undefined") return;
  const cfg = _resolveVerificationUIConfig();
  if (!cfg.enabled) return;

  const overlay = _ensureVerificationUI(cfg);
  _applyVerificationUIConfig(overlay, cfg);
  overlay.hidden = false;
}

function _hideVerificationUI(): void {
  if (_verificationEl) {
    _verificationEl.hidden = true;
  }
}

function _ensureVerificationUI(cfg: Required<VerificationUIOptions>): HTMLDivElement {
  if (_verificationEl && document.body.contains(_verificationEl)) {
    return _verificationEl;
  }

  _ensureVerificationStyles();

  const overlay = document.createElement("div");
  overlay.id = "veilgate-verification";
  overlay.className = "veilgate-verification";
  overlay.hidden = true;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");

  const panel = document.createElement("div");
  panel.className = "veilgate-verification__panel";

  const spinner = document.createElement("div");
  spinner.className = "veilgate-verification__spinner";
  spinner.setAttribute("aria-hidden", "true");

  const title = document.createElement("p");
  title.className = "veilgate-verification__title";

  const message = document.createElement("p");
  message.className = "veilgate-verification__message";

  panel.appendChild(spinner);
  panel.appendChild(title);
  panel.appendChild(message);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  _verificationEl = overlay;
  _applyVerificationUIConfig(overlay, cfg);
  return overlay;
}

function _ensureVerificationStyles(): void {
  if (_verificationStyleEl && document.head.contains(_verificationStyleEl)) return;

  const style = document.createElement("style");
  style.id = "veilgate-verification-style";
  style.textContent = `
.veilgate-verification {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  backdrop-filter: blur(8px);
}
.veilgate-verification[hidden] {
  display: none;
}
.veilgate-verification__panel {
  width: min(360px, 100%);
  display: grid;
  gap: 12px;
  justify-items: center;
  padding: 24px;
  border: 1px solid;
  border-radius: 8px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, .14);
  text-align: center;
}
.veilgate-verification__spinner {
  width: 34px;
  height: 34px;
  border: 3px solid;
  border-radius: 50%;
  animation: veilgate-verification-spin .8s linear infinite;
}
.veilgate-verification__title {
  margin: 0;
  font: 650 16px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.veilgate-verification__message {
  margin: 0;
  font: 400 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@keyframes veilgate-verification-spin {
  to { transform: rotate(360deg); }
}`;
  document.head.appendChild(style);
  _verificationStyleEl = style;
}

function _applyVerificationUIConfig(
  overlay: HTMLDivElement,
  cfg: Required<VerificationUIOptions>,
): void {
  const panel = overlay.querySelector<HTMLElement>(".veilgate-verification__panel");
  const spinner = overlay.querySelector<HTMLElement>(".veilgate-verification__spinner");
  const title = overlay.querySelector<HTMLElement>(".veilgate-verification__title");
  const message = overlay.querySelector<HTMLElement>(".veilgate-verification__message");

  overlay.style.zIndex = String(cfg.zIndex);
  overlay.style.background = cfg.overlayColor;

  if (panel) {
    panel.style.background = cfg.panelColor;
    panel.style.borderColor = cfg.borderColor;
  }
  if (spinner) {
    spinner.style.borderColor = cfg.spinnerTrackColor;
    spinner.style.borderTopColor = cfg.spinnerColor;
  }
  if (title) {
    title.textContent = cfg.title;
    title.style.color = cfg.textColor;
  }
  if (message) {
    message.textContent = cfg.message;
    message.style.color = cfg.mutedTextColor;
  }
}

function _removeVerificationUI(): void {
  _verificationEl?.remove();
  _verificationStyleEl?.remove();
  _verificationEl = null;
  _verificationStyleEl = null;
}

// ---------------------------------------------------------------------------
// Breadcrumb injection
// ---------------------------------------------------------------------------

interface AppManifest {
  build: string;
  apiBase: string;
  endpoints: string[];
  openapi: string;
  status: string;
  traceId: string;
  session: string;
}

let _breadcrumbsInstalled = false;
let _elementSuffix: string | null = null;

function _installBreadcrumbs(): void {
  if (_breadcrumbsInstalled || typeof document === "undefined") return;
  const cfg = _resolveConfig();
  if (!cfg.enabled) return;
  _breadcrumbsInstalled = true;

  const manifest = _buildManifest(cfg);
  const suffix = _randomBase64Url(8);
  _elementSuffix = suffix;
  const id = `${cfg.elementPrefix}-${suffix}`;

  const script = document.createElement("script");
  script.id = id;
  script.type = "application/json";
  script.setAttribute("data-app-build", suffix);
  script.textContent = JSON.stringify(manifest);
  document.head.appendChild(script);

  const meta = document.createElement("meta");
  meta.name = `${cfg.elementPrefix}-build`;
  meta.setAttribute("data-app-build", suffix);
  meta.content = `${manifest.build}:${manifest.openapi}`;
  document.head.appendChild(meta);

  const comment = document.createComment(_buildBuildComment(manifest, suffix));
  document.head.appendChild(comment);

  const jsonLd = document.createElement("script");
  jsonLd.type = "application/ld+json";
  jsonLd.setAttribute("data-app-build", suffix);
  jsonLd.textContent = JSON.stringify(_buildJsonLd(manifest));
  document.head.appendChild(jsonLd);

  const globalName = `__APP_${suffix.replace(/-/g, "_")}__`;
  try {
    Object.defineProperty(window, globalName, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(manifest),
    });
  } catch { /* non-critical */ }

  if (typeof document.body !== "undefined" && document.body) {
    const panel = _buildUIPanel(manifest, suffix, cfg.elementPrefix);
    document.body.appendChild(panel);
  }
}

function _buildBuildComment(m: AppManifest, suffix: string): string {
  const ep = m.endpoints[0] ?? m.status;
  const ts = new Date(Date.now() - _randomInt(3600) * 1000).toISOString();
  const variants = [
    ` build:${m.build} trace:${m.traceId} route:${ep} openapi:${m.openapi} `,
    ` build-meta: v${m.build} | api-root: ${m.apiBase} | status: ${m.status} | session: ${m.session} `,
    ` release-note: route ${ep} verified at ${ts.slice(0, 10)} trace=${m.traceId} `,
    ` runtime: api-base=${m.apiBase} status=${m.status} docs=${m.openapi} build=${suffix} `,
  ];
  return variants[_randomInt(variants.length)];
}

function _buildJsonLd(m: AppManifest): object {
  return {
    "@context": "https://schema.org",
    "@type": "WebAPI",
    "name": "Internal Service API",
    "documentation": m.openapi,
    "endpointURL": m.apiBase,
    "description": `Service API metadata for ${m.status}`,
    "potentialAction": m.endpoints.map(ep => ({
      "@type": "ReadAction",
      "target": ep,
    })),
  };
}

function _buildUIPanel(m: AppManifest, suffix: string, prefix: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = `${prefix}-panel-${suffix}`;
  wrap.setAttribute("data-app-build", suffix);
  wrap.setAttribute("aria-hidden", "true");
  wrap.setAttribute("role", "navigation");
  wrap.setAttribute("aria-label", "Internal navigation");
  wrap.style.cssText =
    "position:absolute;width:1px;height:1px;padding:0;margin:-1px;" +
    "overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

  const label = document.createElement("span");
  label.textContent = `build:${m.build}`;
  label.setAttribute("data-trace", m.traceId);
  label.setAttribute("data-session", m.session);
  wrap.appendChild(label);

  const nav = document.createElement("nav");
  for (const ep of m.endpoints) {
    const a = document.createElement("a");
    a.href = ep;
    a.setAttribute("data-svc", ep.split("/")[2] ?? "api");
    a.textContent = ep;
    nav.appendChild(a);
  }
  for (const href of [m.openapi, m.status]) {
    const a = document.createElement("a");
    a.href = href;
    a.rel = "nofollow";
    a.textContent = href;
    nav.appendChild(a);
  }
  wrap.appendChild(nav);

  return wrap;
}

function _removeBreadcrumbs(): void {
  if (typeof document === "undefined") return;
  if (_elementSuffix !== null) {
    document.querySelectorAll(`[data-app-build="${_elementSuffix}"]`).forEach((el) => el.remove());
    document.head.childNodes.forEach((node) => {
      if (node.nodeType === Node.COMMENT_NODE) {
        const c = node as Comment;
        if (c.textContent?.includes(_elementSuffix!)) c.remove();
      }
    });
  }
  _elementSuffix = null;
  _breadcrumbsInstalled = false;
}

function _resolveConfig(): Required<BreadcrumbOptions> {
  const raw = _opts.breadcrumbs;
  const overrides = typeof raw === "object" && raw !== null ? raw : {};
  const manifestPaths = _discovery?.routes?.paths ?? [];
  const serverPaths = manifestPaths.map((e) => e.path);
  const endpointPool = overrides.endpoints ?? serverPaths;

  return {
    enabled: raw !== false && overrides.enabled !== false,
    apiBase: overrides.apiBase ?? "/api",
    endpointCount: Math.max(1, overrides.endpointCount ?? 5),
    elementPrefix: overrides.elementPrefix ?? "app-manifest",
    endpoints: endpointPool,
  };
}

function _buildManifest(cfg: Required<BreadcrumbOptions>): AppManifest {
  const endpoints = _pickRandom(cfg.endpoints, cfg.endpointCount);
  const apiBase = cfg.apiBase.replace(/\/$/, "");
  return {
    build: _randomHex(12),
    apiBase,
    endpoints,
    openapi: `${apiBase}/docs/openapi.json`,
    status: `${apiBase}/status`,
    traceId: _randomHex(16),
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
    breadcrumbs: true,
    verificationUI: true,
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
  _removeVerificationUI();
  _removeBreadcrumbs();
  _internal.iframeLoader = _defaultIframeLoader;
  _memStorage.clear();
}

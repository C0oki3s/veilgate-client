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
  _internal.iframeLoader = _defaultIframeLoader;
  _memStorage.clear();
}

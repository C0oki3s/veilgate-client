import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  init,
  handleAll,
  getToken,
  getDiscovery,
  _loadToken,
  _saveToken,
  _clearToken,
  _solve,
  _reset,
  _internal,
  type StoredToken,
  type DiscoveryDoc,
} from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(overrides?: Partial<StoredToken>): StoredToken {
  return {
    value: "test-token-abc123",
    header: "X-App-Token",
    expiresAt: Date.now() + 1_800_000,
    ...overrides,
  };
}

function makeDiscovery(overrides?: Partial<DiscoveryDoc["challenge"]>): DiscoveryDoc {
  return {
    challenge: {
      verify_path: "/_g/verify",
      start_path: "/_g/start",
      token_header: "X-App-Token",
      cookie_name: "__app_ts",
      ...overrides,
    },
  };
}

function makeFetchMock(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): ReturnType<typeof vi.fn> {
  const hdr = headers ?? { "Content-Type": "application/json" };
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => hdr[k] ?? null },
    json: () => Promise.resolve(body),
    clone() { return this; },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _reset();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

describe("token storage", () => {
  it("round-trips a token through sessionStorage", () => {
    const t = makeToken();
    _saveToken(t);
    expect(_loadToken()).toEqual(t);
  });

  it("returns null when nothing is stored", () => {
    expect(_loadToken()).toBeNull();
  });

  it("clears the stored token", () => {
    _saveToken(makeToken());
    _clearToken();
    expect(_loadToken()).toBeNull();
  });

  it("token expiresAt is preserved accurately", () => {
    const t = makeToken({ expiresAt: Date.now() + 3_600_000 });
    _saveToken(t);
    expect(_loadToken()!.expiresAt).toBe(t.expiresAt);
  });
});

// ---------------------------------------------------------------------------
// init() — discovery fetch
// ---------------------------------------------------------------------------

describe("init()", () => {
  it("fetches /_g/config and caches it", async () => {
    const doc = makeDiscovery();
    global.fetch = makeFetchMock(200, doc) as unknown as typeof fetch;
    await init();
    expect(getDiscovery()).toEqual(doc);
  });

  it("handles a failed discovery fetch gracefully (returns null)", async () => {
    global.fetch = makeFetchMock(503, {}) as unknown as typeof fetch;
    await init();
    expect(getDiscovery()).toBeNull();
  });

  it("applies baseURL option", async () => {
    const doc = makeDiscovery();
    const spy = makeFetchMock(200, doc);
    global.fetch = spy as unknown as typeof fetch;
    await init({ baseURL: "https://api.example.com" });
    expect(spy).toHaveBeenCalledWith(
      "https://api.example.com/_g/config",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("is idempotent — does not re-fetch on second call", async () => {
    const spy = makeFetchMock(200, makeDiscovery());
    global.fetch = spy as unknown as typeof fetch;
    await init();
    await init();
    // Discovery promise is reused; fetch called only once.
    expect(spy).toHaveBeenCalledOnce();
  });

  it("does not inject a built-in endpoint list when discovery has no routes", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init();

    const el = document.querySelector('script[type="application/json"][data-app-build]');
    expect(el).not.toBeNull();
    const manifest = JSON.parse(el!.textContent ?? "{}") as { endpoints: string[] };
    expect(manifest.endpoints).toEqual([]);
  });

  it("renders endpoints from discovery routes", async () => {
    global.fetch = makeFetchMock(200, {
      ...makeDiscovery(),
      routes: { paths: [{ path: "/api/status", service: "api" }] },
    }) as unknown as typeof fetch;
    await init();

    const el = document.querySelector('script[type="application/json"][data-app-build]');
    expect(el).not.toBeNull();
    const manifest = JSON.parse(el!.textContent ?? "{}") as { endpoints: string[] };
    expect(manifest.endpoints).toEqual(["/api/status"]);
  });
});

// ---------------------------------------------------------------------------
// _solve() — iframe orchestration
// ---------------------------------------------------------------------------

describe("_solve()", () => {
  it("calls the iframe loader and returns the token", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init();

    const expectedToken = makeToken();
    const loaderSpy = vi.fn().mockResolvedValue(expectedToken);
    _internal.iframeLoader = loaderSpy;

    const result = await _solve();
    expect(result).toEqual(expectedToken);
    expect(loaderSpy).toHaveBeenCalledOnce();
    // Token should be persisted.
    expect(_loadToken()).toEqual(expectedToken);
  });

  it("coalesces concurrent calls into a single solve", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init();

    let callCount = 0;
    _internal.iframeLoader = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(makeToken());
    });

    await Promise.all([_solve(), _solve(), _solve()]);
    expect(callCount).toBe(1);
  });

  it("calls onChallenge and onToken callbacks", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    const onChallenge = vi.fn();
    const onToken = vi.fn();
    await init({ onChallenge, onToken });

    _internal.iframeLoader = vi.fn().mockResolvedValue(makeToken());

    await _solve();
    expect(onChallenge).toHaveBeenCalledOnce();
    expect(onToken).toHaveBeenCalledWith("test-token-abc123", "X-App-Token");
  });

  it("shows and hides the built-in verification UI during a solve", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init();

    let resolveLoader!: (value: StoredToken) => void;
    _internal.iframeLoader = vi.fn().mockImplementation(() => new Promise<StoredToken>((resolve) => {
      resolveLoader = resolve;
    }));

    const solving = _solve();
    await Promise.resolve();

    const overlay = document.getElementById("veilgate-verification") as HTMLDivElement | null;
    expect(overlay).not.toBeNull();
    expect(overlay!.hidden).toBe(false);
    expect(overlay!.style.background).toBe("rgba(255, 255, 255, 0.82)");
    expect(overlay!.querySelector(".veilgate-verification__title")?.textContent).toBe("Verifying your browser");
    expect((overlay!.querySelector(".veilgate-verification__title") as HTMLElement).style.color).toBe("rgb(0, 0, 0)");

    resolveLoader(makeToken());
    await solving;
    expect(overlay!.hidden).toBe(true);
  });

  it("applies custom built-in verification UI colors and copy", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init({
      verificationUI: {
        title: "Checking session",
        message: "One moment",
        overlayColor: "rgba(0, 0, 0, 0.5)",
        panelColor: "#111111",
        textColor: "#ffffff",
        mutedTextColor: "#cccccc",
        spinnerColor: "#ff0000",
        spinnerTrackColor: "#333333",
        borderColor: "#444444",
        zIndex: 1000,
      },
    });

    let resolveLoader!: (value: StoredToken) => void;
    _internal.iframeLoader = vi.fn().mockImplementation(() => new Promise<StoredToken>((resolve) => {
      resolveLoader = resolve;
    }));

    const solving = _solve();
    await Promise.resolve();

    const overlay = document.getElementById("veilgate-verification") as HTMLDivElement;
    const panel = overlay.querySelector(".veilgate-verification__panel") as HTMLElement;
    const spinner = overlay.querySelector(".veilgate-verification__spinner") as HTMLElement;
    const title = overlay.querySelector(".veilgate-verification__title") as HTMLElement;
    const message = overlay.querySelector(".veilgate-verification__message") as HTMLElement;

    expect(overlay.style.zIndex).toBe("1000");
    expect(overlay.style.background).toBe("rgba(0, 0, 0, 0.5)");
    expect(panel.style.background).toBe("rgb(17, 17, 17)");
    expect(panel.style.borderColor).toBe("rgb(68, 68, 68)");
    expect(spinner.style.borderTopColor).toBe("rgb(255, 0, 0)");
    expect(title.textContent).toBe("Checking session");
    expect(title.style.color).toBe("rgb(255, 255, 255)");
    expect(message.textContent).toBe("One moment");
    expect(message.style.color).toBe("rgb(204, 204, 204)");

    resolveLoader(makeToken());
    await solving;
  });

  it("passes the origin param to the iframe src", async () => {
    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init();

    let capturedSrc = "";
    _internal.iframeLoader = vi.fn().mockImplementation((src: string) => {
      capturedSrc = src;
      return Promise.resolve(makeToken());
    });

    await _solve();
    expect(capturedSrc).toContain("?origin=");
  });
});

// ---------------------------------------------------------------------------
// handleAll() — fetch interceptor
// ---------------------------------------------------------------------------

describe("handleAll() fetch interceptor", () => {
  it("attaches a cached token to outgoing requests", async () => {
    const spy = makeFetchMock(200, { data: "ok" });
    global.fetch = spy as unknown as typeof fetch;
    handleAll();

    _saveToken(makeToken());
    await fetch("/api/data");

    // spy was captured as _prePatchFetch; verify the call args.
    expect(spy).toHaveBeenCalledOnce();
    const [, init] = spy.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-App-Token")).toBe("test-token-abc123");
  });

  it("does not attach an expired token", async () => {
    const spy = makeFetchMock(200, { data: "ok" });
    global.fetch = spy as unknown as typeof fetch;
    handleAll();

    _saveToken(makeToken({ expiresAt: Date.now() - 1000 }));
    await fetch("/api/data");

    const [, init] = spy.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-App-Token")).toBeNull();
  });

  it("solves challenge and retries on 401 challenge_required", async () => {
    // Discovery fetch + first (401) + second (200 after solve)
    const spy = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve(makeDiscovery()),
      })
      .mockResolvedValueOnce({
        ok: false, status: 401,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ error: "challenge_required" }),
        clone() { return this; },
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ data: "ok" }),
      });
    global.fetch = spy as unknown as typeof fetch;

    await init();
    handleAll();

    _internal.iframeLoader = vi.fn().mockResolvedValue(makeToken());

    const resp = await fetch("/api/data");
    expect(resp.status).toBe(200);
    // Loader called once for the solve.
    expect(_internal.iframeLoader).toHaveBeenCalledOnce();
    // Total raw fetch calls: 1 (discovery) + 1 (first attempt) + 1 (retry) = 3
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does not retry on a non-veilgate 401", async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve(makeDiscovery()),
      })
      .mockResolvedValueOnce({
        ok: false, status: 401,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ error: "unauthorized" }),
        clone() { return this; },
      });
    global.fetch = spy as unknown as typeof fetch;
    await init();
    handleAll();

    const loaderSpy = vi.fn().mockResolvedValue(makeToken());
    _internal.iframeLoader = loaderSpy;

    const resp = await fetch("/api/secure");
    expect(resp.status).toBe(401);
    expect(loaderSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getToken()
// ---------------------------------------------------------------------------

describe("getToken()", () => {
  it("returns cached token when it has plenty of time left", async () => {
    const fresh = makeToken({ expiresAt: Date.now() + 3_600_000 });
    _saveToken(fresh);
    // No network call needed — skip init.
    global.fetch = vi.fn() as unknown as typeof fetch;
    const result = await getToken();
    expect(result).toEqual(fresh);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("solves a fresh challenge when the token is about to expire", async () => {
    // Token expires in 30 s — within the 60 s renewal window.
    _saveToken(makeToken({ expiresAt: Date.now() + 30_000 }));

    global.fetch = makeFetchMock(200, makeDiscovery()) as unknown as typeof fetch;
    await init();

    const freshToken = makeToken({ value: "new-token-xyz" });
    _internal.iframeLoader = vi.fn().mockResolvedValue(freshToken);

    const result = await getToken();
    expect(result.value).toBe("new-token-xyz");
  });
});

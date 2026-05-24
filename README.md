# @veilgate/client

Browser SDK for [VeilGate](https://github.com/C0oki3s/veilgate). Intercepts `fetch` and `XMLHttpRequest` globally, auto-attaches VeilGate session tokens, drives the proof-of-work challenge flow transparently, and injects runtime metadata from the server route manifest.

## Install

```bash
npm install @veilgate/client
```

## Usage

### Two-liner setup

```ts
import { init, handleAll } from "@veilgate/client";

await init({ baseURL: "https://gate.example.com" });
handleAll();
// All subsequent fetch() / XHR calls automatically carry VeilGate credentials.
// Breadcrumbs are injected into document.head automatically.
```

### Manual token management

```ts
import { getToken } from "@veilgate/client";

const token = await getToken();
const resp = await fetch("/api/data", {
  headers: { Authorization: `Bearer ${token}` },
});
```

### Runtime breadcrumb control

```ts
import { init, handleAll, updateBreadcrumbs } from "@veilgate/client";

await init();
handleAll();

// Disable for an authenticated admin session — removes DOM elements immediately.
updateBreadcrumbs(false);

// Re-enable later.
updateBreadcrumbs(true);

// Swap to a specific endpoint list and increase breadcrumb count.
updateBreadcrumbs({ endpoints: ["/api/status", "/api/docs/openapi.json"], endpointCount: 8 });
```

### Verification UI

The SDK includes a built-in verification overlay. By default it uses a white
overlay, white panel, black primary text, and black spinner.

```ts
await init({
  verificationUI: true,
});
```

Customize the colors and copy without writing your own overlay:

```ts
await init({
  verificationUI: {
    title: "Checking session",
    message: "One moment",
    overlayColor: "rgba(255, 255, 255, 0.82)",
    panelColor: "#ffffff",
    textColor: "#000000",
    mutedTextColor: "#3f3f46",
    spinnerColor: "#000000",
    spinnerTrackColor: "#e4e4e7",
    borderColor: "#d4d4d8",
  },
});
```

Set `verificationUI: false` to disable the built-in overlay and use
`onChallenge` / `onToken` for a fully custom implementation.

## API

### `init(opts?)`

Fetches `/_g/config`, caches the discovery document, and installs breadcrumbs. Call once on page load.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseURL` | `string` | `""` (same origin) | VeilGate server base URL |
| `storageKey` | `string` | `"vg_token"` | `sessionStorage` key for the cached token |
| `onChallenge` | `() => void` | — | Called when a PoW challenge starts |
| `onToken` | `(token, header) => void` | — | Called each time a fresh token is issued |
| `breadcrumbs` | `boolean \| BreadcrumbOptions` | `true` | DOM breadcrumb injection (see below) |
| `verificationUI` | `boolean \| VerificationUIOptions` | `true` | Built-in verification overlay |

### Verification UI options (`verificationUI`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master on/off switch |
| `title` | `string` | `"Verifying your browser"` | Main overlay text |
| `message` | `string` | `"This usually takes a moment."` | Secondary overlay text |
| `overlayColor` | `string` | `"rgba(255, 255, 255, 0.82)"` | Full-screen overlay background |
| `panelColor` | `string` | `"#ffffff"` | Panel background |
| `textColor` | `string` | `"#000000"` | Main text color |
| `mutedTextColor` | `string` | `"#3f3f46"` | Secondary text color |
| `spinnerColor` | `string` | `"#000000"` | Spinner active segment |
| `spinnerTrackColor` | `string` | `"#e4e4e7"` | Spinner track |
| `borderColor` | `string` | `"#d4d4d8"` | Panel border |
| `zIndex` | `number` | `2147483647` | Overlay stacking order |

### `handleAll(opts?)`

Patches `globalThis.fetch` and `XMLHttpRequest`. Accepts the same options as `init()`. Also installs breadcrumbs if not already installed.

### `getToken()`

Returns a valid `StoredToken`. Solves a PoW challenge when no cached token exists or the current one is within 60 seconds of expiry.

### `getDiscovery()`

Returns the cached discovery document, or `null` if `init()` has not been called.

### `updateBreadcrumbs(optsOrEnabled)`

Enable, disable, or reconfigure breadcrumbs at runtime without reinitialising the SDK. Disabling removes the injected DOM elements immediately via `data-app-build` attribute selector.

| Argument | Effect |
|----------|--------|
| `false` | Remove injected DOM elements and disable future injection |
| `true` | Re-enable and (re-)inject with the current config |
| `Partial<BreadcrumbOptions>` | Merge new options, tear down old elements, reinject |

### Breadcrumb options (`breadcrumbs`)

The SDK reads `routes.paths` from `/_g/config` and uses those as the breadcrumb
pool. If the server does not return `routes.paths`, no route endpoints are
injected unless the caller passes `endpoints`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master on/off switch |
| `endpointCount` | `number` | `5` | Paths to inject per page load |
| `apiBase` | `string` | `"/api"` | `apiBase` field in the injected manifest |
| `elementPrefix` | `string` | `"app-manifest"` | DOM id/name prefix for injected elements |
| `endpoints` | `string[]` | `routes.paths` from the server | Override the endpoint pool entirely |

## How It Works

1. `init()` fetches `/_g/config` and stores challenge config and `routes.paths`.
2. Breadcrumbs are injected into `document.head`: a `<script type="application/json">`, JSON-LD, metadata, comments, and hidden navigation, each stamped `data-app-build=<random-suffix>` for clean removal.
3. `handleAll()` wraps global fetch/XHR to attach a valid VeilGate token to every request.
4. On `401 { "error": "challenge_required" }`, the SDK opens a hidden iframe, solves the PoW, stores the token, and retries the original request automatically.
5. Concurrent requests during a challenge are coalesced — only one PoW solve happens regardless of how many calls are in-flight.
6. `updateBreadcrumbs(false)` queries `[data-app-build]` and removes all injected elements cleanly.

## Browser Support

ES2020+, modern browsers only. No IE11 support.

## License

MIT

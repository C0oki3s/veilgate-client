# @veilgate/client

Browser SDK for [VeilGate](https://github.com/C0oki3s/veilgate). Intercepts `fetch` and `XMLHttpRequest` globally, auto-attaches VeilGate session tokens, drives the proof-of-work challenge flow transparently, and injects DOM agent decoys that route scanners and LLM tool-callers into the tarpit.

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
// Agent decoys are injected into document.head automatically.
```

### Manual token management

```ts
import { getToken } from "@veilgate/client";

const token = await getToken();
const resp = await fetch("/api/data", {
  headers: { Authorization: `Bearer ${token}` },
});
```

### Runtime decoy control

```ts
import { init, handleAll, updateDecoys } from "@veilgate/client";

await init();
handleAll();

// Disable for an authenticated admin session — removes DOM elements immediately.
updateDecoys(false);

// Re-enable later.
updateDecoys(true);

// Swap to a specific endpoint list and increase breadcrumb count.
updateDecoys({ endpoints: ["/v1/secret/data/prod", "/actuator/env"], endpointCount: 8 });
```

## API

### `init(opts?)`

Fetches `/__veilgate/.well-known`, caches the discovery document, and installs agent decoys. Call once on page load.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseURL` | `string` | `""` (same origin) | VeilGate server base URL |
| `storageKey` | `string` | `"vg_token"` | `sessionStorage` key for the cached token |
| `onChallenge` | `() => void` | — | Called when a PoW challenge starts |
| `onToken` | `(token, header) => void` | — | Called each time a fresh token is issued |
| `agentDecoys` | `boolean \| AgentDecoyOptions` | `true` | DOM breadcrumb injection (see below) |

### `handleAll(opts?)`

Patches `globalThis.fetch` and `XMLHttpRequest`. Accepts the same options as `init()`. Also installs agent decoys if not already installed.

### `getToken()`

Returns a valid `StoredToken`. Solves a PoW challenge when no cached token exists or the current one is within 60 seconds of expiry.

### `getDiscovery()`

Returns the cached discovery document, or `null` if `init()` has not been called.

### `updateDecoys(optsOrEnabled)`

Enable, disable, or reconfigure agent decoys at runtime without reinitialising the SDK. Disabling removes the injected DOM elements immediately via `data-vg-runtime` attribute selector.

| Argument | Effect |
|----------|--------|
| `false` | Remove injected DOM elements and disable future injection |
| `true` | Re-enable and (re-)inject with the current config |
| `Partial<AgentDecoyOptions>` | Merge new options, tear down old elements, reinject |

### Agent decoy options (`agentDecoys`)

The SDK reads `tarpit.paths` from `/__veilgate/.well-known` (populated by
`veilgate-rules/decoy_paths.yaml`) and uses those as the breadcrumb pool. Falls
back to a built-in pool of ~50 realistic bait paths when the server has no
`decoy_paths.yaml` configured.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master on/off switch |
| `endpointCount` | `number` | `5` | Paths to inject per page load |
| `apiBase` | `string` | `"/api"` | `apiBase` field in the injected manifest |
| `elementPrefix` | `string` | `"vg-app-manifest"` | DOM id/name prefix for injected elements |
| `endpoints` | `string[]` | server paths or built-in pool | Override the endpoint pool entirely |

## How It Works

1. `init()` fetches `/__veilgate/.well-known` and stores challenge config and `tarpit.paths`.
2. Agent decoys are injected into `document.head`: a `<script type="application/json">` and a `<meta>` tag, each stamped `data-vg-runtime=<random-suffix>` for clean removal.
3. `handleAll()` wraps global fetch/XHR to attach a valid VeilGate token to every request.
4. On `401 { "error": "challenge_required" }`, the SDK opens a hidden iframe, solves the PoW, stores the token, and retries the original request automatically.
5. Concurrent requests during a challenge are coalesced — only one PoW solve happens regardless of how many calls are in-flight.
6. `updateDecoys(false)` queries `[data-vg-runtime]` and removes all injected elements cleanly.

## Browser Support

ES2020+, modern browsers only. No IE11 support.

## License

MIT

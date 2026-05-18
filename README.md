# @veilgate/client

Browser SDK for [VeilGate](https://github.com/C0oki3s/veilgate). Intercepts `fetch` and `XMLHttpRequest` globally, auto-attaches VeilGate session tokens, and drives the proof-of-work challenge flow transparently.

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
```

### Manual token management

```ts
import { getToken } from "@veilgate/client";

const token = await getToken();
const resp = await fetch("/api/data", {
  headers: { Authorization: `Bearer ${token}` },
});
```

## API

### `init(opts?)`

Fetches the VeilGate discovery document and caches it. Call once on page load.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseURL` | `string` | `""` (same origin) | VeilGate server base URL |
| `onChallenge` | `() => void` | — | Called when a PoW challenge starts |
| `onToken` | `(token: string) => void` | — | Called each time a fresh token is issued |

### `handleAll(opts?)`

Patches `globalThis.fetch` and `XMLHttpRequest`. Any options accepted by `init()` are forwarded.

### `getToken()`

Returns a valid token string. Solves a PoW challenge if no cached token is available or if the current one is within 60 seconds of expiry.

### `getDiscovery()`

Returns the cached discovery document, or `null` if `init()` has not been called.

## How It Works

1. `init()` fetches `<baseURL>/vg/discovery` and stores the challenge configuration.
2. `handleAll()` wraps the global fetch/XHR to inject an `Authorization: Bearer <token>` header on every request.
3. When a request returns `401` with a VeilGate challenge, the SDK opens a hidden iframe, solves the PoW, stores the new token, and retries the original request automatically.
4. Concurrent requests during a challenge are coalesced — only one PoW is solved regardless of how many calls are in-flight.

## Browser Support

ES2020+, modern browsers only. No IE11 support.

## License

MIT

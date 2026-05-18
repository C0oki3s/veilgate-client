# Security Policy — VeilGate SDK

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **rohith83090@gmail.com**

Include:
- Package name (`@veilgate/client` or `@veilgate/node`) and version
- Steps to reproduce or a minimal proof-of-concept
- Impact assessment (what an attacker could do)

You will receive a response within **48 hours** and a patch within **7 days** for critical issues.

---

## Supported Versions

| Package | Version | Supported |
|---------|---------|-----------|
| `@veilgate/client` | 0.1.x | ✅ |
| `@veilgate/node` | 0.1.x | ✅ |

---

## Maintenance & Audit Schedule

### Quarterly (every 3 months)

- [ ] Run `npm audit` in both packages and resolve all high/critical findings
- [ ] Review and update all devDependencies to their latest minor/patch versions
- [ ] Re-run the full test suite after dependency updates
- [ ] Rotate any long-lived HMAC secrets used in test fixtures

### Per-release checklist

- [ ] `npm audit` passes with no high/critical vulnerabilities
- [ ] All TypeScript errors are resolved (`npm run typecheck` in both packages)
- [ ] All tests pass (`npm test` in both packages)
- [ ] `dist/` is rebuilt fresh (`npm run build` in both packages)
- [ ] Version bumped in both `package.json` files (semver)
- [ ] CHANGELOG entry written
- [ ] GitHub release tag created (`vX.Y.Z`)
- [ ] Packages published to npm (`npm publish --access public`)

### Annual

- [ ] Full dependency tree audit including transitive devDependencies
- [ ] Review HMAC signing algorithm — ensure SHA-256 is still appropriate
- [ ] Review replay window defaults (currently 300 s) against threat model
- [ ] Review token storage strategy in `@veilgate/client` (sessionStorage fallback)
- [ ] Check for any browser API deprecations affecting `@veilgate/client`

---

## Known Security Properties

### `@veilgate/client`

- Tokens are stored in `sessionStorage` with an in-memory fallback. They are **not** stored in `localStorage` or cookies to limit persistence.
- The PoW challenge iframe is sandboxed and communicates via `postMessage`. Ensure your CSP allows the VeilGate challenge origin.
- The fetch/XHR interceptor only injects the `Authorization` header if the header is not already present (no credential overwrite).

### `@veilgate/node`

- HMAC secrets must be kept in environment variables and never committed to source control.
- `verifySignature()` uses `timingSafeEqual` to prevent timing attacks.
- The replay window (default 300 s) rejects requests with timestamps too far in the past or future. Match this value with the server-side VeilGate configuration.
- Streaming bodies (`ReadableStream`) are fully buffered before hashing. Do not pass unbounded streams.
- `FormData` bodies are explicitly rejected — callers must serialize to `Buffer` or `string` first.

---

## GitHub Repository

- **Browser SDK:** https://github.com/C0oki3s/veilgate-client
- **Node SDK:** https://github.com/C0oki3s/veilgate-node
- **Main VeilGate server:** https://github.com/C0oki3s/veilgate
- **npm `@veilgate/client`:** https://www.npmjs.com/package/@veilgate/client
- **npm `@veilgate/node`:** https://www.npmjs.com/package/@veilgate/node

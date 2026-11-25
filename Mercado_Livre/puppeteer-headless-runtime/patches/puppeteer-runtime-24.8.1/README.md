# Puppeteer runtime patch

This directory contains the four original CommonJS `addBinding` runtime patches
plus an optional native identity initializer in TargetManager, based on
`puppeteer-core 24.8.1`.

The TargetManager initializer is activated only by an explicit adapter option.
The default lifecycle and service worker detachment remain unchanged without it.

The project installs the base package under the `research-puppeteer-runtime`
npm alias. The installer patches only that copy and verifies the source hashes.

Environment contract used by the patched files:

- `REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding`
- `REBROWSER_PATCHES_DEBUG` is cleared

The patch is applied automatically by `npm install` from the repository root.
Run `npm run verify` to check the installed runtime against the manifest.

# CEPO navigation Puppeteer runtime patch

This directory contains the four CommonJS runtime files from the user's tested
phase-7 `addBinding` configuration, based on `puppeteer-core 24.8.1`.

The CEPO keeps its existing `puppeteer-core 25.11.0` dependency for the other
browser flows. The navigation module uses an npm alias for `24.8.1`, and the
installer below patches only that isolated copy.

Environment contract used by the patched files:

- `REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding`
- `REBROWSER_PATCHES_DEBUG` is cleared

The patch is applied automatically by `npm install`, `npm start`, `npm test`,
and `npm run build` in `agent/`.

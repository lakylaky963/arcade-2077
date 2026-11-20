# Vendored `@colyseus/sdk` (0.17)

The phone client talks to the game server with the Colyseus JavaScript SDK. It is served from this folder, never from a CDN.

| file | what |
|---|---|
| `colyseus-sdk.mjs` | one bundled ESM file that exports `Client`, loaded by `../js/net.js` |
| `VERSION` | the exact pinned version and the file's sha256 |
| `LICENSE-colyseus-sdk` | the SDK's MIT licence (keep it with the file) |
| `vendor.mjs` | the script that produces the three files above |

To (re)vendor, on a machine with npm access: `node wildcard/vendor/vendor.mjs` (or `... 0.17.3` for an exact 0.17.x), then commit the three files.
The script only accepts 0.17.x because `wildcard-server` runs Colyseus 0.17, and it refuses to continue without the package's licence file.
Do not bump to another minor version without bumping the server too.

Until `colyseus-sdk.mjs` exists the lobby shows "the game connection library is missing" instead of connecting, and `hub.test.mjs` reports the vendored-file check as skipped.

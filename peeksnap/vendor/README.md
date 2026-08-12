# Vendored third-party code

Do not edit anything in this directory. These files ship byte-for-byte as
published upstream. If behavior needs to change, change PeekSnap's own code
around them.

## pdfjs/ — PDF.js 6.2.108

Source: https://github.com/mozilla/pdf.js/releases/download/v6.2.108/pdfjs-6.2.108-dist.zip

Copied from that archive:

| Path here | From archive | Why |
|---|---|---|
| `pdf.mjs` | `build/pdf.mjs` | Main library (ES module) |
| `pdf.worker.mjs` | `build/pdf.worker.mjs` | Parsing/rendering worker |
| `cmaps/` | `web/cmaps/` | CJK character maps |
| `standard_fonts/` | `web/standard_fonts/` | The 14 standard PDF fonts |
| `wasm/` | `web/wasm/` | Image decoders, incl. JPEG 2000 |

Deliberately excluded: `.map` sourcemaps (~7 MB) and Mozilla's own
`web/viewer.*` UI.

`cmaps`, `standard_fonts`, and `wasm` are NOT optional for this project's
purpose — scanned PDFs depend on those image decoders and font fallbacks.
Removing them makes some PDFs render blank or with wrong fonts.

To upgrade: download the new dist zip, repeat the copies above, update
`VERSION`, and re-run the manual PDF verification matrix.

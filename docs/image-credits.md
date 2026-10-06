# Instance imagery

| File | Role |
| --- | --- |
| `auroville-symbol.svg` | Favicon source, referenced as `rel="icon" type="image/svg+xml"` |
| `auroville-symbol.png` | 512x512 raster fallback (`rel="alternate icon"`) and `apple-touch-icon` |
| `og-image.png` | 1200x630 shared-link card (`og:image`) |

Provenance: `auroville-symbol.svg` is the Auroville symbol from Wikimedia Commons,
<https://commons.wikimedia.org/wiki/File:Auroville_symbol.svg> (uploader Sarang).
The file is marked **public domain** there, so no attribution is required and no
licence obligation attaches to redistribution.

The two PNGs are rasterised locally from that SVG with headless Chrome (no
network font or image fetches at build time), so `web/public/images` stays fully
self-hosted and the og card renders the same for scrapers that reject SVG.

# eTrex Bridge

A single-page web app that reads and writes a **Garmin eTrex 30x** directly over
USB, using the Chrome **File System Access API**. Vanilla HTML/CSS/JS — no
dependencies, no build step, no server-side anything.

The eTrex mounts as plain USB mass storage, so there is no protocol to
implement: the device is just a filesystem. This app picks the mounted volume
with `showDirectoryPicker()` and works with the files under `/Garmin`.

---

## Requirements

| | |
|---|---|
| **Browser** | Chromium only — Chrome, Edge, Opera, Brave, Arc. |
| **Origin** | `https://` or `http://localhost`. Not `file://`. |
| **Gesture** | A click is required to connect. There is no silent disk access. |

Firefox and Safari implement only the *origin-private filesystem*, which is a
sandbox inside the browser profile — it cannot reach a mounted USB volume. The
app detects this and says so rather than degrading to something useless.

`file://` has an opaque origin, so it is not a secure context and
`showDirectoryPicker` is not exposed there. **Opening `index.html` by
double-clicking will not work.**

---

## Running it

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open <http://localhost:8000> in Chrome. `localhost` counts as a secure
context, so no TLS certificate is needed.

`--bind 127.0.0.1` matters: without it `http.server` listens on **all**
interfaces and shares this directory with anyone on your network.

The command **blocks** — it prints `Serving HTTP on ...` and then sits there
without returning to the prompt. That is it working. It logs one line per
request, and stops on Ctrl+C. To run it in the background instead:

```bash
nohup python3 -m http.server 8000 --bind 127.0.0.1 > /tmp/etrex-server.log 2>&1 &
```

Any other static server works — `npx serve`, `php -S`, Caddy — as long as it
serves over `localhost` or real HTTPS.

---

## How to

### Connect to the device

1. Plug the eTrex in and wait for the volume(s) to mount.
2. Click **Connect volume…** and pick **GARMIN** in the OS dialog.
3. The status line turns green and the inventory fills in.

The eTrex presents the internal storage (`GARMIN`, ~3.7 GB) and, if fitted, the
microSD card as **two independent disks**. The picker returns one directory
handle at a time, so connect to each separately.

On later visits the app offers **Reconnect** — one permission prompt instead of
a fresh OS file dialog, because the handle is kept in IndexedDB. **Forget**
clears it. If the volume was unmounted or relabelled the stored handle goes
stale; the app falls back to asking for a fresh pick.

A missing `/Garmin` folder produces a warning, not an error — that is normal for
a blank SD card, and the folder is created on first write.

### See what is on the device

The **Inventory** panel shows `gmapsupp.img` (size and mtime), every `.gpx`
across `GPX/`, `GPX/Current/` and `GPX/Archive/`, and any `.kmz` custom maps.

**Everything under /Garmin** expands to a recursive listing with sizes, capped
at depth 4 and 800 entries. Use it when you want to know what is actually on the
volume, including files this app knows nothing about.

### View a track

Click **open** on any GPX. You get counts (tracks, track points, waypoints,
routes, route points), the `<name>` of every track, route and waypoint, and the
track drawn over a terrain basemap.

### Copy a GPX onto the device

1. Choose the file under **Upload GPX**.
2. Check the **Save on device as** field — it is pre-filled with a sanitised name
   and is freely editable. **suggest** restores the derived name.
3. Click **Upload to device**.

The file is validated as well-formed XML with a `<gpx>` root *before* anything is
written, you are warned if it breaches a firmware ceiling, and asked to confirm
if it would overwrite an existing file.

### Delete a GPX or a custom map

Click **delete** on any row under **GPX files** or **Custom maps**. The
confirmation names the full device path, size and mtime. There is no trash on
the volume — this is immediate and final.

Both kinds warn that the device reads these at boot, so a deletion may not show
up until the eTrex restarts: a deleted track can linger in Track Manager, and a
deleted `.kmz` in **Setup → Map**. Deleting the active recording in
`GPX/Current/` carries an extra warning, since that discards a track still being
logged.

Deleting the GPX currently open in the viewer clears the viewer too.

### Install a vector map

1. Get a Garmin `.img` (see [Maps](#maps-vector-vs-overlay)).
2. Choose it under **Install map** and click **Install map**.
3. Confirm the overwrite. **Do not unplug while the progress bar runs.**
4. Eject the volume before unplugging.

The file is streamed chunk-by-chunk, so a 1 GB+ image is never held in memory.

### Make a Custom Map overlay

1. Open a GPX so the viewer has a track.
2. Expand **Export this area as a Garmin Custom Map (KMZ)**.
3. Pick a detail level, margin and number of zoom levels. The estimate line
   shows the area, the resolution range, the tile requests, the overlay-image
   count against your budget, and the approximate size — all before anything is
   downloaded.
4. Click **Write KMZ to device**.
5. Restart the eTrex and enable it under **Setup → Map**.

Leave **Zoom levels** at 3 unless you have a reason not to — custom maps stop
drawing when you zoom out, and the extra tiers are what keep them visible. They
cost no extra downloads.

---

## Device layout

```
/Garmin/GPX/*.gpx           waypoints, routes, saved tracks (GPX 1.1)
/Garmin/GPX/Current/        the active recording
/Garmin/GPX/Archive/        auto-archived tracks
/Garmin/gmapsupp.img        the map image (routable Garmin .img, often 1 GB+)
/Garmin/CustomMaps/*.kmz    raster overlays
```

### Firmware ceilings

The eTrex truncates **silently** past these. The app warns before uploading a
file that breaches one.

| Limit | Value |
|---|---|
| Waypoints | 2000 |
| Routes | 200 |
| Saved tracks | 200 |
| Points per track | 10000 |

These are device *totals*, not per-file. A file under the ceiling can still push
the device over it when combined with what is already stored.

### Where the names you see on the device come from

Filenames on the volume and the names the eTrex shows in Track Manager are two
different things. A track's displayed name is the `<name>` element inside the
GPX — `<trk><name>…</name></trk>` — not the file it arrived in. The same goes for
`<wpt><name>` and `<rte><name>`.

They often *look* identical, because most software that writes a GPX sets both
from the same string, and the eTrex names a track it saves and the file it saves
it into consistently. So a run of `Track.gpx`, `Track1.gpx`, `Track2.gpx` very
often does contain tracks named `Track`, `Track1`, `Track2` — the numbering is
collision-avoidance applied to both at once. The filename is a good *guess* at
the displayed name, never an authority on it.

The viewer settles it: it lists the actual `<name>` values alongside the counts.
Renaming on upload leaves them untouched, so the device's display does not
change.

---

## Maps: vector vs overlay

The basemap in the viewer and the map on the eTrex are **not the same kind of
thing**, and tiles cannot simply be copied across. `gmapsupp.img` is Garmin's
proprietary *vector* format — geometry, labels and a routing graph. The viewer
draws pre-rendered *raster* PNG tiles. There is no path from one to the other.

The two layers are independent and coexist:

| | `gmapsupp.img` | `CustomMaps/*.kmz` |
|---|---|---|
| Format | Vector | Raster JPEG |
| Routable | Yes | No — overlay only |
| Coverage | Whole country | The areas you export |
| Size | ~1.7 GB | ~2 MB per area |
| Hillshading | Not rendered on device | Yes, as baked into the imagery |

With neither installed you still get the eTrex's built-in firmware basemap —
coastlines and major roads, no contours. It lives in firmware, not on the
volume, which is why nothing appears in `/Garmin`.

### 1. Download OpenTopoMap's Garmin build (recommended)

OpenTopoMap publishes Garmin `.img` files at <https://garmin.opentopomap.org/> —
the same cartography as the viewer's default basemap, compiled for the device.
Per their site these include **hillshade and an elevation map**, routing, and
contour lines as an optional layer.

```bash
curl -O https://garmin.opentopomap.org/australia-oceania/australia/otm-australia.zip
```

That download is **1.48 GB**; the `.img` inside is **1.67 GB** (built 26 May
2026). A `-contours` variant is offered separately. Unzip it, then use **Install
map**.

**On free space.** OpenTopoMap advise installing to a microSD card. With **no
existing map**, though, `createWritable()` needs room only for the new file, so
1.67 GB fits a 3.7 GB internal volume with ~2 GB to spare. The problem is
*replacing* it later: old + new peaks at ~3.34 GB, which is genuinely tight and
can fail mid-write. Delete the existing `gmapsupp.img` first if you hit that.

Maps are **CC-BY-NC-SA 4.0** — non-commercial, share-alike, not for resale.

Other pre-built OSM sources: **Freizeitkarte**, **openmtbmap / velomap**, and
country projects like **Talkytoaster** for the UK.

### 2. Custom Maps — raster imagery, built by this app

**This is the route if you have no microSD card**, or if you only want the few
areas you actually walk.

`/Garmin/CustomMaps/*.kmz` is the one place the eTrex takes real raster imagery:
a KMZ (a ZIP) holding JPEGs plus a KML `GroundOverlay` with a `LatLonBox`
georeferencing each. The exporter fetches basemap tiles for the open track's
extent, stitches them into ≤1024×1024 JPEGs, writes the KML, zips it, and streams
it to the device.

Typical handheld limits are around **100 overlay tiles**, JPEG only, drawn over
the base map and not routable. The exporter has a tile-budget field (default 100)
and refuses to exceed it — check your model's own limit, as these vary.

#### Custom maps vanish when you zoom out

This catches people out. Unlike BirdsEye imagery, custom maps **do not draw at
every zoom**: past roughly a 300 m scale the device stops rendering them and you
drop back to the base map. It is a function of the image's ground resolution —
finely detailed imagery is only renderable when zoomed right in.

The fix is to ship the same ground at **several resolutions** and let the device
pick whichever it can still draw. The **Zoom levels** control does this, and
defaults to 3.

Coarser tiers are built by downscaling the imagery already fetched for the
sharpest tier, so they cost **no extra tile requests at all** — only extra
images, and those fall away as 1 + ¼ + ¹⁄₁₆:

| Tiers | Requests | Overlay images | Size | Resolution range |
|---|---|---|---|---|
| 1 | 72 | 6 | ~1.85 MB | 2.0 m/px |
| 2 | 72 | 8 | ~2.31 MB | 2.0 – 4.1 m/px |
| 3 | 72 | 9 | ~2.42 MB | 2.0 – 8.1 m/px |

Every tier covers an identical extent; only the resolution changes.
`drawOrder` is 99 / 89 / 79 — above 50 so they sit over Garmin's own maps, with
finer imagery ordered above coarser.

#### The one-megapixel cap

Garmin caps a Custom Map image at **one megapixel**. A 4×4 block of 256 px tiles
is 1024², which is 1.049 MP — just over. Each block is therefore composed at
native resolution and resampled once to **1000×1000**, exactly at the cap, at the
cost of a 2.3% downscale. Verified: no image the exporter produces exceeds
1.000 MP.

Scale, measured from real hiking tracks (single tier):

| Extent | Detail | Requests | Overlay tiles | Size |
|---|---|---|---|---|
| 3.9 × 3.5 km | z15, 4 m/px | 20 | 2 | ~0.5 MB |
| 3.9 × 3.5 km | z16, 2 m/px | 72 | 6 | ~1.9 MB |
| 5.9 × 5.5 km | z16, 2 m/px | 156 | 12 | ~4.2 MB |

One canyon at full detail is a couple of megabytes and a hundred-odd requests; a
100-tile budget holds roughly eight such areas. Cost is about **420 KB per
megapixel** at quality 0.75, measured against real OpenTopoMap tiles — a full
1024×1024 tile lands near 440 KB.

Keep exports to areas you actually walk. OpenTopoMap asks that its server not be
burdened by *Massendownloads*, and it moved to a smaller machine in January 2026.
A per-track export at these sizes is nothing; systematically tiling a region
would not be. Fetches run six at a time, and the confirmation states the exact
request count before anything is downloaded.

Note the overlay is largely redundant once a vector map is installed — **except**
that Garmin handhelds do not render hillshading. If shaded relief is what you
want in steep country, the KMZ is the only way to get it.

### 3. Build the vector map yourself

`splitter` + `mkgmap` compile an OSM extract (from Geofabrik) into a
`gmapsupp.img`, and `phyghtmap` generates contour lines from SRTM to fold in.
Full control over style and coverage, no scraping, but a real toolchain and a
slow first run.

---

## How it works

### Terrain basemap

| Source | Good for |
|---|---|
| **OpenTopoMap** (default) | Hiking — contours, SRTM hillshading, marked trails |
| **CyclOSM** | Outdoor detail, tracks and surface types |
| **OpenStreetMap** | Standard road rendering |

This is the one thing here that touches the network. A tile request tells the
tile server which patch of ground you are looking at, which for a record of where
you walk is worth knowing about. The basemap is **on by default**; unticking it
gives a fully offline, shape-only view, and that choice is remembered in
`localStorage`. The note beside the toggle always states which way it sits.

Attribution is rendered under the map. It is a licence condition of all three
sources (OpenTopoMap is CC-BY-SA), not decoration — leave it in place.

Over a basemap the track is drawn **magenta with a white casing**. Blue
disappears into watercourses, green into vegetation, brown into contour lines;
magenta is the GPS convention for exactly that reason.

### Two projections, on purpose

Raster tiles are cut in **Web Mercator**, so the basemap view projects the track
that way — anything else would misregister the line against the terrain beneath
it. With the basemap off the plot is **equirectangular with a `cos(lat)`
correction**, which needs no network and is a good local approximation over a
single track's extent. Without that correction a track is stretched
horizontally — 1.20× at Sydney's latitude, worse further from the equator.

There is no mapping library. A slippy map is `lon → x`, `lat → y` and some
absolutely-positioned `<img>` elements — about 60 lines, verified against an
independent implementation with round-trip error near 1e-14.

### The Custom Map export

- **Alignment.** Overlay tiles are cut on blocks of source tiles — 4×4 for the
  sharpest tier, 8×8 and 16×16 for the coarser ones — and each block's
  `LatLonBox` comes straight from the inverse Mercator of its edges. Blocks are
  composed at native 256 px and resampled once as a whole, rather than scaling
  each tile individually, which would resample across tile edges and seam.
- **Projection error.** Garmin stretches each overlay linearly between its
  `LatLonBox` edges, while tiles are Mercator. Over one 1024 px block the
  mismatch peaks at **5 cm at z16** and 21 cm at z15 — far below GPS error.
- **No dependencies.** A KMZ is a ZIP, and JPEGs are already compressed, so the
  archive is written with stored (uncompressed) entries — about 60 lines
  including a CRC-32 table, rather than a deflate library. Output verified to
  open cleanly in Python's `zipfile` with all CRCs intact.
- **Tainting.** All three tile servers send `Access-Control-Allow-Origin: *`, so
  tiles can be fetched and drawn to a canvas without tainting it. Without that
  the export would be impossible in-browser.
- **Failure handling.** If more than 2% of tiles fail to download the export
  aborts rather than writing a map with holes.

### Renaming on upload

Plenty of real filenames fail the allowlist — a browser download suffix like
`tiger-snake-canyon (1).gpx`, or accented place names. Rather than dead-ending,
choosing a file populates an editable **Save on device as** field:

| Picked | Suggested |
|---|---|
| `tiger-snake-canyon (1).gpx` | `tiger-snake-canyon_1.gpx` |
| `Track (copy) (2).gpx` | `Track_copy_2.gpx` |
| `café rün — détour.gpx` | `cafe run_detour.gpx` |
| `Ærø Østerby.gpx` | `AEro Osterby.gpx` |
| `Łódź trał.gpx` | `Lodz tral.gpx` |

Sanitising folds to ASCII, replaces runs of disallowed characters with a single
`_` (absorbing surrounding spaces), trims leading and trailing separators, caps
the stem at 64 characters, and falls back to `Track.gpx` if nothing usable
survives. Non-Latin scripts have no ASCII fallback and land on `Track.gpx` — type
a name instead.

**Sanitising is a convenience, not the security boundary.** Whatever is in the
field still has to pass the allowlist before a byte is written.

#### Why no npm package for this

The obvious candidates were measured against the allowlist; none solve it:

| Package | `tiger-snake-canyon (1).gpx` → | |
|---|---|---|
| `sanitize-filename` | unchanged | still illegal |
| `filenamify` | unchanged | still illegal |
| `@sindresorhus/slugify` | `tiger-snake-canyon-1-gpx` | eats the extension |
| `@sindresorhus/transliterate` | unchanged | |

`sanitize-filename` and `filenamify` enforce a *denylist* of characters illegal
on Windows/POSIX (`<>:"/\|?*`, control codes, reserved names like `CON`).
Parentheses, `&` and accents are perfectly legal filenames and pass straight
through — the opposite of an allowlist. `slugify` is built for URLs: it
lowercases, hyphenates and turns `.gpx` into `-gpx`, failing every case
including `Track1.gpx`.

Only `@sindresorhus/transliterate` adds anything, and only for accent folding —
which `String.prototype.normalize('NFD')` mostly covers for free. Diffing the two
across Latin-1 Supplement and Latin Extended-A shows NFD's entire gap is **21
characters** — `Æ Ð Ø Þ ß æ ð ø þ Đ đ Ħ ħ ı Ĳ ĳ Ł ł Œ œ Ə` — because those are
distinct letters, not accented forms. `app.js` inlines that 21-entry map, which
is why the zero-dependency constraint survives. The package is 56 KB of lookup
tables for the same result.

### Streaming the map image

A `gmapsupp.img` is routinely over 1 GB, which must never be buffered in memory:

```js
await file.stream()
  .pipeThrough(byteMeter(file.size, showProgress))
  .pipeTo(writable);
```

`byteMeter` is a `TransformStream` that counts bytes and repaints the progress
bar at most every 100 ms, passing chunks straight through. `pipeTo` closes the
writable on success, which is what commits the file.

`createWritable()` writes to a temporary `.crswap` file alongside the target and
renames it on close. If the write is aborted, the existing `gmapsupp.img` is left
untouched.

---

## Safety rules the code enforces

- **Validate before writing.** A GPX must be well-formed XML with a `<gpx>` root
  before a single byte reaches the device. A malformed file on the device is
  worse than no file.
- **Filename allowlist.** Path separators are stripped first
  (`split(/[/\\]/).pop()`), then the basename must match
  `/^[A-Za-z0-9 ._-]{1,64}\.(gpx|kmz)$/i`. `.`, `..` and names containing NUL are
  rejected. A name that becomes a path component on the device is never trusted,
  whether picked or typed.
- **No `innerHTML` for device-derived data.** Filenames and GPX metadata are set
  with `textContent` only.
- **Confirm before overwriting** `gmapsupp.img`, an existing GPX, or an existing
  KMZ.
- **Confirm before deleting.** `removeEntry()` is immediate and final, for both
  GPX files and custom maps. The prompt names the full path, size and mtime, and
  warns separately for the active recording.
- **Warn on firmware ceilings** before an upload, with a chance to cancel.

---

## Known constraints (by design, not bugs)

- **You must click to connect, every session.** There is no plug-in event for USB
  mass storage and no way to enumerate mounted volumes from the web platform. A
  user gesture is mandatory.
- **Permission does not survive indefinitely.** Chrome may drop the grant between
  sessions; the stored handle then needs a `requestPermission()` click.
- **WebUSB is not an alternative.** Chrome blocks protected interface classes and
  USB mass storage is one of them. The OS has also already claimed the device.
- **The basemap does not re-render on window resize.** Reopen the track.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "This browser can't do it" | Not Chromium, or not on `https`/`localhost`. Check you did not open `index.html` directly. |
| The server "doesn't start" | `python3 -m http.server` blocks by design — it never returns to the prompt. That is it working. |
| Port 8000 in use | `lsof -nP -iTCP:8000 -sTCP:LISTEN`, then `kill <pid>`. |
| Reconnect fails | The volume was unmounted or relabelled. Use **Connect volume…**. |
| Status says permission lapsed | Chrome dropped the grant. Click **Reconnect**. |
| Basemap tiles blank | Offline, or the tile server declined. The log says which. The track still draws. |
| Export refuses to run | Over the tile budget. Lower the detail, use fewer zoom levels, trim the margin, or raise the budget. |
| Custom map vanishes when zoomed out | Expected — export more zoom levels. See above. |
| Uploaded track missing on device | The eTrex imports GPX at boot — restart it. |
| Deleted map still in Setup → Map | Custom maps are also read at boot — restart it. |

---

## Files

```
index.html                       markup
styles.css                       light/dark theme via prefers-color-scheme
app.js                           all logic
sample/sample-track.gpx          420-pt synthetic loop, Sydney Harbour
sample/blue-mountains-loop.gpx   550-pt synthetic loop, Blackheath NSW
```

Both samples are synthetic, so you can exercise the viewer, the rename flow and
the Custom Map export before plugging anything in. The Blue Mountains one sits in
steep canyon country, so OpenTopoMap's contours and hillshading have something
to show.

---

## Ejecting

Always eject/unmount the volume in the OS before unplugging, especially after a
map install — the write is not necessarily flushed to flash the moment the
progress bar hits 100%.

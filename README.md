```
                 _____
                /     \
                | .-. |
                | | | |
                | '-' |
                |     |
                |     |
          ___   |     |   ___
         /   \  |     |  /   \___
        |     | |     | |    |   \
   ___  |     | |     | |    |    |
  /   \ |     |_|     |_|    |    |
 |     \|                         |
 |      \                         |
  \      '.                       |
   \       '--.__                 /
    '.            ''---..._      /
      '.                   '.   /
        '-.__________________\_/
           |                 |
           |                 |
```

```
    ____           __                ______
   / __/_  _______/ /__   ____  ____/ / __/
  / /_/ / / / ___/ //_/  / __ \/ __  / /_
 / __/ /_/ / /__/ ,<    / /_/ / /_/ / __/
/_/  \__,_/\___/_/|_|  / .___/\__,_/_/
                      /_/
```

# fuck pdf

**A free PDF viewer and editor for Windows. Free as in beer. Free as in freedom. Free as in "go fuck yourself, subscription model".**

---

## why does this exist

Because it is the year of our lord 2026 and changing **one typo** in a PDF still costs you a monthly subscription.

Because "free PDF editors" are a scam genre. You open the file. You fix the typo. You hit save. And *then* it tells you: upgrade to Pro, or enjoy your document with a giant watermark stamped across every page. Half of them want an account. The other half want your email "to send you the file". Some of them are just a web upload form wearing a trench coat, and your contract is now on someone else's server.

Because the PDF format has been an open ISO standard (ISO 32000) since 2008, and the buttons to edit it are still behind a paywall.

Because we got tired of it.

So: **every single "Pro" feature in here is free.** No trial. No watermark. No "export limit". No account. No telemetry. No cloud. No upsell banner. No "Pro" badge on any button, because there is no Pro. There is only this.

## what it does

All of it runs locally on your machine. Nothing ever leaves it.

| the thing | what they charge for it | what we charge |
|---|---|---|
| edit existing text (keeps the original font) | subscription | nothing |
| add text, images, whiteout | subscription | nothing |
| sign (draw it, type it, or use an image) | subscription, sometimes per document | nothing |
| fill forms (text, checkboxes, dropdowns), reset, flatten | sometimes free, sometimes not | nothing |
| **real** redaction (removes the text, not just a black box on top) + search-and-redact | subscription | nothing |
| merge / combine files, images to pdf | subscription | nothing |
| split, extract, insert, delete, duplicate, reorder (drag), rotate, crop, resize pages | subscription | nothing |
| watermark, headers, footers, page numbers, Bates numbering | subscription | nothing |
| password protection (AES-256) + permissions, remove passwords | subscription | nothing |
| compress / optimize, strip metadata and javascript | subscription | nothing |
| highlight, underline, strike out, sticky notes, freehand, boxes, ellipses, lines, arrows, stamps | usually free, credit where due | nothing |
| export pages to PNG / JPG, text to TXT, print | usually free | nothing |
| undo / redo for every single edit | n/a | nothing |
| a white-on-black UI with an ASCII middle finger for a logo | not available at any price | nothing |

It also opens images, EPUB, CBZ, HTML and plain text, and converts them to PDF so every tool works on them too.

### how "edit text" actually works

Most free editors fake it: they paint a white box over the old text and slap new text on top. The old text is still in the file. Search for it, copy it, it's all still there.

We don't do that. Click a line, change it, hit enter. The old glyphs are **removed** from the page content, and the new text is written in the **same font** at the same position, size and colour. Embedded fonts are usually subsets (only the letters that were used), so if your edit needs a letter the subset doesn't have, fuck pdf finds the full font installed on your system (Arial, Calibri, whatever the document used) and uses that. Only if that fails does it fall back to a standard font.

Polish, Czech, German, whatever: `Zażółć gęślą jaźń` works. It's tested.

## download

Grab an `.exe` from the releases page (or build it yourself, see below):

- `fuck-pdf-x.y.z-portable.exe` : one file, no install, run it from anywhere, a USB stick, whatever.
- `fuck-pdf-x.y.z-setup.exe` : installs it, adds a start menu entry, and shows up under "Open with" for PDFs.

The exe isn't code-signed (certificates cost money, see "why does this exist"). Windows SmartScreen will whine with "Windows protected your PC". Click **More info**, then **Run anyway**. If you don't trust it, good, you shouldn't trust random exes: read the source and build it yourself. That's the whole point.

## keyboard

| key | does |
|---|---|
| `v` `h` | select, pan (or hold `space`, or middle mouse) |
| `e` `t` | edit existing text, add new text |
| `l` `u` `k` | highlight, underline, strike out |
| `d` `r` `o` `a` | draw, box, ellipse, arrow |
| `n` `i` `s` `m` | note, image, sign, stamp |
| `w` `x` `c` | whiteout, redact, crop |
| `ctrl+z` `ctrl+y` | undo, redo |
| `ctrl+f` `ctrl+g` | find, go to page |
| `ctrl+wheel` | zoom at cursor |
| `ctrl+1` `ctrl+2` | fit width, fit page |
| `ctrl+shift+n` | night mode (inverts pages, saves your eyes at 2am) |
| `f1` | the full list |

## build it yourself

You need Node.js 20+.

```sh
npm install
npm start            # run it
npm test             # engine test suite (27 tests: editing, redaction, forms, encryption...)
npm run dist:win     # build the Windows exes into dist/
```

Building the Windows portable exe works from Linux, macOS or Windows. The installer (`setup.exe`) needs Wine when you build it on Linux.

## how it's built

- **[MuPDF](https://mupdf.com)** by Artifex does the actual PDF work: rendering, text extraction, annotations, redaction, forms, encryption, page surgery. It's a serious, battle-tested engine, compiled to WebAssembly, and it runs in a worker thread so the UI never freezes.
- **[Electron](https://www.electronjs.org)** for the window.
- Plain JavaScript, HTML and CSS for the UI. No framework. No build step. No 900 MB `node_modules` for the app itself (just MuPDF).

```
src/
  engine.mjs        every pdf operation (pure node + mupdf, unit tested)
  fontindex.mjs     reads installed fonts so edited text matches the original
  engine-worker.mjs runs the engine off the main thread
  main.js           window, files, dialogs, printing
  preload.js        the narrow bridge between the two
  renderer/         the UI: viewer, tools, dialogs, menus
test/
  engine.test.mjs   the test suite
  ui/               scripted end-to-end runs of the real app
```

## what it doesn't do (yet)

Honesty is free too.

- **OCR** for scanned documents.
- **Certificate-based digital signatures** (the cryptographic kind). The "sign" tool places a visible signature, like every free fill-and-sign tool does.
- **Reflowing whole paragraphs** when you edit text. Editing works line by line.
- XFA forms (the cursed ones), PDF/A conversion, comparing two documents.

Pull requests welcome. Angry ones especially.

## license

**GNU AGPL v3 or later.** See [LICENSE](LICENSE).

That means it's free forever, and anyone who ships a modified version has to publish their source too. Nobody gets to take this, bolt a paywall onto it, and sell it back to you. That's not an accident; that's the point.

MuPDF is © Artifex Software and is also AGPL. Electron is MIT.

## the boring legal bit

fuck pdf is not affiliated with, endorsed by, or in any way related to Adobe, Tracker Software, or anyone else who makes PDF software. No code from any of them was used. "Acrobat" and "PDF-XChange" are trademarks of their respective owners, and they can keep them. We just wanted to fix a typo without a credit card.

---

```
no subscription. no account. no telemetry. no watermark. no bullshit.
```

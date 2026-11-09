<p align="center">
  <img src="docs/logo.png" alt="fuck pdf" width="100%">
</p>

<h3 align="center">a free pdf editor for windows. it edits pdfs. that's it. that's the whole business model.</h3>

<p align="center">
  <a href="#download">download</a> &nbsp;|&nbsp;
  <a href="#what-it-does">features</a> &nbsp;|&nbsp;
  <a href="#screenshots">screenshots</a> &nbsp;|&nbsp;
  <a href="#build-it-yourself">build</a>
</p>

---

## why

You have a PDF. It has one typo in it. One.

So you go looking for a "free PDF editor". You download it. You fix the typo. You press save. And *that* is the moment it tells you saving is a premium feature. Or it saves, and stamps a fat watermark across every page. Or it wants an account first. Or an email address "to send you your file". Or it's a website that uploads your contract, your bank statement and your medical letter to a server you have never heard of, in a country you couldn't point to.

PDF is an open standard. It has been for years. The buttons to edit it are still behind a monthly subscription.

**fuck that.**

So here's the thing they charge for, minus the charge. Every feature, on, for everyone, forever. No trial. No watermark. No export limit. No account. No telemetry. No cloud. No "upgrade" button, because there's nothing to upgrade to. This is it. All of it.

## screenshots

**edit the text that's already there.** click a line, type, enter. it keeps the original font, size and colour, and the old text is actually gone, not hidden under a white box.

![editing existing text](docs/screenshots/edit-text.png)

**mark it up.** highlights, circles, arrows, sticky notes, stamps that say whatever you want.

![annotations and a custom stamp](docs/screenshots/annotate.png)

**sign it.** draw it, type it, or use an image. saved on your machine for next time.

![signing a document](docs/screenshots/sign.png)

**fill the form.** text fields, checkboxes, dropdowns. tab between fields like a normal person.

![filling a form](docs/screenshots/forms.png)

**shuffle pages around.** drag thumbnails to reorder. right-click to rotate, duplicate, delete, extract, insert.

![page tools](docs/screenshots/pages.png)

**lock it.** AES-256 passwords and permissions. no backdoor, so write the password down.

![password protection](docs/screenshots/protect.png)

**night mode** for 2am contract reading, because of course it's 2am.

![night mode](docs/screenshots/night.png)

## what it does

Everything runs on your computer. Nothing is uploaded. Nothing phones home.

| the thing | what it usually costs | what it costs here |
|---|---|---|
| edit existing text, in the original font | a subscription | nothing |
| add text, images, whiteout | a subscription | nothing |
| sign: draw, type, or image | a subscription, sometimes per document | nothing |
| fill forms, reset them, flatten them | depends on the mood of the vendor | nothing |
| **real** redaction (deletes the content, not a black box over it), plus search-and-redact | a subscription | nothing |
| merge files, images to pdf | a subscription | nothing |
| split, extract, insert, delete, duplicate, reorder, rotate, crop, resize pages | a subscription | nothing |
| watermarks, headers, footers, page numbers, Bates numbering | a subscription | nothing |
| password protection, permissions, removing passwords | a subscription | nothing |
| compress, strip metadata and hidden scripts | a subscription | nothing |
| highlight, underline, strike out, notes, freehand, boxes, ellipses, lines, arrows, stamps | sometimes free, if you sit through the upsell | nothing |
| export pages to png / jpg, all text to txt, print | sometimes free | nothing |
| clickable links (web links open in your browser, internal links jump to the page) | free, fair enough | nothing |
| undo / redo for every single edit | | nothing |
| a white on black interface with a skeleton giving you the finger | not available at any price | nothing |

It also opens images, EPUB, CBZ, HTML and plain text files and turns them into PDFs, so every tool works on those too.

### about that "edit text" thing

The usual "free" trick: paint a white rectangle over the old words and type new ones on top. The old text is still in the file. Copy it, search it, it's all still there, sitting under a white box like a body under a rug.

Not here. Click a line, change it, press enter:

- the old glyphs are **removed from the page**, for real
- the new text goes in the **same spot**, **same size**, **same colour**
- in the **same font**. PDFs usually embed only the letters they used, so if your edit needs a letter that isn't there, fuck pdf finds the full font installed on your computer and uses that. A generic font is the last resort, not the first one.
- light text on a dark background stays readable while you edit it
- Polish, Czech, German, whatever. `Zażółć gęślą jaźń` works. It's in the test suite.

## download

Two flavours:

- **`fuck-pdf-x.y.z-portable.exe`**: one file. No install. Run it from your desktop, a USB stick, a network drive, wherever.
- **`fuck-pdf-x.y.z-setup.exe`**: installs it, adds a start menu entry, and shows up under "Open with" for PDF files.

The exe isn't signed, because signing certificates cost money every year and see "why". Windows will show **"Windows protected your PC"**. Click **More info**, then **Run anyway**. And if you'd rather not trust a random exe from the internet: good instinct. The source is right here. Read it, then build it yourself.

## keyboard

| key | does |
|---|---|
| `v` / `h` | select / pan (or hold `space`, or drag with the middle mouse button) |
| `e` / `t` | edit existing text / add new text |
| `l` / `u` / `k` | highlight / underline / strike out |
| `d` / `r` / `o` / `a` | draw / box / ellipse / arrow |
| `n` / `i` / `s` / `m` | note / image / sign / stamp |
| `w` / `x` / `c` | whiteout / redact / crop |
| `ctrl+z` / `ctrl+y` | undo / redo |
| `ctrl+f` / `ctrl+g` | find / go to page |
| `ctrl+wheel` | zoom at the cursor |
| `ctrl+1` / `ctrl+2` | fit width / fit page |
| `ctrl+shift+n` | night mode |
| `f1` | all of them |

## build it yourself

```sh
npm install
npm start            # run it
npm test             # engine tests: text editing, redaction, forms, links, encryption, page surgery
npm run test:ui      # drives the real app and clicks through it
npm run dist:win     # windows portable exe + installer, into dist/
```

The portable exe builds on any OS. Build the installer on Windows.

```
src/
  engine.mjs         every pdf operation, unit tested
  fontindex.mjs      reads your installed fonts so edited text matches the original
  engine-worker.mjs  runs the engine off the UI thread, so nothing ever freezes
  main.js            window, files, dialogs, printing
  preload.js         the narrow bridge between the two halves
  renderer/          the interface: viewer, tools, dialogs, menus
test/                engine tests, scripted UI runs, windows build check
docs/                logo and screenshots
```

## what it doesn't do (yet)

Honesty is also free.

- **OCR** for scanned documents
- **certificate-based digital signatures** (the cryptographic kind). "sign" places a visible signature, which is what most people mean by signing.
- **reflowing whole paragraphs** when editing. editing works line by line.
- XFA forms (the cursed kind), PDF/A conversion, comparing two documents

Pull requests welcome. Angry ones especially.

## license

**AGPL-3.0-or-later.** See [LICENSE](LICENSE).

Free forever, and anyone who ships a modified version has to publish their source too. Nobody gets to take this, bolt a paywall on it, and sell it back to you. That's not an accident. That's the point.

---

<p align="center"><code>no subscription. no account. no telemetry. no watermark. no bullshit.</code></p>

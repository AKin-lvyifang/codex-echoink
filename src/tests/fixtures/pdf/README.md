# PDF text fixtures

These small PDFs contain synthetic test text only. They were authored as PDF objects and normalized with pypdf 6.7.3; they contain no user documents or embedded font files.

- `bilingual-multipage.pdf`: two pages, Helvetica plus STSong-Light CID font with a FontDescriptor and a ToUnicode map. Expected text includes English, Chinese, and line breaks.
- `cjk-predefined-cmap.pdf`: the same text with `UniGB-UCS2-H` instead of ToUnicode. This exercises the host's bundled CMaps. Use it with Obsidian's actual PDF.js/resources; the serverless test engine alone does not ship those CMaps.
- `encrypted.pdf`: the bilingual PDF encrypted with RC4-128, password `echoink-fixture-password`. Extraction without a password must report `encrypted`.

Both text PDFs were also parsed with the PDF.js 5.3.34 engine and bundled CMaps from Obsidian 1.13.7 in Node. This checks the asset compatibility, not the Obsidian renderer or its `app://` resource loading.

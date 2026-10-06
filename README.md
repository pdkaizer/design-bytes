# design bytes

Articles live in `articles/` as Markdown; images live in `images/`. Quick notes live in `quick-notes/` (kept out of git, so they stay on this machine).

## Writing with DB Writer

```sh
npm start        # opens the writer at http://localhost:4321
```

- Everything autosaves to `articles/<name>.md`, so you can keep using git or VS Code alongside it. If a file changes on disk while you're editing, the writer asks which version to keep.
- Paste, drop or pick an image and it's saved to `images/` and inserted as `![](../images/…)`.
- Write / Split / Preview views, focus mode, light & dark themes, three editor fonts.
- The status bar shows word count, reading time, and writing suggestions (links pasted twice, repeated words, extra spaces).
- Each article has a status — **Backlog → Editing → Final → Published** — set from the picker in the top bar and stored at the top of the file:
  ```
  ---
  status: published
  ---
  ```
  New articles start in Backlog. The sidebar can filter by status.
- Final and Published articles get a **Copy for Ghost** button: it copies the Markdown without the status block or the title heading (Ghost has its own title field), with double-pasted links repaired. The ⋯ menu has "Copy Markdown with title" if you want the heading too.
- **Suggested alternatives:** highlight a word, phrase or sentence and click the **Alternatives** chip (or press ⌘J) to get five rewordings from Claude. Click one, or press 1–5, to swap it in; ⌘Z undoes it. This needs an Anthropic API key in a `.env` file at the project root (it's git-ignored):
  ```
  ANTHROPIC_API_KEY=sk-ant-…
  ```
- **Notes:** each article has a private notes area, shown or hidden with the **Notes** button in the status bar (⌥⌘N). Highlight text and click **To notes** (or ⌥⌘M) to move it out of the article and into the notes. Moved text shows up as a card in the notes panel with a **Put back** button that reinserts it where it came from — found by the words around it, so it still works after you've edited elsewhere. The notes panel slides in from the right, next to the editor; hover a card and a **Goes back here** marker shows the exact spot in the article. Notes are saved at the end of the same file inside an HTML comment, so they never appear in the preview, word count, published pages or Copy for Ghost:
  ```
  <!-- notes
  A sentence I cut…
  -->
  ```
- **Version history:** the **History** button in the status bar (or ⋯ → Version history) lists earlier versions of the article by day. Pick one to see what's changed since (added and removed text highlighted) or a preview of how it read, then **Restore this version** if you want it back — your current text is saved as a version first, so restoring can be undone. While you edit, a version is kept every few minutes; you can also save a named one ("Before restructuring") any time. Versions live in `articles/.history/` (git-ignored, so drafts stay private). Older automatic versions thin out — everything from the last two days, then hourly for two weeks, then daily — while named versions are kept for good.
- **Readability:** click **Readability** in the status bar to highlight long sentences (25+ words) and very long ones (35+), and underline passive voice, adverbs and wordy phrases or filler. Each type can be switched on or off, the button shows the article's reading grade (Flesch–Kincaid), and putting your cursor in a highlight shows why it's marked. Code, headings, link URLs, the status block and notes are ignored.
- **Import:** the import button next to **New** (or dropping `.md` / `.txt` files on the window) brings Markdown files in — as articles in Backlog on the Articles tab, or as quick notes on the Quick notes tab. Before importing, a dialog shows each file's proposed file name, which you can change; it warns if a name is already taken. Front matter from other tools (Obsidian, Jekyll, Ghost exports: `title:`, `tags:` lists…) is kept, and a `title:` there is used when the file has no heading.
- **Title and file name in front matter (articles):** an article's title lives in `title:` and its file name in `slug:`, so the body starts with the content itself:
  ```
  ---
  title: The Conductor's Role
  slug: the-conductors-role
  status: backlog
  created: 2026-10-01
  ---
  ```
  The preview and published pages show the title at the top. Change `slug:` and, once your cursor leaves the front matter, the file is renamed to match (if the name is taken, it says so and keeps the old one). ⋯ → Rename file… updates `slug:` too. Quick notes don't use these — their first line is the title.
- **Date added:** every article and quick note records when it was added as `created:` in its front matter (e.g. `created: 2026-10-04 19:32`), set automatically on New and on import (an imported file that already has a `created:` keeps it). It shows in the sidebar and under the title; edit the line to change it.
- **Quick notes:** switch the sidebar to **Quick notes** for jotting things down outside of Design Bytes. **New** starts a note straight away — no title needed; its first line becomes the title. Notes get autosave, preview, Readability, Alternatives and version history, but no status, Ghost copy or notes panel, and they're never published or built.
- Deleted articles go to `articles/.trash/`, along with their history.

| Shortcut | Action |
| --- | --- |
| ⌘B / ⌘I / ⌘⇧X | Bold / italic / strikethrough |
| ⌘K | Link (or paste a URL over selected text) |
| ⌘E | Inline code (code block if several lines are selected) |
| ⌘⌥2 / ⌘⌥3 | Heading / subheading |
| ⌘⇧8 / ⌘⇧7 / ⌘⇧9 | Bulleted / numbered / checklist |
| ⌘⇧. | Quote |
| Tab / ⇧Tab | Indent / outdent list items |
| ⌘J | Suggest alternatives for the highlighted text |
| ⌥⌘M | Move the highlighted text to notes |
| ⌥⌘N | Show / hide notes |
| ⌘S | Save now |
| ⌘/ | Cycle Write → Split → Preview |
| ⌘. | Focus mode (Esc to leave) |
| ⌘\ | Toggle sidebar |

## Publishing

```sh
npm run build    # renders Published articles to dist/ (index + one page per article)
```

"Download as HTML" in the ⋯ menu exports a single, self-contained article with its images embedded.

## Under the hood

Node 22.9+ and one dependency, the Anthropic SDK (`npm install`).

- `editor/lib/markdown.js` — the Markdown renderer, shared by the browser and the build
- `editor/server.js` — local server and file API (listens on 127.0.0.1 only)
- `editor/lib/suggest.js` — rewording suggestions via the Claude API
- `editor/build.js` — static site build
- `editor/public/` — the editor UI; `article.css` is used by both the preview and published pages
- `npm test` — renderer tests

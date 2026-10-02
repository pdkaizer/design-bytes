# design bytes

Articles live in `articles/` as Markdown; images live in `images/`.

## Writing

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
- Deleted articles go to `articles/.trash/`.

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

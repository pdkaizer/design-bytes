---
title: Why Product Designers Need  Markdown Now
slug: why-product-designers-need-markdown-now
tags:
  - Craft
  - Code
  - Tools
  - Article
excerpt: "Markdown’s constraint has quietly become strategically more important, because it’s the format AI models read and write natively."
feature_image: ../images/2026-07-Designer-markdown-1.png
status: published
date: 2026-07-23
created: 2026-10-15 20:54
---

> **Fluent in plain text**

I still remember the first time I opened a .md file and felt the same small satisfaction I used to get after finishing forming a piece of pottery on my wheel — nothing decorative, nothing wasted, just the form of the vessel. That’s an odd sensation to have about a file format. But Markdown has a way of rewarding you for thinking clearly, and in a design practice increasingly mediated by AI, that reward is becoming a professional advantage.

Most product designers have brushed up against Markdown without registering it as a skill. It’s the asterisks in a Notion doc, the formatting in a GitHub README, the syntax quietly rendering your comments in Figma, the plain text you type into a chat window with an AI model. It’s everywhere, and because it’s everywhere, it’s easy to treat as invisible infrastructure — something that happens to text rather than something you deliberately practice. I want to make the case that this is a mistake, and that fluency in Markdown deserves a place next to typography and prototyping as a core literacy of the craft.

## A Short History of a Small Idea

Markdown was created in 2004 by [John Gruber](https://daringfireball.net/), with help from Aaron Swartz, as a reaction to a very specific frustration: writing in HTML is tedious. Gruber wanted a way to write for the web using plain text that stayed readable on its own, before and after conversion — no tags cluttering the sentence, no angle brackets breaking the flow of thought. The syntax he settled on borrowed conventions writers already used informally: asterisks for emphasis, dashes for lists, blank lines for paragraphs. It wasn’t inventing a new language so much as formalizing the shorthand people already reached for in plain-text emails. To quote John Gruber:

> ”I often say that Markdown is a convention, not a language or format. The format is plain text. The convention is how to structure the plain text.”

What’s notable is how modest the ambition was, and how far it traveled anyway. Markdown spread through blogging platforms in the mid-2000s, then became the default documentation format on GitHub, then the backbone of tools like Ghost, Notion, Obsidian, and nearly every modern writing surface a designer or engineer touches in a given week. It succeeded not because it was powerful, but because it was small enough to disappear into the writing itself.

### Constraint as Craft, Not Limitation

That smallness is the part worth sitting with. Markdown gives you a handful of symbols — a hash for a heading, an asterisk for emphasis, a dash for a list, a bracket for a link — and very deliberately nothing else. There’s no font picker, no color palette, no seventeen heading styles to choose between. And that constraint is exactly the point.

This is the same logic behind mise en place: a good station isn’t full of options, it’s stripped down to what you actually need, arranged so you stop thinking about the tools and start thinking about the work. A cook with a cluttered station spends energy on decisions that have nothing to do with the dish. A designer fighting a bloated rich-text editor spends energy on decisions that have nothing to do with the idea. Markdown removes the clutter. You’re left with structure and words, which is usually what you meant to be thinking about in the first place.

There’s a shokunin instinct here too — the idea that mastery isn’t about accumulating more tools, but about developing total command of a small, well-chosen set. Shoji Hamada didn’t need forty glazes to make work that mattered; he needed to deeply understand the handful he used. Markdown asks something similar of a designer: not “learn more software,” but “get genuinely fluent in this one, small, durable thing.”

### The Real Reason This Matters Now

**Here’s the argument I actually want to make, though:** Markdown’s constraint has quietly become strategically more important, because it’s the format AI models read and write natively.

When you prompt an AI tool, plain text with Markdown conventions is the clearest way to specify structure. Ask for a comparison, and the model will often reach for a table. Ask for a process and it reaches for a numbered list. Ask it to distinguish a code snippet from prose, and it reaches for a fenced code block. This isn’t incidental — Markdown is the layer where intent and structured output meet. A designer who can read that structure fluently and write prompts that specify it precisely, is having a fundamentally more precise conversation with the tool than one who’s describing structure vaguely in prose and hoping the model guesses right.

This is the same instinct behind Why Before What: before adopting any tool, ask what problem it actually solves. The problem Markdown solves is that an AI workflow has translation loss. If you can write “give me this as a table with three columns” instead of “can you make it look organized,” you’ve removed a layer of interpretation between what you meant and what you got. That’s not a small thing when you’re iterating quickly with a model, and it’s a skill, not a preference — the difference between directing an AI output and simply hoping it lands somewhere useful is often just this fluency.

A quick example, because the syntax really is this small:

`### Section heading`

A paragraph of body text, with `**bold**` for emphasis and a `[link](https://example.com)` when needed.

`- A list item`  
 `- Another list item`

`| Table header: Option | Table header: Tradeoff |`  
 `|---|---|`  
 `| Faster iteration | Less polish |`  
 `| Slower iteration | More polish |`

**Transforms to:**

### Section heading

A paragraph of body text, with **bold** for emphasis and a [link](https://example.com) when needed.

- A list item
- Another list item

| Table header: Option | Table header: Tradeoff |
| --- | --- |
| Faster iteration | Less polish |
| Slower iteration | More polish |

### Where This Already Shows Up in Your Week

If you look closely, Markdown isn’t a new tool to add to your practice — it’s already load-bearing in most of it. Product requirement docs and specs in Notion are written in it, whether or not anyone names it that way. Design system documentation, changelogs, and PR descriptions on GitHub live entirely in it. Figma’s Dev Mode annotations and comments render it. Ghost, this very publication, is built on it end to end.

None of this is an argument that designers should learn to code. It’s the same distinction I’ve made about code literacy generally: understanding a language well enough to read it, reason about it, and communicate precisely in it is different from being the one who builds with it professionally. Markdown fluency is a literacy argument, not a development argument. You don’t need to become an engineer to benefit from being able to write a clean spec that an engineer, or a model, can parse without friction.

### Fluency as Amplification

The payoff mirrors the broader case for design orchestration. As AI tools take on more of the mechanical work of design and development, the designers who get the most out of them aren’t the ones with the flashiest prompts — they’re the ones who **understand the underlying structure well enough to direct precisely and evaluate what comes back critically**. Markdown fluency is a small, unglamorous piece of that foundation. It’s the plain-text equivalent of knowing your materials before you shape them.

I think about the leather work I did in high school, and the pottery I threw for almost two decades after that. In both crafts, the tools that I reached for more than any other and mattered most were the plain, well-kept ones you understood completely. Markdown belongs in that category now. It’s not exciting. It doesn’t do anything on its own. But understood well, it removes friction between what you mean and what gets made, and in a practice increasingly mediated by AI, that friction is exactly where the difference between a good outcome and a mediocre one tends to live.

> The best tools in any craft are rarely the most powerful ones — they’re the ones you understand completely.

### A place to learn

I feel so strongly about this, I have created a [little learning site](https://pdkaizer.github.io/github-for-designers/) hosted on GitHub or go right to the [GitHub repo](https://github.com/pdkaizer/github-for-designers).

---

This piece was developed in collaboration with AI to do research and a human editor, with full editorial direction and ownership by the author.

A special thanks to John Gruber for creating Markdown and for reviewing my description of its history.

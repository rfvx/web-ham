# Contributing to Web Ham

First off, thanks for taking the time to contribute! Please read the relevant
section below before making your contribution — it makes things easier for
everyone involved.

> And if you like the project but just don't have time to contribute, that's
> fine. There are other easy ways to support it:
>
> - Star the project
> - Tell other hams about it — at club meetings, nets, or online
> - Refer to it in your own project's readme

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [I Have a Question](#i-have-a-question)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Enhancements](#suggesting-enhancements)
- [Your First Code Contribution](#your-first-code-contribution)
- [Improving the Documentation](#improving-the-documentation)
- [Style Guides](#style-guides)

## Code of Conduct

By participating in this project you are expected to keep discussions friendly
and on-topic, and to treat other operators with respect — the same courtesy the
ham radio community expects on the air.

Report unacceptable behavior to the maintainer via a private GitHub message
rather than in public issues.

## I Have a Question

Before asking, please:

1. Read [`docs/architecture.md`](docs/architecture.md) — most questions about
   how Web Ham works are answered there.
2. Search existing [Issues](https://github.com/rfvx/web-ham/issues) — someone
   may have already asked yours.
3. If your question relates to a bug, gather the details listed in
   [Reporting Bugs](#reporting-bugs) first.

If you still need an answer, [open an Issue](https://github.com/rfvx/web-ham/issues/new)
with as much context as possible (browser, OS, radio model).

## Reporting Bugs

### Before submitting a bug report

A good bug report shouldn't leave maintainers chasing you for more
information. Please check the following first:

- You're on the latest version of Web Ham.
- The problem is really a bug and not an environment issue — e.g. a browser
  without Web Serial, or an unsupported radio profile.
- No existing [issue](https://github.com/rfvx/web-ham/issues?q=label%3Abug)
  already covers it. If one does, add your details as a comment instead of
  opening a new one.

### How do I submit a good bug report?

> ⚠️ **Never report security vulnerabilities publicly.** Use GitHub's private
> vulnerability reporting (the **Security** tab on the repository) instead of
> opening a public issue.

We use GitHub issues to track bugs. When you
[open one](https://github.com/rfvx/web-ham/issues/new), include:

- **Expected behavior** vs **actual behavior**
- **Reproduction steps** someone else can follow — ideally a minimal case
- **Your setup**, which matters a lot for radio software:
  - Browser and version (Chrome/Edge/Firefox), desktop or mobile
  - Operating system and version
  - Radio make/model and which profile you selected
  - Serial adapter/chip if relevant (FTDI, CP210x, CH340…)
- Any **console output** from the browser DevTools, and serial log output if
  available
- Whether the issue reproduces reliably

## Suggesting Enhancements

Enhancement suggestions are tracked as [GitHub issues](https://github.com/rfvx/web-ham/issues).
When suggesting one:

- Use a **clear, descriptive title**.
- Give a **step-by-step description** of the enhancement, describing current
  behavior and what you expected instead.
- Include **screenshots or recordings** if they help show the problem.
- **Explain why it would be useful** to most Web Ham users, not just one
  operating style. Features useful only to a small subset may be better kept
  out of core — but make your case!

Check that the idea hasn't already been suggested; if it has, comment on the
existing issue.

## Your First Code Contribution

Web Ham has **no build step**: native ES modules served statically, no
bundler, no TypeScript, no runtime npm dependencies.

To get started:

```bash
npm start          # serve locally on http://localhost:4173
./check.sh         # JS syntax, required element IDs, duplicate IDs, CSS
node test/test-cat-codecs.mjs    # CAT wire codecs
node test/test-grid.mjs          # Maidenhead / distance / bearing
```

Radio control requires a Chromium-based browser or Firefox 151+ with Web
Serial; everything else works anywhere.

Before writing code, skim [`docs/architecture.md`](docs/architecture.md) and
respect the layering rule: `main → shell + apps → connectors → utils`.
Mini-apps never import each other; everything arrives through the shared
`ctx` object.

Adding a mini-app: create `js/apps/<id>/index.js` exporting
`{ id, title, mount(panelEl, ctx) }`, register it in `js/main.js`, and add a
`VIEW_ORDER`/`VIEWS` entry in `js/shell/shell.js`.

Run `./check.sh` before submitting — it catches most mechanical mistakes.

## Improving the Documentation

Documentation lives in:

- [`README.md`](README.md) — overview and quick start
- [`docs/architecture.md`](docs/architecture.md) — structure, event channels,
  known wrinkles
- [`docs/deploying.md`](docs/deploying.md) — hosting notes

Corrections, clarifications, and new guides are welcome. If you find
something documented that no longer matches reality, that's a valuable fix —
please open an issue or PR. Keep the tone honest: this project documents its
known problems rather than hiding them.

## Style Guides

### Commit messages

- Short imperative summary line, e.g. `Fix FT8 slot timer drift`, not
  `Fixed some stuff`
- One logical change per commit where practical
- Reference issues in the body (`Fixes #12`) when applicable

### Code style

- Match the style of surrounding code; there is deliberately no formatter or
  linter config beyond `check.sh`
- Plain ES modules, no dependencies unless discussed in an issue first
- Vendored third-party code goes under `vendor/` and is never hand-edited

## Attribution

This guide is based on the template from
[contributing.md](https://contributing.md/generator).
# Changelog

All notable changes to **Mattccessibility Tool** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] - 2026-10-06

### Fixed
- **Tab trail now matches real Chrome Tab order.** Checked against real Tab, Shift+Tab and arrow-key presses in Chromium 153 (see `qa-test-site`).
  - **Radio groups:** each native group is one stop, as in Chrome. The stop is the checked option, or the first option in Tab order when none can take focus. A "↕ N options" tag and dotted outlines show the options reached with arrow keys. "You are here" stays on the group while you arrow between options.
  - **Stops that were missing:**
    - `contenteditable` regions
    - Scroll areas with nothing focusable inside (Chrome makes these Tab stops)
    - Image-map `<area>` links
    - Controls inside web components (Shadow DOM), including slotted content
    - Controls inside same-origin iframes
  - **Multi-press stops are labelled:** date/time fields ("⇥ parts"), media players and cross-origin frames each show a tag, with a fuller hint in the Tab drawer.
  - **New flow anomalies:**
    - ARIA widgets where every item is a separate Tab stop (for example, a tablist without roving tabindex)
    - Radio buttons with no `name`, which are not grouped
- **False positives removed:**
  - Skip links parked off-screen and revealed on `:focus` are no longer reported as hidden focusable content or as screen-reader barriers.
  - Card-style radios and checkboxes (visually hidden input with a visible label) are no longer reported as hidden.
  - Text inside a scroll area no longer counts as overlapping the content below it.
  - Empty elements are reported as empty, not as hidden content.
- **No double counting.** A defect axe already reports is not reported again by the tool's own rule. This covers link-name / area-alt vs. `af-link-no-text`, aria-hidden-focus vs. `af-hidden-focusable`, target-size vs. `af-target-size`, and meta-viewport vs. `af-viewport-zoom`.

### Changed
- **Side panel tidy-up.**
  - Spacing and type now follow one consistent scale.
  - The score ring's glow no longer clips, and the six severity chips are replaced by a single severity row.
  - WCAG rule cards are collapsed to one row by default.
  - Each element gets a filled cyan **🎯 Locate** button and a green **✦ Preview Fix** button, which reads "Previewing · Revert" while active. Failure details and code sit behind a Details button.
- **Tab trail.**
  - Straight lines with arrowheads by default, with a toggle for gently curved lines.
  - Only stops that a real Tab press reaches are included.
  - A "You are here" marker follows real focus, and Prev / Next buttons call real `.focus()`.
- **Live updates.** The tab trail and the screen-reader HUD watch the page. When content is revealed, inserted or hidden, the Tab and Screen Reader drawers update in place and show "● Live".
- **Screen reader simulation.**
  - Follows the accessibility tree: it skips `display:none`, `hidden`, `inert`, `aria-hidden` and closed `<details>`/`<dialog>` content.
  - "Skip content hidden from view" is now **on by default**.
- **Mobile simulator.**
  - The phone is always centred and scaled to fit, so it is never clipped.
  - On windows 960px or wider, the issues drawer docks on the right.
  - Mouse-wheel scrolling is native. Dragging behaves like iOS, with 1:1 tracking, flick momentum and a rubber-band at the edges.
- **No best-practice findings.** Only WCAG 2.x A/AA failures are reported, scored or exported. Removed: `target="_blank"` without `noopener`, empty `href`, `javascript:void(0)`, non-skip broken anchors, and axe `best-practice` rules.

### Added
- Violations for content that receives focus but isn't visible (`af-hidden-focusable`, 2.4.7 / 2.4.11) and content that is announced but not visible (`af-hidden-announced`, 1.3.2).

## [1.4.0] - 2026-10-05

### Rebuilt
- The whole extension was rebuilt from `REPLICATION_SPEC_SHEET.md` v1.4.0. The previous code and its git history were removed. The vendor libraries and icons were kept: axe-core 4.13.0, jsPDF and jsPDF AutoTable.

### Added
- Side panel UI with Welcome, Progress, Results and Error views, and six results drawers: WCAG issues, mobile and responsive layout, screen reader simulation, tab order, vision lenses, and link integrity.
- An eight-stage audit: axe-core with `preload: false`, the ARIA linter, `:hover` contrast checks, the screen reader assessment, tab order, links, and mobile layout.
- Screen reader simulation for VoiceOver, TalkBack, NVDA and Narrator, with Web Audio earcons and the on-page HUD.
- In-page phone simulator with five devices. A service-worker DNR rule (ID 2001) removes frame-blocking headers on sub-frames so pages can load in it.
- Tab-Trail SVG overlay, 13 vision lenses, the element highlighter, and live CSS fix preview.
- Client-side vector PDF report.

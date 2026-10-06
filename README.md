# Mattccessibility Tool (Chrome Extension)

A standalone Chrome extension (Manifest V3) that audits any web page against **WCAG 2.2 Level AA**. It opens in Chrome's side panel next to the page you're testing. Everything runs locally in your browser: there is no server, no account and no tracking.

---

## Features

1. **WCAG 2.2 AA audit**
   - Runs Deque axe-core with the WCAG 2.0, 2.1 and 2.2 A/AA rule tags.
   - Adds an ARIA linter: label in name (2.5.3), generic labels such as `aria-label="button"`, and icon contradictions such as an ✕ icon labelled "Search".
   - Checks text and boundary contrast in the **`:hover` state**, not just at rest, and suggests CSS fixes.
   - Gives a 0–100 compliance score, a grade from A+ to F, and a risk level.
2. **Screen reader simulation** for Apple iOS VoiceOver, Android TalkBack, NVDA and Windows Narrator.
   - Each uses its own announcement order and synthesised sound cues (earcons), with live speech.
   - An on-page HUD lets you navigate the page as each screen reader would: swipe, double-tap, rotor or granularity, and quick-nav keys.
   - Gives a separate 0–100 screen reader score covering headings, landmarks, labels, focus and image text.
3. **Tab order and Tab-Trail overlay**
   - Shows the keyboard focus order, flags positive `tabindex`, and checks the skip link.
   - Draws numbered badges joined by curved lines across the page. Lines are coloured red or amber where focus jumps up or backwards.
4. **Mobile and responsive layout audit**
   - Checks the viewport meta tag, overlapping elements, horizontal overflow, touch targets under 24×24px (AA) or 44×44px (advisory), crowded targets, and sticky elements that cover more than 30% of the screen.
   - An **in-page phone simulator** shows the page on iPhone 16 / 15 Pro, iPhone SE, Galaxy S24, Pixel 8 or iPhone 16 Pro Max. It has a rotate button, drag-to-scroll touch emulation, and a drawer listing that device's issues.
5. **Vision and reading impairment lenses**
   - Colour vision: protanopia, deuteranopia, tritanopia and achromatopsia.
   - Low vision: cataracts, glaucoma, macular degeneration, diabetic retinopathy, reduced contrast sensitivity, severe myopia and photophobia.
   - Other: astigmatism / diplopia and visual snow.
   - A floating "Reset Normal" button turns the lens off.
6. **Link integrity:** flags empty `href`, `javascript:void(0)`, anchors pointing at ids that don't exist, `target="_blank"` without `rel="noopener noreferrer"`, and generic link text such as "click here".
7. **Element highlighter and fix preview**
   - "🎯 Locate" scrolls to any issue and draws a pulsing ring around it, with a diagnostic badge.
   - "Preview Fix" applies the suggested CSS live on the page so you can check it. "Revert" undoes it.
8. **PDF report:** a multi-page vector PDF with a cover scorecard and sections for violations, screen reader, tab navigation and mobile layout. It's generated entirely in the browser.

---

## Installation (Chrome / Edge / Brave)

1. Open `chrome://extensions/` (or `edge://extensions/`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `AuditExtension` folder (the one containing `manifest.json`).
4. Pin **Mattccessibility Tool** from the extensions menu (🧩).
5. *(Optional)* To audit local `file://` pages, open the extension's **Details** page and turn on **Allow access to file URLs**.

## Running an audit

1. Go to the page you want to test, then click the extension icon to open the side panel.
2. The current page's URL is filled in for you. You can change it if you want to audit a different page.
3. Click **⚡ Run Audit**. The audit runs in four stages: navigate → inject the rules → audit → build the scorecard.
4. Open each drawer to see that area's results. Use **🎯 Locate** to find an issue on the page, and the simulator buttons to try the on-page tools.
5. Click **📄 Download PDF Report** to save `WCAG_2.2_Compliance_Report.pdf`.

## Permissions

| Permission | Why it's needed |
|---|---|
| `sidePanel` | Shows the auditor next to the page. |
| `scripting`, `activeTab`, `tabs` | Injects axe-core and the audit engine into the page you're testing, and handles navigation. |
| `declarativeNetRequest` | Removes frame-blocking headers on sub-frames so sites can load inside the phone simulator. |
| `downloads` | Saves the PDF report. |
| `tts` | Backup text-to-speech if the Web Speech API isn't available. |
| `storage` | Saves your preferences. |

> **Security note:** to make the phone simulator work, the `declarativeNetRequest` rule removes `X-Frame-Options`, CSP and cross-origin isolation headers from **every** sub-frame response while the extension is enabled. That weakens clickjacking protection for embedded frames on every site you browse. Disable the extension when you're not using it.

## To do

- [ ] **One-click bug report templating:** turn any finding into a ready-to-paste bug report.
- [ ] **Colour-blindness impact of low contrast:** show which types of colour blindness each low-contrast finding affects.
- [ ] **List axe "needs review" items:** the summary counts them, but the elements are never shown. This covers about 8 rules, including bypass and duplicate IDs.
- [ ] **Check the Tab Trail in Safari and Firefox:** it has only been verified against Chrome, and the other browsers differ (for example, around scroll areas).
- [ ] **List stops inside cross-origin iframes:** the Tab Trail can only tag these frames as a single stop.
- [ ] **Automated tests for closed Shadow DOM and audio autoplay:** neither is covered by the QA test site yet.
- [ ] **Add the QA test site to the repo:** publish it with GitHub Pages so the team has a shareable link.

See [CHANGELOG.md](CHANGELOG.md) for the version history.

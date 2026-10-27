# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

> Electron 45 desktop app (Mac + Windows) whose UI is a React 19 web renderer. Native desktop affordances (app menu, file dialogs, drag-and-drop) apply; no mobile layout is required, but windows can be resized down to about 1100 px wide.

## Users

- **运营** at a K12 online-education company (primary-school English line). They collect school exam papers, produce analysis for the boss, cut parent-facing material from it, and tell tutors what to emphasise. Their English is ordinary, they don't know grammar terms, and they aren't technical. They're busy and want usable output in a few clicks.
- **辅导老师**, of uneven ability. The weaker ones aren't English majors and aren't comfortable with software. They check AI-tagged questions, look up key and error-prone points, pull original-paper screenshots for lessons, and explain to parents in plain words what a child should practise.
- **Readers of exports, who never open the app:**
  - **老板**: wants decisions — 教研重点 and 课程卖点.
  - **家长**: wants plain words and what to practise at home.

## Product Purpose

Turn a pile of school exam papers (PDF, photos, Word) into knowledge-point evidence: what each grade tests, how this year differs from earlier years, and what is key, difficult or error-prone. Every claim is backed by a screenshot of the original question, and the result goes into reports that each audience can read. Success means a non-English-specialist operator or tutor gets from import to a shareable report without help, and every number is traceable to real questions.

## Positioning

- **Offline:** runs on the user's own machine, with no login and no server.
- **Numbers vs. AI:** every statistic is computed locally from reviewed questions; the AI only interprets and never invents numbers.
- **Evidence:** every conclusion links back to the original paper's question crop.

## Operating Context

- **Where it's used:** office computers by day, at home in the evening (tutors preparing lessons), and **projected in meetings** to present to the boss. All three are confirmed.
- **Workflow:**
  1. Batch-import papers.
  2. AI parses them; papers wait in a processing queue.
  3. Tutors review the questions in a three-column review page.
  4. Analysis dashboard: distribution, year-over-year comparison, key and difficult points, two-way specification table.
  5. AI report.
  6. Export to PDF or Markdown, or copy the text into WeChat.
- **AI:** the user's own DeepSeek key. An AI generation takes about 2–3 minutes.

## Capabilities and Constraints

- **Stack:**
  - Electron, React 19, TypeScript, Ant Design 6, ECharts 6, TanStack Query, `node:sqlite`.
  - No native npm modules.
  - Everything works offline: no CDN fonts or remote assets at runtime; fonts must be bundled.
- **Language:** the UI is in Chinese, while the content (questions, options) is English.
- **Charts:** treemap, bar charts, heatmap/matrix.
- **Must not be lost:** keyboard shortcuts (J/K, Enter) on the review page, and drag-and-drop import anywhere in the window.
- **Exports:** PDF reports must render Chinese on Windows (font fallback chain).

## Brand Commitments

- None. The user said to design freely ("没有，自由设计"). The product name is 「英语校考分析工作台」.
- The user explicitly rejects (corrected answer):
  - the **old-style admin back office**: grey ground, blue buttons, full-screen tables, which is what it looks like now;
  - the **kindergarten-cartoon** look: candy colours and round mascot illustrations that read as unprofessional.
- The user did not reject the Dribbble look or the dark-terminal look.
- The user called the current default-Ant-Design look ugly ("太丑了，没有审美").

## Evidence on Hand

- Real parsed papers: two grade-4 finals (2024–25 and 2025–26), with samples in `samples/`.
- Synthetic sample data: 12 papers.
- Persona usability reports, in `docs/体验报告/`.
- Absences that must not be fabricated: no customers, no logo, no testimonials.

## Product Principles

1. **Plain words first.** No grammar jargon or internal codes on screen without a plain-language gloss and an example sentence.
2. **Evidence beside every claim.** A number or conclusion is always one click from the original question.
3. **The right version for each reader.** The boss sees decisions, parents see what to practise, teachers see how to teach it.
4. **Honest about small samples.** Don't present one paper's pattern as a trend.
5. **Calm under waiting.** AI takes minutes, so always show what is happening and never lose work.

## Accessibility & Inclusion

- Must stay legible when projected: large type for key numbers, high contrast, and colour never the only carrier of meaning.
- Light and dark themes are both required.
- Many users have low tech confidence, so actions are labelled with words, not icon-only.

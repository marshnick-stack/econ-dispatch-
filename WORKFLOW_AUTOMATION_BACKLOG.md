# Workflow Automation Backlog

A living list of repeated tasks and pain points across **teaching, trading, Airbnb, and website
development**, each tagged with the mechanism most likely to help:

- **Loop** — runs on a schedule/interval (poll, refresh, recap). Good for "do this every morning / week".
- **Goal** — a standing objective tracked over time, not a single run (coverage, P&L, tax records).
- **Skill** — an on-demand reusable procedure you invoke when you need it (`/skill-name`).

> **Status legend:** `grounded` = inferred from your actual code in this repo · `to-confirm` = a sensible
> guess seeded for you to correct/delete · Priority is my suggestion, not a rule.

> **Note from Claude:** I don't have a saved profile of your habits in this environment. The teaching and
> website items are grounded in The Econ Dispatch codebase; the trading and Airbnb sections are starter
> guesses. Edit ruthlessly — the point is to get the list out of your head and onto paper.

---

## 1. Teaching (IGCSE 0455 + IB Economics)

| # | Pain point / repeated task | Frequency | Mechanism | What it would do | Status |
|---|---|---|---|---|---|
| 1 | Daily econ news digest (micro/macro/global) | Daily | Loop | Pre-warm the digest cache before your first lesson so it never loads cold in class; alert if generation fails | grounded (`api/digest.js`) |
| 2 | Dead/wrong article links in the digest | Daily | Skill/Loop | Validate every `url` the model returns (HTTP 200, not a 404/paywall) and regenerate any broken story before students see it | grounded (links are LLM-generated, a known failure point) |
| 3 | Adding teaching videos to the library | Weekly+ | Skill | Take a YouTube/article URL and auto-fill title, section (micro/macro/global), topic and teacher note — instead of typing each field | grounded (`api/videos.js`) |
| 4 | Writing the IGCSE-link + IB-link for a news story | Per story | Skill | Generate the "exam angle" tying a story to 0455 concepts and to IB Units 2–4 | grounded (digest prompt) |
| 5 | Making worksheets / structured questions on a topic | Weekly | Skill | Produce IGCSE structured Qs or IB-style questions + a diagram brief from a topic name | to-confirm |
| 6 | Model answers & mark schemes | Weekly | Skill | Generate model answers against IB mark bands / IGCSE rubric for a given question | to-confirm |
| 7 | Marking & feedback on student essays | Weekly | Skill | Grade an essay against the band descriptors and return targeted feedback | to-confirm |
| 8 | Revision flashcards / key-term lists | Per topic | Skill | Build flashcards or definitions for a syllabus topic | to-confirm |
| 9 | Differentiating one story for IGCSE vs IB | Per story | Skill | Already half-built in the digest — extend to full lesson snippets at two levels | grounded |
| 10 | Syllabus coverage tracking across the term | Ongoing | Goal | Track which 0455 / IB units you've taught vs. what's left, flag gaps before exams | to-confirm |
| 11 | Starter activities / lesson plans | Daily/weekly | Skill | Generate a starter or full lesson outline from a topic + class level | to-confirm |

## 2. Trading

| # | Pain point / repeated task | Frequency | Mechanism | What it would do | Status |
|---|---|---|---|---|---|
| 12 | Pre-market prep / economic calendar check | Daily | Loop | Pull the day's data releases (rates, CPI, GDP) — overlaps neatly with your econ teaching | to-confirm |
| 13 | Watchlist / market recap | Daily/weekly | Loop | Summarise overnight moves on your tickers each morning | to-confirm |
| 14 | Trade journal logging | Per trade | Skill | Capture entry/exit, size, rationale into a structured log in one step | to-confirm |
| 15 | Setup screening against your rules | Daily | Loop/Skill | Scan for setups matching defined criteria and surface only the qualifying ones | to-confirm |
| 16 | Weekly/monthly performance & P&L review | Weekly/monthly | Goal | Aggregate the journal into win-rate, R-multiple, drawdown trends | to-confirm |
| 17 | Risk / position-sizing checks | Per trade | Skill | Given account size + stop, compute size and flag if it breaches exposure limits | to-confirm |
| 18 | Strategy backtest / rule check | Ad hoc | Skill | Run a defined ruleset over historical data and report stats | to-confirm |

## 3. Airbnb

| # | Pain point / repeated task | Frequency | Mechanism | What it would do | Status |
|---|---|---|---|---|---|
| 19 | Guest messaging (check-in, FAQs) | Per booking | Skill | Draft templated, personalised replies for check-in info and common questions | to-confirm |
| 20 | Nightly price review | Daily/weekly | Loop | Suggest rate adjustments vs. season, local events, occupancy | to-confirm |
| 21 | Turnover / cleaning checklist & scheduling | Per booking | Skill/Goal | Generate the turnaround checklist and confirm scheduling between guests | to-confirm |
| 22 | Supplies & restocking inventory | Weekly | Goal | Track consumables and flag what to reorder before it runs out | to-confirm |
| 23 | Review responses & review prompts | Per guest | Skill | Draft a reply to each guest review and a nudge asking guests to leave one | to-confirm |
| 24 | Calendar / availability sync | Daily | Loop | Watch for double-bookings or gaps across platforms | to-confirm |
| 25 | Expense tracking for tax | Monthly | Goal | Roll up cleaning, supplies, fees into a monthly statement | to-confirm |

## 4. Website development (Econ Dispatch & general)

| # | Pain point / repeated task | Frequency | Mechanism | What it would do | Status |
|---|---|---|---|---|---|
| 26 | Verify after a change / deploy | Per change | Skill | Run the app, confirm the digest + video + examples tabs actually work before you ship (`/verify`) | grounded |
| 27 | API health monitoring | Daily | Loop | Ping the digest endpoint; alert on Anthropic API errors, Redis read/write failures | grounded (`api/digest.js` warns on both) |
| 28 | Cache management | Ad hoc | Skill | Wrap `api/clear-cache.js` so you can force-refresh today's digest in one command | grounded (`api/clear-cache.js`) |
| 29 | Anthropic model / API-version upkeep | Quarterly | Goal | Track when `claude-sonnet-4-5` / `anthropic-version: 2023-06-01` should be bumped, and the web_search tool version | grounded (`api/digest.js`) |
| 30 | Cost monitoring (Anthropic + Upstash) | Weekly | Loop/Goal | Watch token spend and Redis usage so a runaway loop doesn't surprise you | grounded |
| 31 | OG image / SEO refresh | Ad hoc | Skill | Regenerate share images and metadata when branding changes (`api/og-image.js`) | grounded (`api/og-image.js`) |
| 32 | Backup of Redis video/examples data | Weekly | Loop | Snapshot `teacher:videos` so a bad write can't lose your library | grounded (`api/videos.js`) |

---

## Suggested starting point

You asked to *kick-start* the process, not finish it. If you build only a few first, I'd pick the ones
that are repeated, painful, and already half-built in your code:

1. **#2 Digest link-checker** (Skill or Loop) — protects you live in front of students.
2. **#3 Video add-from-URL** (Skill) — removes the most-repeated manual typing.
3. **#1 Digest pre-warm** (Loop) — kills the cold-load wait before first period.
4. **#26 Verify-before-ship** (Skill) — you already have `/verify`; wire it to this project.
5. **#14 Trade journal** (Skill) — lowest-effort, highest-discipline win in trading.

## Next step

Tell me which rows are real vs. junk (especially Trading and Airbnb), and which 2–3 you want built first.
I'll turn those into actual loops/goals/skills and delete the rest.

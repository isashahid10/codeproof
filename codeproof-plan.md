# CodeProof — VS Code Extension Project Plan

**Concept:** A VS Code extension that continuously records timestamped snapshots of your coding activity, then generates AI-powered PDF reports to prove authorship and progressive development of your work.

**Tagline:** *"Prove you wrote it."*

---

## The Problem

Universities are cracking down on AI-generated code and contract cheating. Students have no standardised way to prove:

- They wrote the code themselves
- Work was developed progressively (not pasted in one go)
- They spent real time iterating, debugging, and refining
- Their development patterns match a human writing code

VS Code's built-in Timeline tracks local history per-file but isn't exportable, isn't tamper-resistant, and doesn't generate evidence you can submit. Git commits are manual and easy to fabricate after the fact.

---

## Feasibility Study

### Technical Feasibility — HIGH ✅

| Component | API / Approach | Difficulty |
|---|---|---|
| Track document changes | `vscode.workspace.onDidChangeTextDocument` — fires on every edit | Easy |
| Track file saves | `vscode.workspace.onDidSaveTextDocument` | Easy |
| Capture snapshots at intervals | `setInterval` + debounce logic | Easy |
| Compute diffs between snapshots | `jsdiff` npm package (well-maintained, 15M+ weekly downloads) | Easy |
| Store snapshots locally | SQLite via `better-sqlite3` or flat JSON/NDJSON files | Easy |
| Generate HTML/PDF report | `puppeteer` or just HTML export (let browser print to PDF) | Medium |
| Tamper-resistance (hash chaining) | SHA-256 hash of each snapshot + previous hash (like blockchain) | Easy |
| Detect paste vs typing events | `onDidChangeTextDocument` — large single-change = paste, many small changes = typing | Medium |
| AI-powered analysis | Call Claude/OpenAI API to summarise development story | Medium |
| VS Code extension packaging | `yo code` scaffolding + `vsce` for publishing | Easy |

### Market Feasibility — STRONG ✅

- No existing extension does exactly this
- CodeLapse does manual snapshots but not continuous recording or report generation
- WakaTime tracks time but not content changes
- Universities worldwide are tightening academic integrity policies
- Students are actively looking for ways to demonstrate legitimate work
- Could be adopted by universities themselves as a recommended tool

### Cost Feasibility — LOW BARRIER ✅

- Free to build (TypeScript, open source dependencies)
- Free to publish on VS Code Marketplace
- AI report generation is the only cost: ~$0.02-0.10 per report via Claude API
- Could offer a free tier (HTML report, no AI) + paid tier (AI analysis)

### Risks

| Risk | Mitigation |
|---|---|
| Performance impact from constant monitoring | Debounce to 30-60s intervals, only store diffs not full files |
| Storage bloat | Compress old snapshots, configurable retention period |
| Students could still fabricate by "typing out" AI code | Detect abnormal patterns (perfect code with zero debugging, unusual speed) — not foolproof but raises the bar |
| Privacy concerns (recording all keystrokes) | All data stays local, never leaves machine unless user explicitly exports |
| University acceptance | Position as supplementary evidence, not a certification system |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  VS Code Extension               │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │  Event        │    │  Snapshot Engine      │  │
│  │  Listeners    │───▶│  - Debounce/interval  │  │
│  │  - onChange   │    │  - Diff computation   │  │
│  │  - onSave     │    │  - Hash chaining      │  │
│  │  - onPaste    │    │  - Metadata capture   │  │
│  └──────────────┘    └──────────┬────────────┘  │
│                                  │               │
│                                  ▼               │
│                      ┌───────────────────────┐  │
│                      │  Storage Layer         │  │
│                      │  SQLite per-project    │  │
│                      │  ~/.codeproof/         │  │
│                      └──────────┬────────────┘  │
│                                  │               │
│                    ┌─────────────┼──────────┐   │
│                    ▼             ▼          ▼   │
│              ┌──────────┐ ┌──────────┐ ┌─────┐ │
│              │ HTML      │ │ AI       │ │ PDF │ │
│              │ Timeline  │ │ Analysis │ │ Gen │ │
│              │ View      │ │ (Claude) │ │     │ │
│              └──────────┘ └──────────┘ └─────┘ │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Status Bar: "CodeProof ● Recording"     │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### Data Model

Each snapshot record:

```typescript
interface Snapshot {
  id: string;                    // UUID
  timestamp: string;             // ISO 8601
  filename: string;              // Relative path
  content_hash: string;          // SHA-256 of file content at this point
  diff: string;                  // Unified diff from previous snapshot
  lines_added: number;
  lines_removed: number;
  total_lines: number;
  change_type: 'typing' | 'paste' | 'delete' | 'refactor' | 'save';
  change_size: number;           // Characters changed
  chain_hash: string;            // SHA-256(previous_chain_hash + content_hash + timestamp)
  session_id: string;            // Groups snapshots within a coding session
}

interface Session {
  id: string;
  started_at: string;
  ended_at: string;
  project_name: string;
  files_touched: string[];
  total_snapshots: number;
}
```

---

## Feature Breakdown

### Phase 1 — Core Recording (MVP, ~1 week)

The foundation. Get this right first.

- **Continuous snapshot capture** — record diffs every 30 seconds (configurable)
- **Change type detection** — distinguish typing vs paste vs bulk delete
  - Paste detection: if a single `onDidChangeTextDocument` event adds 50+ characters in one range, flag as paste
  - Typing: many small sequential changes
  - Refactor: VS Code's built-in rename/refactor triggers specific events
- **Hash chaining** — each snapshot includes `SHA-256(prev_hash + content + timestamp)` so the chain is tamper-evident
- **SQLite storage** — one database per workspace, stored in `.codeproof/` in the project root (or global `~/.codeproof/`)
- **Status bar indicator** — shows recording status, snapshot count, session duration
- **Basic commands:**
  - `CodeProof: Start Recording` / `Stop Recording`
  - `CodeProof: View Session Summary` (quick stats in output panel)

### Phase 2 — Report Generation (~1 week)

- **HTML timeline report** — interactive page showing:
  - Timeline of all changes with timestamps
  - Colour-coded diffs (green = added, red = removed)
  - Graphs: lines of code over time, edit frequency, files touched
  - Session breakdown (when you started/stopped working)
  - Paste events highlighted/flagged
- **PDF export** — render the HTML report to PDF via Puppeteer or `html-pdf`
- **Integrity verification section** — report includes the hash chain so a verifier can confirm no snapshots were inserted/removed after the fact
- **Summary statistics:**
  - Total development time
  - Number of sessions
  - Average edit frequency
  - Ratio of typing vs paste events
  - Progression curve (does code grow gradually or appear in chunks?)

### Phase 3 — AI-Powered Analysis (~1 week)

This is the differentiator.

- **AI development narrative** — send the snapshot timeline to Claude API and generate a human-readable story:
  > "Development began at 2:14 PM with the creation of `bst.py`. The student started by implementing the `Node` class with `__init__`, then moved to the `BST` class. Over the next 45 minutes, the insert method was written, tested (3 iterations — the first had an off-by-one error on line 23 which was corrected at 2:32 PM), and finalised. The delete method took longer, with 7 revisions over 1.5 hours, suggesting the student was working through the logic incrementally..."
  
- **Authenticity indicators** — AI analyses patterns and flags:
  - ✅ "Progressive development with iterative debugging"
  - ✅ "Natural typing patterns with corrections and backtracking"
  - ⚠️ "Large code block pasted at 3:15 PM (45 lines) — student may want to document source"
  - ✅ "Consistent coding style throughout"

- **Development style profile** — characterise how this student codes:
  - Average speed, tendency to write tests first or last, refactoring habits
  - Useful for building a baseline across multiple assignments

- **Configurable AI provider** — support Claude, OpenAI, or local models via Ollama

### Phase 4 — Smart Flags & Dual Reports (~1 week)

This is a student-first feature. Before you submit, CodeProof scans your development history and shows you potential flags — things that *could* look suspicious to a marker, even if they're perfectly innocent. You then decide how to handle them.

**Flag Categories:**

| Flag | What triggers it | Why it matters | Severity |
|---|---|---|---|
| 🟡 Large paste event | 30+ lines added in a single change | Looks like code was copied from somewhere | Medium |
| 🟡 Rapid completion | Assignment completed significantly faster than expected | Could indicate prior solution or AI generation | Low |
| 🔴 Code appeared fully formed | A complex function/class was added in one go with zero iterations or corrections | Human coding almost always has revisions | High |
| 🟡 Long gap then sudden completion | No activity for days, then entire solution written in one session | Suggests possible last-minute copying | Medium |
| 🟡 Style inconsistency | Part of the code uses different naming conventions, indentation, or patterns | Suggests multiple authors or external code | Medium |
| 🟡 No debugging iterations | Code compiles/runs correctly on first attempt for complex logic | Unusual for student work — not impossible, but notable | Low |
| 🔴 Clipboard content mismatch | Pasted code doesn't match anything the student previously had open | Harder to explain — code came from outside VS Code | High |
| 🟡 Unusual typing speed | Sustained 200+ characters/minute for extended periods | Beyond normal typing speed, may indicate paste or macro | Low |
| 🟢 External reference (informational) | Student opened a browser/docs tab around the same time as a paste | Suggests they were referencing documentation — actually a good sign | Info |

**How it works for the student:**

1. Student finishes their assignment
2. Runs `CodeProof: Review Flags` command
3. A WebView panel opens showing all detected flags with:
   - What was flagged and when
   - Why it was flagged
   - The actual code diff that triggered it
   - A severity indicator (🔴 high / 🟡 medium / 🟢 info)
4. For each flag, the student can:
   - **Add context** — write a note explaining the flag (e.g., "I pasted this from the lecture slides as a starting template, then modified it")
   - **Acknowledge** — accept the flag will appear in the report
   - **Dismiss** — mark as not relevant (only hides from the clean report, the data still exists)

**Dual Report Generation:**

The student can generate two separate reports:

**Report A: Full Transparency Report (recommended)**
- Complete development timeline with ALL flags visible
- Student's explanations/context for each flag
- AI narrative that incorporates the flags naturally
  > "At 3:15 PM, 42 lines were pasted into `bst.py`. The student noted this was the starter template from the assignment spec. Over the following 2 hours, this code was significantly modified — the original template's `insert()` stub was replaced with a full recursive implementation across 7 iterations..."
- Hash chain verification
- This is the version students should submit — transparency looks better than hiding things

**Report B: Clean Summary Report**
- Development timeline WITHOUT flag annotations
- Just the progression story, stats, and timeline
- Still includes hash chain (so integrity is verifiable)
- Useful for: portfolios, job applications, personal records
- Does NOT hide the underlying data — if someone verifies the hash chain and re-analyses, flags would still be detectable

**Important design principle:** Report B doesn't delete or alter the evidence. It just doesn't highlight the flags in the presentation layer. The hash chain is identical in both reports. This means:
- Students can't claim they had a "clean" development history
- They just get a choice of how much annotation to include
- If a university runs their own analysis on the raw data export, they'll see everything regardless

**AI-Powered Flag Suggestions:**

Before generating the report, AI reviews the flag list and suggests:

- Which flags the student should definitely address with context
- Which flags are probably fine and don't need explanation
- Suggested wording for explanations (student can edit)
- An overall "confidence score" for authenticity

Example AI suggestions panel:
```
┌─────────────────────────────────────────────────────┐
│  CodeProof Pre-Submission Review                     │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Overall Authenticity Confidence: 87% ✅              │
│                                                      │
│  3 flags detected:                                   │
│                                                      │
│  🟡 FLAG 1: Large paste at 3:15 PM (42 lines)       │
│     Suggestion: Add a note about the source.         │
│     This is the most significant flag — a brief      │
│     explanation will make your report much stronger.  │
│     [Add context...] [Dismiss]                       │
│                                                      │
│  🟡 FLAG 2: No changes for 25 min at 4:00 PM        │
│     Suggestion: Probably fine — likely a break.       │
│     Most markers won't flag this.                    │
│     [Add context...] [Dismiss]                       │
│                                                      │
│  🟢 FLAG 3: Opened MDN docs before paste event      │
│     Suggestion: This actually supports your case.    │
│     Shows you were researching before writing code.  │
│     [Keep visible ✓]                                 │
│                                                      │
│  ┌─────────────────┐  ┌─────────────────────────┐   │
│  │ Generate Full    │  │ Generate Clean Report   │   │
│  │ Report (w/flags) │  │ (without flags)         │   │
│  └─────────────────┘  └─────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Phase 5 — Polish & Power Features (~1-2 weeks)

- **Development replay / timelapse** — WebView panel that plays back the coding session like a video, showing the file evolving character by character (sped up)
- **Multi-file tracking** — track all files in workspace, show cross-file activity in timeline
- **Comparison mode** — compare your development patterns across assignments to build a consistent profile
- **Export formats** — PDF, HTML, JSON (for programmatic verification)
- **Privacy controls:**
  - Exclude specific files/folders (e.g., `.env`, credentials)
  - Pause recording command
  - Redact sensitive content from reports
- **Configurable sensitivity:**
  - Snapshot interval (10s to 5min)
  - Minimum change threshold to trigger snapshot
  - Retention period for old data
- **VS Code sidebar panel** — dedicated CodeProof panel showing:
  - Current session stats
  - Recent snapshots list
  - Quick access to generate report
  - Recording toggle

---

## Additional Feature Ideas

### For Students
- **Assignment mode** — start a named recording session tied to a specific assignment ("FIT1008 Assignment 3"), keeps everything organised
- **Deadline awareness** — if you set a due date, the report shows your work distribution (did you start 3 weeks early or cram the night before?)
- **Quick proof screenshot** — generate a single image summary (like a receipt) showing session duration + progression graph, quick to attach to a submission
- **Collaboration detection** — if multiple people are meant to work on a group project, each person's CodeProof data can be merged to show individual contributions

### For Universities / Instructors
- **Verification CLI tool** — instructors can run `codeproof verify report.pdf` to check the hash chain integrity
- **Bulk analysis dashboard** — if a whole class submits CodeProof reports, flag statistical outliers (suspiciously fast completion, no debugging iterations, identical development patterns between students)
- **LMS integration** — plugin for Moodle/Canvas that accepts CodeProof reports as part of submission

### Anti-Tampering
- **Signed snapshots** — optionally sign each snapshot with a private key so even the hash chain can't be reconstructed
- **Cloud witness** — periodically send a hash (not your code) to a timestamp authority or your own server, creating an external anchor that proves the timeline existed at that point in time
- **Anomaly detection** — flag if the SQLite DB was modified outside of the extension (check file modification times vs internal timestamps)

---

## Tech Stack

| Component | Technology | Why |
|---|---|---|
| Extension runtime | TypeScript | Required for VS Code extensions |
| Diff engine | `jsdiff` | Battle-tested, fast, 15M weekly downloads |
| Storage | `better-sqlite3` | Fast embedded DB, no server needed, single file |
| Hashing | Node.js `crypto` (built-in) | SHA-256, zero dependencies |
| HTML report | Handlebars templates + Chart.js | Clean templating + nice graphs |
| PDF generation | Puppeteer (headless Chrome) | Best HTML-to-PDF fidelity |
| AI analysis | Anthropic SDK (`@anthropic-ai/sdk`) | Claude for narrative generation |
| Extension scaffold | Yeoman `generator-code` | Official VS Code extension generator |
| Packaging | `@vscode/vsce` | Official packaging/publishing tool |

---

## Development Plan

### Week 1: Core Recording Engine

**Day 1-2: Scaffolding + Event Capture**
- `yo code` to generate extension boilerplate
- Implement `onDidChangeTextDocument` listener with debounce
- Implement paste detection (single change > N chars threshold)
- Write snapshot data model and TypeScript interfaces
- Unit tests for change detection logic

**Day 3-4: Storage + Hash Chain**
- Set up SQLite with `better-sqlite3`
- Implement snapshot write/read operations
- Implement hash chaining logic
- Add session management (detect start/end of coding sessions based on activity gaps)
- Status bar UI showing recording state

**Day 5: Commands + Settings**
- Register commands: start, stop, pause, view stats
- VS Code settings for interval, storage location, file exclusions
- `.codeproof` gitignore entry auto-creation
- Basic integration test: open file, type, verify snapshots recorded

### Week 2: Report Generation

**Day 6-7: HTML Report**
- Design report template (Handlebars)
- Timeline visualization with diffs
- Charts: lines over time, edit frequency, session durations (Chart.js)
- Paste event highlighting
- Hash chain integrity section

**Day 8-9: PDF Export + Verification**
- Puppeteer PDF rendering
- Report metadata (student name, assignment name, date range)
- Verification section with hash chain summary
- `CodeProof: Generate Report` command with date range picker

**Day 10: Polish**
- Error handling, edge cases (large files, binary files, empty changes)
- Performance profiling — ensure <1% CPU overhead
- Documentation and README

### Week 3: AI Integration + Flags System

**Day 11-12: AI Narrative Generation**
- Anthropic SDK integration
- Prompt engineering for development narrative
- Authenticity indicators (flag pastes, assess progression)
- Settings for API key, model selection, AI on/off

**Day 13-14: Smart Flags Engine**
- Implement flag detection rules (paste size, typing speed, gap analysis, style consistency)
- Build flag review WebView panel with add context / dismiss / acknowledge actions
- Dual report generation pipeline — full transparency vs clean summary
- AI flag suggestions: severity assessment, recommended explanations, confidence score

**Day 15: Sidebar Panel + Replay**
- VS Code WebView sidebar showing live session stats
- Development replay feature (timelapse playback)
- Assignment mode (named sessions)

### Week 4: Polish + Marketplace

**Day 16-17: Testing + Edge Cases**
- End-to-end testing across all phases
- Performance profiling — ensure <1% CPU overhead
- Edge cases: large files, binary files, empty changes, multi-root workspaces

**Day 18: Marketplace Prep**
- Extension icon, marketplace listing, screenshots, demo GIF
- Package with `vsce` and publish
- README with usage guide and example reports

---

## Estimated Costs

| Item | Cost |
|---|---|
| Development | Your time (4 weeks part-time) |
| VS Code Marketplace publishing | Free (one-time Microsoft account) |
| AI report generation (Claude API) | ~$0.02-0.10 per report |
| Hosting (if cloud witness feature) | ~$5/month for a tiny server |

---

## Monetisation Potential (Optional)

If this gains traction beyond personal use:

- **Free tier** — recording + HTML report + basic stats
- **Pro tier ($3-5/month or $20/year)** — AI narrative, PDF export, replay, cloud witness
- **University license** — bulk pricing for institutions wanting to integrate with their LMS, verification dashboard for instructors
- **One-time report purchase** — $0.50 per AI-generated report (no subscription)

---

## Competitive Landscape

| Tool | What it does | What it lacks |
|---|---|---|
| VS Code Timeline | Local file history on save | Not exportable, not tamper-resistant, no reports |
| Git | Version control with timestamps | Manual commits, easy to fabricate, overkill for this |
| CodeLapse | Manual snapshots with navigation | Not automatic, no reports, no AI |
| WakaTime | Time tracking per project/file | Tracks time only, not content changes |
| Code Time | Coding metrics and dashboards | Same — time metrics only |
| **CodeProof** | **Continuous recording + tamper-evident chain + AI reports** | **Doesn't exist yet — that's the opportunity** |

---

## Next Steps

1. Set up the extension scaffold (`yo code`)
2. Build the snapshot engine (Phase 1, Day 1-2)
3. Get a working prototype that records changes and dumps to SQLite
4. Test with a real assignment to validate the concept
5. Iterate from there

The MVP (recording + basic HTML report) is genuinely a weekend project. The AI analysis and polish takes it from "useful hack" to "product people would pay for."

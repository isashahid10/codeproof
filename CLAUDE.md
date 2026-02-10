# CodeProof — VS Code Extension

## What This Project Is
CodeProof is a VS Code extension that continuously records timestamped snapshots of coding activity, then generates AI-powered reports to prove code authorship. Target users are university students who need to demonstrate they wrote their own code.

## Tech Stack
- **Language:** TypeScript (strict mode)
- **Runtime:** VS Code Extension API
- **Storage:** better-sqlite3 for snapshot database
- **Diffing:** jsdiff for computing file diffs
- **Hashing:** Node.js built-in crypto (SHA-256)
- **Reports:** Handlebars templates + Chart.js for HTML reports
- **PDF:** Puppeteer for HTML-to-PDF conversion
- **AI:** @anthropic-ai/sdk for Claude API (report narrative generation)

## Coding Standards
- Use async/await, never raw Promises with .then()
- All functions must have JSDoc comments
- Use descriptive variable names, no single-letter variables except loop counters
- Error handling: always catch and log, never silently swallow errors
- No any types — use proper TypeScript interfaces

## Key Design Decisions
- Snapshots stored per-workspace in SQLite database
- Hash chain: each snapshot chain_hash = SHA-256(prev_chain_hash + content_hash + timestamp)
- Paste detection threshold: single change adding 50+ characters = flagged as paste
- Default snapshot interval: 30 seconds (configurable)
- All data stays local — nothing leaves the machine unless user explicitly generates an AI report

## Development Commands
- npm install — install dependencies
- npm run compile — compile TypeScript
- npm run watch — compile in watch mode
- Press F5 in VS Code to launch Extension Development Host (debug mode)
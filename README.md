# CodeProof

**Prove you wrote your code.** A VS Code extension that records your work as you write it, then proves nobody edited the record afterwards.

Everything stays on your machine. There is no account, no server, and no upload.

[**Install from Open VSX**](https://open-vsx.org/extension/isashahid/codeproof) · [Website](https://codeproof.netlify.app)

![CodeProof](docs/landing.jpg)

---

## The problem

Plagiarism tools answer one question: *does this look like something else?*

They cannot answer the question an academic integrity panel actually asks: **did this person write this, and when?** A finished file looks identical whether it took three weeks or was pasted in at 2am. If you are accused, you have no evidence, because nobody records the middle of the process.

CodeProof records the middle.

## How it works

1. **Snapshots.** The extension captures your workspace on a timer while you work (30 seconds by default).
2. **Hash chaining.** Every snapshot is SHA-256 hashed together with the hash of the one before it. This links them into an append-only chain.
3. **Tamper evidence.** Because each record depends on the previous one, editing anything in the middle invalidates every hash after it. You do not have to detect the edit. The chain cannot hide it.
4. **Verification.** Verification walks the chain and reports **exactly which file broke it and when**, rather than a useless "verification failed".

The event log lives in a local SQLite database inside your workspace.

## Features

| Feature | What it does |
| --- | --- |
| **Continuous recording** | Timed workspace snapshots, with configurable interval and ignore globs |
| **Development replay** | Scrub back through a coding session like video, to see how the work actually progressed |
| **Flag review** | Surfaces large pastes and unusual structural jumps **for a human to review**, rather than accusing anyone |
| **Reports** | Exportable PDF reports, with development narratives written by Gemini |
| **Local-first** | SQLite in your workspace. Nothing is sent anywhere |

## Install

**[Install from Open VSX](https://open-vsx.org/extension/isashahid/codeproof)**, or search "CodeProof" in any editor that uses the Open VSX registry (VSCodium, Cursor, Gitpod, Theia). A `.vsix` is also attached to the site.

To run from source instead:

```bash
git clone https://github.com/isashahid10/codeproof.git
cd codeproof
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host with CodeProof loaded.

## Usage

Recording starts automatically when you open a workspace. Everything else is in the Command Palette (`Cmd/Ctrl` + `Shift` + `P`):

| Command | |
| --- | --- |
| `CodeProof: Start Recording` | Begin capturing |
| `CodeProof: Stop Recording` | Stop capturing |
| `CodeProof: Pause Recording` | Pause without ending the session |
| `CodeProof: Open Dashboard` | Session overview |
| `CodeProof: Open Development Replay` | Scrub through the session |
| `CodeProof: Review Flags` | Inspect flagged edits |
| `CodeProof: View Stats` | Session statistics |
| `CodeProof: Export Report` | Generate a PDF report |

There is also a CodeProof sidebar in the activity bar.

## Configuration

| Setting | Default | |
| --- | --- | --- |
| `codeproof.snapshotInterval` | `30` | Seconds between snapshots |
| `codeproof.pasteThreshold` | `50` | Characters before an insert counts as a paste |
| `codeproof.excludePatterns` | `node_modules`, `.git`, `dist` | Globs to ignore |
| `codeproof.autoStart` | `true` | Start recording when a workspace opens |
| `codeproof.storageLocation` | `.codeproof` | Data directory, relative to workspace root |
| `codeproof.enableReplay` | `true` | High-frequency capture for replay |
| `codeproof.aiProvider` | `gemini` | Provider for narratives and analysis |
| `codeproof.aiApiKey` | none | Free key from [aistudio.google.com](https://aistudio.google.com/) |

The AI features are optional. Recording, chaining and verification all work without a key.

## What this does and does not prove

Worth being precise, because integrity tooling gets over-claimed constantly.

**It does prove** that a body of work existed at a sequence of points in time, and that the record has not been retroactively tidied up. For a panel asking whether something appeared fully formed overnight, that is the whole argument.

**It does not prove** you personally authored the code. Nothing can. You could type someone else's work in by hand and the chain would faithfully certify that you typed it slowly.

The flag analyser is deliberately built to surface things **for review**, not to make accusations. A large paste is not misconduct. It is a thing a human should look at.

## Built with

TypeScript, VS Code Extension API, better-sqlite3, Google Generative AI (Gemini), puppeteer-core for PDF rendering, diff, minimatch.

## Development

```bash
npm run compile   # build once
npm run watch     # rebuild on change
npm run lint      # eslint
npm test          # vscode-test
```

## Licence

MIT. See [LICENSE](LICENSE).

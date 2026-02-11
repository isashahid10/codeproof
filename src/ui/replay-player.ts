import * as vscode from 'vscode';
import { ReplayEvent } from '../snapshot/types.js';
import { SnapshotStorage } from '../snapshot/storage.js';

/**
 * Message types sent from the replay WebView to the extension.
 */
export interface ReplayMessage {
	type: 'selectFile' | 'ready';
	filename?: string;
}

/**
 * WebView panel that provides a video-like playback of coding sessions.
 * Shows code being written character by character with playback controls,
 * a timeline scrubber, activity density visualization, and speed controls.
 */
export class ReplayPlayerPanel {
	public static readonly viewType = 'codeproofReplay';

	private panel: vscode.WebviewPanel | undefined;

	/**
	 * Creates a new ReplayPlayerPanel.
	 *
	 * @param storage - SnapshotStorage instance to retrieve replay events
	 */
	constructor(private readonly storage: SnapshotStorage) {}

	/**
	 * Opens the replay player panel. Shows a quick pick to select a file,
	 * then loads replay events and renders the WebView.
	 */
	async show(): Promise<void> {
		const files = this.storage.getReplayFileList();

		if (files.length === 0) {
			vscode.window.showInformationMessage(
				'CodeProof: No replay data available. Start recording and make some edits first.'
			);
			return;
		}

		const selectedFile = await vscode.window.showQuickPick(files, {
			placeHolder: 'Select a file to replay',
			title: 'CodeProof — Development Replay',
		});

		if (!selectedFile) {
			return;
		}

		const events = this.storage.getReplayEvents({ filename: selectedFile });

		if (events.length === 0) {
			vscode.window.showInformationMessage(
				'CodeProof: No replay events found for this file.'
			);
			return;
		}

		this.createPanel(selectedFile, events, files);
	}

	/**
	 * Creates the WebView panel and loads the replay data.
	 *
	 * @param filename - The file being replayed
	 * @param events - Replay events for the selected file
	 * @param allFiles - All files with replay data (for file selector)
	 */
	private createPanel(filename: string, events: ReplayEvent[], allFiles: string[]): void {
		if (this.panel) {
			this.panel.dispose();
		}

		this.panel = vscode.window.createWebviewPanel(
			ReplayPlayerPanel.viewType,
			`Replay — ${filename}`,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		this.panel.webview.html = this.getHTML(filename, events, allFiles);

		this.panel.webview.onDidReceiveMessage(
			async (message: ReplayMessage) => {
				if (message.type === 'selectFile' && message.filename) {
					const newEvents = this.storage.getReplayEvents({ filename: message.filename });
					if (newEvents.length > 0) {
						this.createPanel(message.filename, newEvents, allFiles);
					} else {
						vscode.window.showInformationMessage(
							'CodeProof: No replay events found for this file.'
						);
					}
				}
			}
		);

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	/**
	 * Generates the complete HTML for the replay player WebView.
	 *
	 * @param filename - The file being replayed
	 * @param events - The replay events data
	 * @param allFiles - All available files for the file selector
	 * @returns Complete HTML document string
	 */
	private getHTML(filename: string, events: ReplayEvent[], allFiles: string[]): string {
		const eventsJson = JSON.stringify(events);
		const allFilesJson = JSON.stringify(allFiles);

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com;">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
${ReplayPlayerPanel.getStyles()}
</style>
</head>
<body>

<div class="replay-container">

	<!-- STATS OVERLAY -->
	<div class="stats-overlay" id="statsOverlay">
		<div class="stat-item">
			<span class="stat-label">Speed</span>
			<span class="stat-value" id="statSpeed">1x</span>
		</div>
		<div class="stat-item">
			<span class="stat-label">Elapsed</span>
			<span class="stat-value" id="statElapsed">0:00 / 0:00</span>
		</div>
		<div class="stat-item">
			<span class="stat-label">Lines</span>
			<span class="stat-value" id="statLines">0</span>
		</div>
		<div class="stat-item">
			<span class="stat-label">Action</span>
			<span class="stat-value" id="statAction">--</span>
		</div>
	</div>

	<!-- CODE DISPLAY -->
	<div class="code-display" id="codeDisplay">
		<div class="line-numbers" id="lineNumbers"></div>
		<div class="code-content" id="codeContent">
			<pre><code id="codeBlock" class="hljs"></code></pre>
			<span class="cursor" id="cursor"></span>
		</div>
	</div>

	<!-- CONTROLS BAR -->
	<div class="controls-bar">

		<!-- MINI TIMELINE -->
		<div class="mini-timeline" id="miniTimeline">
			<canvas id="miniTimelineCanvas" height="20"></canvas>
		</div>

		<!-- SCRUBBER -->
		<div class="scrubber-container">
			<span class="time-display" id="currentTime">--:--</span>
			<div class="scrubber" id="scrubber">
				<div class="scrubber-track" id="scrubberTrack">
					<div class="scrubber-fill" id="scrubberFill"></div>
					<div class="scrubber-thumb" id="scrubberThumb"></div>
				</div>
			</div>
			<span class="time-display" id="endTime">--:--</span>
		</div>

		<!-- BUTTONS -->
		<div class="controls-row">
			<div class="controls-left">
				<button class="ctrl-btn" id="btnPlay" title="Play / Pause">
					<span id="playIcon">&#9654;</span>
				</button>
				<button class="ctrl-btn" id="btnSkipNext" title="Skip to next edit">&#9197;</button>
				<div class="skip-idle-toggle">
					<label class="toggle-label">
						<input type="checkbox" id="skipIdleToggle" checked>
						<span class="toggle-text">Skip idle</span>
					</label>
				</div>
			</div>

			<div class="controls-center">
				<select class="file-select" id="fileSelect">
					${allFiles.map((file) =>
						`<option value="${this.escapeHtml(file)}" ${file === filename ? 'selected' : ''}>${this.escapeHtml(file)}</option>`
					).join('')}
				</select>
			</div>

			<div class="controls-right">
				<div class="speed-controls">
					<button class="speed-btn" data-speed="1">1x</button>
					<button class="speed-btn" data-speed="2">2x</button>
					<button class="speed-btn" data-speed="5">5x</button>
					<button class="speed-btn" data-speed="10">10x</button>
					<button class="speed-btn" data-speed="50">50x</button>
				</div>
				<div class="record-hint">
					Tip: Cmd+Shift+5 to screen record
				</div>
			</div>
		</div>
	</div>
</div>

<script>
${ReplayPlayerPanel.getScript(eventsJson, allFilesJson)}
</script>
</body>
</html>`;
	}

	/**
	 * Escapes HTML special characters for safe insertion into attributes.
	 *
	 * @param text - Raw text
	 * @returns HTML-escaped text
	 */
	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	/**
	 * Returns the CSS styles for the replay player.
	 *
	 * @returns CSS string
	 */
	private static getStyles(): string {
		return `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');

* {
	margin: 0;
	padding: 0;
	box-sizing: border-box;
}

body {
	background: #1e1e1e;
	color: #d4d4d4;
	font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
	overflow: hidden;
	height: 100vh;
	display: flex;
	flex-direction: column;
}

/* ── CONTAINER ──────────────────────────────────── */
.replay-container {
	display: flex;
	flex-direction: column;
	height: 100vh;
	position: relative;
}

/* ── STATS OVERLAY ──────────────────────────────── */
.stats-overlay {
	position: absolute;
	top: 12px;
	right: 16px;
	z-index: 10;
	display: flex;
	gap: 16px;
	padding: 8px 14px;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(8px);
	border-radius: 8px;
	border: 1px solid rgba(255, 255, 255, 0.08);
}

.stats-overlay .stat-item {
	text-align: center;
}

.stats-overlay .stat-label {
	display: block;
	font-size: 9px;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: #888;
	margin-bottom: 2px;
}

.stats-overlay .stat-value {
	display: block;
	font-size: 12px;
	font-weight: 700;
	color: #e0e0e0;
}

/* ── CODE DISPLAY ───────────────────────────────── */
.code-display {
	flex: 1;
	display: flex;
	overflow: auto;
	position: relative;
	background: #1e1e1e;
}

.line-numbers {
	padding: 16px 12px 16px 16px;
	text-align: right;
	color: #555;
	font-size: 13px;
	line-height: 1.6;
	user-select: none;
	min-width: 50px;
	background: #1a1a1a;
	border-right: 1px solid #333;
	flex-shrink: 0;
}

.code-content {
	flex: 1;
	padding: 16px;
	overflow: auto;
	position: relative;
}

.code-content pre {
	margin: 0;
	padding: 0;
}

.code-content code {
	font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
	font-size: 13px;
	line-height: 1.6;
	tab-size: 4;
	white-space: pre;
}

/* Cursor */
.cursor {
	display: inline-block;
	width: 2px;
	height: 18px;
	background: #569cd6;
	position: absolute;
	animation: blink 1s step-end infinite;
	box-shadow: 0 0 4px rgba(86, 156, 214, 0.5);
	pointer-events: none;
	display: none;
}

@keyframes blink {
	0%, 100% { opacity: 1; }
	50% { opacity: 0; }
}

/* New text highlight animation */
.new-text {
	background: rgba(86, 156, 214, 0.25);
	border-radius: 2px;
	animation: fadeHighlight 1.5s ease-out forwards;
}

@keyframes fadeHighlight {
	from { background: rgba(86, 156, 214, 0.25); }
	to { background: transparent; }
}

/* Deleted text flash */
.deleted-text {
	background: rgba(244, 67, 54, 0.35);
	text-decoration: line-through;
	animation: fadeDelete 0.4s ease-out forwards;
}

@keyframes fadeDelete {
	from { background: rgba(244, 67, 54, 0.35); opacity: 1; }
	to { background: transparent; opacity: 0; }
}

/* ── CONTROLS BAR ───────────────────────────────── */
.controls-bar {
	background: #252526;
	border-top: 1px solid #333;
	padding: 8px 16px 12px;
	flex-shrink: 0;
}

/* ── MINI TIMELINE ──────────────────────────────── */
.mini-timeline {
	height: 20px;
	margin-bottom: 6px;
	cursor: pointer;
	border-radius: 3px;
	overflow: hidden;
	background: #1a1a1a;
	border: 1px solid #333;
}

.mini-timeline canvas {
	width: 100%;
	height: 100%;
	display: block;
}

/* ── SCRUBBER ───────────────────────────────────── */
.scrubber-container {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 8px;
}

.time-display {
	font-size: 11px;
	color: #999;
	min-width: 60px;
	text-align: center;
	font-variant-numeric: tabular-nums;
}

.scrubber {
	flex: 1;
	height: 20px;
	display: flex;
	align-items: center;
	cursor: pointer;
}

.scrubber-track {
	width: 100%;
	height: 4px;
	background: #444;
	border-radius: 2px;
	position: relative;
}

.scrubber-fill {
	height: 100%;
	background: #569cd6;
	border-radius: 2px;
	width: 0%;
	transition: width 0.1s linear;
}

.scrubber-thumb {
	width: 14px;
	height: 14px;
	background: #569cd6;
	border-radius: 50%;
	position: absolute;
	top: 50%;
	transform: translate(-50%, -50%);
	left: 0%;
	box-shadow: 0 0 6px rgba(86, 156, 214, 0.5);
	transition: left 0.1s linear;
}

.scrubber:hover .scrubber-track {
	height: 6px;
}

.scrubber:hover .scrubber-thumb {
	width: 16px;
	height: 16px;
}

/* ── CONTROLS ROW ───────────────────────────────── */
.controls-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.controls-left,
.controls-center,
.controls-right {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ctrl-btn {
	width: 36px;
	height: 36px;
	border: none;
	border-radius: 50%;
	background: #333;
	color: #e0e0e0;
	font-size: 14px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.15s, transform 0.1s;
}

.ctrl-btn:hover {
	background: #444;
	transform: scale(1.05);
}

.ctrl-btn:active {
	transform: scale(0.95);
}

#btnPlay {
	width: 42px;
	height: 42px;
	background: #569cd6;
	font-size: 16px;
}

#btnPlay:hover {
	background: #6db0e8;
}

/* Skip idle toggle */
.skip-idle-toggle {
	margin-left: 4px;
}

.toggle-label {
	display: flex;
	align-items: center;
	gap: 6px;
	cursor: pointer;
	font-size: 11px;
	color: #999;
}

.toggle-label input {
	accent-color: #569cd6;
}

.toggle-label input:checked + .toggle-text {
	color: #569cd6;
}

/* File selector */
.file-select {
	padding: 6px 10px;
	border-radius: 4px;
	border: 1px solid #444;
	background: #333;
	color: #e0e0e0;
	font-family: 'JetBrains Mono', monospace;
	font-size: 11px;
	cursor: pointer;
	max-width: 300px;
}

.file-select:hover {
	border-color: #569cd6;
}

/* Speed controls */
.speed-controls {
	display: flex;
	gap: 2px;
	background: #1a1a1a;
	border-radius: 6px;
	padding: 2px;
}

.speed-btn {
	padding: 4px 10px;
	border: none;
	border-radius: 4px;
	background: transparent;
	color: #999;
	font-family: 'JetBrains Mono', monospace;
	font-size: 11px;
	font-weight: 600;
	cursor: pointer;
	transition: all 0.15s;
}

.speed-btn:hover {
	color: #e0e0e0;
}

.speed-btn.active {
	background: #569cd6;
	color: #fff;
}

/* Record hint */
.record-hint {
	font-size: 10px;
	color: #666;
	margin-left: 8px;
}

/* ── EMPTY STATE ────────────────────────────────── */
.empty-state {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1;
	color: #666;
	font-size: 16px;
}
`;
	}

	/**
	 * Returns the JavaScript for the replay player logic.
	 *
	 * @param eventsJson - JSON-serialized replay events
	 * @param allFilesJson - JSON-serialized array of all available filenames
	 * @returns JavaScript string
	 */
	private static getScript(eventsJson: string, allFilesJson: string): string {
		return `
(function() {
	const vscodeApi = acquireVsCodeApi();
	const events = ${eventsJson};
	const allFiles = ${allFilesJson};

	/** Virtual document — array of lines */
	let docLines = [''];
	/** Current event index */
	let currentIndex = 0;
	/** Whether playback is running */
	let isPlaying = false;
	/** Playback speed multiplier */
	let speed = 1;
	/** Whether to skip idle periods */
	let skipIdle = true;
	/** Animation frame handle */
	let animFrame = null;
	/** Timeout handle for scheduled playback */
	let playTimeout = null;
	/** Timestamp of the first event */
	const startTimestamp = events.length > 0 ? events[0].timestamp : 0;
	/** Timestamp of the last event */
	const endTimestamp = events.length > 0 ? events[events.length - 1].timestamp : 0;
	/** Idle threshold in ms — gaps longer than this get compressed */
	const IDLE_THRESHOLD_MS = 5000;
	/** Compressed idle duration in ms */
	const COMPRESSED_IDLE_MS = 500;
	/** Batch rendering threshold — events closer than this are batched */
	const BATCH_THRESHOLD_MS = 16;

	// DOM elements
	const codeBlock = document.getElementById('codeBlock');
	const lineNumbers = document.getElementById('lineNumbers');
	const cursorEl = document.getElementById('cursor');
	const btnPlay = document.getElementById('btnPlay');
	const playIcon = document.getElementById('playIcon');
	const btnSkipNext = document.getElementById('btnSkipNext');
	const skipIdleToggle = document.getElementById('skipIdleToggle');
	const scrubber = document.getElementById('scrubber');
	const scrubberFill = document.getElementById('scrubberFill');
	const scrubberThumb = document.getElementById('scrubberThumb');
	const currentTimeEl = document.getElementById('currentTime');
	const endTimeEl = document.getElementById('endTime');
	const fileSelect = document.getElementById('fileSelect');
	const miniTimelineCanvas = document.getElementById('miniTimelineCanvas');
	const statSpeed = document.getElementById('statSpeed');
	const statElapsed = document.getElementById('statElapsed');
	const statLines = document.getElementById('statLines');
	const statAction = document.getElementById('statAction');

	/**
	 * Formats a timestamp to a time string (HH:MM:SS AM/PM).
	 * @param {number} ms - Timestamp in milliseconds
	 * @returns {string} Formatted time string
	 */
	function formatTimestamp(ms) {
		if (!ms) return '--:--';
		const date = new Date(ms);
		return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
	}

	/**
	 * Formats a duration in milliseconds to M:SS or H:MM:SS.
	 * @param {number} ms - Duration in milliseconds
	 * @returns {string} Formatted duration
	 */
	function formatDuration(ms) {
		const totalSeconds = Math.floor(ms / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		const pad = (n) => String(n).padStart(2, '0');
		if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(seconds);
		return minutes + ':' + pad(seconds);
	}

	/**
	 * Applies a single change to the virtual document.
	 * @param {object} change - The change to apply
	 */
	function applyChange(change) {
		const startLine = change.rangeStart.line;
		const startChar = change.rangeStart.character;
		const endLine = change.rangeEnd.line;
		const endChar = change.rangeEnd.character;

		// Ensure document has enough lines
		while (docLines.length <= endLine) {
			docLines.push('');
		}

		// Get the text before the range start and after the range end
		const prefix = docLines[startLine].substring(0, startChar);
		const suffix = docLines[endLine].substring(endChar);

		// Build new content
		const newText = prefix + change.text + suffix;
		const newLines = newText.split('\\n');

		// Replace the affected lines
		docLines.splice(startLine, endLine - startLine + 1, ...newLines);
	}

	/**
	 * Applies all changes in a replay event to the virtual document.
	 * @param {object} event - The replay event
	 */
	function applyEvent(event) {
		// Apply changes in reverse order to handle multiple ranges correctly
		const sortedChanges = [...event.changes].sort((a, b) => {
			if (b.rangeStart.line !== a.rangeStart.line) {
				return b.rangeStart.line - a.rangeStart.line;
			}
			return b.rangeStart.character - a.rangeStart.character;
		});

		for (const change of sortedChanges) {
			applyChange(change);
		}
	}

	/**
	 * Detects the language from the filename for syntax highlighting.
	 * @param {string} filename - The filename
	 * @returns {string} Language identifier for highlight.js
	 */
	function detectLanguage(filename) {
		const ext = filename.split('.').pop().toLowerCase();
		const langMap = {
			'ts': 'typescript', 'tsx': 'typescript',
			'js': 'javascript', 'jsx': 'javascript',
			'py': 'python', 'rb': 'ruby', 'rs': 'rust',
			'go': 'go', 'java': 'java', 'c': 'c', 'cpp': 'cpp',
			'cs': 'csharp', 'php': 'php', 'swift': 'swift',
			'kt': 'kotlin', 'scala': 'scala', 'html': 'html',
			'css': 'css', 'scss': 'scss', 'json': 'json',
			'yaml': 'yaml', 'yml': 'yaml', 'md': 'markdown',
			'sql': 'sql', 'sh': 'bash', 'bash': 'bash',
			'xml': 'xml', 'vue': 'html', 'svelte': 'html',
		};
		return langMap[ext] || 'plaintext';
	}

	/** The language for the current file */
	const language = detectLanguage(fileSelect.value);

	/**
	 * Renders the current document state to the code display.
	 */
	function render() {
		const text = docLines.join('\\n');

		// Highlight with highlight.js
		let highlighted;
		try {
			const result = hljs.highlight(text, { language: language, ignoreIllegals: true });
			highlighted = result.value;
		} catch (e) {
			highlighted = escapeHtml(text);
		}

		codeBlock.innerHTML = highlighted;

		// Line numbers
		const lineCount = docLines.length;
		let lineNums = '';
		for (let i = 1; i <= lineCount; i++) {
			lineNums += i + '\\n';
		}
		lineNumbers.textContent = lineNums;

		// Update stats
		statLines.textContent = String(lineCount);
	}

	/**
	 * Escapes HTML special characters.
	 * @param {string} text - Raw text
	 * @returns {string} Escaped text
	 */
	function escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	/**
	 * Updates the scrubber position and time displays.
	 */
	function updateScrubber() {
		if (events.length === 0) return;

		const currentTs = currentIndex < events.length ? events[currentIndex].timestamp : endTimestamp;
		const totalDuration = endTimestamp - startTimestamp;
		const elapsed = currentTs - startTimestamp;
		const progress = totalDuration > 0 ? (elapsed / totalDuration) * 100 : 0;

		scrubberFill.style.width = progress + '%';
		scrubberThumb.style.left = progress + '%';
		currentTimeEl.textContent = formatTimestamp(currentTs);
		endTimeEl.textContent = formatTimestamp(endTimestamp);

		// Stats overlay
		statElapsed.textContent = formatDuration(elapsed) + ' / ' + formatDuration(totalDuration);
	}

	/**
	 * Determines the change type for an event (typing, paste, or delete).
	 * @param {object} event - The replay event
	 * @returns {string} Change type label
	 */
	function getChangeType(event) {
		let totalInserted = 0;
		let totalDeleted = 0;
		for (const change of event.changes) {
			totalInserted += change.text.length;
			totalDeleted += change.rangeLength;
		}
		if (totalInserted >= 50) return 'paste';
		if (totalDeleted > 0 && totalInserted === 0) return 'delete';
		if (totalDeleted > 0) return 'edit';
		return 'typing';
	}

	/**
	 * Draws the mini timeline showing activity density and paste markers.
	 */
	function drawMiniTimeline() {
		const canvas = miniTimelineCanvas;
		const rect = canvas.parentElement.getBoundingClientRect();
		canvas.width = rect.width;
		canvas.height = 20;

		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const totalDuration = endTimestamp - startTimestamp;
		if (totalDuration === 0) return;

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		// Background
		ctx.fillStyle = '#1a1a1a';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// Activity density — divide into buckets
		const bucketCount = Math.min(canvas.width, 200);
		const bucketDuration = totalDuration / bucketCount;
		const buckets = new Array(bucketCount).fill(0);
		const pasteBuckets = [];

		for (const event of events) {
			const elapsed = event.timestamp - startTimestamp;
			const bucketIndex = Math.min(Math.floor(elapsed / bucketDuration), bucketCount - 1);
			buckets[bucketIndex]++;

			if (getChangeType(event) === 'paste') {
				pasteBuckets.push(bucketIndex);
			}
		}

		const maxCount = Math.max(...buckets, 1);

		// Draw activity bars
		const barWidth = canvas.width / bucketCount;
		for (let i = 0; i < bucketCount; i++) {
			const intensity = buckets[i] / maxCount;
			const height = Math.max(intensity * canvas.height, intensity > 0 ? 2 : 0);
			const alpha = 0.3 + intensity * 0.7;
			ctx.fillStyle = 'rgba(86, 156, 214, ' + alpha + ')';
			ctx.fillRect(
				i * barWidth,
				canvas.height - height,
				barWidth - 0.5,
				height
			);
		}

		// Draw paste markers
		ctx.fillStyle = '#ffc107';
		for (const bucketIndex of pasteBuckets) {
			const xPos = bucketIndex * barWidth + barWidth / 2;
			ctx.beginPath();
			ctx.arc(xPos, 4, 3, 0, Math.PI * 2);
			ctx.fill();
		}

		// Draw playback position
		if (events.length > 0) {
			const currentTs = currentIndex < events.length ? events[currentIndex].timestamp : endTimestamp;
			const posX = ((currentTs - startTimestamp) / totalDuration) * canvas.width;
			ctx.fillStyle = '#fff';
			ctx.fillRect(posX - 1, 0, 2, canvas.height);
		}
	}

	/**
	 * Plays a single event and schedules the next one.
	 */
	function playNext() {
		if (!isPlaying || currentIndex >= events.length) {
			if (currentIndex >= events.length) {
				pausePlayback();
			}
			return;
		}

		// Batch rapid events
		const batchEnd = currentIndex;
		applyEvent(events[currentIndex]);

		const changeType = getChangeType(events[currentIndex]);
		statAction.textContent = changeType;

		currentIndex++;

		// Batch events that are very close together
		while (
			currentIndex < events.length &&
			events[currentIndex].timestamp - events[currentIndex - 1].timestamp < BATCH_THRESHOLD_MS
		) {
			applyEvent(events[currentIndex]);
			currentIndex++;
		}

		render();
		updateScrubber();
		drawMiniTimeline();

		// Schedule next event
		if (currentIndex < events.length) {
			let delay = events[currentIndex].timestamp - events[currentIndex - 1].timestamp;

			// Apply speed
			delay = delay / speed;

			// Skip idle
			if (skipIdle && delay > IDLE_THRESHOLD_MS / speed) {
				delay = COMPRESSED_IDLE_MS / speed;
			}

			// Clamp minimum delay
			delay = Math.max(delay, 1);

			playTimeout = setTimeout(playNext, delay);
		} else {
			pausePlayback();
		}
	}

	/**
	 * Starts or resumes playback.
	 */
	function startPlayback() {
		if (currentIndex >= events.length) {
			// Reset to beginning
			currentIndex = 0;
			docLines = [''];
			render();
		}
		isPlaying = true;
		playIcon.innerHTML = '&#10074;&#10074;';
		btnPlay.style.background = '#ff9800';
		playNext();
	}

	/**
	 * Pauses playback.
	 */
	function pausePlayback() {
		isPlaying = false;
		playIcon.innerHTML = '&#9654;';
		btnPlay.style.background = '#569cd6';
		if (playTimeout) {
			clearTimeout(playTimeout);
			playTimeout = null;
		}
	}

	/**
	 * Seeks to a specific event index by replaying all events up to that point.
	 * @param {number} targetIndex - The event index to seek to
	 */
	function seekTo(targetIndex) {
		const wasPlaying = isPlaying;
		pausePlayback();

		// Rebuild document from scratch up to targetIndex
		docLines = [''];
		for (let i = 0; i < targetIndex && i < events.length; i++) {
			applyEvent(events[i]);
		}
		currentIndex = targetIndex;

		render();
		updateScrubber();
		drawMiniTimeline();

		if (wasPlaying) {
			startPlayback();
		}
	}

	/**
	 * Skips to the next edit, jumping over idle periods.
	 */
	function skipToNextEdit() {
		if (currentIndex >= events.length) return;

		let nextIndex = currentIndex + 1;
		while (
			nextIndex < events.length - 1 &&
			events[nextIndex].timestamp - events[nextIndex - 1].timestamp < 1000
		) {
			nextIndex++;
		}

		seekTo(Math.min(nextIndex, events.length));
	}

	// ── EVENT LISTENERS ──────────────────────────

	btnPlay.addEventListener('click', function() {
		if (isPlaying) {
			pausePlayback();
		} else {
			startPlayback();
		}
	});

	btnSkipNext.addEventListener('click', function() {
		skipToNextEdit();
	});

	skipIdleToggle.addEventListener('change', function() {
		skipIdle = skipIdleToggle.checked;
	});

	// Speed buttons
	document.querySelectorAll('.speed-btn').forEach(function(btn) {
		btn.addEventListener('click', function() {
			speed = parseInt(btn.dataset.speed, 10);
			document.querySelectorAll('.speed-btn').forEach(function(b) {
				b.classList.remove('active');
			});
			btn.classList.add('active');
			statSpeed.textContent = speed + 'x';
		});
	});

	// Scrubber click to seek
	scrubber.addEventListener('click', function(e) {
		const rect = scrubber.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		const targetTs = startTimestamp + fraction * (endTimestamp - startTimestamp);

		// Find the closest event index
		let targetIndex = 0;
		for (let i = 0; i < events.length; i++) {
			if (events[i].timestamp <= targetTs) {
				targetIndex = i + 1;
			} else {
				break;
			}
		}

		seekTo(targetIndex);
	});

	// Mini timeline click to seek
	miniTimelineCanvas.addEventListener('click', function(e) {
		const rect = miniTimelineCanvas.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		const targetTs = startTimestamp + fraction * (endTimestamp - startTimestamp);

		let targetIndex = 0;
		for (let i = 0; i < events.length; i++) {
			if (events[i].timestamp <= targetTs) {
				targetIndex = i + 1;
			} else {
				break;
			}
		}

		seekTo(targetIndex);
	});

	// File selector
	fileSelect.addEventListener('change', function() {
		vscodeApi.postMessage({ type: 'selectFile', filename: fileSelect.value });
	});

	// Keyboard shortcuts
	document.addEventListener('keydown', function(e) {
		if (e.code === 'Space') {
			e.preventDefault();
			if (isPlaying) {
				pausePlayback();
			} else {
				startPlayback();
			}
		} else if (e.code === 'ArrowRight') {
			e.preventDefault();
			skipToNextEdit();
		} else if (e.code === 'ArrowLeft') {
			e.preventDefault();
			seekTo(Math.max(0, currentIndex - 10));
		}
	});

	// ── INITIALIZATION ───────────────────────────

	// Set initial speed button active
	document.querySelector('.speed-btn[data-speed="1"]').classList.add('active');

	// Set timestamps
	currentTimeEl.textContent = formatTimestamp(startTimestamp);
	endTimeEl.textContent = formatTimestamp(endTimestamp);

	// Draw mini timeline
	drawMiniTimeline();

	// Initial render
	render();
	updateScrubber();

	// Redraw mini timeline on resize
	window.addEventListener('resize', function() {
		drawMiniTimeline();
	});
})();
`;
	}

	/**
	 * Disposes the panel and cleans up resources.
	 */
	dispose(): void {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
	}
}

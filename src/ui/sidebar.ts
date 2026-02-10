import * as vscode from 'vscode';

/** Recording state for the sidebar display */
export type RecordingState = 'recording' | 'paused' | 'stopped';

/** Data sent from the extension to update the sidebar UI */
export interface SidebarStatusUpdate {
	/** Current recording state */
	recordingState: RecordingState;
	/** Session duration in seconds */
	sessionDurationSeconds: number;
	/** Number of snapshots taken */
	snapshotCount: number;
	/** Number of files being tracked */
	filesTracked: number;
	/** List of tracked filenames with change counts */
	trackedFiles: Array<{ filename: string; changeCount: number }>;
	/** Last snapshot ISO timestamp, or empty string */
	lastSnapshotTime: string;
	/** Number of paste events detected */
	pasteEventCount: number;
	/** Whether auto-start is enabled */
	autoStart: boolean;
	/** Current snapshot interval in seconds */
	snapshotInterval: number;
	/** AI provider status description */
	aiStatus: string;
}

/** Message types sent from the sidebar WebView to the extension */
export interface SidebarMessage {
	type:
		| 'start'
		| 'pause'
		| 'stop'
		| 'openDashboard'
		| 'reviewFlags'
		| 'exportReport'
		| 'openInBrowser'
		| 'emailReport'
		| 'setAutoStart'
		| 'setSnapshotInterval';
	/** Boolean value for toggle messages */
	value?: boolean;
	/** Numeric value for interval changes */
	interval?: number;
}

/**
 * WebviewViewProvider for the CodeProof sidebar panel in the Activity Bar.
 * Renders a control panel with recording status, session info, action buttons,
 * and quick settings. Communicates with the extension via message passing.
 */
export class CodeProofSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'codeproof.sidebar';

	private view: vscode.WebviewView | undefined;
	private currentStatus: SidebarStatusUpdate = {
		recordingState: 'stopped',
		sessionDurationSeconds: 0,
		snapshotCount: 0,
		filesTracked: 0,
		trackedFiles: [],
		lastSnapshotTime: '',
		pasteEventCount: 0,
		autoStart: true,
		snapshotInterval: 30,
		aiStatus: 'No AI key configured',
	};

	private readonly onMessageEmitter = new vscode.EventEmitter<SidebarMessage>();

	/** Event fired when the sidebar sends a message to the extension */
	public readonly onMessage: vscode.Event<SidebarMessage> = this.onMessageEmitter.event;

	/**
	 * Creates a new CodeProofSidebarProvider.
	 *
	 * @param extensionUri - The URI of the extension's root directory
	 */
	constructor(private readonly extensionUri: vscode.Uri) {}

	/**
	 * Called by VS Code when the sidebar view is resolved (made visible).
	 * Sets up the WebView content and message handling.
	 *
	 * @param webviewView - The WebView view instance
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		webviewView.webview.html = this.getHTML();

		webviewView.webview.onDidReceiveMessage((message: SidebarMessage) => {
			this.onMessageEmitter.fire(message);
		});

		// Send current status when the view becomes visible
		this.sendStatusUpdate(this.currentStatus);
	}

	/**
	 * Sends a status update to the sidebar WebView.
	 * Stores the status so it can be re-sent when the view is re-created.
	 *
	 * @param status - The status data to display
	 */
	sendStatusUpdate(status: SidebarStatusUpdate): void {
		this.currentStatus = status;
		if (this.view) {
			this.view.webview.postMessage({
				type: 'statusUpdate',
				data: status,
			});
		}
	}

	/**
	 * Generates the complete HTML for the sidebar WebView panel.
	 *
	 * @returns Complete HTML document string
	 */
	private getHTML(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${this.getStyles()}
</style>
</head>
<body>

<div class="sidebar">

	<!-- RECORDING STATUS -->
	<section class="section status-section">
		<div class="status-indicator" id="statusIndicator">
			<span class="status-dot stopped" id="statusDot"></span>
			<span class="status-text" id="statusText">Stopped</span>
		</div>
		<div class="stats-grid">
			<div class="stat">
				<span class="stat-value" id="duration">0:00</span>
				<span class="stat-label">Duration</span>
			</div>
			<div class="stat">
				<span class="stat-value" id="snapshots">0</span>
				<span class="stat-label">Snapshots</span>
			</div>
			<div class="stat">
				<span class="stat-value" id="filesCount">0</span>
				<span class="stat-label">Files</span>
			</div>
		</div>
		<div class="button-row">
			<button class="btn btn-start" id="btnStart" onclick="send('start')">
				<span class="btn-icon">&#9654;</span> Start
			</button>
			<button class="btn btn-pause" id="btnPause" onclick="send('pause')" disabled>
				<span class="btn-icon">&#10074;&#10074;</span> Pause
			</button>
			<button class="btn btn-stop" id="btnStop" onclick="send('stop')" disabled>
				<span class="btn-icon">&#9632;</span> Stop
			</button>
		</div>
	</section>

	<!-- CURRENT SESSION -->
	<section class="section">
		<h3 class="section-title">Current Session</h3>
		<div class="session-detail">
			<span class="detail-label">Last snapshot</span>
			<span class="detail-value" id="lastSnapshot">--</span>
		</div>
		<div class="session-detail">
			<span class="detail-label">Paste events</span>
			<span class="detail-value" id="pasteEvents">
				<span id="pasteCount">0</span>
				<span class="paste-badge hidden" id="pasteBadge">!</span>
			</span>
		</div>
		<div class="file-list-container">
			<span class="detail-label">Tracked files</span>
			<ul class="file-list" id="fileList">
				<li class="file-item empty">No files tracked yet</li>
			</ul>
		</div>
	</section>

	<!-- ACTIONS -->
	<section class="section">
		<h3 class="section-title">Actions</h3>
		<button class="btn btn-action" onclick="send('openDashboard')">
			<span class="btn-icon">&#128202;</span> Open Dashboard
		</button>
		<button class="btn btn-action" onclick="send('reviewFlags')">
			<span class="btn-icon">&#128681;</span> Review Flags
		</button>
		<button class="btn btn-action" onclick="send('exportReport')">
			<span class="btn-icon">&#8595;</span> Export Report
		</button>
		<button class="btn btn-action" onclick="send('openInBrowser')">
			<span class="btn-icon">&#8599;</span> Open in Browser
		</button>
		<button class="btn btn-action" onclick="send('emailReport')">
			<span class="btn-icon">&#9993;</span> Email Report
		</button>
	</section>

	<!-- QUICK SETTINGS -->
	<section class="section">
		<h3 class="section-title">Quick Settings</h3>
		<div class="setting-row">
			<span class="setting-label">Auto-start</span>
			<label class="toggle">
				<input type="checkbox" id="autoStartToggle" onchange="toggleAutoStart()">
				<span class="toggle-slider"></span>
			</label>
		</div>
		<div class="setting-row">
			<span class="setting-label">Snapshot interval</span>
			<select class="interval-select" id="intervalSelect" onchange="changeInterval()">
				<option value="15">15s</option>
				<option value="30" selected>30s</option>
				<option value="60">60s</option>
				<option value="120">120s</option>
			</select>
		</div>
		<div class="setting-row ai-status-row">
			<span class="setting-label">AI Provider</span>
			<span class="ai-status" id="aiStatus">No AI key configured</span>
		</div>
	</section>

</div>

<script>
${this.getScript()}
</script>
</body>
</html>`;
	}

	/**
	 * Returns the CSS styles for the sidebar, using VS Code theme variables.
	 *
	 * @returns CSS string
	 */
	private getStyles(): string {
		return `
* {
	margin: 0;
	padding: 0;
	box-sizing: border-box;
}

body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-editor-foreground);
	background: var(--vscode-sideBar-background);
	padding: 0;
	overflow-x: hidden;
}

.sidebar {
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

/* ── SECTIONS ─────────────────────────────────── */
.section {
	padding: 12px;
	border-radius: 6px;
	background: var(--vscode-editor-background);
	border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
	margin-bottom: 8px;
}

.section-title {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 10px;
}

/* ── STATUS INDICATOR ─────────────────────────── */
.status-section {
	text-align: center;
}

.status-indicator {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	margin-bottom: 12px;
}

.status-dot {
	width: 12px;
	height: 12px;
	border-radius: 50%;
	display: inline-block;
	flex-shrink: 0;
}

.status-dot.recording {
	background: #4caf50;
	box-shadow: 0 0 6px rgba(76, 175, 80, 0.6);
	animation: pulse 1.5s ease-in-out infinite;
}

.status-dot.paused {
	background: #ff9800;
}

.status-dot.stopped {
	background: var(--vscode-descriptionForeground);
	opacity: 0.5;
}

@keyframes pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.5; }
}

.status-text {
	font-size: 16px;
	font-weight: 700;
}

/* ── STATS GRID ───────────────────────────────── */
.stats-grid {
	display: grid;
	grid-template-columns: 1fr 1fr 1fr;
	gap: 8px;
	margin-bottom: 12px;
}

.stat {
	text-align: center;
	padding: 6px 4px;
	border-radius: 4px;
	background: var(--vscode-sideBar-background);
}

.stat-value {
	display: block;
	font-size: 18px;
	font-weight: 700;
	color: var(--vscode-editor-foreground);
	line-height: 1.2;
}

.stat-label {
	display: block;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.3px;
	color: var(--vscode-descriptionForeground);
	margin-top: 2px;
}

/* ── BUTTON ROW ───────────────────────────────── */
.button-row {
	display: grid;
	grid-template-columns: 1fr 1fr 1fr;
	gap: 6px;
}

.btn {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	padding: 6px 8px;
	border: none;
	border-radius: 4px;
	font-family: var(--vscode-font-family);
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	transition: opacity 0.15s;
	white-space: nowrap;
}

.btn:hover:not(:disabled) {
	opacity: 0.85;
}

.btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.btn-icon {
	font-size: 10px;
}

.btn-start {
	background: #4caf50;
	color: #fff;
}

.btn-pause {
	background: #ff9800;
	color: #fff;
}

.btn-stop {
	background: #f44336;
	color: #fff;
}

/* ── ACTION BUTTONS ───────────────────────────── */
.btn-action {
	width: 100%;
	padding: 8px 12px;
	margin-bottom: 6px;
	background: var(--vscode-button-secondaryBackground, var(--vscode-sideBar-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
	border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
	border-radius: 4px;
	justify-content: flex-start;
	font-weight: 500;
}

.btn-action:hover:not(:disabled) {
	background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
	opacity: 1;
}

.btn-action:last-child {
	margin-bottom: 0;
}

/* ── SESSION DETAILS ──────────────────────────── */
.session-detail {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 4px 0;
	border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.session-detail:last-of-type {
	border-bottom: none;
}

.detail-label {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
}

.detail-value {
	font-size: 12px;
	font-weight: 600;
	display: flex;
	align-items: center;
	gap: 6px;
}

.paste-badge {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	background: #ff9800;
	color: #fff;
	font-size: 10px;
	font-weight: 700;
}

.paste-badge.hidden {
	display: none;
}

/* ── FILE LIST ────────────────────────────────── */
.file-list-container {
	margin-top: 8px;
}

.file-list-container > .detail-label {
	display: block;
	margin-bottom: 6px;
}

.file-list {
	list-style: none;
	max-height: 150px;
	overflow-y: auto;
}

.file-item {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 3px 6px;
	border-radius: 3px;
	font-size: 11px;
	font-family: var(--vscode-editor-font-family, monospace);
}

.file-item:nth-child(odd) {
	background: var(--vscode-sideBar-background);
}

.file-item.empty {
	color: var(--vscode-descriptionForeground);
	font-style: italic;
	font-family: var(--vscode-font-family);
}

.file-change-count {
	font-size: 10px;
	font-weight: 600;
	padding: 1px 6px;
	border-radius: 10px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}

/* ── SETTINGS ─────────────────────────────────── */
.setting-row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 6px 0;
}

/* Toggle switch */
.toggle {
	position: relative;
	display: inline-block;
	width: 36px;
	height: 20px;
}

.toggle input {
	opacity: 0;
	width: 0;
	height: 0;
}

.toggle-slider {
	position: absolute;
	cursor: pointer;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: var(--vscode-descriptionForeground);
	border-radius: 20px;
	transition: 0.2s;
	opacity: 0.4;
}

.toggle-slider::before {
	content: '';
	position: absolute;
	height: 14px;
	width: 14px;
	left: 3px;
	bottom: 3px;
	background: #fff;
	border-radius: 50%;
	transition: 0.2s;
}

.toggle input:checked + .toggle-slider {
	background: #4caf50;
	opacity: 1;
}

.toggle input:checked + .toggle-slider::before {
	transform: translateX(16px);
}

/* Dropdown */
.interval-select {
	padding: 4px 8px;
	border-radius: 4px;
	border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	font-family: var(--vscode-font-family);
	font-size: 12px;
	cursor: pointer;
}

.setting-label {
	font-size: 12px;
	color: var(--vscode-editor-foreground);
}

.ai-status {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
}

.ai-status.connected {
	color: #4caf50;
}
`;
	}

	/**
	 * Returns the JavaScript for sidebar WebView message passing and UI updates.
	 *
	 * @returns JavaScript string
	 */
	private getScript(): string {
		return `
const vscode = acquireVsCodeApi();

/**
 * Sends a message to the extension.
 * @param {string} messageType - The message type to send
 */
function send(messageType) {
	vscode.postMessage({ type: messageType });
}

/**
 * Toggles the auto-start setting.
 */
function toggleAutoStart() {
	const checked = document.getElementById('autoStartToggle').checked;
	vscode.postMessage({ type: 'setAutoStart', value: checked });
}

/**
 * Changes the snapshot interval setting.
 */
function changeInterval() {
	const value = parseInt(document.getElementById('intervalSelect').value, 10);
	vscode.postMessage({ type: 'setSnapshotInterval', interval: value });
}

/**
 * Formats seconds into a human-readable duration string.
 * @param {number} totalSeconds - Duration in seconds
 * @returns {string} Formatted duration (e.g. "1:23:45" or "5:30")
 */
function formatDuration(totalSeconds) {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (num) => String(num).padStart(2, '0');
	if (hours > 0) {
		return hours + ':' + pad(minutes) + ':' + pad(seconds);
	}
	return minutes + ':' + pad(seconds);
}

/**
 * Formats an ISO timestamp to a short time string.
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted time
 */
function formatTime(isoString) {
	if (!isoString) { return '--'; }
	const date = new Date(isoString);
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Updates the sidebar UI with new status data.
 * @param {object} status - The status update payload
 */
function updateUI(status) {
	// Status indicator
	const dot = document.getElementById('statusDot');
	const text = document.getElementById('statusText');
	dot.className = 'status-dot ' + status.recordingState;

	if (status.recordingState === 'recording') {
		text.textContent = 'Recording';
	} else if (status.recordingState === 'paused') {
		text.textContent = 'Paused';
	} else {
		text.textContent = 'Stopped';
	}

	// Stats
	document.getElementById('duration').textContent = formatDuration(status.sessionDurationSeconds);
	document.getElementById('snapshots').textContent = String(status.snapshotCount);
	document.getElementById('filesCount').textContent = String(status.filesTracked);

	// Buttons
	const isRunning = status.recordingState !== 'stopped';
	const isPaused = status.recordingState === 'paused';
	document.getElementById('btnStart').disabled = isRunning && !isPaused;
	document.getElementById('btnPause').disabled = !isRunning;
	document.getElementById('btnStop').disabled = !isRunning;

	// If paused, clicking Start should resume
	if (isPaused) {
		document.getElementById('btnStart').disabled = false;
	}

	// Session details
	document.getElementById('lastSnapshot').textContent = formatTime(status.lastSnapshotTime);
	document.getElementById('pasteCount').textContent = String(status.pasteEventCount);
	const pasteBadge = document.getElementById('pasteBadge');
	if (status.pasteEventCount > 0) {
		pasteBadge.classList.remove('hidden');
	} else {
		pasteBadge.classList.add('hidden');
	}

	// File list
	const fileList = document.getElementById('fileList');
	if (status.trackedFiles && status.trackedFiles.length > 0) {
		fileList.innerHTML = status.trackedFiles.map(function(file) {
			return '<li class="file-item">'
				+ '<span class="file-name">' + escapeHtml(file.filename) + '</span>'
				+ '<span class="file-change-count">' + file.changeCount + '</span>'
				+ '</li>';
		}).join('');
	} else {
		fileList.innerHTML = '<li class="file-item empty">No files tracked yet</li>';
	}

	// Settings
	document.getElementById('autoStartToggle').checked = status.autoStart;
	document.getElementById('intervalSelect').value = String(status.snapshotInterval);

	// AI status
	const aiStatusEl = document.getElementById('aiStatus');
	aiStatusEl.textContent = status.aiStatus;
	if (status.aiStatus.toLowerCase().includes('connected')) {
		aiStatusEl.classList.add('connected');
	} else {
		aiStatusEl.classList.remove('connected');
	}
}

/**
 * Escapes HTML special characters for safe insertion.
 * @param {string} text - Raw text
 * @returns {string} HTML-escaped text
 */
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// Listen for status updates from the extension
window.addEventListener('message', function(event) {
	const message = event.data;
	if (message.type === 'statusUpdate') {
		updateUI(message.data);
	}
});
`;
	}

	/**
	 * Disposes resources held by the sidebar provider.
	 */
	dispose(): void {
		this.onMessageEmitter.dispose();
	}
}

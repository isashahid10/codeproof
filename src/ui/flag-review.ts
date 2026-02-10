import * as vscode from 'vscode';
import { FlagWithContext } from '../snapshot/types.js';

/** Message types sent from the WebView to the extension */
export interface FlagReviewMessage {
	type: 'addContext' | 'acknowledge' | 'dismiss' | 'generateFull' | 'generateClean';
	/** Flag ID for addContext/acknowledge/dismiss */
	flagId?: string;
	/** Student context text for addContext */
	context?: string;
}

/**
 * WebView panel for reviewing detected flags before generating a report.
 * Displays each flag as a card with severity badge, description, diff preview,
 * suggested context, and action buttons. Students can add explanations,
 * acknowledge, or dismiss flags before choosing to generate a full or clean report.
 */
export class FlagReviewPanel {
	private panel: vscode.WebviewPanel | undefined;
	private flags: FlagWithContext[];
	private readonly onMessageEmitter = new vscode.EventEmitter<FlagReviewMessage>();

	/** Event fired when the WebView sends a message to the extension */
	public readonly onMessage = this.onMessageEmitter.event;

	/**
	 * Creates a new FlagReviewPanel.
	 *
	 * @param flags - Array of flags with context to display
	 */
	constructor(flags: FlagWithContext[]) {
		this.flags = flags;
	}

	/**
	 * Opens the WebView panel and renders the flag review UI.
	 *
	 * @param extensionUri - The extension's root URI for loading resources
	 */
	show(extensionUri: vscode.Uri): void {
		this.panel = vscode.window.createWebviewPanel(
			'codeproofFlagReview',
			'CodeProof — Review Flags',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		this.panel.webview.html = this.getHTML();

		this.panel.webview.onDidReceiveMessage((message: FlagReviewMessage) => {
			this.onMessageEmitter.fire(message);

			// Update local state for re-renders
			if (message.type === 'addContext' && message.flagId && message.context !== undefined) {
				const flag = this.flags.find((flagItem) => flagItem.id === message.flagId);
				if (flag) {
					flag.studentContext = message.context;
					flag.status = 'context_added';
				}
			} else if (message.type === 'acknowledge' && message.flagId) {
				const flag = this.flags.find((flagItem) => flagItem.id === message.flagId);
				if (flag) {
					flag.status = 'acknowledged';
				}
			} else if (message.type === 'dismiss' && message.flagId) {
				const flag = this.flags.find((flagItem) => flagItem.id === message.flagId);
				if (flag) {
					flag.status = 'dismissed';
				}
			}
		});

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	/**
	 * Updates the flags displayed in the panel and re-renders.
	 *
	 * @param flags - Updated array of flags
	 */
	updateFlags(flags: FlagWithContext[]): void {
		this.flags = flags;
		if (this.panel) {
			this.panel.webview.html = this.getHTML();
		}
	}

	/**
	 * Returns the current flags (with any student-applied changes).
	 *
	 * @returns The current flags array
	 */
	getFlags(): FlagWithContext[] {
		return this.flags;
	}

	/**
	 * Disposes the panel.
	 */
	dispose(): void {
		this.panel?.dispose();
	}

	/**
	 * Generates the complete HTML for the flag review WebView.
	 *
	 * @returns Complete HTML document string
	 */
	private getHTML(): string {
		const highCount = this.flags.filter((flag) => flag.severity === 'high').length;
		const mediumCount = this.flags.filter((flag) => flag.severity === 'medium').length;
		const lowCount = this.flags.filter((flag) => flag.severity === 'low').length;

		const flagCards = this.flags.map((flag, index) => this.renderFlagCard(flag, index)).join('\n');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeProof — Flag Review</title>
<style>
${this.getStyles()}
</style>
</head>
<body>

<div class="container">
	<div class="header">
		<div class="header-title">
			<span class="logo-icon">&#9672;</span>
			<h1>Pre-Submission Review</h1>
		</div>
		<p class="header-description">
			We found some patterns in your development history that a reviewer might notice.
			This is completely normal — most students will see some flags. Adding context to
			explain flagged items makes your submission stronger and more transparent.
		</p>
	</div>

	<div class="summary-bar">
		<div class="summary-counts">
			<span class="summary-total">${this.flags.length} flag${this.flags.length !== 1 ? 's' : ''} detected</span>
			${highCount > 0 ? `<span class="badge badge-high">${highCount} high</span>` : ''}
			${mediumCount > 0 ? `<span class="badge badge-medium">${mediumCount} medium</span>` : ''}
			${lowCount > 0 ? `<span class="badge badge-low">${lowCount} low</span>` : ''}
		</div>
		<p class="summary-hint">Review these before generating your report. Adding context to flagged items strengthens your submission.</p>
	</div>

	${this.flags.length === 0 ? `
	<div class="no-flags">
		<div class="no-flags-icon">&#10003;</div>
		<h2>No flags detected</h2>
		<p>Your development history looks great! No suspicious patterns were found.
		   You can go ahead and generate your report with confidence.</p>
	</div>
	` : `
	<div class="flag-list">
		${flagCards}
	</div>
	`}

	<div class="actions-bar">
		<button class="btn btn-primary" onclick="generateFull()">
			Generate Full Report (with flags)
		</button>
		<button class="btn btn-secondary" onclick="generateClean()">
			Generate Clean Report (without flags)
		</button>
	</div>

	<p class="actions-note">
		<strong>Tip:</strong> The full report with your explanations is recommended for academic submissions —
		transparency demonstrates integrity. The clean report is useful for portfolios and personal records.
	</p>
</div>

<script>
${this.getScript()}
</script>

</body>
</html>`;
	}

	/**
	 * Renders a single flag card as HTML.
	 *
	 * @param flag - The flag to render
	 * @param index - Index for unique element IDs
	 * @returns HTML string for the card
	 */
	private renderFlagCard(flag: FlagWithContext, index: number): string {
		const severityClass = this.getSeverityClass(flag.severity);
		const severityLabel = flag.severity.charAt(0).toUpperCase() + flag.severity.slice(1);
		const categoryLabel = this.formatCategory(flag.category);
		const time = new Date(flag.timestamp).toLocaleString();
		const statusLabel = this.getStatusLabel(flag.status);
		const escapedDescription = this.escapeHTML(flag.description);
		const escapedSuggestion = this.escapeHTML(flag.suggestedContext);
		const escapedContext = this.escapeHTML(flag.studentContext);

		return `
	<div class="flag-card ${severityClass}" id="flag-${index}">
		<div class="flag-header">
			<span class="severity-badge ${severityClass}">${severityLabel}</span>
			<span class="flag-category">${categoryLabel}</span>
			${statusLabel ? `<span class="status-label status-${flag.status}">${statusLabel}</span>` : ''}
		</div>
		<p class="flag-description">${escapedDescription}</p>
		<div class="flag-meta">
			<span class="flag-time">${time}</span>
			<span class="flag-file">${this.escapeHTML(flag.filename)}</span>
		</div>
		<p class="flag-suggestion"><em>${escapedSuggestion}</em></p>
		<div class="flag-context-area">
			<textarea
				id="context-${index}"
				class="context-input"
				placeholder="Write your explanation here..."
				rows="3"
			>${escapedContext}</textarea>
		</div>
		<div class="flag-actions">
			<button class="btn btn-small btn-add-context" onclick="addContext('${flag.id}', ${index})">
				Add Context
			</button>
			<button class="btn btn-small btn-acknowledge" onclick="acknowledge('${flag.id}')">
				Acknowledge
			</button>
			<button class="btn btn-small btn-dismiss" onclick="dismiss('${flag.id}')">
				Dismiss
			</button>
		</div>
	</div>`;
	}

	/**
	 * Returns the CSS class for a severity level.
	 *
	 * @param severity - The flag severity
	 * @returns CSS class name
	 */
	private getSeverityClass(severity: string): string {
		switch (severity) {
			case 'high': return 'severity-high';
			case 'medium': return 'severity-medium';
			case 'low': return 'severity-low';
			default: return 'severity-low';
		}
	}

	/**
	 * Formats a flag category as a readable label.
	 *
	 * @param category - The flag category
	 * @returns Human-readable label
	 */
	private formatCategory(category: string): string {
		return category
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	}

	/**
	 * Returns a label for the current flag status, or empty string for default.
	 *
	 * @param status - The flag status
	 * @returns Display label
	 */
	private getStatusLabel(status: string): string {
		switch (status) {
			case 'context_added': return 'Context Added';
			case 'dismissed': return 'Dismissed';
			case 'acknowledged': return '';
			default: return '';
		}
	}

	/**
	 * Escapes HTML special characters.
	 *
	 * @param text - Raw text
	 * @returns HTML-safe string
	 */
	private escapeHTML(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	/**
	 * Returns the CSS stylesheet for the flag review panel.
	 *
	 * @returns CSS string
	 */
	private getStyles(): string {
		return `
:root {
	--primary: #1a1a2e;
	--accent: #4361ee;
	--success: #2ec4b6;
	--warning: #ff9f1c;
	--danger: #e71d36;
	--bg: #f8f9fa;
	--bg-card: #ffffff;
	--text: #2d3436;
	--text-secondary: #636e72;
	--border: #e9ecef;
	--shadow: 0 2px 8px rgba(0,0,0,0.08);
	--radius: 12px;
	--font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	--mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
	font-family: var(--font);
	font-size: 15px;
	line-height: 1.6;
	color: var(--text);
	background: var(--bg);
	padding: 2rem;
}

.container {
	max-width: 800px;
	margin: 0 auto;
}

/* ── HEADER ─────────────────────────────────── */
.header {
	margin-bottom: 1.5rem;
}

.header-title {
	display: flex;
	align-items: center;
	gap: 0.6rem;
	margin-bottom: 0.8rem;
}

.header-title h1 {
	font-size: 1.5rem;
	font-weight: 700;
	color: var(--primary);
}

.logo-icon {
	color: var(--accent);
	font-size: 1.3rem;
}

.header-description {
	color: var(--text-secondary);
	font-size: 0.9rem;
	line-height: 1.6;
}

/* ── SUMMARY BAR ────────────────────────────── */
.summary-bar {
	background: var(--bg-card);
	border-radius: var(--radius);
	padding: 1.2rem 1.5rem;
	margin-bottom: 1.5rem;
	box-shadow: var(--shadow);
	border: 1px solid var(--border);
}

.summary-counts {
	display: flex;
	align-items: center;
	gap: 0.8rem;
	margin-bottom: 0.5rem;
	flex-wrap: wrap;
}

.summary-total {
	font-size: 1rem;
	font-weight: 600;
	color: var(--primary);
}

.badge {
	display: inline-block;
	padding: 0.15rem 0.65rem;
	border-radius: 20px;
	font-size: 0.75rem;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.3px;
}

.badge-high { background: #ffebee; color: #c62828; }
.badge-medium { background: #fff3e0; color: #e65100; }
.badge-low { background: #e8f5e9; color: #2e7d32; }

.summary-hint {
	color: var(--text-secondary);
	font-size: 0.82rem;
}

/* ── NO FLAGS ───────────────────────────────── */
.no-flags {
	text-align: center;
	padding: 3rem 2rem;
	background: var(--bg-card);
	border-radius: var(--radius);
	box-shadow: var(--shadow);
	border: 2px solid var(--success);
	margin-bottom: 1.5rem;
}

.no-flags-icon {
	font-size: 3rem;
	color: var(--success);
	margin-bottom: 0.8rem;
}

.no-flags h2 {
	font-size: 1.3rem;
	color: var(--primary);
	margin-bottom: 0.5rem;
}

.no-flags p {
	color: var(--text-secondary);
	font-size: 0.9rem;
	max-width: 500px;
	margin: 0 auto;
}

/* ── FLAG CARDS ─────────────────────────────── */
.flag-list {
	display: flex;
	flex-direction: column;
	gap: 1rem;
	margin-bottom: 1.5rem;
}

.flag-card {
	background: var(--bg-card);
	border-radius: var(--radius);
	padding: 1.5rem;
	box-shadow: var(--shadow);
	border-left: 4px solid var(--border);
	border-top: 1px solid var(--border);
	border-right: 1px solid var(--border);
	border-bottom: 1px solid var(--border);
}

.flag-card.severity-high { border-left-color: var(--danger); }
.flag-card.severity-medium { border-left-color: var(--warning); }
.flag-card.severity-low { border-left-color: var(--success); }

.flag-header {
	display: flex;
	align-items: center;
	gap: 0.6rem;
	margin-bottom: 0.8rem;
	flex-wrap: wrap;
}

.severity-badge {
	display: inline-block;
	padding: 0.2rem 0.7rem;
	border-radius: 20px;
	font-size: 0.72rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.severity-badge.severity-high { background: #ffebee; color: #c62828; }
.severity-badge.severity-medium { background: #fff3e0; color: #e65100; }
.severity-badge.severity-low { background: #e8f5e9; color: #2e7d32; }

.flag-category {
	font-weight: 600;
	font-size: 0.9rem;
	color: var(--primary);
}

.status-label {
	margin-left: auto;
	font-size: 0.75rem;
	font-weight: 600;
	padding: 0.15rem 0.6rem;
	border-radius: 20px;
}

.status-context_added { background: #e8f5e9; color: #2e7d32; }
.status-dismissed { background: #f5f5f5; color: #9e9e9e; }

.flag-description {
	color: var(--text);
	font-size: 0.9rem;
	line-height: 1.6;
	margin-bottom: 0.6rem;
}

.flag-meta {
	display: flex;
	gap: 1rem;
	margin-bottom: 0.8rem;
	flex-wrap: wrap;
}

.flag-time {
	font-size: 0.78rem;
	color: var(--text-secondary);
	font-family: var(--mono);
}

.flag-file {
	font-family: var(--mono);
	font-size: 0.78rem;
	font-weight: 500;
	color: var(--accent);
	background: #eef1ff;
	padding: 0.1rem 0.4rem;
	border-radius: 4px;
}

.flag-suggestion {
	color: var(--text-secondary);
	font-size: 0.82rem;
	margin-bottom: 0.8rem;
	padding: 0.6rem 0.8rem;
	background: var(--bg);
	border-radius: 8px;
	border-left: 3px solid var(--border);
}

.flag-context-area {
	margin-bottom: 0.8rem;
}

.context-input {
	width: 100%;
	padding: 0.7rem 0.9rem;
	border: 1px solid var(--border);
	border-radius: 8px;
	font-family: var(--font);
	font-size: 0.85rem;
	color: var(--text);
	background: var(--bg-card);
	resize: vertical;
	transition: border-color 0.15s;
	line-height: 1.5;
}

.context-input:focus {
	outline: none;
	border-color: var(--accent);
	box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.1);
}

.context-input::placeholder {
	color: #b2bec3;
}

.flag-actions {
	display: flex;
	gap: 0.5rem;
	flex-wrap: wrap;
}

/* ── BUTTONS ────────────────────────────────── */
.btn {
	padding: 0.6rem 1.2rem;
	border-radius: 8px;
	border: none;
	font-family: var(--font);
	font-size: 0.85rem;
	font-weight: 600;
	cursor: pointer;
	transition: all 0.15s ease;
}

.btn:hover {
	transform: translateY(-1px);
}

.btn:active {
	transform: translateY(0);
}

.btn-primary {
	background: var(--accent);
	color: #fff;
	padding: 0.8rem 1.5rem;
	font-size: 0.9rem;
}

.btn-primary:hover {
	background: #3451d1;
	box-shadow: 0 4px 12px rgba(67, 97, 238, 0.3);
}

.btn-secondary {
	background: transparent;
	color: var(--accent);
	border: 2px solid var(--accent);
	padding: 0.8rem 1.5rem;
	font-size: 0.9rem;
}

.btn-secondary:hover {
	background: rgba(67, 97, 238, 0.06);
}

.btn-small {
	padding: 0.35rem 0.8rem;
	font-size: 0.78rem;
}

.btn-add-context {
	background: var(--accent);
	color: #fff;
}

.btn-add-context:hover {
	background: #3451d1;
}

.btn-acknowledge {
	background: #e8f5e9;
	color: #2e7d32;
}

.btn-acknowledge:hover {
	background: #c8e6c9;
}

.btn-dismiss {
	background: #f5f5f5;
	color: #757575;
}

.btn-dismiss:hover {
	background: #eeeeee;
}

/* ── ACTIONS BAR ────────────────────────────── */
.actions-bar {
	display: flex;
	gap: 1rem;
	margin-bottom: 1rem;
	flex-wrap: wrap;
}

.actions-note {
	color: var(--text-secondary);
	font-size: 0.8rem;
	line-height: 1.5;
}

.actions-note strong {
	color: var(--text);
}
`;
	}

	/**
	 * Returns the JavaScript for WebView message passing.
	 *
	 * @returns JavaScript string
	 */
	private getScript(): string {
		return `
const vscode = acquireVsCodeApi();

function addContext(flagId, index) {
	const textarea = document.getElementById('context-' + index);
	const context = textarea ? textarea.value : '';
	vscode.postMessage({ type: 'addContext', flagId: flagId, context: context });
}

function acknowledge(flagId) {
	vscode.postMessage({ type: 'acknowledge', flagId: flagId });
}

function dismiss(flagId) {
	vscode.postMessage({ type: 'dismiss', flagId: flagId });
}

function generateFull() {
	vscode.postMessage({ type: 'generateFull' });
}

function generateClean() {
	vscode.postMessage({ type: 'generateClean' });
}
`;
	}
}

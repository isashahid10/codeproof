import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SnapshotStorage } from '../snapshot/storage.js';
import { Snapshot, Session, FlagWithContext } from '../snapshot/types.js';
import { AIProvider, ConfidenceResult } from './ai-provider.js';

/** Options for report generation */
export interface ReportOptions {
	/** Filter by filename */
	filename?: string;
	/** Include only snapshots after this ISO 8601 timestamp */
	after?: string;
	/** Include only snapshots before this ISO 8601 timestamp */
	before?: string;
	/** Filter by session ID */
	sessionId?: string;
	/** Student name for the report header */
	studentName?: string;
	/** Assignment name for the report header */
	assignmentName?: string;
	/** Optional flags with student context — included in full report, omitted for clean report */
	flags?: FlagWithContext[];
}

/** Maximum gap in ms between consecutive edits to count as active time (5 minutes) */
const ACTIVE_GAP_THRESHOLD_MS = 5 * 60_000;

/** Per-file aggregated statistics */
interface FileStats {
	filename: string;
	totalChanges: number;
	linesAdded: number;
	linesRemoved: number;
	pasteEvents: number;
	/** Cumulative active editing time in milliseconds */
	timeSpentMs: number;
	/** Ordered timestamps for computing active time */
	timestamps: string[];
}

/** AI-generated content for the report */
interface AIContent {
	narrative: string;
	confidence: ConfidenceResult;
}

/**
 * Generates self-contained HTML reports from CodeProof snapshot data.
 * The report includes timeline charts, statistics, diffs, AI analysis,
 * and hash chain verification.
 */
export class ReportGenerator {
	private readonly storage: SnapshotStorage;
	private readonly aiProvider: AIProvider | null;
	private readonly extensionContext: vscode.ExtensionContext;

	/**
	 * Creates a new ReportGenerator.
	 *
	 * @param storage - The SnapshotStorage instance to query data from
	 * @param extensionContext - The VS Code extension context for accessing extension resources
	 * @param aiProvider - Optional AI provider for narrative generation
	 */
	constructor(storage: SnapshotStorage, extensionContext: vscode.ExtensionContext, aiProvider?: AIProvider) {
		this.storage = storage;
		this.extensionContext = extensionContext;
		this.aiProvider = aiProvider || null;
	}

	/**
	 * Generates a complete self-contained HTML report.
	 *
	 * @param options - Filtering and metadata options for the report
	 * @returns A complete HTML document string
	 */
	async generateHTML(options: ReportOptions = {}): Promise<string> {
		const logoPath = path.join(this.extensionContext.extensionPath, 'icon.png');
		const logoBase64 = fs.readFileSync(logoPath).toString('base64');
		const logoDataUri = `data:image/png;base64,${logoBase64}`;

		const snapshots = this.storage.getSnapshots({
			filename: options.filename,
			after: options.after,
			before: options.before,
			sessionId: options.sessionId,
		});

		const sessions = this.storage.getSessions();
		const chainIntact = this.storage.verifyHashChain();

		const studentName = options.studentName || 'Student';
		const assignmentName = options.assignmentName || 'Assignment';

		const fileStats = this.computeFileStats(snapshots);
		const pasteCount = snapshots.filter((snap) => snap.change_type === 'paste').length;
		const totalDevTime = this.computeTotalDevTime(sessions);
		const dateRange = this.computeDateRange(snapshots);
		const distinctFiles = new Set(snapshots.map((snap) => snap.filename)).size;

		const timelineData = this.buildTimelineData(snapshots);
		const editFrequencyData = this.buildEditFrequencyData(snapshots);
		const sessionBoundaries = this.buildSessionBoundaries(sessions);

		const firstHash = snapshots.length > 0 ? snapshots[0].chain_hash : 'N/A';
		const lastHash = snapshots.length > 0 ? snapshots[snapshots.length - 1].chain_hash : 'N/A';

		// Generate AI content if provider is available
		const aiContent = await this.generateAIContent(snapshots, studentName, assignmentName, options.flags);

		const baseHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeProof Report — ${this.escapeHTML(assignmentName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation"></script>
<style>
${this.getStyles()}
</style>
</head>
<body>

<!-- CODEPROOF-ACTION-BAR-START -->
<div class="action-bar">
  <button class="action-btn" onclick="handleDownloadPDF()" title="Download PDF"><span class="action-icon">\u2193</span> Download PDF</button>
  <button class="action-btn" onclick="handleOpenBrowser()" title="Open in Browser"><span class="action-icon">\u2197</span> Open in Browser</button>
  <button class="action-btn" onclick="handleEmailReport()" title="Email Report"><span class="action-icon">\u2709</span> Email Report</button>
</div>
<!-- CODEPROOF-ACTION-BAR-END -->

<header>
  <div class="header-content">
    <div class="header-top">
      <div class="header-title-row">
        <div class="logo">
          <span class="logo-icon">&#9672;</span> CodeProof
        </div>
        <img src="${logoDataUri}" alt="CodeProof Logo" class="header-logo" />
      </div>
      <div class="header-subtitle">Development Authenticity Report</div>
    </div>
    <div class="header-meta">
      <div class="meta-item">
        <div class="meta-label">Student</div>
        <div class="meta-value">${this.escapeHTML(studentName)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Assignment</div>
        <div class="meta-value">${this.escapeHTML(assignmentName)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Date Range</div>
        <div class="meta-value">${dateRange}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Generated</div>
        <div class="meta-value">${this.formatTimestamp(new Date())}</div>
      </div>
    </div>
  </div>
</header>

<main>

<section class="stats-cards">
  <div class="stat-card">
    <div class="stat-icon">&#9201;</div>
    <div class="stat-value">${totalDevTime}</div>
    <div class="stat-label">Total Coding Time</div>
  </div>
  <div class="stat-card">
    <div class="stat-icon">&#9654;</div>
    <div class="stat-value">${sessions.length}</div>
    <div class="stat-label">Sessions</div>
  </div>
  <div class="stat-card">
    <div class="stat-icon">&#9673;</div>
    <div class="stat-value">${snapshots.length}</div>
    <div class="stat-label">Snapshots Recorded</div>
  </div>
  <div class="stat-card">
    <div class="stat-icon">&#9782;</div>
    <div class="stat-value">${distinctFiles}</div>
    <div class="stat-label">Files Tracked</div>
  </div>
  <div class="stat-card">
    <div class="stat-icon">&#9112;</div>
    <div class="stat-value ${pasteCount > 0 ? 'value-warning' : ''}">${pasteCount}</div>
    <div class="stat-label">Paste Events</div>
  </div>
</section>

${this.renderAISection(aiContent)}

${this.renderFlagsSection(options.flags)}

<section class="card">
  <h2 class="section-title">Code Progression Over Time</h2>
  <div class="chart-container">
    <canvas id="timelineChart"></canvas>
  </div>
</section>

<section class="card">
  <h2 class="section-title">Edit Frequency Distribution</h2>
  <div class="chart-container">
    <canvas id="frequencyChart"></canvas>
  </div>
</section>

<section class="card">
  <h2 class="section-title">File Activity</h2>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Changes</th>
          <th>Lines Added</th>
          <th>Lines Removed</th>
          <th>Time Spent</th>
          <th>Paste Events</th>
        </tr>
      </thead>
      <tbody>
${fileStats.map((file) => `        <tr>
          <td class="file-cell">${this.escapeHTML(file.filename)}</td>
          <td>${file.totalChanges}</td>
          <td class="text-success">+${file.linesAdded}</td>
          <td class="text-danger">-${file.linesRemoved}</td>
          <td>${file.timeSpentMs < 60_000 ? '< 1m' : this.formatDuration(file.timeSpentMs)}</td>
          <td>${file.pasteEvents > 0 ? `<span class="paste-badge">${file.pasteEvents}</span>` : '<span class="text-muted">0</span>'}</td>
        </tr>`).join('\n')}
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2 class="section-title">Change Log</h2>
  <div class="changelog">
${snapshots.map((snap, index) => this.renderChangelogEntry(snap, index)).join('\n')}
  </div>
</section>

<section class="card">
  <h2 class="section-title">Integrity Verification</h2>
  <div class="integrity-box ${chainIntact ? 'integrity-verified' : 'integrity-broken'}">
    <div class="integrity-status">
      <span class="integrity-icon">${chainIntact ? '&#10003;' : '&#10007;'}</span>
      <div class="integrity-text">
        <strong>${chainIntact ? 'Hash Chain Verified' : 'Hash Chain Broken'}</strong>
        <span>${chainIntact
          ? `— ${snapshots.length} snapshots, chain intact`
          : '— tampering detected'}</span>
      </div>
    </div>
    <div class="integrity-details">
      <div class="hash-row"><span class="hash-label">Chain length:</span> <code>${snapshots.length} snapshots</code></div>
      <div class="hash-row"><span class="hash-label">First hash:</span> <code>${firstHash}</code></div>
      <div class="hash-row"><span class="hash-label">Last hash:</span> <code>${lastHash}</code></div>
      <div class="hash-row"><span class="hash-label">Algorithm:</span> <code>SHA-256(prev_chain_hash + content_hash + timestamp)</code></div>
    </div>
    <p class="integrity-explainer">Each snapshot is cryptographically linked to the previous one. A verified chain means no snapshots were inserted, removed, or modified after recording.</p>
  </div>
</section>

</main>

<footer>
  <div class="footer-content">
    <p>Generated by <strong>CodeProof</strong> v0.1.0</p>
    <p class="footer-note">This report is provided as supplementary evidence of development process. Hash chain can be independently verified.</p>
  </div>
</footer>

<script>
${this.getChartScript(timelineData, editFrequencyData, sessionBoundaries)}
</script>

<!-- CODEPROOF-ACTION-BAR-SCRIPT-START -->
<script>
${this.getActionBarScript(studentName, assignmentName, snapshots.length, sessions.length, chainIntact)}
</script>
<!-- CODEPROOF-ACTION-BAR-SCRIPT-END -->

</body>
</html>`;

		return this.embedVerificationId(baseHtml, snapshots.length);
	}

	/**
	 * Computes a SHA-256 hash of the report HTML and embeds a verification ID,
	 * corresponding meta tags, and a visible verification block into the document.
	 * The verification website can later strip these markers and re-hash to verify integrity.
	 *
	 * The hash is computed from the base HTML BEFORE inserting any verification data,
	 * avoiding a circular dependency.
	 *
	 * @param baseHtml - The complete HTML report without verification markers
	 * @param snapshotCount - Number of snapshots in the report for the verification block
	 * @returns The HTML with verification ID, meta tags, and visible verification block embedded
	 */
	private embedVerificationId(baseHtml: string, snapshotCount: number): string {
		const hash = crypto.createHash('sha256').update(baseHtml, 'utf8').digest('hex');
		const now = new Date();
		const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
		const verificationId = `CP-${dateStr}-${hash.substring(0, 12)}`;
		const generatedStr = this.formatTimestamp(now);

		const metaTags = [
			'\n<!-- CODEPROOF-VERIFICATION-META-START -->',
			`<meta name="codeproof-verification" content="${verificationId}">`,
			`<meta name="codeproof-hash" content="${hash}">`,
			'<!-- CODEPROOF-VERIFICATION-META-END -->'
		].join('\n');

		const badge = [
			'\n    <!-- CODEPROOF-VERIFICATION-BADGE-START -->',
			`    <div class="verification-id">${verificationId}</div>`,
			'    <!-- CODEPROOF-VERIFICATION-BADGE-END -->'
		].join('\n');

		/* Visible verification block — uses monospace font and a visible border
		   so it survives PDF conversion intact and pdf.js can extract the text. */
		const verificationBlock = `
<!-- CODEPROOF-VERIFICATION-BLOCK-START -->
<section class="card verification-block">
  <pre class="verification-pre">┌─────────────────────────────────────────────────────────────────────┐
│ VERIFICATION                                                        │
│ ID: ${verificationId.padEnd(64)}│
│ Hash: ${hash}  │
│ Chain Length: ${String(snapshotCount).padEnd(55)}│
│ Generated: ${generatedStr.padEnd(57)}│
│ Verify at: codeproof.netlify.app#verify${' '.repeat(30)}│
└─────────────────────────────────────────────────────────────────────┘</pre>
</section>
<!-- CODEPROOF-VERIFICATION-BLOCK-END -->
`;

		let finalHtml = baseHtml.replace(
			'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
			'<meta name="viewport" content="width=device-width, initial-scale=1.0">' + metaTags
		);

		finalHtml = finalHtml.replace(
			'<div class="header-subtitle">Development Authenticity Report</div>',
			'<div class="header-subtitle">Development Authenticity Report</div>' + badge
		);

		/* Insert the visible verification block above the footer */
		finalHtml = finalHtml.replace(
			'</main>\n\n<footer>',
			'</main>\n' + verificationBlock + '\n<footer>'
		);

		return finalHtml;
	}

	/**
	 * Generates AI content (narrative + confidence score) if a provider is available.
	 * When flags are provided, includes their context in the narrative prompt so the
	 * AI can reference them naturally in the development story.
	 *
	 * @param snapshots - Array of snapshots for analysis
	 * @param studentName - Student name for the narrative
	 * @param assignmentName - Assignment name for context
	 * @param flags - Optional flags to include in the AI narrative context
	 * @returns AI-generated content or null if no provider
	 */
	private async generateAIContent(
		snapshots: Snapshot[],
		studentName: string,
		assignmentName: string,
		flags?: FlagWithContext[]
	): Promise<AIContent | null> {
		if (!this.aiProvider || snapshots.length === 0) {
			return null;
		}

		try {
			const narrative = await this.aiProvider.generateNarrative(
				snapshots,
				studentName,
				assignmentName,
				flags
			);
			const confidence = await this.aiProvider.generateConfidenceScore(snapshots);

			return { narrative, confidence };
		} catch (error) {
			console.error('[CodeProof] AI content generation failed:', error);
			return null;
		}
	}

	/**
	 * Renders the AI Development Analysis section.
	 *
	 * @param aiContent - AI-generated content, or null
	 * @returns HTML string for the AI section
	 */
	private renderAISection(aiContent: AIContent | null): string {
		if (!this.aiProvider) {
			return `<section class="card ai-section ai-unconfigured">
  <h2 class="section-title"><span class="ai-icon">&#10022;</span> AI Development Analysis</h2>
  <p class="ai-placeholder">AI analysis not configured — add a Gemini API key in settings to enable AI-powered development narratives and authenticity scoring.</p>
</section>`;
		}

		if (!aiContent || !aiContent.narrative) {
			return `<section class="card ai-section">
  <h2 class="section-title"><span class="ai-icon">&#10022;</span> AI Development Analysis</h2>
  <p class="ai-placeholder">AI analysis could not be generated. Check your API key and try again.</p>
</section>`;
		}

		const score = aiContent.confidence.score;
		const scoreClass = score >= 75 ? 'score-high' : score >= 50 ? 'score-medium' : 'score-low';
		const scoreColor = score >= 75 ? '#2ec4b6' : score >= 50 ? '#ff9f1c' : '#e71d36';

		const narrativeParagraphs = aiContent.narrative
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((paragraph) => `<p>${this.escapeHTML(paragraph)}</p>`)
			.join('\n          ');

		return `<section class="card ai-section">
  <h2 class="section-title"><span class="ai-icon">&#10022;</span> AI Development Analysis</h2>
  <div class="ai-narrative">
    <div class="narrative-content">
      ${narrativeParagraphs}
    </div>
  </div>
  <div class="confidence-section">
    <div class="confidence-header">
      <span class="confidence-label">Authenticity Confidence Score</span>
      <span class="confidence-value ${scoreClass}">${score}</span>
    </div>
    <div class="confidence-bar-track">
      <div class="confidence-bar-fill ${scoreClass}" style="width: ${score}%; background: ${scoreColor};"></div>
    </div>
    <p class="confidence-justification">${this.escapeHTML(aiContent.confidence.justification)}</p>
  </div>
</section>`;
	}

	/**
	 * Renders the Development Flags & Context section for the full report.
	 * Returns an empty string if no flags are provided (clean report).
	 *
	 * @param flags - Optional array of flags with student context
	 * @returns HTML string for the flags section, or empty string
	 */
	private renderFlagsSection(flags?: FlagWithContext[]): string {
		if (!flags || flags.length === 0) {
			return '';
		}

		const highCount = flags.filter((flag) => flag.severity === 'high').length;
		const mediumCount = flags.filter((flag) => flag.severity === 'medium').length;
		const lowCount = flags.filter((flag) => flag.severity === 'low').length;

		const flagCards = flags.map((flag) => {
			const severityClass = flag.severity === 'high' ? 'flag-severity-high'
				: flag.severity === 'medium' ? 'flag-severity-medium'
				: 'flag-severity-low';
			const severityLabel = flag.severity.charAt(0).toUpperCase() + flag.severity.slice(1);
			const categoryLabel = flag.category.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
			const time = new Date(flag.timestamp).toLocaleString();
			const contextHtml = flag.studentContext
				? `<div class="flag-student-context">
				<strong>Student's explanation:</strong>
				<p>${this.escapeHTML(flag.studentContext)}</p>
			   </div>`
				: `<div class="flag-no-context">No context provided</div>`;

			return `      <div class="flag-report-card ${severityClass}">
        <div class="flag-report-header">
          <span class="flag-report-badge ${severityClass}">${severityLabel}</span>
          <span class="flag-report-category">${categoryLabel}</span>
          <span class="flag-report-time">${time}</span>
        </div>
        <p class="flag-report-description">${this.escapeHTML(flag.description)}</p>
        <div class="flag-report-file">${this.escapeHTML(flag.filename)}</div>
        ${contextHtml}
      </div>`;
		}).join('\n');

		return `<section class="card flags-section">
  <h2 class="section-title"><span class="flag-icon">&#9873;</span> Development Flags &amp; Context</h2>
  <div class="flags-summary">
    <span>${flags.length} flag${flags.length !== 1 ? 's' : ''} detected:</span>
    ${highCount > 0 ? `<span class="flag-count-high">${highCount} high</span>` : ''}
    ${mediumCount > 0 ? `<span class="flag-count-medium">${mediumCount} medium</span>` : ''}
    ${lowCount > 0 ? `<span class="flag-count-low">${lowCount} low</span>` : ''}
  </div>
  <div class="flags-list">
${flagCards}
  </div>
</section>`;
	}

	/**
	 * Formats a Date as a nice readable timestamp.
	 *
	 * @param date - The date to format
	 * @returns Formatted string like "Feb 10, 2026 at 2:14 PM"
	 */
	private formatTimestamp(date: Date): string {
		return date.toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	/**
	 * Computes per-file statistics from a list of snapshots.
	 *
	 * @param snapshots - Array of snapshots to aggregate
	 * @returns Array of FileStats, one per unique file
	 */
	private computeFileStats(snapshots: Snapshot[]): FileStats[] {
		const map = new Map<string, FileStats>();

		for (const snap of snapshots) {
			const existing = map.get(snap.filename);
			if (existing) {
				existing.totalChanges++;
				existing.linesAdded += snap.lines_added;
				existing.linesRemoved += snap.lines_removed;
				if (snap.change_type === 'paste') {
					existing.pasteEvents++;
				}
				existing.timestamps.push(snap.timestamp);
			} else {
				map.set(snap.filename, {
					filename: snap.filename,
					totalChanges: 1,
					linesAdded: snap.lines_added,
					linesRemoved: snap.lines_removed,
					pasteEvents: snap.change_type === 'paste' ? 1 : 0,
					timeSpentMs: 0,
					timestamps: [snap.timestamp],
				});
			}
		}

		// Compute cumulative active time: sum gaps between consecutive edits
		// that are shorter than ACTIVE_GAP_THRESHOLD_MS
		for (const stats of map.values()) {
			let activeMs = 0;
			for (let i = 1; i < stats.timestamps.length; i++) {
				const gap = new Date(stats.timestamps[i]).getTime() - new Date(stats.timestamps[i - 1]).getTime();
				if (gap <= ACTIVE_GAP_THRESHOLD_MS) {
					activeMs += gap;
				}
			}
			stats.timeSpentMs = activeMs;
		}

		return Array.from(map.values()).sort((fileA, fileB) => fileB.totalChanges - fileA.totalChanges);
	}

	/**
	 * Computes the total development time across all sessions.
	 *
	 * @param sessions - Array of sessions
	 * @returns Human-readable duration string (e.g. "2h 34m")
	 */
	private computeTotalDevTime(sessions: Session[]): string {
		let totalMs = 0;

		for (const session of sessions) {
			const start = new Date(session.started_at).getTime();
			const end = session.ended_at
				? new Date(session.ended_at).getTime()
				: Date.now();
			totalMs += end - start;
		}

		return this.formatDuration(totalMs);
	}

	/**
	 * Formats a duration in milliseconds to a human-readable string.
	 *
	 * @param durationMs - Duration in milliseconds
	 * @returns Formatted string like "2h 34m" or "5m"
	 */
	private formatDuration(durationMs: number): string {
		const totalMinutes = Math.floor(durationMs / 60_000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;

		if (hours > 0) {
			return `${hours}h ${minutes}m`;
		}
		return `${minutes}m`;
	}

	/**
	 * Computes the date range string from first to last snapshot.
	 *
	 * @param snapshots - Array of snapshots (assumed sorted by timestamp)
	 * @returns Formatted date range string
	 */
	private computeDateRange(snapshots: Snapshot[]): string {
		if (snapshots.length === 0) {
			return 'No data';
		}

		const first = new Date(snapshots[0].timestamp);
		const last = new Date(snapshots[snapshots.length - 1].timestamp);

		const formatDate = (date: Date): string => {
			return date.toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			});
		};

		return `${formatDate(first)} — ${formatDate(last)}`;
	}

	/**
	 * Builds timeline chart data (total lines over time per file).
	 *
	 * @param snapshots - Array of snapshots sorted by timestamp
	 * @returns JSON-serializable chart data object
	 */
	private buildTimelineData(snapshots: Snapshot[]): { labels: string[]; datasets: { label: string; data: number[] }[] } {
		const labels: string[] = [];
		const totalLinesByTimestamp: number[] = [];

		// Track latest total_lines per file and maintain a running aggregate
		const fileLines = new Map<string, number>();
		let runningTotal = 0;

		for (const snap of snapshots) {
			const previousLines = fileLines.get(snap.filename) || 0;
			runningTotal += snap.total_lines - previousLines;
			fileLines.set(snap.filename, snap.total_lines);

			labels.push(snap.timestamp);
			totalLinesByTimestamp.push(runningTotal);
		}

		return {
			labels,
			datasets: [{
				label: 'Total Lines of Code',
				data: totalLinesByTimestamp,
			}],
		};
	}

	/**
	 * Builds edit frequency data (edits per hour).
	 *
	 * @param snapshots - Array of snapshots sorted by timestamp
	 * @returns JSON-serializable bar chart data
	 */
	private buildEditFrequencyData(snapshots: Snapshot[]): { labels: string[]; data: number[] } {
		if (snapshots.length === 0) {
			return { labels: [], data: [] };
		}

		const hourBuckets = new Map<string, number>();

		for (const snap of snapshots) {
			const date = new Date(snap.timestamp);
			const hourKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
			hourBuckets.set(hourKey, (hourBuckets.get(hourKey) || 0) + 1);
		}

		// Sort by hour key
		const sortedEntries = Array.from(hourBuckets.entries()).sort(
			(entryA, entryB) => entryA[0].localeCompare(entryB[0])
		);

		return {
			labels: sortedEntries.map((entry) => entry[0]),
			data: sortedEntries.map((entry) => entry[1]),
		};
	}

	/**
	 * Builds session boundary data for chart annotations.
	 *
	 * @param sessions - Array of sessions
	 * @returns Array of session start/end timestamp pairs
	 */
	private buildSessionBoundaries(sessions: Session[]): { start: string; end: string; label: string }[] {
		return sessions.map((session, index) => ({
			start: session.started_at,
			end: session.ended_at || new Date().toISOString(),
			label: `Session ${index + 1}`,
		}));
	}

	/**
	 * Renders a single changelog entry with collapsible diff.
	 *
	 * @param snapshot - The snapshot to render
	 * @param index - The entry index for unique IDs
	 * @returns HTML string for the changelog entry
	 */
	private renderChangelogEntry(snapshot: Snapshot, index: number): string {
		const date = new Date(snapshot.timestamp);
		const formattedTime = date.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
		}) + ' at ' + date.toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit',
		});

		const typeClass = this.getChangeTypeClass(snapshot.change_type);
		const typeLabel = snapshot.change_type.charAt(0).toUpperCase() + snapshot.change_type.slice(1);

		const diffHtml = this.renderDiff(snapshot.diff);

		return `    <div class="changelog-entry">
      <div class="entry-header" onclick="toggleDiff('diff-${index}')">
        <span class="entry-time">${formattedTime}</span>
        <span class="entry-file">${this.escapeHTML(snapshot.filename)}</span>
        <span class="entry-type ${typeClass}">${typeLabel}</span>
        <span class="entry-stats"><span class="text-success">+${snapshot.lines_added}</span> <span class="text-danger">-${snapshot.lines_removed}</span></span>
        <span class="entry-toggle" id="toggle-${index}">&#9660;</span>
      </div>
      <div class="entry-diff" id="diff-${index}">
${diffHtml}
      </div>
    </div>`;
	}

	/**
	 * Returns the CSS class for a change type.
	 *
	 * @param changeType - The change type
	 * @returns CSS class name
	 */
	private getChangeTypeClass(changeType: string): string {
		switch (changeType) {
			case 'typing': return 'type-typing';
			case 'paste': return 'type-paste';
			case 'delete': return 'type-delete';
			case 'refactor': return 'type-refactor';
			default: return 'type-typing';
		}
	}

	/**
	 * Renders a unified diff string as syntax-highlighted HTML.
	 *
	 * @param diff - Unified diff string
	 * @returns HTML string with coloured diff lines
	 */
	private renderDiff(diff: string): string {
		const lines = diff.split('\n');
		const htmlLines: string[] = [];

		for (const line of lines) {
			const escaped = this.escapeHTML(line);
			if (line.startsWith('@@')) {
				htmlLines.push(`<div class="diff-hunk">${escaped}</div>`);
			} else if (line.startsWith('+') && !line.startsWith('+++')) {
				htmlLines.push(`<div class="diff-add">${escaped}</div>`);
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				htmlLines.push(`<div class="diff-remove">${escaped}</div>`);
			} else if (line.startsWith('+++') || line.startsWith('---')) {
				htmlLines.push(`<div class="diff-header">${escaped}</div>`);
			} else {
				htmlLines.push(`<div class="diff-context">${escaped}</div>`);
			}
		}

		return `        <pre class="diff-block">${htmlLines.join('\n')}</pre>`;
	}

	/**
	 * Escapes HTML special characters to prevent XSS.
	 *
	 * @param text - Raw text to escape
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
	 * Returns the complete CSS stylesheet for the report.
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
  --shadow-lg: 0 4px 16px rgba(0,0,0,0.1);
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
}

/* ── HEADER ─────────────────────────────────── */
header {
  background: var(--primary);
  background-image: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #1a1a2e 100%);
  color: #fff;
  padding: 3rem 2rem 2.5rem;
  position: relative;
  overflow: hidden;
}

header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: radial-gradient(circle at 20% 50%, rgba(67, 97, 238, 0.08) 0%, transparent 50%),
                    radial-gradient(circle at 80% 50%, rgba(46, 196, 182, 0.06) 0%, transparent 50%);
  pointer-events: none;
}

.header-content {
  max-width: 1100px;
  margin: 0 auto;
  position: relative;
  z-index: 1;
}

.header-top {
  margin-bottom: 2rem;
}

.header-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-logo {
  width: 60px;
  height: 60px;
  filter: drop-shadow(0 2px 6px rgba(255, 255, 255, 0.3));
}

.logo {
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 3px;
  opacity: 0.6;
  margin-bottom: 0.5rem;
}

.logo-icon {
  color: var(--accent);
  font-size: 1rem;
}

.header-subtitle {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.5px;
}

.verification-id {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.1);
  padding: 4px 12px;
  border-radius: 6px;
  display: inline-block;
  margin-top: 8px;
  letter-spacing: 0.5px;
}

.header-meta {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1.2rem;
  background: rgba(255, 255, 255, 0.06);
  border-radius: var(--radius);
  padding: 1.2rem 1.5rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.meta-item {}

.meta-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 0.15rem;
}

.meta-value {
  font-size: 0.95rem;
  font-weight: 500;
  color: #fff;
}

/* ── MAIN ───────────────────────────────────── */
main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem;
}

/* ── STAT CARDS ─────────────────────────────── */
.stats-cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 1.5rem 1.2rem;
  text-align: center;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.stat-icon {
  font-size: 1.2rem;
  color: var(--accent);
  margin-bottom: 0.4rem;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: var(--accent);
  line-height: 1.2;
  margin-bottom: 0.25rem;
}

.stat-value.value-warning {
  color: var(--warning);
}

.stat-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 500;
}

/* ── CARDS ──────────────────────────────────── */
.card {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 1.8rem;
  margin-bottom: 2rem;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
}

.section-title {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--primary);
  margin-bottom: 1.2rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* ── AI SECTION ─────────────────────────────── */
.ai-section {
  border-left: 4px solid var(--accent);
}

.ai-section.ai-unconfigured {
  border-left-color: var(--border);
}

.ai-icon {
  color: var(--accent);
  font-size: 1.1rem;
}

.ai-placeholder {
  color: var(--text-secondary);
  font-size: 0.9rem;
  font-style: italic;
  padding: 1rem 0;
}

.ai-narrative {
  margin-bottom: 1.5rem;
}

.narrative-content p {
  margin-bottom: 0.8rem;
  line-height: 1.7;
  color: var(--text);
}

.narrative-content p:last-child {
  margin-bottom: 0;
}

.confidence-section {
  background: var(--bg);
  border-radius: 8px;
  padding: 1.2rem 1.5rem;
}

.confidence-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.8rem;
}

.confidence-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.confidence-value {
  font-size: 1.8rem;
  font-weight: 700;
  line-height: 1;
}

.confidence-value.score-high { color: var(--success); }
.confidence-value.score-medium { color: var(--warning); }
.confidence-value.score-low { color: var(--danger); }

.confidence-bar-track {
  width: 100%;
  height: 8px;
  background: var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.8rem;
}

.confidence-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.6s ease;
}

.confidence-justification {
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* ── FLAGS SECTION ──────────────────────────── */
.flags-section {
  border-left: 4px solid var(--warning);
}

.flag-icon {
  color: var(--warning);
  font-size: 1.1rem;
}

.flags-summary {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1.2rem;
  font-size: 0.9rem;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.flag-count-high {
  font-weight: 600;
  color: var(--danger);
  background: #ffebee;
  padding: 0.1rem 0.5rem;
  border-radius: 12px;
  font-size: 0.8rem;
}

.flag-count-medium {
  font-weight: 600;
  color: #e65100;
  background: #fff3e0;
  padding: 0.1rem 0.5rem;
  border-radius: 12px;
  font-size: 0.8rem;
}

.flag-count-low {
  font-weight: 600;
  color: #2e7d32;
  background: #e8f5e9;
  padding: 0.1rem 0.5rem;
  border-radius: 12px;
  font-size: 0.8rem;
}

.flags-list {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.flag-report-card {
  border-radius: 8px;
  padding: 1.2rem;
  border: 1px solid var(--border);
  border-left: 4px solid var(--border);
  background: var(--bg);
}

.flag-report-card.flag-severity-high { border-left-color: var(--danger); }
.flag-report-card.flag-severity-medium { border-left-color: var(--warning); }
.flag-report-card.flag-severity-low { border-left-color: var(--success); }

.flag-report-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.6rem;
  flex-wrap: wrap;
}

.flag-report-badge {
  display: inline-block;
  padding: 0.15rem 0.6rem;
  border-radius: 20px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.flag-report-badge.flag-severity-high { background: #ffebee; color: #c62828; }
.flag-report-badge.flag-severity-medium { background: #fff3e0; color: #e65100; }
.flag-report-badge.flag-severity-low { background: #e8f5e9; color: #2e7d32; }

.flag-report-category {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--primary);
}

.flag-report-time {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-family: var(--mono);
  margin-left: auto;
}

.flag-report-description {
  font-size: 0.85rem;
  line-height: 1.6;
  color: var(--text);
  margin-bottom: 0.5rem;
}

.flag-report-file {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--accent);
  background: #eef1ff;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  display: inline-block;
  margin-bottom: 0.6rem;
}

.flag-student-context {
  background: var(--bg-card);
  border-radius: 6px;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border);
  margin-top: 0.4rem;
}

.flag-student-context strong {
  font-size: 0.78rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.flag-student-context p {
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--text);
  margin-top: 0.3rem;
}

.flag-no-context {
  font-size: 0.82rem;
  color: var(--text-secondary);
  font-style: italic;
  margin-top: 0.4rem;
}

/* ── CHARTS ─────────────────────────────────── */
.chart-container {
  position: relative;
  height: 320px;
}

/* ── TABLE ──────────────────────────────────── */
.table-wrapper {
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--border);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

thead {
  background: var(--primary);
}

th {
  text-align: left;
  padding: 0.85rem 1rem;
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #fff;
}

tbody tr {
  transition: background 0.1s;
}

tbody tr:nth-child(even) {
  background: var(--bg);
}

tbody tr:hover {
  background: #eef0f7;
}

td {
  padding: 0.7rem 1rem;
  border-top: 1px solid var(--border);
}

.file-cell {
  font-family: var(--mono);
  font-size: 0.8rem;
  font-weight: 500;
}

.text-success { color: var(--success); font-weight: 600; }
.text-danger { color: var(--danger); font-weight: 600; }
.text-muted { color: var(--text-secondary); }

.paste-badge {
  display: inline-block;
  padding: 0.15rem 0.6rem;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 600;
  background: #fff3e0;
  color: #e65100;
}

/* ── CHANGELOG ──────────────────────────────── */
.changelog {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 600px;
  overflow-y: auto;
}

.changelog-entry {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-card);
}

.entry-header {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.65rem 1rem;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
  flex-wrap: wrap;
}

.entry-header:hover {
  background: var(--bg);
}

.entry-time {
  font-size: 0.78rem;
  color: var(--text-secondary);
  font-family: var(--mono);
  min-width: 170px;
  font-weight: 400;
}

.entry-file {
  font-family: var(--mono);
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--accent);
  background: #eef1ff;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}

.entry-type {
  display: inline-block;
  padding: 0.12rem 0.55rem;
  border-radius: 20px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.type-typing { background: #e8f5e9; color: #2e7d32; }
.type-paste { background: #fff3e0; color: #e65100; }
.type-delete { background: #ffebee; color: #c62828; }
.type-refactor { background: #e8eaf6; color: #283593; }

.entry-stats {
  font-family: var(--mono);
  font-size: 0.82rem;
  margin-left: auto;
}

.entry-toggle {
  font-size: 0.6rem;
  color: var(--text-secondary);
  transition: transform 0.2s ease;
}

.entry-diff {
  display: none;
  border-top: 1px solid var(--border);
  max-height: 400px;
  overflow: auto;
}

.entry-diff.open {
  display: block;
}

/* ── DIFFS ──────────────────────────────────── */
.diff-block {
  font-family: var(--mono);
  font-size: 0.8rem;
  line-height: 1.5;
  margin: 0;
  padding: 0;
}

.diff-block > div {
  padding: 1px 1rem;
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-add { background: #e6ffed; color: #1a5c2b; }
.diff-remove { background: #ffeef0; color: #8b1a1a; }
.diff-hunk { background: #eef1ff; color: var(--accent); font-weight: 600; padding: 0.3rem 1rem; }
.diff-header { color: var(--text-secondary); font-weight: 600; }
.diff-context { color: var(--text-secondary); }

/* ── INTEGRITY ──────────────────────────────── */
.integrity-box {
  border-radius: 8px;
  padding: 1.5rem;
  border: 2px solid;
}

.integrity-verified {
  border-color: var(--success);
  background: linear-gradient(135deg, #f0faf9 0%, #e8f8f5 100%);
}

.integrity-broken {
  border-color: var(--danger);
  background: linear-gradient(135deg, #fff5f5 0%, #ffeaea 100%);
}

.integrity-status {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 1.2rem;
}

.integrity-icon {
  font-size: 1.6rem;
  line-height: 1;
}

.integrity-verified .integrity-icon { color: var(--success); }
.integrity-broken .integrity-icon { color: var(--danger); }

.integrity-text {
  font-size: 1rem;
}

.integrity-text strong {
  font-weight: 700;
}

.integrity-text span {
  color: var(--text-secondary);
}

.integrity-details {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.hash-row {
  font-size: 0.85rem;
}

.hash-label {
  font-weight: 600;
  color: var(--text-secondary);
  margin-right: 0.4rem;
}

.hash-row code {
  font-family: var(--mono);
  font-size: 0.78rem;
  word-break: break-all;
  background: rgba(0, 0, 0, 0.04);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
}

.integrity-explainer {
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.5;
  font-style: italic;
}

/* ── VERIFICATION BLOCK ────────────────────── */
.verification-block {
  border: 2px solid var(--primary);
  background: var(--bg);
  padding: 0;
  overflow: hidden;
}

.verification-pre {
  font-family: var(--mono);
  font-size: 0.82rem;
  line-height: 1.6;
  color: var(--primary);
  margin: 0;
  padding: 1.5rem 2rem;
  white-space: pre;
  overflow-x: auto;
}

/* ── FOOTER ─────────────────────────────────── */
footer {
  background: var(--bg);
  border-top: 1px solid var(--border);
  padding: 2rem;
  text-align: center;
}

.footer-content {
  max-width: 1100px;
  margin: 0 auto;
}

footer p {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.footer-note {
  margin-top: 0.3rem;
  font-size: 0.75rem;
  opacity: 0.7;
}

/* ── ACTION BAR ────────────────────────────── */
.action-bar {
  position: sticky;
  top: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.5rem 1.5rem;
  background: #f0f0f0;
  border-bottom: 1px solid var(--border);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  background: #fff;
  color: var(--text);
  font-family: var(--font);
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  white-space: nowrap;
}

.action-btn:hover {
  background: #e8e8e8;
  border-color: #b0b0b0;
}

.action-icon {
  font-size: 0.95rem;
  line-height: 1;
}

/* ── PRINT ──────────────────────────────────── */
@media print {
  .action-bar { display: none; }
  body { background: #fff; }
  header { padding: 1.5rem; }
  .stat-card:hover { transform: none; box-shadow: none; }
  .card { box-shadow: none; break-inside: avoid; }
  .entry-diff.open { max-height: none; }
  .entry-header { cursor: default; }
  .entry-toggle { display: none; }
  .changelog { max-height: none; overflow: visible; }
  .chart-container { break-inside: avoid; }
  footer { border-top: 1px solid #ccc; }
}

/* ── RESPONSIVE ─────────────────────────────── */
@media (max-width: 900px) {
  .stats-cards { grid-template-columns: repeat(3, 1fr); }
}

@media (max-width: 600px) {
  header { padding: 2rem 1rem 1.5rem; }
  .header-subtitle { font-size: 1.3rem; }
  .header-meta { grid-template-columns: 1fr 1fr; }
  main { padding: 1rem; }
  .stats-cards { grid-template-columns: repeat(2, 1fr); }
  .stat-value { font-size: 1.5rem; }
  .card { padding: 1.2rem; }
  .entry-header { font-size: 0.8rem; gap: 0.4rem; }
  .entry-time { min-width: auto; }
}
`;
	}

	/**
	 * Returns the Chart.js initialization script.
	 *
	 * @param timelineData - Data for the timeline line chart
	 * @param frequencyData - Data for the edit frequency bar chart
	 * @param sessionBoundaries - Session start/end pairs for chart annotations
	 * @returns JavaScript string
	 */
	private getChartScript(
		timelineData: { labels: string[]; datasets: { label: string; data: number[] }[] },
		frequencyData: { labels: string[]; data: number[] },
		sessionBoundaries: { start: string; end: string; label: string }[]
	): string {
		return `
function toggleDiff(elementId) {
  var element = document.getElementById(elementId);
  if (element) {
    element.classList.toggle('open');
    var idx = elementId.replace('diff-', '');
    var toggle = document.getElementById('toggle-' + idx);
    if (toggle) {
      toggle.style.transform = element.classList.contains('open') ? 'rotate(180deg)' : '';
    }
  }
}

(function() {
  var rawTimestamps = ${JSON.stringify(timelineData.labels)};
  var timelineLabels = rawTimestamps.map(function(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  });

  // Build session boundary box annotations for the timeline chart
  var sessions = ${JSON.stringify(sessionBoundaries)};
  var sessionColors = [
    'rgba(67, 97, 238, 0.06)',
    'rgba(46, 196, 182, 0.06)',
    'rgba(255, 159, 28, 0.06)',
    'rgba(231, 29, 54, 0.06)'
  ];
  var sessionAnnotations = {};
  sessions.forEach(function(session, idx) {
    var startTime = new Date(session.start).getTime();
    var endTime = new Date(session.end).getTime();
    var startIdx = 0;
    var endIdx = rawTimestamps.length - 1;
    for (var i = 0; i < rawTimestamps.length; i++) {
      if (new Date(rawTimestamps[i]).getTime() >= startTime) { startIdx = i; break; }
    }
    for (var j = rawTimestamps.length - 1; j >= 0; j--) {
      if (new Date(rawTimestamps[j]).getTime() <= endTime) { endIdx = j; break; }
    }
    sessionAnnotations['session' + idx] = {
      type: 'box',
      xMin: startIdx,
      xMax: endIdx,
      backgroundColor: sessionColors[idx % sessionColors.length],
      borderWidth: 0,
      label: {
        display: true,
        content: session.label,
        position: 'start',
        font: { size: 10, weight: 'normal', family: "'Inter', sans-serif" },
        color: '#636e72'
      }
    };
  });

  // Timeline chart with gradient fill
  var timelineCtx = document.getElementById('timelineChart').getContext('2d');
  var gradient = timelineCtx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(67, 97, 238, 0.2)');
  gradient.addColorStop(1, 'rgba(67, 97, 238, 0.01)');

  new Chart(timelineCtx, {
    type: 'line',
    data: {
      labels: timelineLabels,
      datasets: [{
        label: ${JSON.stringify(timelineData.datasets[0]?.label || 'Total Lines')},
        data: ${JSON.stringify(timelineData.datasets[0]?.data || [])},
        borderColor: '#4361ee',
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 6,
        pointBackgroundColor: '#4361ee',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        borderWidth: 2.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        annotation: { annotations: sessionAnnotations }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 12, maxRotation: 45, font: { size: 10, family: "'Inter', sans-serif" } },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Total Lines', font: { size: 12, family: "'Inter', sans-serif" } },
          grid: { color: 'rgba(0,0,0,0.04)' }
        }
      }
    }
  });

  // Edit frequency bar chart
  var freqLabels = ${JSON.stringify(frequencyData.labels)}.map(function(label) {
    var parts = label.split(' ');
    var datePart = parts[0] || '';
    var timePart = parts[1] || '';
    var dateParts = datePart.split('-');
    return (dateParts[1] || '') + '/' + (dateParts[2] || '') + ' ' + timePart;
  });

  var freqCtx = document.getElementById('frequencyChart').getContext('2d');
  new Chart(freqCtx, {
    type: 'bar',
    data: {
      labels: freqLabels,
      datasets: [{
        label: 'Edits',
        data: ${JSON.stringify(frequencyData.data)},
        backgroundColor: 'rgba(67, 97, 238, 0.65)',
        hoverBackgroundColor: 'rgba(67, 97, 238, 0.85)',
        borderColor: '#4361ee',
        borderWidth: 0,
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 16, maxRotation: 45, font: { size: 10, family: "'Inter', sans-serif" } },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Edits per Hour', font: { size: 12, family: "'Inter', sans-serif" } },
          ticks: { stepSize: 1 },
          grid: { color: 'rgba(0,0,0,0.04)' }
        }
      }
    }
  });
})();
`;
	}

	/**
	 * Returns the action bar script for WebView message passing.
	 * Embeds report metadata so the extension can construct mailto links
	 * and file names without re-parsing the HTML.
	 *
	 * @param studentName - Student name for email subject
	 * @param assignmentName - Assignment name for email subject
	 * @param snapshotCount - Total snapshots in the report
	 * @param sessionCount - Total sessions in the report
	 * @param chainVerified - Whether the hash chain is intact
	 * @returns JavaScript string
	 */
	private getActionBarScript(
		studentName: string,
		assignmentName: string,
		snapshotCount: number,
		sessionCount: number,
		chainVerified: boolean
	): string {
		return `
(function() {
  var vscodeApi;
  try { vscodeApi = acquireVsCodeApi(); } catch(e) { vscodeApi = null; }

  var reportMeta = {
    studentName: '${this.escapeJSString(studentName)}',
    assignmentName: '${this.escapeJSString(assignmentName)}',
    generatedDate: '${this.escapeJSString(this.formatTimestamp(new Date()))}',
    snapshotCount: ${snapshotCount},
    sessionCount: ${sessionCount},
    chainVerified: ${chainVerified}
  };

  window.handleDownloadPDF = function() {
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'downloadPDF' });
    }
  };

  window.handleOpenBrowser = function() {
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'openInBrowser' });
    }
  };

  window.handleEmailReport = function() {
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'emailReport', meta: reportMeta });
    }
  };
})();
`;
	}

	/**
	 * Escapes a string for safe embedding inside a JavaScript single-quoted string literal.
	 *
	 * @param text - Raw text to escape
	 * @returns JS-safe string
	 */
	private escapeJSString(text: string): string {
		return text
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "\\'")
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r');
	}
}

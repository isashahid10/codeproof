import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SnapshotEngine } from './snapshot/engine.js';
import { SnapshotStorage } from './snapshot/storage.js';
import { FlagWithContext } from './snapshot/types.js';
import { ConfigManager } from './utils/config.js';
import { ReportGenerator } from './reports/generator.js';
import { AIProvider, GeminiProvider, NoAIProvider } from './reports/ai-provider.js';
import { FlagAnalyzer } from './flags/analyzer.js';
import { FlagReviewPanel, FlagReviewMessage } from './ui/flag-review.js';
import { CodeProofSidebarProvider, SidebarStatusUpdate } from './ui/sidebar.js';
import { findChromePath, generatePDF } from './reports/pdf.js';

/** The snapshot engine instance */
let engine: SnapshotEngine | undefined;

/** The snapshot storage instance */
let storage: SnapshotStorage | undefined;

/** The configuration manager instance */
let configManager: ConfigManager | undefined;

/** Status bar item showing recording state */
let statusBarItem: vscode.StatusBarItem;

/** Running count of snapshots for the status bar */
let snapshotCount = 0;

/** The sidebar WebView provider */
let sidebarProvider: CodeProofSidebarProvider | undefined;

/** Timer for sending duration ticks to the sidebar */
let sidebarDurationInterval: ReturnType<typeof setInterval> | undefined;

/** Timestamp when the current session started recording */
let sessionStartTime: number | undefined;

/** Last snapshot ISO timestamp for sidebar display */
let lastSnapshotTime = '';

/** Count of paste events in the current session */
let pasteEventCount = 0;

/**
 * Creates and configures the status bar item for CodeProof.
 * Shows recording status and acts as a toggle button.
 */
function createStatusBarItem(): vscode.StatusBarItem {
	const item = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	item.command = 'codeproof.startRecording';
	updateStatusBarStopped(item);
	item.show();
	return item;
}

/**
 * Updates the status bar to show the stopped state.
 *
 * @param item - The status bar item to update
 */
function updateStatusBarStopped(item: vscode.StatusBarItem): void {
	item.text = '$(circle-outline) CodeProof ○ Stopped';
	item.tooltip = 'CodeProof is stopped — click to start recording';
	item.command = 'codeproof.startRecording';
}

/**
 * Updates the status bar to show the recording state with a snapshot count.
 *
 * @param item - The status bar item to update
 * @param count - Number of snapshots recorded
 */
function updateStatusBarRecording(item: vscode.StatusBarItem, count: number): void {
	item.text = `$(record) CodeProof ● ${count} snapshots`;
	item.tooltip = 'CodeProof is recording — click to stop';
	item.command = 'codeproof.stopRecording';
}

/**
 * Updates the status bar to show the paused state.
 *
 * @param item - The status bar item to update
 * @param count - Number of snapshots recorded so far
 */
function updateStatusBarPaused(item: vscode.StatusBarItem, count: number): void {
	item.text = `$(debug-pause) CodeProof ❚❚ ${count} snapshots`;
	item.tooltip = 'CodeProof is paused — click to resume';
	item.command = 'codeproof.pauseRecording';
}

/**
 * Builds and sends a status update to the sidebar WebView.
 * Gathers data from the engine, storage, and local state.
 */
function sendSidebarUpdate(): void {
	if (!sidebarProvider) {
		return;
	}

	const stats = engine?.getStats();
	let recordingState: SidebarStatusUpdate['recordingState'] = 'stopped';
	if (stats?.isRunning) {
		recordingState = stats.isPaused ? 'paused' : 'recording';
	}

	let durationSeconds = 0;
	if (sessionStartTime) {
		durationSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
	}

	// Build tracked file list from storage snapshots in current session
	const trackedFiles: Array<{ filename: string; changeCount: number }> = [];
	if (storage && stats?.sessionId) {
		try {
			const sessionSnapshots = storage.getSnapshots({ sessionId: stats.sessionId });
			const fileCounts = new Map<string, number>();
			for (const snapshot of sessionSnapshots) {
				fileCounts.set(snapshot.filename, (fileCounts.get(snapshot.filename) ?? 0) + 1);
			}
			for (const [filename, changeCount] of fileCounts) {
				trackedFiles.push({ filename, changeCount });
			}
		} catch (error) {
			console.error('[CodeProof] Error building tracked files list:', error);
		}
	}

	// Read current settings
	const config = vscode.workspace.getConfiguration('codeproof');
	const autoStart = config.get<boolean>('autoStart', true);
	const snapshotInterval = config.get<number>('snapshotInterval', 30);
	const aiProvider = config.get<string>('aiProvider', 'gemini');
	const aiApiKey = config.get<string>('aiApiKey', '') || process.env.GEMINI_API_KEY || '';

	let aiStatus = 'No AI key configured';
	if (aiProvider === 'gemini' && aiApiKey) {
		aiStatus = 'Gemini \u2713 Connected';
	} else if (aiProvider === 'none') {
		aiStatus = 'AI disabled';
	}

	sidebarProvider.sendStatusUpdate({
		recordingState,
		sessionDurationSeconds: durationSeconds,
		snapshotCount,
		filesTracked: stats?.trackedFiles ?? 0,
		trackedFiles,
		lastSnapshotTime,
		pasteEventCount,
		autoStart,
		snapshotInterval,
		aiStatus,
	});
}

/**
 * Starts a 1-second interval that sends duration updates to the sidebar.
 */
function startSidebarDurationTimer(): void {
	stopSidebarDurationTimer();
	sidebarDurationInterval = setInterval(() => {
		sendSidebarUpdate();
	}, 1000);
}

/**
 * Stops the sidebar duration update timer.
 */
function stopSidebarDurationTimer(): void {
	if (sidebarDurationInterval) {
		clearInterval(sidebarDurationInterval);
		sidebarDurationInterval = undefined;
	}
}

/**
 * Returns the workspace folder path, or undefined if no workspace is open.
 *
 * @returns The absolute path to the first workspace folder, or undefined
 */
function getWorkspaceFolderPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Ensures the storage directory is listed in the workspace .gitignore file.
 * Creates the .gitignore if it doesn't exist.
 *
 * @param workspaceFolderPath - Absolute path to the workspace root
 * @param storageDir - Name of the storage directory to ignore
 */
function ensureGitignore(workspaceFolderPath: string, storageDir: string): void {
	const gitignorePath = path.join(workspaceFolderPath, '.gitignore');
	const entry = `${storageDir}/`;

	try {
		if (fs.existsSync(gitignorePath)) {
			const content = fs.readFileSync(gitignorePath, 'utf-8');
			if (!content.includes(entry)) {
				const separator = content.endsWith('\n') ? '' : '\n';
				fs.appendFileSync(gitignorePath, `${separator}${entry}\n`);
				console.log(`[CodeProof] Added ${entry} to .gitignore`);
			}
		} else {
			fs.writeFileSync(gitignorePath, `${entry}\n`);
			console.log(`[CodeProof] Created .gitignore with ${entry} entry`);
		}
	} catch (error) {
		console.error('[CodeProof] Failed to update .gitignore:', error);
	}
}

/**
 * Starts recording document changes via the SnapshotEngine.
 * Creates storage and engine instances, subscribes to snapshots, and begins recording.
 *
 * @param context - The VS Code extension context for managing disposables
 * @param silent - If true, suppress the "Recording started" notification (used for autoStart)
 */
function startRecording(context: vscode.ExtensionContext, silent: boolean = false): void {
	if (engine?.getStats().isRunning) {
		if (!silent) {
			vscode.window.showInformationMessage('CodeProof is already recording.');
		}
		return;
	}

	const workspaceFolderPath = getWorkspaceFolderPath();
	if (!workspaceFolderPath) {
		if (!silent) {
			vscode.window.showErrorMessage(
				'CodeProof: No workspace folder open. Please open a folder first.'
			);
		}
		return;
	}

	// Ensure ConfigManager exists
	if (!configManager) {
		configManager = new ConfigManager();
		context.subscriptions.push(configManager);
	}

	const storageLocation = configManager.storageLocation;

	// Set up storage
	try {
		storage = new SnapshotStorage(workspaceFolderPath, storageLocation);
		context.subscriptions.push(storage);
	} catch (error) {
		vscode.window.showErrorMessage(
			`CodeProof: Failed to initialise storage — ${error instanceof Error ? error.message : String(error)}`
		);
		console.error('[CodeProof] Storage initialisation error:', error);
		return;
	}

	// Ensure storage dir is in .gitignore
	ensureGitignore(workspaceFolderPath, storageLocation);

	engine = new SnapshotEngine(storage, configManager);
	context.subscriptions.push(engine);

	// Update status bar and sidebar on each snapshot
	snapshotCount = 0;
	pasteEventCount = 0;
	lastSnapshotTime = '';
	sessionStartTime = Date.now();

	engine.onSnapshot((snapshot) => {
		snapshotCount++;
		lastSnapshotTime = snapshot.timestamp;
		if (snapshot.change_type === 'paste') {
			pasteEventCount++;
		}
		updateStatusBarRecording(statusBarItem, snapshotCount);
		sendSidebarUpdate();
	});

	engine.start();
	updateStatusBarRecording(statusBarItem, snapshotCount);
	startSidebarDurationTimer();
	sendSidebarUpdate();

	if (!silent) {
		vscode.window.showInformationMessage('CodeProof: Recording started.');
	}
	console.log('[CodeProof] Recording started.');
}

/**
 * Stops recording document changes.
 * Shows a summary of how many snapshots were captured.
 */
function stopRecording(): void {
	if (!engine?.getStats().isRunning) {
		vscode.window.showInformationMessage('CodeProof is not recording.');
		return;
	}

	engine.stop();
	updateStatusBarStopped(statusBarItem);
	stopSidebarDurationTimer();
	sessionStartTime = undefined;
	sendSidebarUpdate();

	const stats = engine.getStats();
	vscode.window.showInformationMessage(
		`CodeProof: Recording stopped. ${stats.snapshotCount} snapshots captured.`
	);
}

/**
 * Toggles pause/resume on the snapshot engine.
 * When paused, changes are still accumulated but snapshots aren't emitted.
 */
function togglePause(): void {
	if (!engine?.getStats().isRunning) {
		vscode.window.showInformationMessage('CodeProof is not recording.');
		return;
	}

	const stats = engine.getStats();
	if (stats.isPaused) {
		engine.resume();
		updateStatusBarRecording(statusBarItem, snapshotCount);
		startSidebarDurationTimer();
		sendSidebarUpdate();
		vscode.window.showInformationMessage('CodeProof: Recording resumed.');
	} else {
		engine.pause();
		updateStatusBarPaused(statusBarItem, snapshotCount);
		stopSidebarDurationTimer();
		sendSidebarUpdate();
		vscode.window.showInformationMessage('CodeProof: Recording paused.');
	}
}

/**
 * Shows a notification with current recording statistics including
 * total snapshots, session duration, files tracked, and hash chain integrity.
 */
function showStats(): void {
	if (!storage) {
		vscode.window.showInformationMessage('CodeProof: No recording data available. Start recording first.');
		return;
	}

	const totalSnapshots = storage.getSnapshotCount();
	const filesTracked = storage.getDistinctFileCount();
	const currentSession = storage.getCurrentSession();

	let sessionDuration = 'No active session';
	if (currentSession) {
		const startedAt = new Date(currentSession.started_at);
		const now = new Date();
		const durationMs = now.getTime() - startedAt.getTime();
		const minutes = Math.floor(durationMs / 60_000);
		const seconds = Math.floor((durationMs % 60_000) / 1_000);
		sessionDuration = `${minutes}m ${seconds}s`;
	}

	const chainIntact = storage.verifyHashChain();
	const chainStatus = chainIntact ? 'Intact' : 'BROKEN — data may have been tampered with';

	vscode.window.showInformationMessage(
		`CodeProof Stats:\n` +
		`Snapshots: ${totalSnapshots} | ` +
		`Session: ${sessionDuration} | ` +
		`Files: ${filesTracked} | ` +
		`Hash chain: ${chainStatus}`
	);
}

/**
 * Creates the appropriate AI provider based on VS Code settings.
 *
 * @returns An AIProvider instance (GeminiProvider or NoAIProvider)
 */
function createAIProvider(): AIProvider {
	const config = vscode.workspace.getConfiguration('codeproof');
	const providerType = config.get<string>('aiProvider', 'gemini');
	const apiKey = config.get<string>('aiApiKey', '') || process.env.GEMINI_API_KEY || '';

	if (providerType === 'gemini' && apiKey) {
		return new GeminiProvider(apiKey);
	}

	return new NoAIProvider();
}

/**
 * Prompts the user for student name and assignment name, then generates
 * the HTML report with AI analysis. Returns undefined if no storage is available.
 *
 * @param flags - Optional flags to include in the report (for full report)
 * @returns The generated HTML string, or undefined if cancelled/unavailable
 */
async function promptAndGenerateReport(context: vscode.ExtensionContext, flags?: FlagWithContext[]): Promise<string | undefined> {
	if (!storage) {
		vscode.window.showInformationMessage('CodeProof: No recording data available. Start recording first.');
		return undefined;
	}

	const studentName = await vscode.window.showInputBox({
		prompt: 'Student name (for the report header)',
		placeHolder: 'e.g. Jane Doe',
		value: '',
	});
	if (studentName === undefined) {
		return undefined;
	}

	const assignmentName = await vscode.window.showInputBox({
		prompt: 'Assignment name (for the report header)',
		placeHolder: 'e.g. FIT1008 Assignment 3',
		value: '',
	});
	if (assignmentName === undefined) {
		return undefined;
	}

	const aiProvider = createAIProvider();
	const generator = new ReportGenerator(storage, context, aiProvider);

	const html = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'CodeProof',
			cancellable: false,
		},
		async (progress) => {
			progress.report({ message: 'Generating report...' });

			if (!(aiProvider instanceof NoAIProvider)) {
				progress.report({ message: 'Generating AI analysis...' });
			}

			return generator.generateHTML({
				studentName: studentName || undefined,
				assignmentName: assignmentName || undefined,
				flags,
			});
		}
	);

	return html;
}

/** Metadata sent from the WebView action bar for email construction */
interface ReportMeta {
	studentName: string;
	assignmentName: string;
	generatedDate: string;
	snapshotCount: number;
	sessionCount: number;
	chainVerified: boolean;
}

/**
 * Strips the action bar HTML and its associated script from report HTML
 * so that exported files are clean.
 *
 * @param html - The full report HTML including action bar
 * @returns Clean HTML without action bar elements
 */
function stripActionBar(html: string): string {
	return html
		.replace(/<!-- CODEPROOF-ACTION-BAR-START -->[\s\S]*?<!-- CODEPROOF-ACTION-BAR-END -->\n?/g, '')
		.replace(/<!-- CODEPROOF-ACTION-BAR-SCRIPT-START -->[\s\S]*?<!-- CODEPROOF-ACTION-BAR-SCRIPT-END -->\n?/g, '');
}

/**
 * Handles the "Download PDF" action from the WebView.
 * Converts the report HTML to PDF using puppeteer-core and the system Chrome,
 * then shows a save dialog for the user to pick the output path.
 *
 * @param html - The full report HTML
 */
async function handleDownloadPDF(html: string): Promise<void> {
	const chromePath = findChromePath();
	if (!chromePath) {
		vscode.window.showErrorMessage(
			'CodeProof: Chrome or Chromium not found. Please install Google Chrome to enable PDF export.'
		);
		return;
	}

	const cleanHtml = stripActionBar(html);

	try {
		const pdfBuffer = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'CodeProof: Generating PDF...',
				cancellable: false,
			},
			async () => generatePDF(cleanHtml, chromePath)
		);

		const defaultName = `codeproof-report-${new Date().toISOString().slice(0, 10)}.pdf`;
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(
				path.join(getWorkspaceFolderPath() || '', defaultName)
			),
			filters: { 'PDF Files': ['pdf'] },
			title: 'Save CodeProof Report as PDF',
		});

		if (!uri) {
			return;
		}

		fs.writeFileSync(uri.fsPath, pdfBuffer);
		vscode.window.showInformationMessage(
			`CodeProof: PDF saved to ${path.basename(uri.fsPath)}`
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			`CodeProof: Failed to generate PDF — ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Handles the "Open in Browser" action from the WebView.
 * Writes a clean copy to a temp file and opens it in the default browser.
 *
 * @param html - The full report HTML
 */
async function handleOpenInBrowser(html: string): Promise<void> {
	const cleanHtml = stripActionBar(html);
	const tmpFile = path.join(os.tmpdir(), `codeproof-report-${Date.now()}.html`);

	try {
		fs.writeFileSync(tmpFile, cleanHtml, 'utf-8');
		await vscode.env.openExternal(vscode.Uri.file(tmpFile));
	} catch (error) {
		vscode.window.showErrorMessage(
			`CodeProof: Failed to open in browser — ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Handles the "Email Report" action from the WebView.
 * Prompts for a recipient email, generates a PDF, saves it to .codeproof/exports/,
 * then opens a mailto: link with the recipient pre-filled.
 *
 * @param html - The full report HTML
 * @param meta - Report metadata for the email subject/body
 */
async function handleEmailReport(html: string, meta: ReportMeta): Promise<void> {
	const recipient = await vscode.window.showInputBox({
		prompt: 'Recipient email address',
		placeHolder: 'e.g. lecturer@university.edu',
	});
	if (recipient === undefined) {
		return;
	}

	const chromePath = findChromePath();
	if (!chromePath) {
		vscode.window.showErrorMessage(
			'CodeProof: Chrome or Chromium not found. Please install Google Chrome to enable PDF export.'
		);
		return;
	}

	const cleanHtml = stripActionBar(html);

	// Generate PDF and save to exports directory
	const workspacePath = getWorkspaceFolderPath();
	let savedPdfPath = '';

	try {
		const pdfBuffer = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'CodeProof: Generating PDF for email...',
				cancellable: false,
			},
			async () => generatePDF(cleanHtml, chromePath)
		);

		if (workspacePath) {
			const sanitizedAssignment = meta.assignmentName
				.replace(/[^a-zA-Z0-9\-_]/g, '-')
				.toLowerCase();
			const dateStr = new Date().toISOString().slice(0, 10);
			const exportsDir = path.join(workspacePath, '.codeproof', 'exports');
			fs.mkdirSync(exportsDir, { recursive: true });
			savedPdfPath = path.join(
				exportsDir,
				`codeproof-report-${sanitizedAssignment}-${dateStr}.pdf`
			);
			fs.writeFileSync(savedPdfPath, pdfBuffer);
		}
	} catch (error) {
		vscode.window.showErrorMessage(
			`CodeProof: Failed to generate PDF — ${error instanceof Error ? error.message : String(error)}`
		);
		return;
	}

	// Build mailto link with recipient
	const subject = encodeURIComponent(
		`CodeProof Report — ${meta.assignmentName} — ${meta.studentName}`
	);
	const body = encodeURIComponent(
		`Please find my CodeProof development authenticity report attached.\n\n` +
		`Generated on ${meta.generatedDate} with ${meta.snapshotCount} snapshots across ${meta.sessionCount} sessions.\n` +
		`Hash chain status: ${meta.chainVerified ? 'Verified' : 'Broken'}`
	);
	const mailtoUri = vscode.Uri.parse(`mailto:${recipient}?subject=${subject}&body=${body}`);
	await vscode.env.openExternal(mailtoUri);

	if (savedPdfPath) {
		vscode.window.showInformationMessage(
			`CodeProof: PDF saved to .codeproof/exports/ — attach it to your email`
		);
	}
}

/**
 * Generates and displays the HTML report in a VS Code WebView panel.
 * Sets up message handling for the action bar buttons (Download, Open in Browser, Email, Print).
 *
 * @param context - The VS Code extension context
 * @param flags - Optional flags to include in the report
 */
async function openDashboard(context: vscode.ExtensionContext, flags?: FlagWithContext[]): Promise<void> {
	const html = await promptAndGenerateReport(context, flags);
	if (!html) {
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'codeproofReport',
		'CodeProof — Development Report',
		vscode.ViewColumn.One,
		{ enableScripts: true }
	);

	panel.webview.html = html;

	// Handle messages from the WebView action bar
	panel.webview.onDidReceiveMessage(
		async (message: { type: string; meta?: ReportMeta }) => {
			try {
				switch (message.type) {
					case 'downloadPDF':
						await handleDownloadPDF(html);
						break;
					case 'openInBrowser':
						await handleOpenInBrowser(html);
						break;
					case 'emailReport':
						if (message.meta) {
							await handleEmailReport(html, message.meta);
						}
						break;
				}
			} catch (error) {
				console.error('[CodeProof] Error handling action bar message:', error);
				vscode.window.showErrorMessage(
					`CodeProof: Error — ${error instanceof Error ? error.message : String(error)}`
				);
			}
		},
		undefined,
		context.subscriptions
	);
}

/**
 * Generates the report and exports it as a PDF to a user-chosen location.
 * Uses puppeteer-core with the system Chrome to convert HTML to PDF.
 */
async function exportReport(context: vscode.ExtensionContext): Promise<void> {
	const chromePath = findChromePath();
	if (!chromePath) {
		vscode.window.showErrorMessage(
			'CodeProof: Chrome or Chromium not found. Please install Google Chrome to enable PDF export.'
		);
		return;
	}

	const html = await promptAndGenerateReport(context);
	if (!html) {
		return;
	}

	const cleanHtml = stripActionBar(html);

	try {
		const pdfBuffer = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'CodeProof: Generating PDF...',
				cancellable: false,
			},
			async () => generatePDF(cleanHtml, chromePath)
		);

		const defaultName = `codeproof-report-${new Date().toISOString().slice(0, 10)}.pdf`;
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(
				path.join(getWorkspaceFolderPath() || '', defaultName)
			),
			filters: { 'PDF Files': ['pdf'] },
			title: 'Export CodeProof Report as PDF',
		});

		if (!uri) {
			return;
		}

		fs.writeFileSync(uri.fsPath, pdfBuffer);
		vscode.window.showInformationMessage(
			`CodeProof: PDF exported to ${path.basename(uri.fsPath)}`
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			`CodeProof: Failed to export PDF — ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Runs the FlagAnalyzer on stored snapshots, loads any persisted flag contexts,
 * then opens the FlagReviewPanel for the student to review and annotate flags.
 * Handles WebView messages for adding context, acknowledging, dismissing, and
 * triggering report generation.
 *
 * @param context - The VS Code extension context
 */
async function reviewFlags(context: vscode.ExtensionContext): Promise<void> {
	if (!storage) {
		vscode.window.showInformationMessage('CodeProof: No recording data available. Start recording first.');
		return;
	}

	const snapshots = storage.getSnapshots();
	if (snapshots.length === 0) {
		vscode.window.showInformationMessage('CodeProof: No snapshots recorded yet. Start recording and make some edits first.');
		return;
	}

	// Run the analyzer
	const analyzer = new FlagAnalyzer();
	const rawFlags = analyzer.analyze(snapshots);

	// Load any previously saved flag contexts from storage
	const savedFlags = storage.getFlags();
	const savedFlagMap = new Map(savedFlags.map((flag) => [flag.id, flag]));

	// Merge: use saved context/status if the flag was previously reviewed, otherwise default
	const flagsWithContext: FlagWithContext[] = rawFlags.map((flag) => {
		const saved = savedFlagMap.get(flag.id);
		if (saved) {
			return saved;
		}
		return {
			...flag,
			studentContext: '',
			status: 'acknowledged' as const,
		};
	});

	// Open the review panel
	const reviewPanel = new FlagReviewPanel(flagsWithContext);
	reviewPanel.show(context.extensionUri);

	// Handle messages from the WebView
	reviewPanel.onMessage(async (message: FlagReviewMessage) => {
		try {
			switch (message.type) {
				case 'addContext': {
					if (message.flagId) {
						const flag = flagsWithContext.find((flagItem) => flagItem.id === message.flagId);
						if (flag) {
							flag.studentContext = message.context || '';
							flag.status = 'context_added';
							storage!.saveFlag(flag);
						}
					}
					break;
				}
				case 'acknowledge': {
					if (message.flagId) {
						const flag = flagsWithContext.find((flagItem) => flagItem.id === message.flagId);
						if (flag) {
							flag.status = 'acknowledged';
							storage!.saveFlag(flag);
						}
					}
					break;
				}
				case 'dismiss': {
					if (message.flagId) {
						const flag = flagsWithContext.find((flagItem) => flagItem.id === message.flagId);
						if (flag) {
							flag.status = 'dismissed';
							storage!.saveFlag(flag);
						}
					}
					break;
				}
				case 'generateFull': {
					reviewPanel.dispose();
					const nonDismissedFlags = flagsWithContext.filter((flag) => flag.status !== 'dismissed');
					await openDashboard(context, nonDismissedFlags);
					break;
				}
				case 'generateClean': {
					reviewPanel.dispose();
					await openDashboard(context);
					break;
				}
			}
		} catch (error) {
			console.error('[CodeProof] Error handling flag review message:', error);
			vscode.window.showErrorMessage(
				`CodeProof: Error — ${error instanceof Error ? error.message : String(error)}`
			);
		}
	});
}

/**
 * Generates the report and opens it in the system browser from the sidebar.
 * Re-uses promptAndGenerateReport then writes to a temp file and opens.
 *
 * @param context - The VS Code extension context
 */
async function openDashboardInBrowser(context: vscode.ExtensionContext): Promise<void> {
	const html = await promptAndGenerateReport(context);
	if (!html) {
		return;
	}
	await handleOpenInBrowser(html);
}

/**
 * Generates the report and triggers the email flow from the sidebar.
 * Re-uses promptAndGenerateReport then delegates to handleEmailReport.
 *
 * @param context - The VS Code extension context
 */
async function emailReportFromSidebar(context: vscode.ExtensionContext): Promise<void> {
	if (!storage) {
		vscode.window.showInformationMessage('CodeProof: No recording data available. Start recording first.');
		return;
	}

	const html = await promptAndGenerateReport(context);
	if (!html) {
		return;
	}

	const totalSnapshots = storage.getSnapshotCount();
	const sessions = storage.getSessions();

	const meta: ReportMeta = {
		studentName: '',
		assignmentName: '',
		generatedDate: new Date().toISOString(),
		snapshotCount: totalSnapshots,
		sessionCount: sessions.length,
		chainVerified: storage.verifyHashChain(),
	};

	await handleEmailReport(html, meta);
}

/**
 * Activates the CodeProof extension.
 * Registers commands, sets up the status bar, and auto-starts if configured.
 *
 * @param context - The VS Code extension context
 */
export function activate(context: vscode.ExtensionContext): void {
	console.log('[CodeProof] Extension activating...');

	statusBarItem = createStatusBarItem();
	context.subscriptions.push(statusBarItem);

	// Create ConfigManager early so we can check autoStart
	configManager = new ConfigManager();
	context.subscriptions.push(configManager);

	// Register the sidebar WebView provider
	sidebarProvider = new CodeProofSidebarProvider(context.extensionUri);
	const sidebarRegistration = vscode.window.registerWebviewViewProvider(
		CodeProofSidebarProvider.viewType,
		sidebarProvider
	);
	context.subscriptions.push(sidebarRegistration, sidebarProvider);

	// Handle messages from the sidebar
	sidebarProvider.onMessage(async (message) => {
		try {
			switch (message.type) {
				case 'start':
					if (engine?.getStats().isPaused) {
						await vscode.commands.executeCommand('codeproof.pauseRecording');
					} else {
						await vscode.commands.executeCommand('codeproof.startRecording');
					}
					break;
				case 'pause':
					await vscode.commands.executeCommand('codeproof.pauseRecording');
					break;
				case 'stop':
					await vscode.commands.executeCommand('codeproof.stopRecording');
					break;
				case 'openDashboard':
					await vscode.commands.executeCommand('codeproof.openDashboard');
					break;
				case 'reviewFlags':
					await vscode.commands.executeCommand('codeproof.reviewFlags');
					break;
				case 'exportReport':
					await vscode.commands.executeCommand('codeproof.exportReport');
					break;
				case 'openInBrowser':
					await openDashboardInBrowser(context);
					break;
				case 'emailReport':
					await emailReportFromSidebar(context);
					break;
				case 'setAutoStart':
					await vscode.workspace.getConfiguration('codeproof').update(
						'autoStart',
						message.value,
						vscode.ConfigurationTarget.Global
					);
					sendSidebarUpdate();
					break;
				case 'setSnapshotInterval':
					if (message.interval) {
						await vscode.workspace.getConfiguration('codeproof').update(
							'snapshotInterval',
							message.interval,
							vscode.ConfigurationTarget.Global
						);
						sendSidebarUpdate();
					}
					break;
			}
		} catch (error) {
			console.error('[CodeProof] Error handling sidebar message:', error);
			vscode.window.showErrorMessage(
				`CodeProof: Error — ${error instanceof Error ? error.message : String(error)}`
			);
		}
	});

	const startCommand = vscode.commands.registerCommand(
		'codeproof.startRecording',
		() => startRecording(context)
	);

	const stopCommand = vscode.commands.registerCommand(
		'codeproof.stopRecording',
		() => stopRecording()
	);

	const pauseCommand = vscode.commands.registerCommand(
		'codeproof.pauseRecording',
		() => togglePause()
	);

	const statsCommand = vscode.commands.registerCommand(
		'codeproof.getStats',
		() => showStats()
	);

	const dashboardCommand = vscode.commands.registerCommand(
		'codeproof.openDashboard',
		async () => {
			try {
				await openDashboard(context);
			} catch (error) {
				console.error('[CodeProof] Error opening dashboard:', error);
				vscode.window.showErrorMessage(
					`CodeProof: Failed to open dashboard — ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	);

	const exportCommand = vscode.commands.registerCommand(
		'codeproof.exportReport',
		async () => {
			try {
				await exportReport(context);
			} catch (error) {
				console.error('[CodeProof] Error exporting report:', error);
				vscode.window.showErrorMessage(
					`CodeProof: Failed to export report — ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	);

	const reviewFlagsCommand = vscode.commands.registerCommand(
		'codeproof.reviewFlags',
		async () => {
			try {
				await reviewFlags(context);
			} catch (error) {
				console.error('[CodeProof] Error reviewing flags:', error);
				vscode.window.showErrorMessage(
					`CodeProof: Failed to review flags — ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	);

	context.subscriptions.push(startCommand, stopCommand, pauseCommand, statsCommand, dashboardCommand, exportCommand, reviewFlagsCommand);

	// Auto-start recording if the setting is enabled and a workspace is open
	if (configManager.autoStart && getWorkspaceFolderPath()) {
		startRecording(context, true);
	}

	console.log('[CodeProof] Extension activated.');
}

/**
 * Deactivates the CodeProof extension.
 * Ensures the snapshot engine, storage, and config manager are properly disposed.
 */
export function deactivate(): void {
	stopSidebarDurationTimer();
	if (engine) {
		engine.dispose();
		engine = undefined;
	}
	if (storage) {
		storage.dispose();
		storage = undefined;
	}
	if (configManager) {
		configManager.dispose();
		configManager = undefined;
	}
	sidebarProvider = undefined;
}

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as Diff from 'diff';
import { minimatch } from 'minimatch';
import { ChangeDetector } from './detector.js';
import { ChangeType, Snapshot } from './types.js';
import { SnapshotStorage } from './storage.js';
import { ConfigManager, CodeProofConfig } from '../utils/config.js';

/** Default snapshot interval in milliseconds (30 seconds) */
const DEFAULT_INTERVAL_MS = 30_000;

/** Priority order for change types — higher value wins when aggregating */
const CHANGE_TYPE_PRIORITY: Record<ChangeType, number> = {
	typing: 0,
	delete: 1,
	refactor: 2,
	paste: 3,
};

/** Accumulated change data for a file between snapshots */
interface PendingChange {
	/** Most significant change type observed since last snapshot */
	changeType: ChangeType;
	/** Total characters added across all changes */
	charsAdded: number;
	/** Total characters removed across all changes */
	charsRemoved: number;
}

/** Statistics about the snapshot engine's current state */
export interface EngineStats {
	/** Whether the engine is running */
	isRunning: boolean;
	/** Whether the engine is paused */
	isPaused: boolean;
	/** Current session identifier */
	sessionId: string;
	/** Total snapshots emitted this session */
	snapshotCount: number;
	/** Number of files being tracked */
	trackedFiles: number;
	/** Number of files with pending changes */
	dirtyFiles: number;
}

/**
 * Core snapshot engine that monitors file changes and periodically
 * emits snapshot data with unified diffs and hash chains.
 *
 * Usage:
 *   const engine = new SnapshotEngine(storage, configManager);
 *   engine.onSnapshot((snapshot) => { ... });
 *   engine.start();
 *   // later:
 *   engine.dispose();
 */
export class SnapshotEngine implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly detector: ChangeDetector;

	/** Previous snapshot content per file (keyed by fsPath) */
	private readonly fileContents: Map<string, string> = new Map();

	/** Files with changes since last snapshot interval */
	private readonly pendingChanges: Map<string, PendingChange> = new Map();

	/** Event emitter for snapshot data */
	private readonly snapshotEmitter = new vscode.EventEmitter<Snapshot>();

	/** Fires when a new snapshot is produced */
	public readonly onSnapshot: vscode.Event<Snapshot> = this.snapshotEmitter.event;

	private intervalHandle: ReturnType<typeof setInterval> | undefined;
	private isRunning = false;
	private isPaused = false;
	private sessionId: string;
	private snapshotCount = 0;
	private lastChainHash = '';
	private intervalMs: number;
	private excludePatterns: string[];
	private readonly storage: SnapshotStorage | undefined;
	private readonly configManager: ConfigManager | undefined;

	/**
	 * Creates a new SnapshotEngine.
	 *
	 * @param storage - Optional SnapshotStorage instance for persisting snapshots
	 * @param configManager - Optional ConfigManager for reading live settings
	 * @param intervalMs - Snapshot interval in milliseconds (used only if no configManager)
	 */
	constructor(
		storage?: SnapshotStorage,
		configManager?: ConfigManager,
		intervalMs: number = DEFAULT_INTERVAL_MS
	) {
		this.storage = storage;
		this.configManager = configManager;

		if (configManager) {
			const config = configManager.getConfig();
			this.intervalMs = config.snapshotInterval * 1_000;
			this.excludePatterns = config.excludePatterns;
			this.detector = new ChangeDetector(config.pasteThreshold);

			// Listen for live config changes
			const configListener = configManager.onConfigChange((newConfig) => {
				this.handleConfigChange(newConfig);
			});
			this.disposables.push(configListener);
		} else {
			this.intervalMs = intervalMs;
			this.excludePatterns = [];
			this.detector = new ChangeDetector();
		}

		this.sessionId = crypto.randomUUID();
	}

	/**
	 * Starts the snapshot engine. Registers the document change listener
	 * and begins the periodic snapshot interval.
	 */
	start(): void {
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;
		this.isPaused = false;
		this.snapshotCount = 0;
		this.lastChainHash = '';

		// Create a session in storage or generate a local ID
		if (this.storage) {
			const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'unknown';
			const session = this.storage.createSession(workspaceName);
			this.sessionId = session.id;
		} else {
			this.sessionId = crypto.randomUUID();
		}

		const changeListener = vscode.workspace.onDidChangeTextDocument(
			(event) => this.handleDocumentChange(event)
		);
		this.disposables.push(changeListener);

		this.startInterval();

		console.log(
			`[CodeProof] Snapshot engine started (interval: ${this.intervalMs}ms, session: ${this.sessionId})`
		);
	}

	/**
	 * Stops the snapshot engine. Processes any remaining pending changes,
	 * cleans up listeners, and clears state.
	 */
	stop(): void {
		if (!this.isRunning) {
			return;
		}

		// Flush any remaining pending changes
		this.processSnapshots();

		// End the session in storage
		if (this.storage) {
			try {
				this.storage.endSession(this.sessionId);
			} catch (error) {
				console.error('[CodeProof] Error ending session in storage:', error);
			}
		}

		this.isRunning = false;
		this.isPaused = false;

		this.stopInterval();
		this.disposeListeners();
		this.fileContents.clear();
		this.pendingChanges.clear();

		console.log(
			`[CodeProof] Snapshot engine stopped (session: ${this.sessionId}, snapshots: ${this.snapshotCount})`
		);
	}

	/**
	 * Pauses snapshot emission. Document changes are still accumulated
	 * and will be included in the next snapshot after resume().
	 */
	pause(): void {
		if (!this.isRunning || this.isPaused) {
			return;
		}

		this.isPaused = true;
		console.log('[CodeProof] Snapshot engine paused');
	}

	/**
	 * Resumes snapshot emission after a pause.
	 */
	resume(): void {
		if (!this.isRunning || !this.isPaused) {
			return;
		}

		this.isPaused = false;
		console.log('[CodeProof] Snapshot engine resumed');
	}

	/**
	 * Returns current engine statistics.
	 *
	 * @returns An object containing engine state and counters
	 */
	getStats(): EngineStats {
		return {
			isRunning: this.isRunning,
			isPaused: this.isPaused,
			sessionId: this.sessionId,
			snapshotCount: this.snapshotCount,
			trackedFiles: this.fileContents.size,
			dirtyFiles: this.pendingChanges.size,
		};
	}

	/**
	 * Handles a text document change event. Classifies the change type
	 * and accumulates it into the pending changes map.
	 *
	 * @param event - The VS Code text document change event
	 */
	private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0) {
			return;
		}

		// Skip non-file schemes (output panels, debug console, etc.)
		if (event.document.uri.scheme !== 'file') {
			return;
		}

		const filePath = event.document.uri.fsPath;

		// Check exclude patterns using workspace-relative path
		const relativePath = vscode.workspace.asRelativePath(event.document.uri, false);
		if (this.isExcluded(relativePath)) {
			return;
		}

		const changeType = this.detector.detect(event);

		// Calculate total characters added and removed in this event
		let charsAdded = 0;
		let charsRemoved = 0;
		for (const change of event.contentChanges) {
			charsAdded += change.text.length;
			charsRemoved += change.rangeLength;
		}

		// Seed baseline content the first time we see a file
		if (!this.fileContents.has(filePath)) {
			this.fileContents.set(filePath, '');
		}

		// Accumulate into pending changes, keeping the most significant change type
		const existing = this.pendingChanges.get(filePath);
		if (existing) {
			if (CHANGE_TYPE_PRIORITY[changeType] > CHANGE_TYPE_PRIORITY[existing.changeType]) {
				existing.changeType = changeType;
			}
			existing.charsAdded += charsAdded;
			existing.charsRemoved += charsRemoved;
		} else {
			this.pendingChanges.set(filePath, {
				changeType,
				charsAdded,
				charsRemoved,
			});
		}
	}

	/**
	 * Checks if a workspace-relative file path matches any exclude pattern.
	 *
	 * @param relativePath - Workspace-relative file path
	 * @returns True if the file should be excluded
	 */
	private isExcluded(relativePath: string): boolean {
		for (const pattern of this.excludePatterns) {
			if (minimatch(relativePath, pattern)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Processes all pending file changes, computing diffs and emitting snapshots.
	 * Called on every interval tick. Skipped if paused or no changes pending.
	 */
	private processSnapshots(): void {
		if (this.isPaused || this.pendingChanges.size === 0) {
			return;
		}

		for (const [filePath, pending] of this.pendingChanges) {
			try {
				this.emitSnapshot(filePath, pending);
			} catch (error) {
				console.error(`[CodeProof] Error processing snapshot for ${filePath}:`, error);
			}
		}

		this.pendingChanges.clear();
	}

	/**
	 * Computes the unified diff, hash chain, and metadata for a single file,
	 * then fires the onSnapshot event.
	 *
	 * @param filePath - Absolute file path
	 * @param pending - Accumulated change data since last snapshot
	 */
	private emitSnapshot(filePath: string, pending: PendingChange): void {
		// Find the open document to get current content
		const document = vscode.workspace.textDocuments.find(
			(doc) => doc.uri.fsPath === filePath
		);
		if (!document) {
			return;
		}

		const currentContent = document.getText();
		const previousContent = this.fileContents.get(filePath) ?? '';

		// Skip if content hasn't actually changed
		if (currentContent === previousContent) {
			return;
		}

		// Compute workspace-relative path for display
		const relativePath = vscode.workspace.asRelativePath(document.uri, false);

		// Compute unified diff
		const unifiedDiff = Diff.createPatch(
			relativePath,
			previousContent,
			currentContent,
			'',
			''
		);

		// Count lines added/removed from the diff
		const { linesAdded, linesRemoved } = this.countDiffLines(unifiedDiff);

		// Compute content hash (SHA-256 of current file content)
		const contentHash = crypto
			.createHash('sha256')
			.update(currentContent)
			.digest('hex');

		// Compute chain hash: SHA-256(prev_chain_hash + content_hash + timestamp)
		const timestamp = new Date().toISOString();
		const chainHash = crypto
			.createHash('sha256')
			.update(this.lastChainHash + contentHash + timestamp)
			.digest('hex');

		const snapshot: Snapshot = {
			id: crypto.randomUUID(),
			timestamp,
			filename: relativePath,
			content_hash: contentHash,
			diff: unifiedDiff,
			lines_added: linesAdded,
			lines_removed: linesRemoved,
			total_lines: document.lineCount,
			change_type: pending.changeType,
			change_size: pending.charsAdded + pending.charsRemoved,
			chain_hash: chainHash,
			session_id: this.sessionId,
		};

		// Update state
		this.lastChainHash = chainHash;
		this.fileContents.set(filePath, currentContent);
		this.snapshotCount++;

		// Persist to storage if available
		if (this.storage) {
			try {
				this.storage.saveSnapshot(snapshot);
			} catch (error) {
				console.error(`[CodeProof] Error saving snapshot to storage:`, error);
			}
		}

		this.snapshotEmitter.fire(snapshot);

		console.log(
			`[CodeProof] Snapshot #${this.snapshotCount}: ${relativePath} ` +
			`(+${linesAdded}/-${linesRemoved}, ${pending.changeType})`
		);
	}

	/**
	 * Counts lines added and removed from a unified diff string.
	 *
	 * @param diff - A unified diff string
	 * @returns Object with linesAdded and linesRemoved counts
	 */
	private countDiffLines(diff: string): { linesAdded: number; linesRemoved: number } {
		let linesAdded = 0;
		let linesRemoved = 0;

		for (const line of diff.split('\n')) {
			if (line.startsWith('+') && !line.startsWith('+++')) {
				linesAdded++;
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				linesRemoved++;
			}
		}

		return { linesAdded, linesRemoved };
	}

	/**
	 * Handles a live configuration change. Updates the interval timer,
	 * exclude patterns, and paste threshold without stopping the engine.
	 *
	 * @param config - The new configuration values
	 */
	private handleConfigChange(config: CodeProofConfig): void {
		const newIntervalMs = config.snapshotInterval * 1_000;

		// Restart the interval timer if the interval changed
		if (newIntervalMs !== this.intervalMs) {
			this.intervalMs = newIntervalMs;
			if (this.isRunning) {
				this.stopInterval();
				this.startInterval();
			}
			console.log(`[CodeProof] Snapshot interval updated to ${this.intervalMs}ms`);
		}

		// Update exclude patterns
		this.excludePatterns = config.excludePatterns;

		// Update paste threshold on the detector
		this.detector.setPasteThreshold(config.pasteThreshold);

		console.log('[CodeProof] Configuration updated');
	}

	/**
	 * Starts the periodic snapshot processing interval.
	 */
	private startInterval(): void {
		this.intervalHandle = setInterval(() => {
			this.processSnapshots();
		}, this.intervalMs);
	}

	/**
	 * Stops the periodic snapshot processing interval.
	 */
	private stopInterval(): void {
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = undefined;
		}
	}

	/**
	 * Disposes all registered event listeners.
	 */
	private disposeListeners(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}

	/**
	 * Disposes the snapshot engine and all its resources.
	 * Stops recording if still running.
	 */
	dispose(): void {
		this.stop();
		this.snapshotEmitter.dispose();
	}
}

import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { ReplayEvent, ReplayChange } from './types.js';
import { SnapshotStorage } from './storage.js';

/** Interval in milliseconds between flushes to storage */
const FLUSH_INTERVAL_MS = 5_000;

/** Maximum time window in milliseconds for coalescing sequential single-character inserts */
const COALESCE_WINDOW_MS = 500;

/**
 * High-frequency recorder that captures every text document edit event
 * for development replay. Unlike the SnapshotEngine which records periodic
 * diffs, the ReplayRecorder captures individual keystrokes and changes
 * for character-by-character playback.
 *
 * Sequential single-character inserts on the same line within 500ms are
 * coalesced into a single event for storage efficiency.
 */
export class ReplayRecorder implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly buffer: ReplayEvent[] = [];
	private flushHandle: ReturnType<typeof setInterval> | undefined;
	private isRecording = false;
	private excludePatterns: string[];

	/**
	 * Creates a new ReplayRecorder.
	 *
	 * @param storage - SnapshotStorage instance for persisting replay events
	 * @param excludePatterns - Glob patterns for files to ignore
	 */
	constructor(
		private readonly storage: SnapshotStorage,
		excludePatterns: string[] = []
	) {
		this.excludePatterns = excludePatterns;
	}

	/**
	 * Starts recording text document changes. Registers the change listener
	 * and begins the periodic flush timer.
	 */
	start(): void {
		if (this.isRecording) {
			return;
		}

		this.isRecording = true;

		const changeListener = vscode.workspace.onDidChangeTextDocument(
			(event) => this.handleDocumentChange(event)
		);
		this.disposables.push(changeListener);

		this.flushHandle = setInterval(() => {
			this.flush();
		}, FLUSH_INTERVAL_MS);

		console.log('[CodeProof] ReplayRecorder started');
	}

	/**
	 * Stops recording and flushes any remaining buffered events to storage.
	 */
	stop(): void {
		if (!this.isRecording) {
			return;
		}

		this.isRecording = false;
		this.flush();

		if (this.flushHandle) {
			clearInterval(this.flushHandle);
			this.flushHandle = undefined;
		}

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;

		console.log('[CodeProof] ReplayRecorder stopped');
	}

	/**
	 * Retrieves replay events from storage with optional filters.
	 *
	 * @param filename - Optional filename filter
	 * @param after - Optional minimum timestamp (milliseconds)
	 * @param before - Optional maximum timestamp (milliseconds)
	 * @returns Array of ReplayEvent objects
	 */
	getEvents(filename?: string, after?: number, before?: number): ReplayEvent[] {
		return this.storage.getReplayEvents({ filename, after, before });
	}

	/**
	 * Updates the exclude patterns used to filter file changes.
	 *
	 * @param patterns - New glob patterns for files to ignore
	 */
	setExcludePatterns(patterns: string[]): void {
		this.excludePatterns = patterns;
	}

	/**
	 * Handles a text document change event. Converts VS Code change events
	 * into ReplayEvent objects and adds them to the buffer, coalescing
	 * sequential single-character inserts on the same line.
	 *
	 * @param event - The VS Code text document change event
	 */
	private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0) {
			return;
		}

		if (event.document.uri.scheme !== 'file') {
			return;
		}

		const relativePath = vscode.workspace.asRelativePath(event.document.uri, false);
		if (this.isExcluded(relativePath)) {
			return;
		}

		const timestamp = Date.now();
		const changes: ReplayChange[] = event.contentChanges.map((change) => ({
			rangeStart: {
				line: change.range.start.line,
				character: change.range.start.character,
			},
			rangeEnd: {
				line: change.range.end.line,
				character: change.range.end.character,
			},
			text: change.text,
			rangeLength: change.rangeLength,
		}));

		const newEvent: ReplayEvent = {
			timestamp,
			filename: relativePath,
			changes,
		};

		// Attempt to coalesce with the last buffered event
		if (this.tryCoalesce(newEvent)) {
			return;
		}

		this.buffer.push(newEvent);
	}

	/**
	 * Attempts to coalesce a new event with the last buffered event.
	 * Coalescing happens when both events are single-character inserts
	 * (no deletion) on the same file and line within the coalesce window.
	 *
	 * @param newEvent - The new replay event to potentially coalesce
	 * @returns True if the event was coalesced, false otherwise
	 */
	private tryCoalesce(newEvent: ReplayEvent): boolean {
		if (this.buffer.length === 0) {
			return false;
		}

		const lastEvent = this.buffer[this.buffer.length - 1];

		// Must be same file
		if (lastEvent.filename !== newEvent.filename) {
			return false;
		}

		// Must be within coalesce window
		if (newEvent.timestamp - lastEvent.timestamp > COALESCE_WINDOW_MS) {
			return false;
		}

		// Both must be single-change events
		if (lastEvent.changes.length !== 1 || newEvent.changes.length !== 1) {
			return false;
		}

		const lastChange = lastEvent.changes[0];
		const newChange = newEvent.changes[0];

		// Both must be pure inserts (no deletion) with single characters or short strings
		if (lastChange.rangeLength !== 0 || newChange.rangeLength !== 0) {
			return false;
		}

		// New insert must be on the same line
		if (lastChange.rangeStart.line !== newChange.rangeStart.line) {
			return false;
		}

		// New insert must be at the position right after the last insert
		const expectedChar = lastChange.rangeStart.character + lastChange.text.length;
		if (newChange.rangeStart.character !== expectedChar) {
			return false;
		}

		// Only coalesce single-character inserts (typing, not paste)
		if (newChange.text.length !== 1) {
			return false;
		}

		// Coalesce: append text to the last change
		lastChange.text += newChange.text;
		lastChange.rangeEnd = {
			line: newChange.rangeEnd.line,
			character: newChange.rangeEnd.character,
		};

		return true;
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
	 * Flushes all buffered replay events to storage.
	 */
	private flush(): void {
		if (this.buffer.length === 0) {
			return;
		}

		const eventsToSave = this.buffer.splice(0);

		try {
			this.storage.saveReplayEvents(eventsToSave);
			console.log(`[CodeProof] Flushed ${eventsToSave.length} replay events`);
		} catch (error) {
			console.error('[CodeProof] Error flushing replay events:', error);
		}
	}

	/**
	 * Disposes the replay recorder and all its resources.
	 */
	dispose(): void {
		this.stop();
	}
}

import * as vscode from 'vscode';
import { ChangeType } from './types.js';

/** Default minimum characters added in a single change to classify as a paste */
const DEFAULT_PASTE_CHAR_THRESHOLD = 50;

/** Minimum characters removed in a single change to classify as a delete */
const DELETE_CHAR_THRESHOLD = 30;

/**
 * Classifies text document change events into change types.
 * Used by the SnapshotEngine to determine how code was modified.
 */
export class ChangeDetector {
	private pasteThreshold: number;

	/**
	 * Creates a new ChangeDetector with the specified paste threshold.
	 *
	 * @param pasteThreshold - Minimum characters to classify as a paste (default: 50)
	 */
	constructor(pasteThreshold: number = DEFAULT_PASTE_CHAR_THRESHOLD) {
		this.pasteThreshold = pasteThreshold;
	}

	/**
	 * Updates the paste detection threshold at runtime.
	 *
	 * @param threshold - New character threshold for paste detection
	 */
	setPasteThreshold(threshold: number): void {
		this.pasteThreshold = threshold;
	}

	/**
	 * Analyzes a text document change event and returns the detected change type.
	 *
	 * Classification rules (checked in order):
	 * - Refactor: multiple ranges changed simultaneously (e.g. rename, multi-cursor)
	 * - Paste: single change adding characters >= paste threshold
	 * - Delete: single change removing 30+ characters with no text added
	 * - Typing: everything else (normal keystroke-level edits)
	 *
	 * @param event - The VS Code text document change event to classify
	 * @returns The detected change type
	 */
	detect(event: vscode.TextDocumentChangeEvent): ChangeType {
		const changes = event.contentChanges;

		if (changes.length === 0) {
			return 'typing';
		}

		// Refactor: changes across multiple ranges simultaneously
		if (changes.length > 1) {
			return 'refactor';
		}

		const change = changes[0];
		const charsAdded = change.text.length;
		const charsRemoved = change.rangeLength;

		// Paste: single change adding characters >= threshold in one range
		if (charsAdded >= this.pasteThreshold) {
			return 'paste';
		}

		// Delete: single change removing 30+ characters with nothing added
		if (charsRemoved >= DELETE_CHAR_THRESHOLD && charsAdded === 0) {
			return 'delete';
		}

		return 'typing';
	}
}

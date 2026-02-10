import * as crypto from 'crypto';
import { Snapshot, Flag } from '../snapshot/types.js';

/** Minimum lines added in a single snapshot to flag as LARGE_PASTE */
const LARGE_PASTE_THRESHOLD = 30;

/** Minimum lines for a code block to be considered complex (fully formed check) */
const FULLY_FORMED_LINE_THRESHOLD = 50;

/** Minimum inactivity gap in ms before checking for LONG_GAP_THEN_COMPLETION (2 hours) */
const LONG_GAP_MS = 2 * 60 * 60 * 1000;

/** Window after a long gap in which significant additions trigger the flag (30 minutes) */
const POST_GAP_WINDOW_MS = 30 * 60 * 1000;

/** Minimum lines added after a long gap to trigger LONG_GAP_THEN_COMPLETION */
const POST_GAP_LINE_THRESHOLD = 30;

/** Minimum total lines added to a file to trigger NO_DEBUGGING check */
const NO_DEBUGGING_LINE_THRESHOLD = 100;

/** Sustained characters-per-minute threshold for UNUSUAL_SPEED */
const UNUSUAL_SPEED_CPM = 200;

/** Window size in ms for measuring sustained typing speed (5 minutes) */
const SPEED_WINDOW_MS = 5 * 60 * 1000;

/** Minimum total lines for RAPID_COMPLETION */
const RAPID_COMPLETION_LINE_THRESHOLD = 200;

/** Maximum elapsed time in ms for RAPID_COMPLETION (1 hour) */
const RAPID_COMPLETION_TIME_MS = 60 * 60 * 1000;

/**
 * Analyses snapshots for patterns that could indicate non-authentic development.
 * Each detection rule produces zero or more Flag objects describing the concern,
 * along with a suggested context hint to help students explain the situation.
 */
export class FlagAnalyzer {
	/**
	 * Runs all detection rules against the provided snapshots and returns
	 * any flags found.
	 *
	 * @param snapshots - Array of snapshots sorted chronologically
	 * @returns Array of detected flags
	 */
	analyze(snapshots: Snapshot[]): Flag[] {
		if (snapshots.length === 0) {
			return [];
		}

		const flags: Flag[] = [];

		flags.push(...this.detectLargePaste(snapshots));
		flags.push(...this.detectFullyFormedCode(snapshots));
		flags.push(...this.detectLongGapThenCompletion(snapshots));
		flags.push(...this.detectStyleInconsistency(snapshots));
		flags.push(...this.detectNoDebugging(snapshots));
		flags.push(...this.detectUnusualSpeed(snapshots));
		flags.push(...this.detectRapidCompletion(snapshots));

		return flags;
	}

	/**
	 * Generates a unique flag ID.
	 *
	 * @returns A UUID string
	 */
	private generateId(): string {
		return crypto.randomUUID();
	}

	/**
	 * LARGE_PASTE: Detects single changes adding 30+ lines.
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for large paste events
	 */
	private detectLargePaste(snapshots: Snapshot[]): Flag[] {
		const flags: Flag[] = [];

		for (const snapshot of snapshots) {
			if (snapshot.lines_added >= LARGE_PASTE_THRESHOLD && snapshot.change_type === 'paste') {
				flags.push({
					id: this.generateId(),
					category: 'large_paste',
					severity: 'medium',
					timestamp: snapshot.timestamp,
					filename: snapshot.filename,
					description: `A paste event added ${snapshot.lines_added} lines to ${snapshot.filename} in a single change. Large pastes can come from many legitimate sources — lecture notes, starter templates, or documentation.`,
					snapshotIds: [snapshot.id],
					suggestedContext: 'Where did this code come from? e.g. "Pasted from lecture starter template" or "Copied from my earlier project to reuse utility functions"',
				});
			}
		}

		return flags;
	}

	/**
	 * CODE_APPEARED_FULLY_FORMED: Detects complex code blocks (50+ lines)
	 * added in one snapshot with zero subsequent edits to that file.
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for fully-formed code blocks
	 */
	private detectFullyFormedCode(snapshots: Snapshot[]): Flag[] {
		const flags: Flag[] = [];

		for (let i = 0; i < snapshots.length; i++) {
			const snapshot = snapshots[i];

			if (snapshot.lines_added < FULLY_FORMED_LINE_THRESHOLD) {
				continue;
			}

			// Check whether this file was edited again after this snapshot
			let wasEditedAfter = false;
			for (let j = i + 1; j < snapshots.length; j++) {
				if (snapshots[j].filename === snapshot.filename) {
					wasEditedAfter = true;
					break;
				}
			}

			if (!wasEditedAfter) {
				flags.push({
					id: this.generateId(),
					category: 'fully_formed_code',
					severity: 'high',
					timestamp: snapshot.timestamp,
					filename: snapshot.filename,
					description: `${snapshot.lines_added} lines were added to ${snapshot.filename} in a single snapshot with no subsequent edits. Code that appears fully formed without any iteration is unusual — most development involves corrections and refinements.`,
					snapshotIds: [snapshot.id],
					suggestedContext: 'Why was this code added without further changes? e.g. "This was a well-practiced algorithm I\'d written several times before" or "I drafted this in a separate file first, then moved it here"',
				});
			}
		}

		return flags;
	}

	/**
	 * LONG_GAP_THEN_COMPLETION: Detects 2+ hour gaps followed by
	 * significant code added within 30 minutes of resuming.
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for gap-then-completion patterns
	 */
	private detectLongGapThenCompletion(snapshots: Snapshot[]): Flag[] {
		const flags: Flag[] = [];

		for (let i = 1; i < snapshots.length; i++) {
			const prevTime = new Date(snapshots[i - 1].timestamp).getTime();
			const currTime = new Date(snapshots[i].timestamp).getTime();
			const gap = currTime - prevTime;

			if (gap < LONG_GAP_MS) {
				continue;
			}

			// Count lines added in the 30-minute window after the gap
			let linesAddedAfterGap = 0;
			const relevantSnapshotIds: string[] = [];
			const windowEnd = currTime + POST_GAP_WINDOW_MS;

			for (let j = i; j < snapshots.length; j++) {
				const snapTime = new Date(snapshots[j].timestamp).getTime();
				if (snapTime > windowEnd) {
					break;
				}
				linesAddedAfterGap += snapshots[j].lines_added;
				relevantSnapshotIds.push(snapshots[j].id);
			}

			if (linesAddedAfterGap >= POST_GAP_LINE_THRESHOLD) {
				const gapHours = Math.round(gap / (60 * 60 * 1000) * 10) / 10;
				flags.push({
					id: this.generateId(),
					category: 'long_gap',
					severity: 'medium',
					timestamp: snapshots[i].timestamp,
					filename: snapshots[i].filename,
					description: `After ${gapHours} hours of inactivity, ${linesAddedAfterGap} lines were added within 30 minutes of resuming. A burst of productivity after a long break can sometimes indicate code prepared elsewhere.`,
					snapshotIds: relevantSnapshotIds,
					suggestedContext: 'What happened during the gap? e.g. "I was planning the solution on paper before coding" or "I took a long break and came back with a clear idea of what to write"',
				});
			}
		}

		return flags;
	}

	/**
	 * STYLE_INCONSISTENCY: Detects naming convention changes within a file
	 * (e.g. camelCase switching to snake_case mid-file).
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for style inconsistencies
	 */
	private detectStyleInconsistency(snapshots: Snapshot[]): Flag[] {
		const flags: Flag[] = [];
		const fileSnapshots = new Map<string, Snapshot[]>();

		// Group snapshots by file
		for (const snapshot of snapshots) {
			const existing = fileSnapshots.get(snapshot.filename);
			if (existing) {
				existing.push(snapshot);
			} else {
				fileSnapshots.set(snapshot.filename, [snapshot]);
			}
		}

		for (const [filename, fileSnaps] of fileSnapshots) {
			if (fileSnaps.length < 2) {
				continue;
			}

			// Analyse naming conventions across snapshots for this file
			const earlySnaps = fileSnaps.slice(0, Math.ceil(fileSnaps.length / 2));
			const lateSnaps = fileSnaps.slice(Math.ceil(fileSnaps.length / 2));

			const earlyStyle = this.detectNamingConvention(earlySnaps);
			const lateStyle = this.detectNamingConvention(lateSnaps);

			if (earlyStyle.dominant && lateStyle.dominant && earlyStyle.dominant !== lateStyle.dominant) {
				const allIds = fileSnaps.map((snap) => snap.id);
				flags.push({
					id: this.generateId(),
					category: 'style_inconsistency',
					severity: 'medium',
					timestamp: lateSnaps[0].timestamp,
					filename,
					description: `Naming convention in ${filename} appears to change from ${earlyStyle.dominant} to ${lateStyle.dominant} partway through development. Inconsistent style can indicate code from different sources.`,
					snapshotIds: allIds,
					suggestedContext: 'Why did the coding style change? e.g. "I started following a different style guide midway" or "I refactored to match the project\'s conventions"',
				});
			}
		}

		return flags;
	}

	/**
	 * Analyses diffs to detect the dominant naming convention.
	 *
	 * @param snapshots - Snapshots to analyse
	 * @returns Object with the dominant convention name, or null if unclear
	 */
	private detectNamingConvention(snapshots: Snapshot[]): { dominant: string | null } {
		let camelCount = 0;
		let snakeCount = 0;

		const camelCasePattern = /[a-z][A-Z]/g;
		const snakeCasePattern = /[a-z]_[a-z]/g;

		for (const snapshot of snapshots) {
			const addedLines = snapshot.diff
				.split('\n')
				.filter((line) => line.startsWith('+') && !line.startsWith('+++'));

			for (const line of addedLines) {
				const camelMatches = line.match(camelCasePattern);
				const snakeMatches = line.match(snakeCasePattern);
				camelCount += camelMatches ? camelMatches.length : 0;
				snakeCount += snakeMatches ? snakeMatches.length : 0;
			}
		}

		const total = camelCount + snakeCount;
		if (total < 5) {
			return { dominant: null };
		}

		const camelRatio = camelCount / total;
		if (camelRatio > 0.7) {
			return { dominant: 'camelCase' };
		}
		if (camelRatio < 0.3) {
			return { dominant: 'snake_case' };
		}

		return { dominant: null };
	}

	/**
	 * NO_DEBUGGING: Detects files with 100+ lines added but zero lines
	 * ever deleted or modified (no iteration).
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for no-debugging patterns
	 */
	private detectNoDebugging(snapshots: Snapshot[]): Flag[] {
		const flags: Flag[] = [];
		const fileStats = new Map<string, { totalAdded: number; totalRemoved: number; snapshotIds: string[]; firstTimestamp: string }>();

		for (const snapshot of snapshots) {
			const existing = fileStats.get(snapshot.filename);
			if (existing) {
				existing.totalAdded += snapshot.lines_added;
				existing.totalRemoved += snapshot.lines_removed;
				existing.snapshotIds.push(snapshot.id);
			} else {
				fileStats.set(snapshot.filename, {
					totalAdded: snapshot.lines_added,
					totalRemoved: snapshot.lines_removed,
					snapshotIds: [snapshot.id],
					firstTimestamp: snapshot.timestamp,
				});
			}
		}

		for (const [filename, stats] of fileStats) {
			if (stats.totalAdded >= NO_DEBUGGING_LINE_THRESHOLD && stats.totalRemoved === 0) {
				flags.push({
					id: this.generateId(),
					category: 'no_debugging',
					severity: 'low',
					timestamp: stats.firstTimestamp,
					filename,
					description: `${stats.totalAdded} lines were added to ${filename} across the session with zero lines deleted or modified. Most development involves some trial and error — this is unusual but not impossible.`,
					snapshotIds: stats.snapshotIds,
					suggestedContext: 'Why was no code removed or changed? e.g. "I planned the logic carefully beforehand" or "I was following a tutorial step by step"',
				});
			}
		}

		return flags;
	}

	/**
	 * UNUSUAL_SPEED: Detects sustained 200+ characters per minute
	 * averaged over a 5-minute window.
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for unusually fast coding
	 */
	private detectUnusualSpeed(snapshots: Snapshot[]): Flag[] {
		const flags: Flag[] = [];
		const flaggedWindows = new Set<string>();

		for (let i = 0; i < snapshots.length; i++) {
			const windowStart = new Date(snapshots[i].timestamp).getTime();
			const windowEnd = windowStart + SPEED_WINDOW_MS;

			let totalChars = 0;
			const windowSnapshotIds: string[] = [];

			for (let j = i; j < snapshots.length; j++) {
				const snapTime = new Date(snapshots[j].timestamp).getTime();
				if (snapTime > windowEnd) {
					break;
				}
				totalChars += snapshots[j].change_size;
				windowSnapshotIds.push(snapshots[j].id);
			}

			const windowDurationMinutes = SPEED_WINDOW_MS / 60_000;
			const charsPerMinute = totalChars / windowDurationMinutes;

			if (charsPerMinute >= UNUSUAL_SPEED_CPM && windowSnapshotIds.length >= 2) {
				// Deduplicate: only flag once per starting snapshot
				const windowKey = snapshots[i].id;
				if (flaggedWindows.has(windowKey)) {
					continue;
				}
				flaggedWindows.add(windowKey);

				const roundedCpm = Math.round(charsPerMinute);
				flags.push({
					id: this.generateId(),
					category: 'unusual_typing_speed',
					severity: 'low',
					timestamp: snapshots[i].timestamp,
					filename: snapshots[i].filename,
					description: `Sustained typing speed of ~${roundedCpm} characters per minute detected over a 5-minute window starting at ${new Date(snapshots[i].timestamp).toLocaleTimeString()}. This is above the typical range for manual coding.`,
					snapshotIds: windowSnapshotIds,
					suggestedContext: 'What explains the fast coding speed? e.g. "I was typing boilerplate code I\'m very familiar with" or "I used code snippets/autocomplete extensively"',
				});
			}
		}

		return flags;
	}

	/**
	 * RAPID_COMPLETION: Detects entire assignments completed in under
	 * 1 hour with 200+ lines of code.
	 *
	 * @param snapshots - Chronologically sorted snapshots
	 * @returns Array of flags for rapid completion
	 */
	private detectRapidCompletion(snapshots: Snapshot[]): Flag[] {
		if (snapshots.length < 2) {
			return [];
		}

		const firstTime = new Date(snapshots[0].timestamp).getTime();
		const lastTime = new Date(snapshots[snapshots.length - 1].timestamp).getTime();
		const elapsed = lastTime - firstTime;

		const totalLinesAdded = snapshots.reduce((sum, snap) => sum + snap.lines_added, 0);

		if (elapsed <= RAPID_COMPLETION_TIME_MS && totalLinesAdded >= RAPID_COMPLETION_LINE_THRESHOLD) {
			const minutes = Math.round(elapsed / 60_000);
			return [{
				id: this.generateId(),
				category: 'rapid_completion',
				severity: 'low',
				timestamp: snapshots[0].timestamp,
				filename: snapshots[0].filename,
				description: `The entire recording session produced ${totalLinesAdded} lines of code in approximately ${minutes} minutes. Completing a substantial amount of code very quickly is notable, though not necessarily suspicious.`,
				snapshotIds: snapshots.map((snap) => snap.id),
				suggestedContext: 'Why was the code completed so quickly? e.g. "I had already designed the solution on paper" or "This was a rebuild of a previous attempt"',
			}];
		}

		return [];
	}
}

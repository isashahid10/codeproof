/** Classification of a code change */
export type ChangeType = 'typing' | 'paste' | 'delete' | 'refactor';

/** Severity levels for flags */
export type FlagSeverity = 'high' | 'medium' | 'low' | 'info';

/** Categories for flags */
export type FlagCategory =
	| 'large_paste'
	| 'rapid_completion'
	| 'fully_formed_code'
	| 'long_gap'
	| 'style_inconsistency'
	| 'no_debugging'
	| 'unusual_typing_speed';

/** Status of a flag after student review */
export type FlagStatus = 'acknowledged' | 'dismissed' | 'context_added';

/** A single snapshot of file state at a point in time */
export interface Snapshot {
	/** Unique identifier (UUID) */
	id: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Relative file path within the workspace */
	filename: string;
	/** SHA-256 hash of the file content at this point */
	content_hash: string;
	/** Unified diff from previous snapshot */
	diff: string;
	/** Number of lines added since previous snapshot */
	lines_added: number;
	/** Number of lines removed since previous snapshot */
	lines_removed: number;
	/** Total lines in the file at this point */
	total_lines: number;
	/** Classification of the change */
	change_type: ChangeType;
	/** Total characters changed */
	change_size: number;
	/** SHA-256(previous_chain_hash + content_hash + timestamp) for tamper evidence */
	chain_hash: string;
	/** Session identifier grouping snapshots within a coding session */
	session_id: string;
}

/** A coding session grouping multiple snapshots */
export interface Session {
	/** Unique identifier (UUID) */
	id: string;
	/** ISO 8601 timestamp when the session started */
	started_at: string;
	/** ISO 8601 timestamp when the session ended (empty string if ongoing) */
	ended_at: string;
	/** Name of the project/workspace */
	project_name: string;
	/** List of files touched during this session */
	files_touched: string[];
	/** Total number of snapshots in this session */
	total_snapshots: number;
}

/** A flag indicating a potentially suspicious pattern */
export interface Flag {
	/** Unique identifier */
	id: string;
	/** Category of the flag */
	category: FlagCategory;
	/** Severity level */
	severity: FlagSeverity;
	/** ISO 8601 timestamp of the event that triggered the flag */
	timestamp: string;
	/** Filename related to the flag */
	filename: string;
	/** Human-readable description of the flagged pattern */
	description: string;
	/** IDs of snapshots relevant to this flag */
	snapshotIds: string[];
	/** Hint text suggesting what kind of explanation would help */
	suggestedContext: string;
}

/** A flag with student-provided context and review status */
export interface FlagWithContext extends Flag {
	/** Student's written explanation for this flag */
	studentContext: string;
	/** Current review status */
	status: FlagStatus;
}

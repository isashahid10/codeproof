import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { Snapshot, Session, FlagWithContext } from './types.js';

/** Options for filtering snapshots */
export interface SnapshotQueryOptions {
	/** Filter by filename (workspace-relative path) */
	filename?: string;
	/** Return snapshots after this ISO 8601 timestamp */
	after?: string;
	/** Return snapshots before this ISO 8601 timestamp */
	before?: string;
	/** Filter by session ID */
	sessionId?: string;
}

/**
 * Persists snapshots and sessions to a SQLite database.
 * One database per workspace, stored at .codeproof/snapshots.db.
 *
 * Implements vscode.Disposable so it can be added to extension subscriptions
 * and cleaned up automatically on deactivation.
 */
export class SnapshotStorage implements vscode.Disposable {
	private readonly database: Database.Database;
	private readonly dbPath: string;

	/* Prepared statements for performance */
	private readonly insertSnapshotStmt: Database.Statement;
	private readonly insertSessionStmt: Database.Statement;
	private readonly updateSessionEndStmt: Database.Statement;
	private readonly updateSessionStatsStmt: Database.Statement;
	private readonly getSnapshotCountStmt: Database.Statement;
	private readonly getCurrentSessionStmt: Database.Statement;

	/**
	 * Creates a new SnapshotStorage instance.
	 * Ensures the storage directory exists, opens (or creates) the SQLite
	 * database, and prepares all SQL statements.
	 *
	 * @param workspaceFolderPath - Absolute path to the workspace root
	 * @param storageDir - Directory name for CodeProof data (default: '.codeproof')
	 */
	constructor(workspaceFolderPath: string, storageDir: string = '.codeproof') {
		const codeproofDir = path.join(workspaceFolderPath, storageDir);
		if (!fs.existsSync(codeproofDir)) {
			fs.mkdirSync(codeproofDir, { recursive: true });
		}

		this.dbPath = path.join(codeproofDir, 'snapshots.db');
		this.database = new Database(this.dbPath);

		// Enable WAL mode for better concurrent read performance
		this.database.pragma('journal_mode = WAL');

		this.createTables();

		// Prepare statements
		this.insertSnapshotStmt = this.database.prepare(`
			INSERT INTO snapshots (
				id, timestamp, filename, content_hash, diff,
				lines_added, lines_removed, total_lines,
				change_type, change_size, chain_hash, session_id
			) VALUES (
				@id, @timestamp, @filename, @content_hash, @diff,
				@lines_added, @lines_removed, @total_lines,
				@change_type, @change_size, @chain_hash, @session_id
			)
		`);

		this.insertSessionStmt = this.database.prepare(`
			INSERT INTO sessions (id, started_at, ended_at, project_name, files_touched, total_snapshots)
			VALUES (@id, @started_at, @ended_at, @project_name, @files_touched, @total_snapshots)
		`);

		this.updateSessionEndStmt = this.database.prepare(`
			UPDATE sessions SET ended_at = @ended_at WHERE id = @id
		`);

		this.updateSessionStatsStmt = this.database.prepare(`
			UPDATE sessions
			SET files_touched = @files_touched,
			    total_snapshots = @total_snapshots
			WHERE id = @id
		`);

		this.getSnapshotCountStmt = this.database.prepare(
			'SELECT COUNT(*) AS count FROM snapshots'
		);

		this.getCurrentSessionStmt = this.database.prepare(
			"SELECT * FROM sessions WHERE ended_at = '' ORDER BY started_at DESC LIMIT 1"
		);

		console.log(`[CodeProof] Storage opened at ${this.dbPath}`);
	}

	/**
	 * Creates the snapshots and sessions tables if they don't already exist.
	 */
	private createTables(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS snapshots (
				id TEXT PRIMARY KEY,
				timestamp TEXT NOT NULL,
				filename TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				diff TEXT NOT NULL,
				lines_added INTEGER NOT NULL,
				lines_removed INTEGER NOT NULL,
				total_lines INTEGER NOT NULL,
				change_type TEXT NOT NULL,
				change_size INTEGER NOT NULL,
				chain_hash TEXT NOT NULL,
				session_id TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
			CREATE INDEX IF NOT EXISTS idx_snapshots_filename ON snapshots(filename);
			CREATE INDEX IF NOT EXISTS idx_snapshots_session_id ON snapshots(session_id);

			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL,
				project_name TEXT NOT NULL,
				files_touched TEXT NOT NULL,
				total_snapshots INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS flags (
				id TEXT PRIMARY KEY,
				category TEXT NOT NULL,
				severity TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				filename TEXT NOT NULL,
				description TEXT NOT NULL,
				snapshot_ids TEXT NOT NULL,
				suggested_context TEXT NOT NULL,
				student_context TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'acknowledged'
			);
		`);
	}

	/**
	 * Persists a snapshot to the database.
	 *
	 * @param snapshot - The snapshot to save
	 */
	saveSnapshot(snapshot: Snapshot): void {
		this.insertSnapshotStmt.run({
			id: snapshot.id,
			timestamp: snapshot.timestamp,
			filename: snapshot.filename,
			content_hash: snapshot.content_hash,
			diff: snapshot.diff,
			lines_added: snapshot.lines_added,
			lines_removed: snapshot.lines_removed,
			total_lines: snapshot.total_lines,
			change_type: snapshot.change_type,
			change_size: snapshot.change_size,
			chain_hash: snapshot.chain_hash,
			session_id: snapshot.session_id,
		});
	}

	/**
	 * Retrieves snapshots from the database with optional filters.
	 *
	 * @param options - Optional filters for filename, after, and before timestamps
	 * @returns An array of Snapshot objects matching the filters
	 */
	getSnapshots(options?: SnapshotQueryOptions): Snapshot[] {
		const conditions: string[] = [];
		const params: Record<string, string> = {};

		if (options?.filename) {
			conditions.push('filename = @filename');
			params.filename = options.filename;
		}
		if (options?.after) {
			conditions.push('timestamp > @after');
			params.after = options.after;
		}
		if (options?.before) {
			conditions.push('timestamp < @before');
			params.before = options.before;
		}
		if (options?.sessionId) {
			conditions.push('session_id = @sessionId');
			params.sessionId = options.sessionId;
		}

		const whereClause = conditions.length > 0
			? `WHERE ${conditions.join(' AND ')}`
			: '';

		const stmt = this.database.prepare(
			`SELECT * FROM snapshots ${whereClause} ORDER BY timestamp ASC`
		);

		return stmt.all(params) as Snapshot[];
	}

	/**
	 * Returns the total number of snapshots stored in the database.
	 *
	 * @returns The total snapshot count
	 */
	getSnapshotCount(): number {
		const row = this.getSnapshotCountStmt.get() as { count: number };
		return row.count;
	}

	/**
	 * Creates a new session record in the database.
	 *
	 * @param projectName - The name of the project/workspace
	 * @returns The newly created Session
	 */
	createSession(projectName: string): Session {
		const session: Session = {
			id: crypto.randomUUID(),
			started_at: new Date().toISOString(),
			ended_at: '',
			project_name: projectName,
			files_touched: [],
			total_snapshots: 0,
		};

		this.insertSessionStmt.run({
			id: session.id,
			started_at: session.started_at,
			ended_at: session.ended_at,
			project_name: session.project_name,
			files_touched: JSON.stringify(session.files_touched),
			total_snapshots: session.total_snapshots,
		});

		return session;
	}

	/**
	 * Ends an active session by setting its ended_at timestamp
	 * and updating final stats from stored snapshots.
	 *
	 * @param sessionId - The ID of the session to end
	 */
	endSession(sessionId: string): void {
		this.updateSessionEndStmt.run({
			id: sessionId,
			ended_at: new Date().toISOString(),
		});

		// Compute final stats from the stored snapshots
		const filesTouchedStmt = this.database.prepare(
			'SELECT DISTINCT filename FROM snapshots WHERE session_id = @sessionId'
		);
		const filesTouchedRows = filesTouchedStmt.all({ sessionId }) as { filename: string }[];
		const filesTouched = filesTouchedRows.map((row) => row.filename);

		const countStmt = this.database.prepare(
			'SELECT COUNT(*) AS count FROM snapshots WHERE session_id = @sessionId'
		);
		const countRow = countStmt.get({ sessionId }) as { count: number };

		this.updateSessionStatsStmt.run({
			id: sessionId,
			files_touched: JSON.stringify(filesTouched),
			total_snapshots: countRow.count,
		});
	}

	/**
	 * Returns the currently active (un-ended) session, if any.
	 *
	 * @returns The current Session or null if none is active
	 */
	getCurrentSession(): Session | null {
		const row = this.getCurrentSessionStmt.get() as Record<string, unknown> | undefined;
		if (!row) {
			return null;
		}

		return {
			id: row.id as string,
			started_at: row.started_at as string,
			ended_at: row.ended_at as string,
			project_name: row.project_name as string,
			files_touched: JSON.parse(row.files_touched as string) as string[],
			total_snapshots: row.total_snapshots as number,
		};
	}

	/**
	 * Returns the number of distinct files that have been tracked across
	 * all snapshots in the database.
	 *
	 * @returns The number of distinct files
	 */
	getDistinctFileCount(): number {
		const stmt = this.database.prepare(
			'SELECT COUNT(DISTINCT filename) AS count FROM snapshots'
		);
		const row = stmt.get() as { count: number };
		return row.count;
	}

	/**
	 * Verifies the integrity of the hash chain by recomputing each
	 * chain_hash from the previous snapshot's chain_hash, content_hash,
	 * and timestamp.
	 *
	 * @returns True if the chain is intact, false if tampered
	 */
	verifyHashChain(): boolean {
		const snapshots = this.database.prepare(
			'SELECT chain_hash, content_hash, timestamp FROM snapshots ORDER BY timestamp ASC'
		).all() as { chain_hash: string; content_hash: string; timestamp: string }[];

		let previousChainHash = '';
		for (const snapshot of snapshots) {
			const expectedHash = crypto
				.createHash('sha256')
				.update(previousChainHash + snapshot.content_hash + snapshot.timestamp)
				.digest('hex');

			if (expectedHash !== snapshot.chain_hash) {
				return false;
			}
			previousChainHash = snapshot.chain_hash;
		}

		return true;
	}

	/**
	 * Returns all sessions ordered by start time.
	 *
	 * @returns An array of Session objects
	 */
	getSessions(): Session[] {
		const rows = this.database.prepare(
			'SELECT * FROM sessions ORDER BY started_at ASC'
		).all() as Record<string, unknown>[];

		return rows.map((row) => ({
			id: row.id as string,
			started_at: row.started_at as string,
			ended_at: row.ended_at as string,
			project_name: row.project_name as string,
			files_touched: JSON.parse(row.files_touched as string) as string[],
			total_snapshots: row.total_snapshots as number,
		}));
	}

	/**
	 * Saves or updates a flag with student context and status.
	 *
	 * @param flag - The FlagWithContext to persist
	 */
	saveFlag(flag: FlagWithContext): void {
		const stmt = this.database.prepare(`
			INSERT OR REPLACE INTO flags (
				id, category, severity, timestamp, filename,
				description, snapshot_ids, suggested_context,
				student_context, status
			) VALUES (
				@id, @category, @severity, @timestamp, @filename,
				@description, @snapshot_ids, @suggested_context,
				@student_context, @status
			)
		`);

		stmt.run({
			id: flag.id,
			category: flag.category,
			severity: flag.severity,
			timestamp: flag.timestamp,
			filename: flag.filename,
			description: flag.description,
			snapshot_ids: JSON.stringify(flag.snapshotIds),
			suggested_context: flag.suggestedContext,
			student_context: flag.studentContext,
			status: flag.status,
		});
	}

	/**
	 * Retrieves all stored flags, optionally filtered by session's snapshots.
	 *
	 * @param sessionId - Optional session ID to filter flags by their associated snapshots
	 * @returns Array of FlagWithContext objects
	 */
	getFlags(sessionId?: string): FlagWithContext[] {
		let rows: Record<string, unknown>[];

		if (sessionId) {
			// Get snapshot IDs for this session, then filter flags that reference them
			const snapshotRows = this.database.prepare(
				'SELECT id FROM snapshots WHERE session_id = @sessionId'
			).all({ sessionId }) as { id: string }[];
			const snapshotIdSet = new Set(snapshotRows.map((row) => row.id));

			const allFlags = this.database.prepare(
				'SELECT * FROM flags ORDER BY timestamp ASC'
			).all() as Record<string, unknown>[];

			rows = allFlags.filter((row) => {
				const ids = JSON.parse(row.snapshot_ids as string) as string[];
				return ids.some((flagId) => snapshotIdSet.has(flagId));
			});
		} else {
			rows = this.database.prepare(
				'SELECT * FROM flags ORDER BY timestamp ASC'
			).all() as Record<string, unknown>[];
		}

		return rows.map((row) => ({
			id: row.id as string,
			category: row.category as FlagWithContext['category'],
			severity: row.severity as FlagWithContext['severity'],
			timestamp: row.timestamp as string,
			filename: row.filename as string,
			description: row.description as string,
			snapshotIds: JSON.parse(row.snapshot_ids as string) as string[],
			suggestedContext: row.suggested_context as string,
			studentContext: row.student_context as string,
			status: row.status as FlagWithContext['status'],
		}));
	}

	/**
	 * Closes the SQLite database connection.
	 * Must be called when the storage is no longer needed.
	 */
	close(): void {
		this.database.close();
		console.log('[CodeProof] Storage closed.');
	}

	/**
	 * Disposes the storage by closing the database connection.
	 * Implements vscode.Disposable.
	 */
	dispose(): void {
		this.close();
	}
}

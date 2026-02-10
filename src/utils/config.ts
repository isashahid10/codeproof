import * as vscode from 'vscode';

/** Typed representation of all CodeProof configuration settings */
export interface CodeProofConfig {
	/** Seconds between snapshots (default: 30) */
	snapshotInterval: number;
	/** Character threshold to classify a change as a paste (default: 50) */
	pasteThreshold: number;
	/** Glob patterns for files to exclude from tracking */
	excludePatterns: string[];
	/** Whether to automatically start recording when a workspace opens */
	autoStart: boolean;
	/** Directory name for CodeProof data, relative to workspace root */
	storageLocation: string;
}

/** Callback type for configuration change events */
export type ConfigChangeListener = (config: CodeProofConfig) => void;

/**
 * Manages reading and live-updating of CodeProof VS Code settings.
 * Listens for configuration changes and notifies subscribers so the
 * engine can adapt (e.g. restart its timer with a new interval).
 *
 * Implements vscode.Disposable for cleanup.
 */
export class ConfigManager implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<CodeProofConfig>();

	/** Fires when any CodeProof configuration setting changes */
	public readonly onConfigChange: vscode.Event<CodeProofConfig> = this.changeEmitter.event;

	private readonly disposable: vscode.Disposable;

	/**
	 * Creates a new ConfigManager and starts listening for setting changes.
	 */
	constructor() {
		this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('codeproof')) {
				this.changeEmitter.fire(this.getConfig());
			}
		});
	}

	/**
	 * Returns the current snapshot of all CodeProof settings.
	 *
	 * @returns A typed CodeProofConfig object
	 */
	getConfig(): CodeProofConfig {
		const config = vscode.workspace.getConfiguration('codeproof');

		return {
			snapshotInterval: config.get<number>('snapshotInterval', 30),
			pasteThreshold: config.get<number>('pasteThreshold', 50),
			excludePatterns: config.get<string[]>('excludePatterns', [
				'**/node_modules/**',
				'**/.git/**',
				'**/dist/**',
			]),
			autoStart: config.get<boolean>('autoStart', true),
			storageLocation: config.get<string>('storageLocation', '.codeproof'),
		};
	}

	/** @returns Snapshot interval in seconds */
	get snapshotInterval(): number {
		return this.getConfig().snapshotInterval;
	}

	/** @returns Paste detection threshold in characters */
	get pasteThreshold(): number {
		return this.getConfig().pasteThreshold;
	}

	/** @returns Array of glob patterns to exclude */
	get excludePatterns(): string[] {
		return this.getConfig().excludePatterns;
	}

	/** @returns Whether auto-start is enabled */
	get autoStart(): boolean {
		return this.getConfig().autoStart;
	}

	/** @returns Storage directory name */
	get storageLocation(): string {
		return this.getConfig().storageLocation;
	}

	/**
	 * Disposes the configuration change listener and event emitter.
	 */
	dispose(): void {
		this.disposable.dispose();
		this.changeEmitter.dispose();
	}
}

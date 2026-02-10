import { GoogleGenerativeAI } from '@google/generative-ai';
import { Snapshot, Flag, FlagWithContext } from '../snapshot/types.js';

/** Result from AI confidence score analysis */
export interface ConfidenceResult {
	/** Score from 0 to 100 */
	score: number;
	/** Brief justification for the score */
	justification: string;
}

/** Interface for AI-powered report narrative generation */
export interface AIProvider {
	/**
	 * Generates a development narrative describing how the code was written.
	 *
	 * @param snapshots - Array of snapshots to analyse
	 * @param studentName - Optional student name for third-person narrative
	 * @param assignmentName - Optional assignment name for context
	 * @param flags - Optional flags with context to weave into the narrative
	 * @returns The narrative text, or empty string on failure
	 */
	generateNarrative(
		snapshots: Snapshot[],
		studentName?: string,
		assignmentName?: string,
		flags?: FlagWithContext[]
	): Promise<string>;

	/**
	 * Generates analysis of flagged events, assessing severity and suggesting explanations.
	 *
	 * @param snapshots - Array of snapshots for context
	 * @param flags - Array of flags to analyse
	 * @returns Analysis text, or empty string on failure
	 */
	generateFlagAnalysis(
		snapshots: Snapshot[],
		flags: Flag[]
	): Promise<string>;

	/**
	 * Generates an authenticity confidence score based on development patterns.
	 *
	 * @param snapshots - Array of snapshots to analyse
	 * @returns Score (0-100) with justification, or score 0 on failure
	 */
	generateConfidenceScore(
		snapshots: Snapshot[]
	): Promise<ConfidenceResult>;
}

/**
 * Gemini-powered AI provider using the @google/generative-ai SDK.
 * Uses the gemini-2.0-flash model for fast, cost-effective analysis.
 */
export class GeminiProvider implements AIProvider {
	private readonly model;
	/** Timestamp of last API call for rate limiting */
	private lastCallTime = 0;
	/** Minimum delay between API calls in milliseconds */
	private static readonly RATE_LIMIT_DELAY_MS = 1000;

	/**
	 * Creates a new GeminiProvider.
	 *
	 * @param apiKey - The Gemini API key
	 */
	constructor(apiKey: string) {
		const genAI = new GoogleGenerativeAI(apiKey);
		this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
	}

	/**
	 * Enforces a minimum delay between consecutive API calls.
	 */
	private async rateLimit(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastCallTime;
		if (elapsed < GeminiProvider.RATE_LIMIT_DELAY_MS) {
			const delay = GeminiProvider.RATE_LIMIT_DELAY_MS - elapsed;
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
		this.lastCallTime = Date.now();
	}

	/**
	 * Builds a concise summary of snapshots for the AI prompt.
	 *
	 * @param snapshots - Array of snapshots to summarise
	 * @returns A text summary of development activity
	 */
	private buildSnapshotSummary(snapshots: Snapshot[]): string {
		const lines: string[] = [];
		lines.push(`Total snapshots: ${snapshots.length}`);

		const files = new Set(snapshots.map((snap) => snap.filename));
		lines.push(`Files: ${Array.from(files).join(', ')}`);

		const pasteCount = snapshots.filter((snap) => snap.change_type === 'paste').length;
		const typingCount = snapshots.filter((snap) => snap.change_type === 'typing').length;
		const deleteCount = snapshots.filter((snap) => snap.change_type === 'delete').length;
		const refactorCount = snapshots.filter((snap) => snap.change_type === 'refactor').length;
		lines.push(`Change types: ${typingCount} typing, ${pasteCount} paste, ${deleteCount} delete, ${refactorCount} refactor`);

		const totalAdded = snapshots.reduce((sum, snap) => sum + snap.lines_added, 0);
		const totalRemoved = snapshots.reduce((sum, snap) => sum + snap.lines_removed, 0);
		lines.push(`Total lines added: ${totalAdded}, removed: ${totalRemoved}`);

		lines.push('');
		lines.push('Timeline (chronological):');

		// Include up to 100 entries to keep prompt size reasonable
		const step = Math.max(1, Math.floor(snapshots.length / 100));
		for (let i = 0; i < snapshots.length; i += step) {
			const snap = snapshots[i];
			const time = new Date(snap.timestamp).toLocaleString();
			lines.push(
				`  ${time} | ${snap.filename} | ${snap.change_type} | +${snap.lines_added}/-${snap.lines_removed} | ${snap.change_size} chars`
			);
		}

		return lines.join('\n');
	}

	/** @inheritdoc */
	async generateNarrative(
		snapshots: Snapshot[],
		studentName?: string,
		assignmentName?: string,
		flags?: FlagWithContext[]
	): Promise<string> {
		if (snapshots.length === 0) {
			return '';
		}

		try {
			await this.rateLimit();

			const summary = this.buildSnapshotSummary(snapshots);
			const name = studentName || 'The student';
			const assignment = assignmentName ? ` for "${assignmentName}"` : '';

			let flagContext = '';
			if (flags && flags.length > 0) {
				const flagDescriptions = flags.map((flag, index) => {
					const studentExplanation = flag.studentContext
						? `Student's explanation: "${flag.studentContext}"`
						: 'No explanation provided';
					return `  Flag ${index + 1}: [${flag.severity.toUpperCase()}] ${flag.category} at ${flag.timestamp} — ${flag.description}. ${studentExplanation}`;
				}).join('\n');

				flagContext = `

The following flags were detected in the development history. If the student provided context, reference it naturally in the narrative (e.g. "A paste event at 3:15 PM was noted by the student as originating from lecture materials..."):
${flagDescriptions}`;
			}

			const prompt = `You are analysing a student's coding development history${assignment}. Write a professional narrative describing how ${name} developed their code. The data below shows timestamped snapshots of their coding activity.

Rules:
- Write in third person ("The student..." or "${name}...")
- Describe development chronologically
- Highlight iterative patterns: debugging, trial-and-error, refactoring
- Note paste events and what happened after (did the student modify pasted code?)
- Mention time gaps, session breaks, and work distribution
- Describe the student's problem-solving approach
- Keep it under 500 words, professional academic tone
- Do NOT invent details not supported by the data${flagContext}

Development data:
${summary}`;

			const result = await this.model.generateContent(prompt);
			const response = result.response;
			return response.text();
		} catch (error) {
			console.error('[CodeProof] Gemini narrative generation failed:', error);
			return '';
		}
	}

	/** @inheritdoc */
	async generateFlagAnalysis(
		snapshots: Snapshot[],
		flags: Flag[]
	): Promise<string> {
		if (flags.length === 0) {
			return 'No flags detected.';
		}

		try {
			await this.rateLimit();

			const summary = this.buildSnapshotSummary(snapshots);
			const flagDescriptions = flags.map((flag, index) => {
				return `Flag ${index + 1}: [${flag.severity.toUpperCase()}] ${flag.category} — ${flag.description} (at ${flag.timestamp})`;
			}).join('\n');

			const prompt = `You are reviewing flagged events in a student's coding development history. Assess each flag and provide recommendations.

Rules:
- Review each flag and assess its actual severity
- Suggest which flags need explanation from the student and which are benign
- Provide recommended context/explanation wording for each flag
- Be fair — many flags have innocent explanations
- Keep your analysis concise and professional

Development data:
${summary}

Flags:
${flagDescriptions}`;

			const result = await this.model.generateContent(prompt);
			const response = result.response;
			return response.text();
		} catch (error) {
			console.error('[CodeProof] Gemini flag analysis failed:', error);
			return '';
		}
	}

	/** @inheritdoc */
	async generateConfidenceScore(
		snapshots: Snapshot[]
	): Promise<ConfidenceResult> {
		if (snapshots.length === 0) {
			return { score: 0, justification: 'No development data available.' };
		}

		try {
			await this.rateLimit();

			const summary = this.buildSnapshotSummary(snapshots);

			const prompt = `You are analysing a student's coding development patterns to assess authenticity. Based on the development data below, provide a confidence score from 0-100 indicating how likely the code was authentically developed by the student.

Consider:
- Progression pattern (gradual vs sudden)
- Debugging iterations (corrections, backtracking)
- Paste ratio (high paste ratio is suspicious)
- Time distribution (spread across sessions vs all at once)
- Typing patterns (natural editing vs bulk insertions)

IMPORTANT: You MUST respond in EXACTLY this JSON format, nothing else:
{"score": <number 0-100>, "justification": "<brief justification under 100 words>"}

Development data:
${summary}`;

			const result = await this.model.generateContent(prompt);
			const response = result.response;
			const text = response.text().trim();

			// Extract JSON from response (handle markdown code blocks)
			const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*"justification"[\s\S]*\}/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]) as { score: number; justification: string };
				const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
				return { score, justification: parsed.justification };
			}

			console.error('[CodeProof] Failed to parse confidence score response:', text);
			return { score: 0, justification: 'Unable to generate confidence score.' };
		} catch (error) {
			console.error('[CodeProof] Gemini confidence score generation failed:', error);
			return { score: 0, justification: 'AI analysis unavailable.' };
		}
	}
}

/**
 * Fallback provider that returns empty/zero values.
 * Used when no AI provider is configured.
 */
export class NoAIProvider implements AIProvider {
	/** @inheritdoc */
	async generateNarrative(): Promise<string> {
		return '';
	}

	/** @inheritdoc */
	async generateFlagAnalysis(): Promise<string> {
		return '';
	}

	/** @inheritdoc */
	async generateConfidenceScore(): Promise<ConfidenceResult> {
		return { score: 0, justification: '' };
	}
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Finds the Chrome or Chromium executable on the system.
 * Checks common installation paths for macOS, Windows, and Linux.
 *
 * @returns The absolute path to the Chrome executable, or undefined if not found
 */
export function findChromePath(): string | undefined {
	const platform = os.platform();

	const candidates: string[] = [];

	if (platform === 'darwin') {
		candidates.push(
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
			'/Applications/Chromium.app/Contents/MacOS/Chromium',
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
		);
	} else if (platform === 'win32') {
		const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
		const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
		const localAppData = process.env.LOCALAPPDATA || '';

		candidates.push(
			path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
		);
	} else {
		candidates.push(
			'/usr/bin/google-chrome',
			'/usr/bin/google-chrome-stable',
			'/usr/bin/chromium',
			'/usr/bin/chromium-browser',
			'/snap/bin/chromium',
			'/usr/bin/microsoft-edge',
		);
	}

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} catch {
			// Skip inaccessible paths
		}
	}

	return undefined;
}

/**
 * Converts a self-contained HTML report string into a PDF buffer
 * using puppeteer-core with the system Chrome installation.
 *
 * @param html - The full HTML report string
 * @param chromePath - Path to the Chrome executable
 * @returns A Buffer containing the PDF data
 * @throws If Chrome cannot be launched or PDF generation fails
 */
export async function generatePDF(html: string, chromePath: string): Promise<Buffer> {
	const puppeteer = await import('puppeteer-core');

	const browser = await puppeteer.launch({
		executablePath: chromePath,
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
	});

	try {
		const page = await browser.newPage();
		await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });

		const pdfBuffer = await page.pdf({
			format: 'A4',
			printBackground: true,
			margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
		});

		return Buffer.from(pdfBuffer);
	} finally {
		await browser.close();
	}
}

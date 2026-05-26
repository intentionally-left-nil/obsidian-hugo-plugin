import type { TFile, TFolder } from 'obsidian';
import { IMAGE_EXTENSIONS } from './paths';

/**
 * Adapter interface so `addImage` functions can be exercised in unit tests
 * without a live Obsidian `App`.
 */
export interface AddImageAdapter {
	/** Ensure the images/ subfolder exists, creating it if necessary. Returns its vault path. */
	ensureImagesFolder(post: TFile): Promise<string>;
	/** Return true if the given vault path already exists. */
	fileExists(path: string): boolean;
	/** Write binary data to a vault path and return the created TFile. */
	createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
	/** Fetch a remote URL without CORS restrictions. */
	requestUrl(opts: { url: string }): Promise<{
		status: number;
		arrayBuffer: ArrayBuffer;
		headers: Record<string, string>;
	}>;
}

/**
 * Sanitize a candidate filename:
 * - Percent-decode.
 * - Strip any directory components (take only the basename).
 * - Replace runs of whitespace or characters illegal on common filesystems with `-`.
 * - Lower-case the extension.
 * - If no extension or extension not in IMAGE_EXTENSIONS, return null (caller
 *   must supply or derive an extension separately).
 */
export function sanitizeFilename(raw: string): string | null {
	// Percent-decode (best-effort; ignore malformed sequences).
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// keep raw
	}

	// Take only the basename (strip path separators).
	const parts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
	const basename = parts[parts.length - 1] ?? '';
	if (!basename) return null;

	// Split on the last `.` to isolate extension.
	const dotIdx = basename.lastIndexOf('.');
	const stem = dotIdx > 0 ? basename.slice(0, dotIdx) : basename;
	const rawExt = dotIdx > 0 ? basename.slice(dotIdx + 1) : '';
	const ext = rawExt.toLowerCase();

	if (!ext || !IMAGE_EXTENSIONS.has(ext)) return null;

	// Sanitize the stem: replace illegal / problematic chars with `-`.
	const cleanStem = stem
		.replace(/[/\\:*?"<>|]/g, '-')   // filesystem-illegal chars
		.replace(/\s+/g, '-')             // whitespace runs
		.replace(/-{2,}/g, '-')           // collapse multiple dashes
		.replace(/^-+|-+$/g, '')          // trim leading/trailing dashes
		|| 'image';                        // fallback if stem becomes empty

	return `${cleanStem}.${ext}`;
}

/**
 * Map a MIME content-type to a file extension, or null if not a known image type.
 */
export function inferExtFromContentType(contentType: string): string | null {
	const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
	const map: Record<string, string> = {
		'image/jpeg': 'jpg',
		'image/jpg': 'jpg',
		'image/png': 'png',
		'image/gif': 'gif',
		'image/webp': 'webp',
		'image/avif': 'avif',
		'image/svg+xml': 'svg',
	};
	return map[mime] ?? null;
}

/**
 * Derive a safe filename from a URL (path segment) and a Content-Type header.
 * Returns null if neither yields a usable name.
 */
export function inferFilenameFromUrl(url: string, contentType: string): string | null {
	let pathPart = '';
	try {
		pathPart = new URL(url).pathname;
	} catch {
		pathPart = url;
	}

	// Take the last non-empty path segment.
	const segments = pathPart.split('/').filter(Boolean);
	const tailRaw = segments[segments.length - 1] ?? '';

	// Strip query params from tail (URL constructor already handles pathname
	// but guard for edge cases).
	const tailClean = (tailRaw.split('?')[0] ?? '').split('#')[0] ?? '';

	// Try sanitizing as-is first.
	const fromPath = tailClean ? sanitizeFilename(tailClean) : null;
	if (fromPath) return fromPath;

	// The path didn't give us a usable extension — try Content-Type.
	const ext = inferExtFromContentType(contentType);
	if (!ext) return null;

	// Build a name from the tail stem + inferred extension.
	const stem = tailClean ? tailClean.replace(/\.[^.]*$/, '') || 'image' : 'image';
	const withExt = `${stem}.${ext}`;
	return sanitizeFilename(withExt);
}

/**
 * Given a desired filename, find a name that doesn't collide with existing
 * files in the images folder. Tries `name.ext`, `name-2.ext`, `name-3.ext`, …
 */
export function pickUniqueName(folderPath: string, filename: string, exists: (path: string) => boolean): string {
	const dotIdx = filename.lastIndexOf('.');
	const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
	const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';

	const candidate = (n: number) =>
		`${folderPath}/${n === 1 ? filename : `${stem}-${n}${ext}`}`;

	for (let n = 1; n <= 1000; n++) {
		if (!exists(candidate(n))) return candidate(n);
	}
	// Extremely unlikely — fall back to a random suffix.
	const rand = Math.random().toString(36).slice(2, 8);
	return `${folderPath}/${stem}-${rand}${ext}`;
}

/**
 * Copy a local `File` (from a file-input element) into the post's images/
 * folder and return the resulting TFile.
 */
export async function addImageFromFile(
	adapter: AddImageAdapter,
	post: TFile,
	file: File,
): Promise<TFile> {
	const sanitized = sanitizeFilename(file.name);
	if (!sanitized) {
		throw new Error(`Unsupported image type: "${file.name}"`);
	}

	const folderPath = await adapter.ensureImagesFolder(post);
	const targetPath = pickUniqueName(folderPath, sanitized, adapter.fileExists);
	const data = await file.arrayBuffer();
	return adapter.createBinary(targetPath, data);
}

/**
 * Download a remote image URL into the post's images/ folder and return the
 * resulting TFile.
 *
 * @param filename Optional explicit filename (from user input). If omitted,
 *   it is derived from the URL path and the response Content-Type.
 */
export async function addImageFromUrl(
	adapter: AddImageAdapter,
	post: TFile,
	url: string,
	filename?: string,
): Promise<TFile> {
	const response = await adapter.requestUrl({ url });

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Download failed (HTTP ${response.status})`);
	}

	const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
	if (!contentType.toLowerCase().startsWith('image/')) {
		throw new Error(`Unsupported image type: server returned "${contentType}"`);
	}

	let resolvedName: string | null = null;

	if (filename && filename.trim()) {
		// User supplied an explicit filename — sanitize it, then add extension
		// from Content-Type if missing.
		const trimmed = filename.trim();
		const hasDot = trimmed.includes('.');
		const candidate = hasDot ? trimmed : `${trimmed}.${inferExtFromContentType(contentType) ?? ''}`;
		resolvedName = sanitizeFilename(candidate);
	}

	if (!resolvedName) {
		resolvedName = inferFilenameFromUrl(url, contentType);
	}

	if (!resolvedName) {
		throw new Error('Could not determine a filename for this image.');
	}

	const folderPath = await adapter.ensureImagesFolder(post);
	const targetPath = pickUniqueName(folderPath, resolvedName, adapter.fileExists);
	return adapter.createBinary(targetPath, response.arrayBuffer);
}

import { TFile, TFolder } from 'obsidian';

export const IMAGE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'svg',
]);

/**
 * Return true if the given file is the `index.md` of a Hugo blog post: it is
 * named `index.md` AND its parent folder contains an `images/` subfolder.
 */
export function isHugoPost(file: TFile | null): file is TFile {
	if (!file) return false;
	if (file.name !== 'index.md') return false;
	const parent = file.parent;
	if (!parent) return false;
	return parent.children.some(
		(child) => child instanceof TFolder && child.name === 'images',
	);
}

export function getImagesFolder(post: TFile): TFolder | null {
	const parent = post.parent;
	if (!parent) return null;
	for (const child of parent.children) {
		if (child instanceof TFolder && child.name === 'images') return child;
	}
	return null;
}

export function listImageFiles(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && isImageFile(child)) out.push(child);
	}
	out.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

export function isImageFile(file: TFile): boolean {
	const ext = file.extension?.toLowerCase();
	return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

/**
 * Resolve a shortcode's `src` value (relative path like `images/foo.png`) to
 * a vault-absolute path, given the post's folder. Returns null for absolute
 * URLs (`http://`, `https://`, `data:`). Does not validate that the file
 * exists. Normalises `..` and `.` segments.
 */
export function resolveSrcToVaultPath(src: string, postFolderPath: string): string | null {
	if (isExternalUrl(src)) return null;
	let trimmed = src;
	if (trimmed.startsWith('/')) {
		// Absolute paths are vault-relative for our purposes; strip leading `/`.
		return normaliseSegments(trimmed.slice(1));
	}
	const base = postFolderPath === '' || postFolderPath === '/' ? '' : postFolderPath;
	const joined = base ? `${base}/${trimmed}` : trimmed;
	return normaliseSegments(joined);
}

function normaliseSegments(path: string): string {
	const out: string[] = [];
	const segments = path.split('/');
	for (const seg of segments) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (out.length === 0) {
				// Path escapes vault root — preserve `..` segments to make this detectable.
				out.push('..');
			} else if (out[out.length - 1] === '..') {
				out.push('..');
			} else {
				out.pop();
			}
			continue;
		}
		out.push(seg);
	}
	return out.join('/');
}

export function isExternalUrl(src: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//');
}

/**
 * Returns true if `src`, when resolved against the post folder, refers to a
 * file located inside the post's bundle (i.e. inside or under
 * `<postFolder>/`).
 */
export function isInsidePostBundle(src: string, postFolderPath: string): boolean {
	if (isExternalUrl(src)) return false;
	const resolved = resolveSrcToVaultPath(src, postFolderPath);
	if (resolved === null) return false;
	if (resolved.startsWith('..')) return false;
	if (postFolderPath === '' || postFolderPath === '/') return !resolved.includes('..');
	return resolved === postFolderPath || resolved.startsWith(`${postFolderPath}/`);
}

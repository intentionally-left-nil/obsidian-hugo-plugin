/**
 * Reads Hugo category metadata from the on-disk `category/` directory that
 * lives one level above the vault root (i.e. the Hugo site root).
 *
 * Each category is a subfolder containing an `_index.md` whose frontmatter
 * carries the display `title` and `url` prefix:
 *
 *   category/technology/_index.md:
 *   ---
 *   title: Technology
 *   url: /category/tech/
 *   ---
 *
 * The `urlPrefix` stored in `CategoryEntry` is the normalised form of that
 * `url` value (always starts and ends with `/`).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CategoryEntry {
	/** Folder name on disk, e.g. `technology`. */
	slug: string;
	/** Display title from `_index.md` frontmatter, e.g. `Technology`. */
	title: string;
	/**
	 * URL prefix including trailing slash, e.g. `/category/tech/`.
	 * New posts in this category use: `urlPrefix + postSlug + '/'`.
	 */
	urlPrefix: string;
}

// ---------------------------------------------------------------------------
// Adapter (for testability)
// ---------------------------------------------------------------------------

export interface CategoryFsAdapter {
	/** Return the names of sub-directories inside `dir`. */
	listSubfolders(dir: string): Promise<string[]>;
	/** Read a text file; return null if it does not exist. */
	readFile(filePath: string): Promise<string | null>;
}

/** Default adapter that delegates to the real Node `fs` module. */
export function makeNodeFsAdapter(): CategoryFsAdapter {
	return {
		async listSubfolders(dir: string): Promise<string[]> {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return [];
			}
			return entries
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort();
		},
		async readFile(filePath: string): Promise<string | null> {
			try {
				return await fs.promises.readFile(filePath, 'utf8');
			} catch {
				return null;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all categories from the on-disk `<vaultBasePath>/../category/`
 * directory.  Returns an empty array (not an error) if the directory does not
 * exist or cannot be read.
 */
export async function loadCategoriesFromDisk(
	vaultBasePath: string,
	adapter: CategoryFsAdapter = makeNodeFsAdapter(),
): Promise<CategoryEntry[]> {
	const categoryDir = path.join(vaultBasePath, '..', 'category');
	const slugs = await adapter.listSubfolders(categoryDir);

	const entries: CategoryEntry[] = [];
	for (const slug of slugs) {
		const indexPath = path.join(categoryDir, slug, '_index.md');
		const content = await adapter.readFile(indexPath);
		const meta = parseIndexFrontmatter(content);

		const title = meta.title ?? capitalise(slug);
		const urlPrefix = normaliseUrlPrefix(meta.url ?? `/category/${slug}/`);

		entries.push({ slug, title, urlPrefix });
	}

	return entries.sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface IndexMeta {
	title: string | null;
	url: string | null;
}

/**
 * Tiny inline YAML frontmatter reader.  Only looks at the leading `---…---`
 * block and extracts `title:` and `url:` scalar values.  Not a general YAML
 * parser — just enough for `_index.md` files.
 */
function parseIndexFrontmatter(content: string | null): IndexMeta {
	const result: IndexMeta = { title: null, url: null };
	if (!content) return result;

	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match?.[1]) return result;

	const block = match[1];
	for (const line of block.split(/\r?\n/)) {
		const kv = /^(title|url):\s*(.+)$/.exec(line.trim());
		if (!kv?.[1] || !kv[2]) continue;
		const key = kv[1] as 'title' | 'url';
		// Strip surrounding quotes if any.
		const value = kv[2].replace(/^['"]|['"]$/g, '').trim();
		result[key] = value;
	}

	return result;
}

function normaliseUrlPrefix(raw: string): string {
	let s = raw.trim();
	if (!s.startsWith('/')) s = '/' + s;
	if (!s.endsWith('/')) s = s + '/';
	return s;
}

function capitalise(s: string): string {
	if (s.length === 0) return s;
	const first = s[0];
	return (first !== undefined ? first.toUpperCase() : '') + s.slice(1);
}

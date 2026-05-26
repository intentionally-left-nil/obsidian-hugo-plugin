/**
 * Creates a new Hugo blog post (folder + images/ subfolder + index.md) in the
 * vault root.
 *
 * The vault root is the Hugo `posts/` directory, so new post folders are
 * created directly at the top level: `<slug>/index.md`.
 *
 * The URL is derived from the last segment of the category's `urlPrefix`:
 *   category urlPrefix `/category/tech/`  →  last segment `tech`
 *   post url  `/tech/<post-slug>/`
 */

import type { TFile } from 'obsidian';
import type { CategoryEntry } from './categories';
import { formatBlogFrontmatter, formatHugoDate, slugify } from './blog-frontmatter';

// ---------------------------------------------------------------------------
// Adapter (for testability — mirrors the pattern in add-image.ts)
// ---------------------------------------------------------------------------

export interface CreateBlogAdapter {
	folderExists(path: string): boolean;
	createFolder(path: string): Promise<void>;
	createFile(path: string, contents: string): Promise<TFile>;
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class DuplicatePostError extends Error {
	constructor(slug: string) {
		super(`A post folder named "${slug}" already exists.`);
		this.name = 'DuplicatePostError';
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateBlogOptions {
	title: string;
	category: CategoryEntry;
	/** Defaults to `new Date()` when omitted. */
	now?: Date;
}

/**
 * Scaffold a new Hugo blog post under the vault root.
 *
 * Produces:
 *   <slug>/
 *     images/       ← makes isHugoPost() return true immediately
 *     index.md      ← pre-filled frontmatter
 *
 * Returns the newly created `index.md` TFile.
 * Throws `DuplicatePostError` if a folder with the same slug already exists.
 */
export async function createBlogPost(
	adapter: CreateBlogAdapter,
	opts: CreateBlogOptions,
): Promise<TFile> {
	const slug = slugify(opts.title);
	if (!slug) throw new Error('Title produces an empty slug — please use a different title.');

	if (adapter.folderExists(slug)) throw new DuplicatePostError(slug);

	const url = `/${postUrlSegment(opts.category.urlPrefix)}${slug}/`;
	const now = opts.now ?? new Date();

	const frontmatter = formatBlogFrontmatter({
		title: opts.title,
		dateIso: formatHugoDate(now),
		url,
		categories: [opts.category.slug],
		tags: [],
	});

	await adapter.createFolder(slug);
	await adapter.createFolder(`${slug}/images`);
	return adapter.createFile(`${slug}/index.md`, frontmatter);
}

/**
 * Extract the last non-empty path segment from a URL prefix.
 * `/category/tech/`  →  `tech/`
 * `/tech/`           →  `tech/`
 */
function postUrlSegment(urlPrefix: string): string {
	const parts = urlPrefix.split('/').filter((p) => p.length > 0);
	const last = parts[parts.length - 1];
	return last ? `${last}/` : '';
}

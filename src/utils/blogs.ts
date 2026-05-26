/**
 * Builds the list of Hugo blog posts that appear in the blogs view.
 * All vault I/O is done through the Obsidian `App` instance so this module
 * stays compatible with the existing plugin architecture.
 */

import type { App, TFolder } from 'obsidian';
import { TFile } from 'obsidian';
import { isHugoPost } from './paths';
import { parseBlogFrontmatter } from './blog-frontmatter';
import { resolveSrcToVaultPath } from './paths';

export interface BlogSummary {
	file: TFile;
	folder: TFolder;
	title: string;
	/** Parsed from frontmatter `date`; null if missing or unparsable. */
	date: Date | null;
	url: string | null;
	/** From frontmatter `category` / `categories`. */
	categorySlugs: string[];
	/** From frontmatter `tag` / `tags`. */
	tags: string[];
	/** Resolved vault file for `cover.src`; null when absent or unresolvable. */
	coverFile: TFile | null;
	/** Raw `cover.src` value as written in frontmatter. */
	coverSrc: string | null;
	coverAlt: string;
	draft: boolean;
}

/**
 * Scan the entire vault for Hugo posts and return a `BlogSummary` for each.
 * Order is not guaranteed — use `sortBlogsByDate` afterwards.
 */
export function listHugoPosts(app: App): BlogSummary[] {
	const summaries: BlogSummary[] = [];

	for (const file of app.vault.getMarkdownFiles()) {
		if (!isHugoPost(file)) continue;

		const folder = file.parent;
		if (!folder) continue;

		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const parsed = parseBlogFrontmatter(fm);

		let coverFile: TFile | null = null;
		if (parsed.cover.src) {
			const vaultPath = resolveSrcToVaultPath(parsed.cover.src, folder.path);
			if (vaultPath) {
				const resolved = app.vault.getFileByPath(vaultPath);
				coverFile = resolved ?? null;
			}
		}

		summaries.push({
			file,
			folder,
			title: parsed.title ?? folder.name,
			date: parsed.date,
			url: parsed.url,
			categorySlugs: parsed.categories,
			tags: parsed.tags,
			coverFile,
			coverSrc: parsed.cover.src,
			coverAlt: parsed.cover.alt ?? '',
			draft: parsed.draft,
		});
	}

	return summaries;
}

/**
 * Sort blogs newest-first by frontmatter `date`.
 * Posts with no date sink to the bottom, tiebroken by folder name ascending.
 */
export function sortBlogsByDate(blogs: BlogSummary[]): BlogSummary[] {
	return [...blogs].sort((a, b) => {
		if (a.date && b.date) {
			const diff = b.date.getTime() - a.date.getTime();
			if (diff !== 0) return diff;
			return a.folder.name.localeCompare(b.folder.name);
		}
		if (a.date) return -1;
		if (b.date) return 1;
		return a.folder.name.localeCompare(b.folder.name);
	});
}

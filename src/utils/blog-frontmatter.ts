/**
 * Pure helpers for parsing and emitting Hugo blog post frontmatter in the
 * specific format used by this vault:
 *
 *   ---
 *   title: My Post Title
 *   date: '2024-09-02T21:33:09+00:00'
 *   url: /category/tech/my-post-title/
 *   category:
 *   - technology
 *   tag: []
 *   ---
 */

export interface BlogFrontmatter {
	title: string | null;
	date: Date | null;
	url: string | null;
	/** Normalised from `category` or `categories` (both are accepted on read). */
	categories: string[];
	/** Normalised from `tag` or `tags` (both are accepted on read). */
	tags: string[];
	cover: { src: string | null; alt: string | null };
	draft: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extract blog metadata from a raw frontmatter object as returned by
 * Obsidian's `metadataCache.getFileCache(file)?.frontmatter`.
 */
export function parseBlogFrontmatter(
	fm: Record<string, unknown> | undefined,
): BlogFrontmatter {
	if (!fm) {
		return {
			title: null,
			date: null,
			url: null,
			categories: [],
			tags: [],
			cover: { src: null, alt: null },
			draft: false,
		};
	}

	return {
		title: stringOrNull(fm['title']),
		date: parseDateField(fm['date']),
		url: stringOrNull(fm['url']),
		categories: toStringArray(fm['category'] ?? fm['categories']),
		tags: toStringArray(fm['tag'] ?? fm['tags']),
		cover: parseCover(fm['cover']),
		draft: fm['draft'] === true,
	};
}

function stringOrNull(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseDateField(v: unknown): Date | null {
	if (!v) return null;
	const d = new Date(String(v));
	return isNaN(d.getTime()) ? null : d;
}

function toStringArray(v: unknown): string[] {
	if (!v) return [];
	if (typeof v === 'string') return v.length > 0 ? [v] : [];
	if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.length > 0) as string[];
	return [];
}

function parseCover(v: unknown): { src: string | null; alt: string | null } {
	if (!v || typeof v !== 'object') return { src: null, alt: null };
	const obj = v as Record<string, unknown>;
	return {
		src: stringOrNull(obj['src']),
		alt: stringOrNull(obj['alt']),
	};
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

export interface EmitOptions {
	title: string;
	dateIso: string;
	url: string;
	categories: string[];
	tags: string[];
}

/**
 * Produce a full frontmatter block (including the opening and closing `---`
 * delimiters) matching the vault's house style, followed by a single blank
 * line ready for the post body.
 *
 * Output example:
 *   ---
 *   title: My Post Title
 *   date: '2024-09-02T21:33:09+00:00'
 *   url: /category/tech/my-post-title/
 *   category:
 *   - technology
 *   tag: []
 *   ---
 *
 * (Followed by a trailing newline so the caller can concatenate the body.)
 */
export function formatBlogFrontmatter(opts: EmitOptions): string {
	const lines: string[] = ['---'];

	lines.push(`title: ${opts.title}`);
	lines.push(`date: '${opts.dateIso}'`);
	lines.push(`url: ${opts.url}`);

	// category: block style when non-empty, flow-style empty otherwise
	if (opts.categories.length === 0) {
		lines.push('category: []');
	} else {
		lines.push('category:');
		for (const c of opts.categories) {
			lines.push(`- ${c}`);
		}
	}

	// tag: always inline flow style (new posts start with no tags)
	if (opts.tags.length === 0) {
		lines.push('tag: []');
	} else {
		lines.push('tag:');
		for (const t of opts.tags) {
			lines.push(`- ${t}`);
		}
	}

	lines.push('---');
	lines.push('');

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * Format a Date as `'YYYY-MM-DDTHH:mm:ss±HH:MM'` using the local timezone
 * offset, matching the existing posts' date style.
 */
export function formatHugoDate(d: Date): string {
	const pad2 = (n: number) => String(n).padStart(2, '0');

	const year = d.getFullYear();
	const month = pad2(d.getMonth() + 1);
	const day = pad2(d.getDate());
	const hours = pad2(d.getHours());
	const minutes = pad2(d.getMinutes());
	const seconds = pad2(d.getSeconds());

	// getTimezoneOffset returns minutes WEST of UTC (negative for east); we
	// need the ±HH:MM representation.
	const offsetMin = d.getTimezoneOffset();
	const sign = offsetMin <= 0 ? '+' : '-';
	const absMin = Math.abs(offsetMin);
	const offsetHours = pad2(Math.floor(absMin / 60));
	const offsetMins = pad2(absMin % 60);

	return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMins}`;
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/**
 * Convert an arbitrary title into a URL-safe slug:
 *   - NFKD-normalize and strip combining diacriticals
 *   - lowercase
 *   - replace runs of non-alphanumeric characters with a single `-`
 *   - trim leading/trailing hyphens
 */
export function slugify(title: string): string {
	return title
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // strip diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

import { describe, it, expect } from 'vitest';
import {
	parseBlogFrontmatter,
	formatBlogFrontmatter,
	formatHugoDate,
	slugify,
} from '../src/utils/blog-frontmatter';

// ---------------------------------------------------------------------------
// parseBlogFrontmatter
// ---------------------------------------------------------------------------

describe('parseBlogFrontmatter', () => {
	it('returns empty defaults when passed undefined', () => {
		const r = parseBlogFrontmatter(undefined);
		expect(r.title).toBeNull();
		expect(r.date).toBeNull();
		expect(r.url).toBeNull();
		expect(r.categories).toEqual([]);
		expect(r.tags).toEqual([]);
		expect(r.cover).toEqual({ src: null, alt: null });
		expect(r.draft).toBe(false);
	});

	it('parses a typical post matching the vault example', () => {
		const fm = {
			title: 'Hibernating is easy now?',
			date: '2024-09-02T21:33:09+00:00',
			url: '/tech/hibernating-is-easy-now/',
			category: ['technology'],
			tag: ['admin', 'arch'],
			cover: { alt: 'Hibernating bear', src: 'images/bear.jpg' },
		};
		const r = parseBlogFrontmatter(fm);
		expect(r.title).toBe('Hibernating is easy now?');
		expect(r.date?.toISOString()).toBe('2024-09-02T21:33:09.000Z');
		expect(r.url).toBe('/tech/hibernating-is-easy-now/');
		expect(r.categories).toEqual(['technology']);
		expect(r.tags).toEqual(['admin', 'arch']);
		expect(r.cover.src).toBe('images/bear.jpg');
		expect(r.cover.alt).toBe('Hibernating bear');
		expect(r.draft).toBe(false);
	});

	it('accepts plural `categories` key', () => {
		const r = parseBlogFrontmatter({ categories: ['ai', 'photography'] });
		expect(r.categories).toEqual(['ai', 'photography']);
	});

	it('accepts plural `tags` key', () => {
		const r = parseBlogFrontmatter({ tags: ['linux', 'arch'] });
		expect(r.tags).toEqual(['linux', 'arch']);
	});

	it('prefers singular `category` over `categories` when both present', () => {
		const r = parseBlogFrontmatter({ category: ['tech'], categories: ['other'] });
		expect(r.categories).toEqual(['tech']);
	});

	it('coerces a bare string category to an array', () => {
		const r = parseBlogFrontmatter({ category: 'technology' });
		expect(r.categories).toEqual(['technology']);
	});

	it('returns draft: true when frontmatter draft is true', () => {
		const r = parseBlogFrontmatter({ draft: true });
		expect(r.draft).toBe(true);
	});

	it('returns draft: false for non-boolean truthy values', () => {
		const r = parseBlogFrontmatter({ draft: 'true' as unknown });
		expect(r.draft).toBe(false);
	});

	it('returns null date for an invalid date string', () => {
		const r = parseBlogFrontmatter({ date: 'not-a-date' });
		expect(r.date).toBeNull();
	});

	it('returns null cover fields when cover is absent', () => {
		const r = parseBlogFrontmatter({ title: 'Hello' });
		expect(r.cover).toEqual({ src: null, alt: null });
	});
});

// ---------------------------------------------------------------------------
// formatBlogFrontmatter
// ---------------------------------------------------------------------------

describe('formatBlogFrontmatter', () => {
	it('emits frontmatter matching the vault house style', () => {
		const output = formatBlogFrontmatter({
			title: 'Hibernating is easy now?',
			dateIso: '2024-09-02T21:33:09+00:00',
			url: '/tech/hibernating-is-easy-now/',
			categories: ['technology'],
			tags: [],
		});

		expect(output).toBe(
			[
				'---',
				'title: Hibernating is easy now?',
				"date: '2024-09-02T21:33:09+00:00'",
				'url: /tech/hibernating-is-easy-now/',
				'category:',
				'- technology',
				'tag: []',
				'---',
				'',
			].join('\n'),
		);
	});

	it('emits category: [] when no categories', () => {
		const output = formatBlogFrontmatter({
			title: 'Test',
			dateIso: '2024-01-01T00:00:00+00:00',
			url: '/test/',
			categories: [],
			tags: [],
		});
		expect(output).toContain('category: []');
	});

	it('emits multiple categories as block list', () => {
		const output = formatBlogFrontmatter({
			title: 'Test',
			dateIso: '2024-01-01T00:00:00+00:00',
			url: '/test/',
			categories: ['ai', 'tech'],
			tags: [],
		});
		expect(output).toContain('category:\n- ai\n- tech');
	});

	it('emits non-empty tags as block list', () => {
		const output = formatBlogFrontmatter({
			title: 'Test',
			dateIso: '2024-01-01T00:00:00+00:00',
			url: '/test/',
			categories: [],
			tags: ['linux', 'arch'],
		});
		expect(output).toContain('tag:\n- linux\n- arch');
	});

	it('ends with a trailing newline', () => {
		const output = formatBlogFrontmatter({
			title: 'T',
			dateIso: '2024-01-01T00:00:00+00:00',
			url: '/t/',
			categories: [],
			tags: [],
		});
		expect(output.endsWith('\n')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatHugoDate
// ---------------------------------------------------------------------------

describe('formatHugoDate', () => {
	it('formats to the expected pattern YYYY-MM-DDTHH:mm:ss±HH:MM', () => {
		// Use a fixed UTC date so the test is deterministic regardless of
		// the runner's local timezone.
		const d = new Date('2024-09-02T21:33:09Z');
		const result = formatHugoDate(d);
		// Should match the pattern regardless of timezone offset.
		expect(result).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
		);
	});

	it('is parseable back to the same UTC instant', () => {
		const original = new Date('2024-03-15T10:00:00Z');
		const formatted = formatHugoDate(original);
		const reparsed = new Date(formatted);
		expect(reparsed.getTime()).toBe(original.getTime());
	});
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
	it('lowercases and replaces spaces with hyphens', () => {
		expect(slugify('Hello World')).toBe('hello-world');
	});

	it('strips diacritics', () => {
		expect(slugify('Ångström')).toBe('angstrom');
	});

	it('collapses multiple non-alphanumeric characters to one hyphen', () => {
		expect(slugify('hello -- world!!')).toBe('hello-world');
	});

	it('trims leading and trailing hyphens', () => {
		expect(slugify('  -hello- ')).toBe('hello');
	});

	it('handles the example post title correctly', () => {
		expect(slugify('Hibernating is easy now?')).toBe('hibernating-is-easy-now');
	});

	it('returns an empty string for an all-punctuation input', () => {
		expect(slugify('!!! ???')).toBe('');
	});

	it('handles numbers', () => {
		expect(slugify('Top 10 tips')).toBe('top-10-tips');
	});
});

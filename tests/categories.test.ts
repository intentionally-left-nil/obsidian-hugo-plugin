import { describe, it, expect } from 'vitest';
import {
	loadCategoriesFromDisk,
	type CategoryFsAdapter,
} from '../src/utils/categories';

// ---------------------------------------------------------------------------
// In-memory adapter factory
// ---------------------------------------------------------------------------

/**
 * Build a fake CategoryFsAdapter from a plain object mapping
 * `<dir>/<name>` → file contents (or null for "does not exist").
 *
 * `listSubfolders` is driven by a separate subfolders map:
 * `<dir>` → string[] of subfolder names.
 */
function makeAdapter(
	subfolders: Record<string, string[]>,
	files: Record<string, string | null>,
): CategoryFsAdapter {
	return {
		async listSubfolders(dir: string): Promise<string[]> {
			return subfolders[dir] ?? [];
		},
		async readFile(filePath: string): Promise<string | null> {
			return filePath in files ? (files[filePath] ?? null) : null;
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// path.join resolves `..` segments, so '/vault/../category' → '/category'
const CAT_DIR = '/category';

describe('loadCategoriesFromDisk', () => {
	it('returns an empty array when the category directory has no subfolders', async () => {
		const adapter = makeAdapter({ [CAT_DIR]: [] }, {});
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result).toEqual([]);
	});

	it('reads slug, title, and urlPrefix from _index.md', async () => {
		const adapter = makeAdapter(
			{ [CAT_DIR]: ['technology'] },
			{
				[`${CAT_DIR}/technology/_index.md`]: [
					'---',
					'title: Technology',
					'url: /category/tech/',
					'---',
				].join('\n'),
			},
		);
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			slug: 'technology',
			title: 'Technology',
			urlPrefix: '/category/tech/',
		});
	});

	it('falls back to capitalised slug for title when _index.md is missing', async () => {
		const adapter = makeAdapter({ [CAT_DIR]: ['photography'] }, {});
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result[0]!.title).toBe('Photography');
	});

	it('falls back to /category/<slug>/ for urlPrefix when url is absent', async () => {
		const adapter = makeAdapter(
			{ [CAT_DIR]: ['ai'] },
			{
				[`${CAT_DIR}/ai/_index.md`]: '---\ntitle: AI\n---',
			},
		);
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result[0]!.urlPrefix).toBe('/category/ai/');
	});

	it('normalises urlPrefix to always start and end with /', async () => {
		const adapter = makeAdapter(
			{ [CAT_DIR]: ['tech'] },
			{
				[`${CAT_DIR}/tech/_index.md`]: '---\ntitle: Tech\nurl: category/tech\n---',
			},
		);
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result[0]!.urlPrefix).toBe('/category/tech/');
	});

	it('strips surrounding quotes from title and url values', async () => {
		const adapter = makeAdapter(
			{ [CAT_DIR]: ['photography'] },
			{
				[`${CAT_DIR}/photography/_index.md`]:
					"---\ntitle: 'Photography'\nurl: \"/category/photography/\"\n---",
			},
		);
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result[0]!.title).toBe('Photography');
		expect(result[0]!.urlPrefix).toBe('/category/photography/');
	});

	it('sorts results by title ascending', async () => {
		const adapter = makeAdapter(
			{ [CAT_DIR]: ['technology', 'ai', 'photography'] },
			{
				[`${CAT_DIR}/technology/_index.md`]: '---\ntitle: Technology\nurl: /category/tech/\n---',
				[`${CAT_DIR}/ai/_index.md`]: '---\ntitle: AI\nurl: /category/ai/\n---',
				[`${CAT_DIR}/photography/_index.md`]:
					'---\ntitle: Photography\nurl: /category/photography/\n---',
			},
		);
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result.map((c) => c.title)).toEqual(['AI', 'Photography', 'Technology']);
	});

	it('returns empty array when listSubfolders returns empty (directory missing)', async () => {
		// adapter returns [] for any unknown dir (default behaviour)
		const adapter = makeAdapter({}, {});
		const result = await loadCategoriesFromDisk('/vault', adapter);
		expect(result).toEqual([]);
	});
});

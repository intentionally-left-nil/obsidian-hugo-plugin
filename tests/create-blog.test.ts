import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import {
	createBlogPost,
	DuplicatePostError,
	type CreateBlogAdapter,
} from '../src/utils/create-blog';
import type { CategoryEntry } from '../src/utils/categories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCategory(
	slug: string,
	title: string,
	urlPrefix: string,
): CategoryEntry {
	return { slug, title, urlPrefix };
}

function makeMockTFile(path: string): TFile {
	const f = new TFile();
	f.name = path.split('/').pop()!;
	f.path = path;
	f.extension = 'md';
	f.basename = 'index';
	return f;
}

function makeAdapter(
	existingSlugs: string[] = [],
	overrides: Partial<CreateBlogAdapter> = {},
): CreateBlogAdapter {
	const existing = new Set(existingSlugs);
	return {
		folderExists: vi.fn((path: string) => existing.has(path)),
		createFolder: vi.fn(async () => undefined),
		createFile: vi.fn(async (path: string) => makeMockTFile(path)),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// createBlogPost
// ---------------------------------------------------------------------------

describe('createBlogPost', () => {
	const category = makeCategory('technology', 'Technology', '/category/tech/');
	const now = new Date('2024-09-02T21:33:09+00:00');

	it('creates the slug folder, images subfolder, and index.md', async () => {
		const adapter = makeAdapter();
		await createBlogPost(adapter, {
			title: 'Hibernating is easy now?',
			category,
			now,
		});

		expect(adapter.createFolder).toHaveBeenCalledWith('hibernating-is-easy-now');
		expect(adapter.createFolder).toHaveBeenCalledWith('hibernating-is-easy-now/images');
		expect(adapter.createFile).toHaveBeenCalledWith(
			'hibernating-is-easy-now/index.md',
			expect.any(String),
		);
	});

	it('returns the new TFile at the expected path', async () => {
		const adapter = makeAdapter();
		const file = await createBlogPost(adapter, { title: 'Hello World', category, now });
		expect(file.path).toBe('hello-world/index.md');
	});

	it('writes the correct frontmatter', async () => {
		let written = '';
		const adapter = makeAdapter([], {
			createFile: vi.fn(async (_path: string, contents: string) => {
				written = contents;
				return makeMockTFile(_path);
			}),
		});

		await createBlogPost(adapter, {
			title: 'Hibernating is easy now?',
			category,
			now,
		});

		expect(written).toContain('title: Hibernating is easy now?');
		expect(written).toContain('url: /tech/hibernating-is-easy-now/');
		expect(written).toContain('category:\n- technology');
		expect(written).toContain('tag: []');
	});

	it('throws DuplicatePostError when the slug folder already exists', async () => {
		const adapter = makeAdapter(['hello-world']);
		await expect(
			createBlogPost(adapter, { title: 'Hello World', category, now }),
		).rejects.toThrow(DuplicatePostError);
	});

	it('DuplicatePostError message contains the slug', async () => {
		const adapter = makeAdapter(['hello-world']);
		await expect(
			createBlogPost(adapter, { title: 'Hello World', category, now }),
		).rejects.toThrow('hello-world');
	});

	it('throws for a title that produces an empty slug', async () => {
		const adapter = makeAdapter();
		await expect(
			createBlogPost(adapter, { title: '!!! ???', category, now }),
		).rejects.toThrow('empty slug');
	});

	it('composes url from last segment of category urlPrefix + slug', async () => {
		let written = '';
		const adapter = makeAdapter([], {
			createFile: vi.fn(async (_path: string, contents: string) => {
				written = contents;
				return makeMockTFile(_path);
			}),
		});

		const catAi = makeCategory('ai', 'AI', '/category/ai/');
		await createBlogPost(adapter, { title: 'My AI Post', category: catAi, now });

		// urlPrefix is /category/ai/ → last segment is "ai" → post url is /ai/<slug>/
		expect(written).toContain('url: /ai/my-ai-post/');
	});

	it('uses current time when now is omitted', async () => {
		// formatHugoDate truncates to-second precision; align our bounds the same way.
		const before = new Date(Math.floor(Date.now() / 1000) * 1000);
		let written = '';
		const adapter = makeAdapter([], {
			createFile: vi.fn(async (_path: string, contents: string) => {
				written = contents;
				return makeMockTFile(_path);
			}),
		});

		await createBlogPost(adapter, { title: 'Timely Post', category });

		const after = new Date(Math.ceil(Date.now() / 1000) * 1000);
		// Extract the date string from frontmatter
		const match = /date: '([^']+)'/.exec(written);
		expect(match).not.toBeNull();
		const d = new Date(match![1]!);
		expect(d.getTime()).toBeGreaterThanOrEqual(before.getTime());
		expect(d.getTime()).toBeLessThanOrEqual(after.getTime());
	});
});

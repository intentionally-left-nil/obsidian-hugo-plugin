import { describe, it, expect } from 'vitest';
import {
	splitFrontmatter,
	readPost,
	setShortcodeArgs,
	appendFigureToBody,
	stripFigureCoverOverrides,
	collectCoverMigration,
	findShortcodeForEntry,
	setFigureCoverArg,
	type PostAdapter,
} from '../src/parser/post';
import { parse } from '../src/parser/shortcodes';
import type { ParsedPost, ReferencedImageEntry, ShortcodeNode } from '../src/types';

/* ---------------------------------------------------------------------------
 * Test adapter: mocks Obsidian's file/frontmatter operations against an
 * in-memory map.
 * ------------------------------------------------------------------------- */

interface FakeFile {
	path: string;
	name: string;
	extension: string;
	parent: { path: string } | null;
}

interface Fixture {
	postPath: string;
	rawContent: string;
	frontmatter?: Record<string, unknown>;
	imageFiles: string[]; // paths under the post folder, e.g. 'blog/post/images/a.png'
}

function fakeFile(path: string): FakeFile {
	const slash = path.lastIndexOf('/');
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf('.');
	const extension = dot === -1 ? '' : name.slice(dot + 1);
	const parentPath = slash === -1 ? '' : path.slice(0, slash);
	return {
		path,
		name,
		extension,
		parent: { path: parentPath },
	};
}

function makeAdapter(fixture: Fixture): {
	adapter: PostAdapter;
	postFile: FakeFile;
	files: Map<string, FakeFile>;
	body: { current: string };
	frontmatter: { current: Record<string, unknown> };
} {
	const files = new Map<string, FakeFile>();
	const postFile = fakeFile(fixture.postPath);
	files.set(postFile.path, postFile);
	for (const p of fixture.imageFiles) {
		files.set(p, fakeFile(p));
	}
	const body = { current: fixture.rawContent };
	const frontmatter = { current: { ...(fixture.frontmatter ?? {}) } };

	const adapter: PostAdapter = {
		readBody: async () => body.current,
		getFrontmatter: () => frontmatter.current,
		listImageFiles: (post) => {
			const folder = post.parent?.path ?? '';
			const imagesPrefix = folder ? `${folder}/images/` : 'images/';
			return [...files.values()]
				.filter((f) => f.path.startsWith(imagesPrefix) && f.path !== post.path)
				.sort((a, b) => a.path.localeCompare(b.path)) as unknown as ReturnType<PostAdapter['listImageFiles']>;
		},
		resolveImageFile: (post, src) => {
			const folder = post.parent?.path ?? '';
			const target = folder ? `${folder}/${src}` : src;
			return (files.get(target) as unknown as ReturnType<PostAdapter['resolveImageFile']>) ?? null;
		},
		processFrontMatter: async (_, fn) => {
			fn(frontmatter.current);
		},
		processBody: async (_, fn) => {
			body.current = fn(body.current);
		},
	};

	return { adapter, postFile, files, body, frontmatter };
}

async function loadPost(fixture: Fixture): Promise<ParsedPost> {
	const { adapter, postFile } = makeAdapter(fixture);
	return readPost(adapter, postFile as unknown as Parameters<typeof readPost>[1]);
}

/* ------------------------------------------------------------------------- */

describe('splitFrontmatter', () => {
	it('returns body unchanged when no frontmatter', () => {
		const result = splitFrontmatter('hello world');
		expect(result.frontmatterRaw).toBe(null);
		expect(result.body).toBe('hello world');
		expect(result.bodyStart).toBe(0);
	});

	it('strips a leading frontmatter block', () => {
		const raw = '---\ntitle: hi\n---\nbody text';
		const result = splitFrontmatter(raw);
		expect(result.frontmatterRaw).toContain('title: hi');
		expect(result.body).toBe('body text');
		expect(result.bodyStart).toBe('---\ntitle: hi\n---\n'.length);
	});

	it('handles CRLF line endings', () => {
		const raw = '---\r\ntitle: hi\r\n---\r\nbody text';
		const result = splitFrontmatter(raw);
		expect(result.body).toBe('body text');
	});

	it('returns full body if frontmatter is unterminated', () => {
		const raw = '---\ntitle: hi\nno close';
		const result = splitFrontmatter(raw);
		expect(result.frontmatterRaw).toBe(null);
		expect(result.body).toBe(raw);
	});
});

describe('readPost', () => {
	it('returns referenced cover entry when only frontmatter cover exists', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '',
			frontmatter: { cover: { src: 'images/a.png', alt: 'a', caption: 'c' } },
			imageFiles: ['blog/p/images/a.png'],
		});
		expect(post.images).toHaveLength(1);
		const entry = post.images[0] as ReferencedImageEntry;
		expect(entry.kind).toBe('referenced');
		expect(entry.isCover).toBe(true);
		expect(entry.alt).toBe('a');
		expect(entry.caption).toBe('c');
	});

	it('emits cover + standalone figures + unreferenced', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '{{< figure src="images/b.png" alt="b" />}}',
			frontmatter: { cover: { src: 'images/a.png', alt: 'a' } },
			imageFiles: [
				'blog/p/images/a.png',
				'blog/p/images/b.png',
				'blog/p/images/unused.png',
			],
		});
		expect(post.images.map((e) => (e.kind === 'referenced' ? e.src : `unref:${e.src}`))).toEqual([
			'images/a.png',
			'images/b.png',
			'unref:images/unused.png',
		]);
	});

	it('emits gallery items individually', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent:
				'{{< gallery >}}{{< figure src="images/x.png" />}}{{< figure src="images/y.png" caption="y!" />}}{{< /gallery >}}',
			imageFiles: ['blog/p/images/x.png', 'blog/p/images/y.png'],
		});
		expect(post.images).toHaveLength(2);
		const entry1 = post.images[0] as ReferencedImageEntry;
		const entry2 = post.images[1] as ReferencedImageEntry;
		expect(entry1.src).toBe('images/x.png');
		expect(entry2.caption).toBe('y!');
		expect(entry1.source.kind).toBe('gallery-item');
	});

	it('detects needsMigration when figure cover=true has overrides', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '{{< figure cover=true alt="from-shortcode" />}}',
			frontmatter: { cover: { src: 'images/a.png' } },
			imageFiles: ['blog/p/images/a.png'],
		});
		expect(post.needsMigration).toBe(true);
	});

	it('does not flag migration for clean figure cover=true', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '{{< figure cover=true />}}',
			frontmatter: { cover: { src: 'images/a.png', alt: 'a' } },
			imageFiles: ['blog/p/images/a.png'],
		});
		expect(post.needsMigration).toBe(false);
	});

	it('synthesises a cover entry when only figure cover=true with overrides exists (no frontmatter)', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '{{< figure cover=true src="images/a.png" alt="a" />}}',
			imageFiles: ['blog/p/images/a.png'],
		});
		expect(post.images).toHaveLength(1);
		const entry = post.images[0] as ReferencedImageEntry;
		expect(entry.isCover).toBe(true);
		expect(entry.src).toBe('images/a.png');
		expect(post.needsMigration).toBe(true);
	});

	it('handles cover image referenced twice (once frontmatter, once figure cover=true) as a single entry', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '{{< figure cover=true >}} text {{< figure src="images/b.png" />}}',
			frontmatter: { cover: { src: 'images/a.png', alt: 'a' } },
			imageFiles: ['blog/p/images/a.png', 'blog/p/images/b.png'],
		});
		const referenced = post.images.filter((e): e is ReferencedImageEntry => e.kind === 'referenced');
		expect(referenced).toHaveLength(2);
		expect(referenced[0]!.isCover).toBe(true);
		expect(referenced[0]!.source.kind).toBe('figure-cover');
		expect(referenced[1]!.isCover).toBe(false);
	});
});

describe('setShortcodeArgs', () => {
	it('updates alt while preserving src', () => {
		const body = '{{< figure src="a.png" alt="old" />}}';
		const ast = parse(body);
		const node = ast[0] as ShortcodeNode;
		const out = setShortcodeArgs(body, node, { alt: 'new' });
		expect(out).toBe('{{< figure src="a.png" alt="new" />}}');
	});

	it('removes alt when set to empty string', () => {
		const body = '{{< figure src="a.png" alt="x" />}}';
		const ast = parse(body);
		const node = ast[0] as ShortcodeNode;
		const out = setShortcodeArgs(body, node, { alt: '' });
		expect(out).toBe('{{< figure src="a.png" />}}');
	});

	it('only edits the affected shortcode', () => {
		const body = '{{< figure src="a.png" />}} {{< figure src="b.png" />}}';
		const ast = parse(body);
		const second = ast.filter((n): n is ShortcodeNode => n.kind === 'shortcode')[1]!;
		const out = setShortcodeArgs(body, second, { alt: 'b alt' });
		expect(out).toBe('{{< figure src="a.png" />}} {{< figure src="b.png" alt="b alt" />}}');
	});
});

describe('appendFigureToBody', () => {
	it('appends to empty body', () => {
		const out = appendFigureToBody('', 'images/a.png');
		expect(out).toBe('{{< figure src="images/a.png" >}}\n');
	});

	it('inserts a blank line if body does not already end with one', () => {
		const out = appendFigureToBody('hello', 'images/a.png');
		expect(out).toBe('hello\n\n{{< figure src="images/a.png" >}}\n');
	});

	it('does not add extra blank line when body ends with two newlines', () => {
		const out = appendFigureToBody('hello\n\n', 'images/a.png');
		expect(out).toBe('hello\n\n{{< figure src="images/a.png" >}}\n');
	});

	it('escapes quotes in src', () => {
		const out = appendFigureToBody('', 'images/with "quote".png');
		expect(out).toBe('{{< figure src="images/with \\"quote\\".png" >}}\n');
	});
});

describe('stripFigureCoverOverrides', () => {
	it('strips src/alt/caption from figure cover=true', () => {
		const body = 'pre {{< figure cover=true src="x" alt="y" caption="z" />}} post';
		const out = stripFigureCoverOverrides(body);
		expect(out).toBe('pre {{< figure cover=true />}} post');
	});

	it('leaves clean figure cover=true alone', () => {
		const body = '{{< figure cover=true />}}';
		expect(stripFigureCoverOverrides(body)).toBe(body);
	});

	it('handles multiple instances', () => {
		const body =
			'{{< figure cover=true alt="x" />}}\n{{< figure cover=true caption="y" />}}';
		const out = stripFigureCoverOverrides(body);
		expect(out).toBe('{{< figure cover=true />}}\n{{< figure cover=true />}}');
	});

	it('does not touch non-cover figures', () => {
		const body = '{{< figure src="a.png" alt="x" />}}';
		expect(stripFigureCoverOverrides(body)).toBe(body);
	});
});

describe('collectCoverMigration', () => {
	it('extracts src/alt/caption from figure cover=true', () => {
		const body = '{{< figure cover=true src="x" alt="y" caption="z" />}}';
		const ast = parse(body);
		expect(collectCoverMigration(ast)).toEqual({ src: 'x', alt: 'y', caption: 'z' });
	});

	it('takes the first non-empty value across multiple instances', () => {
		const body = '{{< figure cover=true alt="first" />}}\n{{< figure cover=true alt="second" caption="c" />}}';
		const ast = parse(body);
		expect(collectCoverMigration(ast)).toEqual({ alt: 'first', caption: 'c' });
	});

	it('returns empty when no figure cover=true present', () => {
		const ast = parse('{{< figure src="a" />}}');
		expect(collectCoverMigration(ast)).toEqual({});
	});
});

describe('findShortcodeForEntry', () => {
	it('returns null for cover-only entries', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '',
			frontmatter: { cover: { src: 'images/a.png' } },
			imageFiles: ['blog/p/images/a.png'],
		});
		const entry = post.images[0] as ReferencedImageEntry;
		expect(findShortcodeForEntry(post.ast, entry)).toBe(null);
	});

	it('returns the right figure for a standalone entry', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: '{{< figure src="images/a.png" />}} {{< figure src="images/b.png" />}}',
			imageFiles: ['blog/p/images/a.png', 'blog/p/images/b.png'],
		});
		const entry = post.images[1] as ReferencedImageEntry;
		const node = findShortcodeForEntry(post.ast, entry);
		expect(node?.args.named.get('src')?.value).toBe('images/b.png');
	});

	it('returns the right child for a gallery item', async () => {
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent:
				'{{< gallery >}}{{< figure src="images/x.png" />}}{{< figure src="images/y.png" />}}{{< /gallery >}}',
			imageFiles: ['blog/p/images/x.png', 'blog/p/images/y.png'],
		});
		const entry = post.images[1] as ReferencedImageEntry;
		const node = findShortcodeForEntry(post.ast, entry);
		expect(node?.args.named.get('src')?.value).toBe('images/y.png');
	});

	it('returns the right figure when a gallery precedes standalone figures', async () => {
		// Regression: figureIndex counts only figure nodes, but the old code used
		// the position within the mixed topLevel array (which included galleries),
		// so nodeIndex 0 resolved to the gallery (wrong) instead of the figure.
		const post = await loadPost({
			postPath: 'blog/p/index.md',
			rawContent: [
				'{{< gallery >}}{{< figure src="images/g.png" />}}{{< /gallery >}}',
				'{{< figure src="images/a.png" />}}',
				'{{< figure src="images/b.png" />}}',
			].join('\n'),
			imageFiles: ['blog/p/images/g.png', 'blog/p/images/a.png', 'blog/p/images/b.png'],
		});
		// images[0] = gallery item g.png, images[1] = standalone a.png, images[2] = standalone b.png
		const entryA = post.images[1] as ReferencedImageEntry;
		const entryB = post.images[2] as ReferencedImageEntry;
		expect(entryA.source).toMatchObject({ kind: 'figure', nodeIndex: 0 });
		expect(entryB.source).toMatchObject({ kind: 'figure', nodeIndex: 1 });
		expect(findShortcodeForEntry(post.ast, entryA)?.args.named.get('src')?.value).toBe('images/a.png');
		expect(findShortcodeForEntry(post.ast, entryB)?.args.named.get('src')?.value).toBe('images/b.png');
	});
});

/* ---------------------------------------------------------------------------
 * setFigureCoverArg
 * ------------------------------------------------------------------------- */

describe('setFigureCoverArg', () => {
	it('adds cover=true and strips src/alt/caption from the target figure', () => {
		const body = '{{< figure src="images/a.png" alt="A" caption="Cap" />}}';
		const result = setFigureCoverArg(body, 0, true);
		expect(result).toBe('{{< figure cover=true />}}');
	});

	it('removes cover=true from a figure-cover shortcode', () => {
		const body = '{{< figure cover=true />}}';
		const result = setFigureCoverArg(body, 0, false);
		expect(result).toBe('{{< figure />}}');
	});

	it('only modifies the figure at the given nodeIndex', () => {
		const body = [
			'{{< figure src="images/a.png" />}}',
			'{{< figure src="images/b.png" alt="B" />}}',
		].join('\n');
		const result = setFigureCoverArg(body, 1, true);
		expect(result).toBe([
			'{{< figure src="images/a.png" />}}',
			'{{< figure cover=true />}}',
		].join('\n'));
	});

	it('returns body unchanged when nodeIndex is out of range', () => {
		const body = '{{< figure src="images/a.png" />}}';
		const result = setFigureCoverArg(body, 5, true);
		expect(result).toBe(body);
	});

	it('skips gallery shortcodes when counting figure nodeIndex', () => {
		const body = [
			'{{< gallery >}}{{< figure src="images/g.png" />}}{{< /gallery >}}',
			'{{< figure src="images/a.png" />}}',
		].join('\n');
		// The standalone figure has nodeIndex=0 (galleries are not counted).
		const result = setFigureCoverArg(body, 0, true);
		expect(result).toContain('cover=true');
		expect(result).not.toContain('images/a.png'); // src stripped when adding cover
		expect(result).toContain('images/g.png'); // gallery item untouched
	});
});

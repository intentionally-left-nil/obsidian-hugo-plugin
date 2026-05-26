import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import {
	sanitizeFilename,
	inferExtFromContentType,
	inferFilenameFromUrl,
	pickUniqueName,
	addImageFromFile,
	addImageFromUrl,
	type AddImageAdapter,
} from '../src/utils/add-image';

// ---------------------------------------------------------------------------
// sanitizeFilename
// ---------------------------------------------------------------------------

describe('sanitizeFilename', () => {
	it('returns a clean name for a simple valid filename', () => {
		expect(sanitizeFilename('photo.jpg')).toBe('photo.jpg');
	});

	it('lowercases the extension', () => {
		expect(sanitizeFilename('PHOTO.PNG')).toBe('PHOTO.png');
	});

	it('strips directory components (unix-style)', () => {
		expect(sanitizeFilename('subdir/photo.jpg')).toBe('photo.jpg');
	});

	it('strips directory components (windows-style)', () => {
		expect(sanitizeFilename('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg');
	});

	it('strips ../ traversal attempts', () => {
		expect(sanitizeFilename('../etc/passwd.jpg')).toBe('passwd.jpg');
	});

	it('percent-decodes encoded characters', () => {
		expect(sanitizeFilename('my%20photo.png')).toBe('my-photo.png');
	});

	it('replaces whitespace runs with dashes', () => {
		expect(sanitizeFilename('my great photo.png')).toBe('my-great-photo.png');
	});

	it('collapses multiple dashes', () => {
		expect(sanitizeFilename('my--photo.png')).toBe('my-photo.png');
	});

	it('trims leading and trailing dashes from stem', () => {
		expect(sanitizeFilename('-photo-.png')).toBe('photo.png');
	});

	it('uses fallback stem "image" when stem becomes empty', () => {
		expect(sanitizeFilename('---.png')).toBe('image.png');
	});

	it('returns null for unsupported extension', () => {
		expect(sanitizeFilename('script.exe')).toBeNull();
	});

	it('returns null for no extension', () => {
		expect(sanitizeFilename('noextension')).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(sanitizeFilename('')).toBeNull();
	});

	it('accepts all known image extensions', () => {
		for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']) {
			expect(sanitizeFilename(`image.${ext}`)).not.toBeNull();
		}
	});
});

// ---------------------------------------------------------------------------
// inferExtFromContentType
// ---------------------------------------------------------------------------

describe('inferExtFromContentType', () => {
	it('maps image/jpeg to jpg', () => {
		expect(inferExtFromContentType('image/jpeg')).toBe('jpg');
	});

	it('maps image/png to png', () => {
		expect(inferExtFromContentType('image/png')).toBe('png');
	});

	it('maps image/svg+xml to svg', () => {
		expect(inferExtFromContentType('image/svg+xml')).toBe('svg');
	});

	it('ignores charset suffix', () => {
		expect(inferExtFromContentType('image/png; charset=utf-8')).toBe('png');
	});

	it('returns null for non-image types', () => {
		expect(inferExtFromContentType('text/html')).toBeNull();
		expect(inferExtFromContentType('application/json')).toBeNull();
	});

	it('returns null for empty string', () => {
		expect(inferExtFromContentType('')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// inferFilenameFromUrl
// ---------------------------------------------------------------------------

describe('inferFilenameFromUrl', () => {
	it('takes the filename from the URL path', () => {
		expect(inferFilenameFromUrl('https://example.com/images/cat.jpg', '')).toBe('cat.jpg');
	});

	it('falls back to content-type when path has no extension', () => {
		expect(inferFilenameFromUrl('https://example.com/images/cat', 'image/png')).toBe('cat.png');
	});

	it('uses "image" as stem when URL has no useful path tail', () => {
		expect(inferFilenameFromUrl('https://example.com/', 'image/webp')).toBe('image.webp');
	});

	it('returns null when neither path nor content-type is useful', () => {
		expect(inferFilenameFromUrl('https://example.com/', '')).toBeNull();
	});

	it('strips query params from URL tail', () => {
		expect(inferFilenameFromUrl('https://example.com/cat.jpg?v=1', '')).toBe('cat.jpg');
	});
});

// ---------------------------------------------------------------------------
// pickUniqueName
// ---------------------------------------------------------------------------

describe('pickUniqueName', () => {
	it('returns the original path when no collision', () => {
		const exists = () => false;
		expect(pickUniqueName('blog/post/images', 'photo.jpg', exists)).toBe('blog/post/images/photo.jpg');
	});

	it('appends -2 when original is taken', () => {
		const taken = new Set(['blog/post/images/photo.jpg']);
		const exists = (p: string) => taken.has(p);
		expect(pickUniqueName('blog/post/images', 'photo.jpg', exists)).toBe('blog/post/images/photo-2.jpg');
	});

	it('increments suffix until free slot found', () => {
		const taken = new Set([
			'blog/post/images/photo.jpg',
			'blog/post/images/photo-2.jpg',
			'blog/post/images/photo-3.jpg',
		]);
		const exists = (p: string) => taken.has(p);
		expect(pickUniqueName('blog/post/images', 'photo.jpg', exists)).toBe('blog/post/images/photo-4.jpg');
	});
});

// ---------------------------------------------------------------------------
// addImageFromFile
// ---------------------------------------------------------------------------

function makeMockTFile(name: string, path: string): TFile {
	const f = new TFile();
	f.name = name;
	f.path = path;
	f.extension = name.split('.').pop() ?? '';
	f.basename = name.replace(/\.[^.]+$/, '');
	return f;
}

function makePost(parentPath: string): TFile {
	const post = makeMockTFile('index.md', `${parentPath}/index.md`);
	return post;
}

function makeAdapter(overrides: Partial<AddImageAdapter> = {}): AddImageAdapter {
	return {
		ensureImagesFolder: vi.fn(async (post: TFile) => {
			const parent = post.path.replace(/\/[^/]+$/, '');
			return `${parent}/images`;
		}),
		fileExists: vi.fn(() => false),
		createBinary: vi.fn(async (path: string) => makeMockTFile(path.split('/').pop()!, path)),
		requestUrl: vi.fn(async () => ({
			status: 200,
			arrayBuffer: new ArrayBuffer(8),
			headers: { 'content-type': 'image/jpeg' },
		})),
		...overrides,
	};
}

describe('addImageFromFile', () => {
	it('writes the file to the images folder', async () => {
		const adapter = makeAdapter();
		const post = makePost('blog/post-1');
		const file = new File([new ArrayBuffer(8)], 'photo.jpg', { type: 'image/jpeg' });

		const result = await addImageFromFile(adapter, post, file);

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/photo.jpg',
			expect.any(ArrayBuffer),
		);
		expect(result.path).toBe('blog/post-1/images/photo.jpg');
	});

	it('applies collision suffix when name is taken', async () => {
		const adapter = makeAdapter({
			fileExists: vi.fn((p: string) => p === 'blog/post-1/images/photo.jpg'),
		});
		const post = makePost('blog/post-1');
		const file = new File([new ArrayBuffer(8)], 'photo.jpg', { type: 'image/jpeg' });

		await addImageFromFile(adapter, post, file);

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/photo-2.jpg',
			expect.any(ArrayBuffer),
		);
	});

	it('sanitizes the filename before writing', async () => {
		const adapter = makeAdapter();
		const post = makePost('blog/post-1');
		const file = new File([new ArrayBuffer(8)], 'my great photo.PNG', { type: 'image/png' });

		await addImageFromFile(adapter, post, file);

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/my-great-photo.png',
			expect.any(ArrayBuffer),
		);
	});

	it('throws for unsupported extension', async () => {
		const adapter = makeAdapter();
		const post = makePost('blog/post-1');
		const file = new File([new ArrayBuffer(8)], 'malware.exe', { type: 'application/x-msdownload' });

		await expect(addImageFromFile(adapter, post, file)).rejects.toThrow('Unsupported image type');
	});
});

// ---------------------------------------------------------------------------
// addImageFromUrl
// ---------------------------------------------------------------------------

describe('addImageFromUrl', () => {
	it('downloads and writes the image using filename from URL', async () => {
		const adapter = makeAdapter();
		const post = makePost('blog/post-1');

		const result = await addImageFromUrl(adapter, post, 'https://example.com/cat.jpg');

		expect(adapter.requestUrl).toHaveBeenCalledWith({ url: 'https://example.com/cat.jpg' });
		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/cat.jpg',
			expect.any(ArrayBuffer),
		);
		expect(result.path).toBe('blog/post-1/images/cat.jpg');
	});

	it('infers extension from content-type when URL path has none', async () => {
		const adapter = makeAdapter({
			requestUrl: vi.fn(async () => ({
				status: 200,
				arrayBuffer: new ArrayBuffer(8),
				headers: { 'content-type': 'image/png' },
			})),
		});
		const post = makePost('blog/post-1');

		await addImageFromUrl(adapter, post, 'https://example.com/cat');

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/cat.png',
			expect.any(ArrayBuffer),
		);
	});

	it('uses an explicit filename override when supplied', async () => {
		const adapter = makeAdapter();
		const post = makePost('blog/post-1');

		await addImageFromUrl(adapter, post, 'https://example.com/abc123', 'my-photo.jpg');

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/my-photo.jpg',
			expect.any(ArrayBuffer),
		);
	});

	it('appends extension from content-type when explicit filename has none', async () => {
		const adapter = makeAdapter({
			requestUrl: vi.fn(async () => ({
				status: 200,
				arrayBuffer: new ArrayBuffer(8),
				headers: { 'content-type': 'image/webp' },
			})),
		});
		const post = makePost('blog/post-1');

		await addImageFromUrl(adapter, post, 'https://example.com/abc123', 'my-photo');

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/my-photo.webp',
			expect.any(ArrayBuffer),
		);
	});

	it('applies collision suffix to URL-derived names', async () => {
		const adapter = makeAdapter({
			fileExists: vi.fn((p: string) => p === 'blog/post-1/images/cat.jpg'),
		});
		const post = makePost('blog/post-1');

		await addImageFromUrl(adapter, post, 'https://example.com/cat.jpg');

		expect(adapter.createBinary).toHaveBeenCalledWith(
			'blog/post-1/images/cat-2.jpg',
			expect.any(ArrayBuffer),
		);
	});

	it('throws on non-2xx HTTP status', async () => {
		const adapter = makeAdapter({
			requestUrl: vi.fn(async () => ({
				status: 404,
				arrayBuffer: new ArrayBuffer(0),
				headers: {},
			})),
		});
		const post = makePost('blog/post-1');

		await expect(addImageFromUrl(adapter, post, 'https://example.com/missing.jpg')).rejects.toThrow(
			'HTTP 404',
		);
	});

	it('throws when content-type is not an image', async () => {
		const adapter = makeAdapter({
			requestUrl: vi.fn(async () => ({
				status: 200,
				arrayBuffer: new ArrayBuffer(8),
				headers: { 'content-type': 'text/html' },
			})),
		});
		const post = makePost('blog/post-1');

		await expect(addImageFromUrl(adapter, post, 'https://example.com/page.html')).rejects.toThrow(
			'Unsupported image type',
		);
	});

	it('throws when filename cannot be determined', async () => {
		const adapter = makeAdapter({
			requestUrl: vi.fn(async () => ({
				status: 200,
				arrayBuffer: new ArrayBuffer(8),
				// content-type not a known image mime → inferExtFromContentType returns null
				headers: { 'content-type': 'image/unknown-format' },
			})),
		});
		const post = makePost('blog/post-1');

		// URL with no usable path tail either
		await expect(addImageFromUrl(adapter, post, 'https://example.com/')).rejects.toThrow();
	});
});

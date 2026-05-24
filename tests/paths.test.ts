import { describe, it, expect } from 'vitest';
import {
	IMAGE_EXTENSIONS,
	isExternalUrl,
	isInsidePostBundle,
	resolveSrcToVaultPath,
} from '../src/utils/paths';

describe('IMAGE_EXTENSIONS', () => {
	it('includes the agreed list', () => {
		for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']) {
			expect(IMAGE_EXTENSIONS.has(ext)).toBe(true);
		}
	});
});

describe('isExternalUrl', () => {
	it('detects http/https/data', () => {
		expect(isExternalUrl('https://example.com/x.png')).toBe(true);
		expect(isExternalUrl('http://example.com/x.png')).toBe(true);
		expect(isExternalUrl('data:image/png;base64,abc')).toBe(true);
	});

	it('detects protocol-relative URLs', () => {
		expect(isExternalUrl('//cdn.example.com/x.png')).toBe(true);
	});

	it('does not flag relative paths', () => {
		expect(isExternalUrl('images/foo.png')).toBe(false);
		expect(isExternalUrl('./images/foo.png')).toBe(false);
		expect(isExternalUrl('../shared/x.png')).toBe(false);
	});
});

describe('resolveSrcToVaultPath', () => {
	it('resolves a relative src against a post folder', () => {
		expect(resolveSrcToVaultPath('images/foo.png', 'blog/post-1')).toBe(
			'blog/post-1/images/foo.png',
		);
	});

	it('strips ./ prefix', () => {
		expect(resolveSrcToVaultPath('./images/foo.png', 'blog/post-1')).toBe(
			'blog/post-1/images/foo.png',
		);
	});

	it('handles vault-root paths via leading /', () => {
		expect(resolveSrcToVaultPath('/shared/x.png', 'blog/post-1')).toBe('shared/x.png');
	});

	it('returns null for external URLs', () => {
		expect(resolveSrcToVaultPath('https://example.com/x.png', 'blog/post-1')).toBe(null);
	});

	it('handles a post at vault root', () => {
		expect(resolveSrcToVaultPath('images/foo.png', '')).toBe('images/foo.png');
	});
});

describe('isInsidePostBundle', () => {
	it('returns true for files under the post folder', () => {
		expect(isInsidePostBundle('images/foo.png', 'blog/post-1')).toBe(true);
	});

	it('returns false for parent-relative paths', () => {
		expect(isInsidePostBundle('../shared/x.png', 'blog/post-1')).toBe(false);
	});

	it('returns false for external URLs', () => {
		expect(isInsidePostBundle('https://example.com/x.png', 'blog/post-1')).toBe(false);
	});
});

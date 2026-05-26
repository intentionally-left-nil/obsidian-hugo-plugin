import { describe, it, expect } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { sortBlogsByDate, type BlogSummary } from '../src/utils/blogs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFolder(name: string): TFolder {
	const f = new TFolder();
	f.name = name;
	f.path = name;
	f.children = [];
	return f;
}

function makeFile(folderName: string): TFile {
	const f = new TFile();
	f.name = 'index.md';
	f.path = `${folderName}/index.md`;
	f.extension = 'md';
	f.basename = 'index';
	return f;
}

function makeSummary(
	folderName: string,
	date: Date | null,
	overrides: Partial<BlogSummary> = {},
): BlogSummary {
	return {
		file: makeFile(folderName),
		folder: makeFolder(folderName),
		title: folderName,
		date,
		url: null,
		categorySlugs: [],
		tags: [],
		coverFile: null,
		coverSrc: null,
		coverAlt: '',
		draft: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// sortBlogsByDate
// ---------------------------------------------------------------------------

describe('sortBlogsByDate', () => {
	it('sorts newest first', () => {
		const posts = [
			makeSummary('a', new Date('2023-01-01')),
			makeSummary('b', new Date('2024-06-15')),
			makeSummary('c', new Date('2022-12-31')),
		];
		const sorted = sortBlogsByDate(posts);
		expect(sorted.map((p) => p.folder.name)).toEqual(['b', 'a', 'c']);
	});

	it('sinks posts with null dates to the bottom', () => {
		const posts = [
			makeSummary('no-date', null),
			makeSummary('recent', new Date('2024-01-01')),
			makeSummary('old', new Date('2020-01-01')),
		];
		const sorted = sortBlogsByDate(posts);
		expect(sorted[0]!.folder.name).toBe('recent');
		expect(sorted[1]!.folder.name).toBe('old');
		expect(sorted[2]!.folder.name).toBe('no-date');
	});

	it('breaks ties by folder name ascending', () => {
		const d = new Date('2024-01-01');
		const posts = [
			makeSummary('zebra', d),
			makeSummary('alpha', d),
			makeSummary('mango', d),
		];
		const sorted = sortBlogsByDate(posts);
		expect(sorted.map((p) => p.folder.name)).toEqual(['alpha', 'mango', 'zebra']);
	});

	it('breaks null-date ties by folder name ascending', () => {
		const posts = [
			makeSummary('z-post', null),
			makeSummary('a-post', null),
		];
		const sorted = sortBlogsByDate(posts);
		expect(sorted[0]!.folder.name).toBe('a-post');
		expect(sorted[1]!.folder.name).toBe('z-post');
	});

	it('does not mutate the input array', () => {
		const posts = [
			makeSummary('b', new Date('2024-01-01')),
			makeSummary('a', new Date('2025-01-01')),
		];
		const original = [...posts];
		sortBlogsByDate(posts);
		expect(posts[0]!.folder.name).toBe(original[0]!.folder.name);
	});

	it('returns an empty array when passed an empty array', () => {
		expect(sortBlogsByDate([])).toEqual([]);
	});
});

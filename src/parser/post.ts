import type { TFile } from 'obsidian';
import {
	type AstNode,
	type CoverFrontmatter,
	type ImageEntry,
	type ParsedPost,
	type ReferencedImageEntry,
	type ShortcodeNode,
	type UnreferencedImageEntry,
} from '../types';
import { applyEdits, parse, serializeShortcodeOpen, type Edit } from './shortcodes';

/**
 * Adapter interface used by post.ts so its core functions can be exercised in
 * unit tests without an Obsidian `App`. Production wiring is in `view/` /
 * `main.ts`.
 */
export interface PostAdapter {
	readBody(file: TFile): Promise<string>;
	getFrontmatter(file: TFile): Record<string, unknown> | undefined;
	listImageFiles(post: TFile): TFile[];
	resolveImageFile(post: TFile, src: string): TFile | null;
	processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
	processBody(file: TFile, fn: (data: string) => string): Promise<void>;
}

/* ---------------------------------------------------------------------------
 * Frontmatter <-> body splitting
 * ------------------------------------------------------------------------- */

interface SplitContent {
	frontmatterRaw: string | null;
	body: string;
	bodyStart: number;
}

export function splitFrontmatter(raw: string): SplitContent {
	if (!raw.startsWith('---')) {
		return { frontmatterRaw: null, body: raw, bodyStart: 0 };
	}
	// Find the closing `---` on its own line.
	const re = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*\r?\n?/;
	const m = re.exec(raw);
	if (!m) {
		return { frontmatterRaw: null, body: raw, bodyStart: 0 };
	}
	const matched = m[0];
	return {
		frontmatterRaw: matched,
		body: raw.slice(matched.length),
		bodyStart: matched.length,
	};
}

/* ---------------------------------------------------------------------------
 * Reading a post
 * ------------------------------------------------------------------------- */

export async function readPost(adapter: PostAdapter, file: TFile): Promise<ParsedPost> {
	const raw = await adapter.readBody(file);
	const { body, bodyStart } = splitFrontmatter(raw);
	const ast = parse(body);
	const cover = extractCover(adapter.getFrontmatter(file));
	const folderImages = adapter.listImageFiles(file);

	const { images, needsMigration } = buildImageEntries(
		adapter,
		file,
		ast,
		cover,
		folderImages,
	);

	return { file, body, bodyStart, ast, cover, images, needsMigration };
}

function extractCover(fm: Record<string, unknown> | undefined): CoverFrontmatter | null {
	if (!fm) return null;
	const cover = fm['cover'];
	if (!cover || typeof cover !== 'object') return null;
	const c = cover as Record<string, unknown>;
	if (typeof c['src'] !== 'string') return null;
	const result: CoverFrontmatter = { src: c['src'] };
	if (typeof c['alt'] === 'string') result.alt = c['alt'];
	if (typeof c['caption'] === 'string') result.caption = c['caption'];
	return result;
}

interface BuildResult {
	images: ImageEntry[];
	needsMigration: boolean;
}

function buildImageEntries(
	adapter: PostAdapter,
	post: TFile,
	ast: AstNode[],
	cover: CoverFrontmatter | null,
	folderImages: TFile[],
): BuildResult {
	const referenced: ReferencedImageEntry[] = [];
	const referencedFiles = new Set<TFile>();
	let needsMigration = false;

	// Top-level shortcodes in document order.
	const topLevel = ast.filter(
		(n): n is ShortcodeNode => n.kind === 'shortcode',
	);

	// Cover row: emit at the position of the first cover-related signal in the
	// document. We emit it first if cover frontmatter exists; otherwise it
	// emerges when we encounter the first `figure cover=true`.
	let coverEntry: ReferencedImageEntry | null = null;
	if (cover) {
		coverEntry = {
			kind: 'referenced',
			source: { kind: 'cover' },
			src: cover.src,
			file: adapter.resolveImageFile(post, cover.src),
			alt: cover.alt ?? '',
			caption: cover.caption ?? '',
			isCover: true,
		};
		referenced.push(coverEntry);
		if (coverEntry.file) referencedFiles.add(coverEntry.file);
	}

	let figureIndex = 0;
	let galleryIndex = 0;
	for (const node of topLevel) {
		if (node.name === 'figure') {
			const isCover = node.args.named.get('cover')?.value === 'true';
			if (isCover) {
				// Detect migration need.
				const hasOverrides =
					node.args.named.has('src') ||
					node.args.named.has('alt') ||
					node.args.named.has('caption');
				if (hasOverrides) needsMigration = true;

				if (coverEntry) {
					// Attach this node to the existing cover entry.
					if (coverEntry.source.kind === 'cover') {
						coverEntry.source = {
							kind: 'figure-cover',
							nodeIndexes: [figureIndex],
						};
					} else if (coverEntry.source.kind === 'figure-cover') {
						coverEntry.source.nodeIndexes.push(figureIndex);
					}
				} else {
					// No frontmatter cover; synthesise one from this node's args.
					const src = node.args.named.get('src')?.value ?? '';
					const entry: ReferencedImageEntry = {
						kind: 'referenced',
						source: { kind: 'figure-cover', nodeIndexes: [figureIndex] },
						src,
						file: src ? adapter.resolveImageFile(post, src) : null,
						alt: node.args.named.get('alt')?.value ?? '',
						caption: node.args.named.get('caption')?.value ?? '',
						isCover: true,
					};
					referenced.push(entry);
					coverEntry = entry;
					if (entry.file) referencedFiles.add(entry.file);
				}
			} else {
				const src = node.args.named.get('src')?.value;
				if (!src) {
					figureIndex++;
					continue;
				}
				const entry: ReferencedImageEntry = {
					kind: 'referenced',
					source: { kind: 'figure', nodeIndex: figureIndex },
					src,
					file: adapter.resolveImageFile(post, src),
					alt: node.args.named.get('alt')?.value ?? '',
					caption: node.args.named.get('caption')?.value ?? '',
					isCover: false,
				};
				referenced.push(entry);
				if (entry.file) referencedFiles.add(entry.file);
			}
			figureIndex++;
			continue;
		}

		if (node.name === 'gallery') {
			const childFigures = node.children.filter(
				(c): c is ShortcodeNode => c.kind === 'shortcode' && c.name === 'figure',
			);
			let childIndex = 0;
			for (const child of childFigures) {
				const src = child.args.named.get('src')?.value;
				if (!src) {
					childIndex++;
					continue;
				}
				const entry: ReferencedImageEntry = {
					kind: 'referenced',
					source: { kind: 'gallery-item', galleryIndex, childIndex },
					src,
					file: adapter.resolveImageFile(post, src),
					alt: child.args.named.get('alt')?.value ?? '',
					caption: child.args.named.get('caption')?.value ?? '',
					isCover: false,
				};
				referenced.push(entry);
				if (entry.file) referencedFiles.add(entry.file);
				childIndex++;
			}
			galleryIndex++;
			continue;
		}
	}

	const unreferenced: UnreferencedImageEntry[] = [];
	for (const file of folderImages) {
		if (referencedFiles.has(file)) continue;
		unreferenced.push({ kind: 'unreferenced', src: deriveSrcFromFile(post, file), file });
	}

	return { images: [...referenced, ...unreferenced], needsMigration };
}

function deriveSrcFromFile(post: TFile, image: TFile): string {
	const folder = post.parent?.path ?? '';
	if (folder && image.path.startsWith(`${folder}/`)) {
		return image.path.slice(folder.length + 1);
	}
	return image.path;
}

/* ---------------------------------------------------------------------------
 * Helpers used by post mutations (also reused by the view's optimistic preview
 * if needed in future).
 * ------------------------------------------------------------------------- */

/**
 * Resolve a logical entry (from `ParsedPost.images`) back to its underlying
 * shortcode node in the AST, if any. Returns null for `cover`-only entries
 * (frontmatter only, no shortcode location).
 */
export function findShortcodeForEntry(
	ast: AstNode[],
	entry: ReferencedImageEntry,
): ShortcodeNode | null {
	const topLevel = ast.filter((n): n is ShortcodeNode => n.kind === 'shortcode');

	// Build a list of top-level figure nodes paired with their figureIndex,
	// which matches the counter used in buildImageEntries: increments only for
	// figure nodes, not for galleries or other shortcodes.
	let fi = 0;
	const figures: { node: ShortcodeNode; figureIndex: number }[] = [];
	for (const node of topLevel) {
		if (node.name === 'figure') {
			figures.push({ node, figureIndex: fi });
			fi++;
		}
	}

	switch (entry.source.kind) {
		case 'cover':
			return null;
		case 'figure': {
			const target = entry.source.nodeIndex;
			return figures.find(({ figureIndex }) => figureIndex === target)?.node ?? null;
		}
		case 'figure-cover': {
			const first = entry.source.nodeIndexes[0];
			if (first === undefined) return null;
			return figures.find(({ figureIndex }) => figureIndex === first)?.node ?? null;
		}
		case 'gallery-item': {
			const source = entry.source;
			let gIdx = 0;
			for (const node of topLevel) {
				if (node.name !== 'gallery') continue;
				if (gIdx === source.galleryIndex) {
					const childFigures = node.children.filter(
						(c): c is ShortcodeNode => c.kind === 'shortcode' && c.name === 'figure',
					);
					return childFigures[source.childIndex] ?? null;
				}
				gIdx++;
			}
			return null;
		}
	}
}

export function findFigureCoverNodes(ast: AstNode[]): ShortcodeNode[] {
	const out: ShortcodeNode[] = [];
	for (const node of ast) {
		if (node.kind === 'shortcode' && node.name === 'figure' && node.args.named.get('cover')?.value === 'true') {
			out.push(node);
		}
	}
	return out;
}

/* ---------------------------------------------------------------------------
 * Body mutation primitives. These are pure: given a body string, return a new
 * body string. The view layer wraps these in `vault.process` calls.
 * ------------------------------------------------------------------------- */

export function setShortcodeArgs(
	body: string,
	node: ShortcodeNode,
	updates: Partial<{ alt: string; caption: string; src: string }>,
): string {
	const mutate = (args: ShortcodeNode['args']) => {
		if (updates.alt !== undefined) {
			if (updates.alt === '') args.named.delete('alt');
			else args.named.set('alt', { value: updates.alt });
		}
		if (updates.caption !== undefined) {
			if (updates.caption === '') args.named.delete('caption');
			else args.named.set('caption', { value: updates.caption });
		}
		if (updates.src !== undefined) {
			if (updates.src === '') args.named.delete('src');
			else args.named.set('src', { value: updates.src });
		}
	};
	const newArgs: ShortcodeNode['args'] = {
		named: new Map(node.args.named),
		positional: [...node.args.positional],
	};
	mutate(newArgs);
	const newNode: ShortcodeNode = { ...node, args: newArgs };
	const openEnd = node.selfClosing ? node.end : node.innerStart ?? node.end;
	const replacement = serializeShortcodeOpen(newNode);
	return applyEdits(body, [{ start: node.start, end: openEnd, replacement }]);
}

/**
 * Set or clear the `cover=true` arg on the figure shortcode at `nodeIndex`
 * (using the same figure-index counter as `buildImageEntries`). Pass
 * `coverValue = true` to add `cover=true`; pass `false` to remove it.
 *
 * The `src`, `alt`, and `caption` args are stripped when adding `cover=true`
 * because those values live in the frontmatter once the image is a cover.
 * When removing `cover=true`, those args are left untouched (the caller is
 * responsible for re-populating them from the frontmatter if needed — but for
 * the demotion case the whole cover is being cleared anyway).
 */
export function setFigureCoverArg(
	body: string,
	nodeIndex: number,
	coverValue: boolean,
): string {
	const ast = parse(body);
	const topLevel = ast.filter((n): n is ShortcodeNode => n.kind === 'shortcode');
	let fi = 0;
	let target: ShortcodeNode | null = null;
	for (const node of topLevel) {
		if (node.name === 'figure') {
			if (fi === nodeIndex) {
				target = node;
				break;
			}
			fi++;
		}
	}
	if (!target) return body;

	const newArgs: ShortcodeNode['args'] = {
		named: new Map(target.args.named),
		positional: [...target.args.positional],
	};
	if (coverValue) {
		newArgs.named.set('cover', { value: 'true' });
		// Strip src/alt/caption from the shortcode — frontmatter is the source of truth.
		newArgs.named.delete('src');
		newArgs.named.delete('alt');
		newArgs.named.delete('caption');
	} else {
		newArgs.named.delete('cover');
	}
	const newNode: ShortcodeNode = { ...target, args: newArgs };
	const openEnd = target.selfClosing ? target.end : target.innerStart ?? target.end;
	const replacement = serializeShortcodeOpen(newNode);
	return applyEdits(body, [{ start: target.start, end: openEnd, replacement }]);
}

export function appendFigureToBody(body: string, src: string): string {
	const figure = `{{< figure src="${escapeForDoubleQuoted(src)}" >}}`;
	if (body.length === 0) return `${figure}\n`;
	let prefix = body;
	// Ensure exactly one blank line between prior content and the new figure.
	if (!prefix.endsWith('\n')) prefix += '\n';
	if (!prefix.endsWith('\n\n')) prefix += '\n';
	return `${prefix}${figure}\n`;
}

function escapeForDoubleQuoted(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Strip migrating args (`src`, `alt`, `caption`) from every `figure cover=true`
 * shortcode in the body. Returns the new body.
 */
export function stripFigureCoverOverrides(body: string): string {
	const ast = parse(body);
	const nodes = findFigureCoverNodes(ast);
	if (nodes.length === 0) return body;
	const edits: Edit[] = [];
	for (const node of nodes) {
		const newArgs: ShortcodeNode['args'] = {
			named: new Map(),
			positional: [...node.args.positional],
		};
		newArgs.named.set('cover', { value: 'true' });
		const newNode: ShortcodeNode = { ...node, args: newArgs };
		const openEnd = node.selfClosing ? node.end : node.innerStart ?? node.end;
		edits.push({ start: node.start, end: openEnd, replacement: serializeShortcodeOpen(newNode) });
	}
	return applyEdits(body, edits);
}

/* ---------------------------------------------------------------------------
 * Migration: read figure cover=true overrides into a plain object suitable for
 * merging into frontmatter.
 * ------------------------------------------------------------------------- */

export interface CoverMigration {
	src?: string;
	alt?: string;
	caption?: string;
}

export function collectCoverMigration(ast: AstNode[]): CoverMigration {
	const out: CoverMigration = {};
	for (const node of findFigureCoverNodes(ast)) {
		const src = node.args.named.get('src')?.value;
		const alt = node.args.named.get('alt')?.value;
		const caption = node.args.named.get('caption')?.value;
		if (src && out.src === undefined) out.src = src;
		if (alt && out.alt === undefined) out.alt = alt;
		if (caption && out.caption === undefined) out.caption = caption;
	}
	return out;
}

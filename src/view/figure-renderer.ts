import { App, MarkdownPostProcessorContext, Plugin, TFile, editorInfoField, editorLivePreviewField } from 'obsidian';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, StateField, Transaction } from '@codemirror/state';
import { parse, findShortcodes } from '../parser/shortcodes';
import type { ShortcodeNode } from '../types';

// Fast-path guards: only invoke the parser when a shortcode is plausibly present.
const FIGURE_RE = /\{\{<\s*figure[\s/>]/;
const GALLERY_OPEN_RE = /\{\{<\s*gallery[\s>]/;
const GALLERY_RE = /\{\{<\s*gallery[\s/>]/;
const SHORTCODE_RE = /\{\{<\s*(?:figure|gallery)[\s/>]/;

interface FigureAttrs {
	src: string;
	alt: string;
	caption: string;
	maxheight: string;
}

/**
 * Read the cover frontmatter for the file at `sourcePath`, if any.
 * Returns null when no `cover.src` is present.
 */
function getCoverFrontmatter(app: App, sourcePath: string): { src: string; alt: string; caption: string } | null {
	const file = app.vault.getFileByPath(sourcePath);
	if (!file) return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return null;
	const cover = fm['cover'];
	if (!cover || typeof cover !== 'object') return null;
	const c = cover as Record<string, unknown>;
	if (typeof c['src'] !== 'string' || !c['src']) return null;
	return {
		src: c['src'] as string,
		alt: typeof c['alt'] === 'string' ? c['alt'] : '',
		caption: typeof c['caption'] === 'string' ? c['caption'] : '',
	};
}

function attrsFromNode(node: ShortcodeNode, app: App, sourcePath: string): FigureAttrs {
	const isCover = node.args.named.get('cover')?.value === 'true';

	// For cover figures, src/alt/caption come from frontmatter, not the shortcode args.
	if (isCover) {
		const cover = getCoverFrontmatter(app, sourcePath);
		if (cover) {
			return {
				src: cover.src,
				alt: cover.alt,
				caption: cover.caption,
				maxheight: node.args.named.get('maxheight')?.value ?? '',
			};
		}
		// Fallback: cover frontmatter missing, try inline args (pre-migration state).
	}

	return {
		src: node.args.named.get('src')?.value ?? node.args.positional[0]?.value ?? '',
		alt: node.args.named.get('alt')?.value ?? '',
		caption: node.args.named.get('caption')?.value ?? '',
		maxheight: node.args.named.get('maxheight')?.value ?? '',
	};
}

function resolveImageSrc(app: App, src: string, sourcePath: string): string {
	const dir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
	const relativePath = dir ? `${dir}/${src}` : src;
	const file = app.vault.getFileByPath(relativePath);
	if (file instanceof TFile) return app.vault.getResourcePath(file);
	return src;
}

/**
 * Return the number of columns for a gallery node.
 * Defaults to 3 (per project convention). Clamped to 1–4.
 */
function getGalleryCols(node: ShortcodeNode): number {
	const raw = node.args.named.get('cols')?.value;
	if (!raw) return 3;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n)) return 3;
	return Math.max(1, Math.min(4, n));
}

/* ---------------------------------------------------------------------------
 * DOM construction helpers
 * ------------------------------------------------------------------------- */

/**
 * Build a standalone `<figure class="hugo-figure">` element.
 */
function buildFigureElement(app: App, attrs: FigureAttrs, sourcePath: string): HTMLElement {
	const figure = document.createElement('figure');
	figure.className = 'hugo-figure';

	const img = document.createElement('img');
	img.className = 'hugo-figure-img';
	img.src = resolveImageSrc(app, attrs.src, sourcePath);
	img.alt = attrs.alt;
	if (attrs.maxheight) img.style.maxHeight = `${attrs.maxheight}px`;
	figure.appendChild(img);

	if (attrs.caption) {
		const cap = document.createElement('figcaption');
		cap.className = 'hugo-figure-caption';
		cap.textContent = attrs.caption;
		figure.appendChild(cap);
	}

	return figure;
}

/**
 * Build a `<figure class="hugo-gallery-item">` for use inside a gallery div.
 */
function buildGalleryItemElement(attrs: FigureAttrs, resolvedSrc: string): HTMLElement {
	const figure = document.createElement('figure');
	figure.className = 'hugo-gallery-item';

	const img = document.createElement('img');
	img.className = 'hugo-gallery-item-img';
	img.src = resolvedSrc;
	img.alt = attrs.alt;
	figure.appendChild(img);

	if (attrs.caption) {
		const cap = document.createElement('figcaption');
		cap.className = 'hugo-gallery-item-caption';
		cap.textContent = attrs.caption;
		figure.appendChild(cap);
	}

	return figure;
}

/**
 * Build a `<div class="hugo-gallery hugo-gallery-cols-N">` containing one
 * gallery item per `{{< figure >}}` child of the given gallery shortcode node.
 */
function buildGalleryElement(app: App, galleryNode: ShortcodeNode, sourcePath: string): HTMLElement {
	const cols = getGalleryCols(galleryNode);
	const div = document.createElement('div');
	div.className = `hugo-gallery hugo-gallery-cols-${cols}`;

	const childFigures = galleryNode.children.filter(
		(c): c is ShortcodeNode => c.kind === 'shortcode' && c.name === 'figure',
	);

	for (const child of childFigures) {
		const attrs = attrsFromNode(child, app, sourcePath);
		const resolvedSrc = resolveImageSrc(app, attrs.src, sourcePath);
		div.appendChild(buildGalleryItemElement(attrs, resolvedSrc));
	}

	return div;
}

/* ---------------------------------------------------------------------------
 * CodeMirror widgets — live preview mode
 * ------------------------------------------------------------------------- */

class FigureWidget extends WidgetType {
	constructor(
		private readonly attrs: FigureAttrs,
		private readonly resolvedSrc: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const figure = document.createElement('figure');
		figure.className = 'hugo-figure';

		const img = document.createElement('img');
		img.className = 'hugo-figure-img';
		img.src = this.resolvedSrc;
		img.alt = this.attrs.alt;
		if (this.attrs.maxheight) img.style.maxHeight = `${this.attrs.maxheight}px`;
		figure.appendChild(img);

		if (this.attrs.caption) {
			const cap = document.createElement('figcaption');
			cap.className = 'hugo-figure-caption';
			cap.textContent = this.attrs.caption;
			figure.appendChild(cap);
		}

		return figure;
	}

	eq(other: FigureWidget): boolean {
		return (
			other.resolvedSrc === this.resolvedSrc &&
			other.attrs.alt === this.attrs.alt &&
			other.attrs.caption === this.attrs.caption &&
			other.attrs.maxheight === this.attrs.maxheight
		);
	}
}

interface GalleryItem {
	resolvedSrc: string;
	alt: string;
	caption: string;
}

class GalleryWidget extends WidgetType {
	constructor(
		private readonly cols: number,
		private readonly items: GalleryItem[],
	) {
		super();
	}

	toDOM(): HTMLElement {
		const div = document.createElement('div');
		div.className = `hugo-gallery hugo-gallery-cols-${this.cols}`;
		console.log('[hugo] GalleryWidget.toDOM cols=', this.cols, 'className=', div.className, 'items=', this.items.length);

		for (const item of this.items) {
			div.appendChild(buildGalleryItemElement(
				{ src: item.resolvedSrc, alt: item.alt, caption: item.caption, maxheight: '' },
				item.resolvedSrc,
			));
		}

		return div;
	}

	eq(other: GalleryWidget): boolean {
		if (other.cols !== this.cols) return false;
		if (other.items.length !== this.items.length) return false;
		for (let i = 0; i < this.items.length; i++) {
			const a = this.items[i]!;
			const b = other.items[i]!;
			if (a.resolvedSrc !== b.resolvedSrc || a.alt !== b.alt || a.caption !== b.caption) return false;
		}
		return true;
	}
}

/* ---------------------------------------------------------------------------
 * Live preview decoration builder
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Live preview — figure decorations (ViewPlugin, inline replacements only)
 * ------------------------------------------------------------------------- */

function buildFigureDecorations(state: EditorView['state'], app: App): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	if (!state.field(editorLivePreviewField, false)) return builder.finish();

	const cursor = state.selection.main.head;
	const sourcePath = state.field(editorInfoField, false)?.file?.path ?? '';

	const fullText = state.doc.toString();
	if (!FIGURE_RE.test(fullText)) return builder.finish();

	let ast;
	try {
		ast = parse(fullText);
	} catch (e) {
		return builder.finish();
	}

	for (const node of ast) {
		if (node.kind !== 'shortcode' || node.name !== 'figure') continue;

		const start = node.start;
		const end = node.end;

		const startLine = state.doc.lineAt(start);
		const endLine = state.doc.lineAt(end);
		const cursorInside = cursor >= startLine.from && cursor <= endLine.to;
		if (cursorInside) continue;

		const attrs = attrsFromNode(node, app, sourcePath);
		const resolvedSrc = resolveImageSrc(app, attrs.src, sourcePath);
		builder.add(start, end, Decoration.replace({ widget: new FigureWidget(attrs, resolvedSrc), block: true }));
	}

	return builder.finish();
}

function makeFigureStateField(app: App): StateField<DecorationSet> {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildFigureDecorations(state, app);
		},
		update(decorations, tr: Transaction) {
			if (!tr.docChanged && !tr.selection) return decorations;
			return buildFigureDecorations(tr.state, app);
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});
}

/* ---------------------------------------------------------------------------
 * Live preview — gallery decorations (StateField, block replacements)
 * StateField is required for block-level Decoration.replace — ViewPlugin does
 * not support them.
 * ------------------------------------------------------------------------- */

function buildGalleryDecorations(state: EditorView['state'], app: App): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	if (!state.field(editorLivePreviewField, false)) return builder.finish();

	const cursor = state.selection.main.head;
	const sourcePath = state.field(editorInfoField, false)?.file?.path ?? '';

	const fullText = state.doc.toString();
	if (!GALLERY_RE.test(fullText)) return builder.finish();

	let ast;
	try {
		ast = parse(fullText);
	} catch (e) {
		console.log('[hugo] gallery parse error:', e);
		return builder.finish();
	}

	console.log('[hugo] gallery StateField: top-level nodes:', ast.map(n => n.kind === 'shortcode' ? `${n.name}(children:${n.children.length})` : 'text'));

	for (const node of ast) {
		if (node.kind !== 'shortcode' || node.name !== 'gallery') continue;

		const start = node.start;
		const end = node.end;

		const startLine = state.doc.lineAt(start);
		const endLine = state.doc.lineAt(end);
		const cursorInside = cursor >= startLine.from && cursor <= endLine.to;
		console.log('[hugo] gallery node start=', start, 'end=', end, 'cursorInside=', cursorInside);
		if (cursorInside) continue;

		const cols = getGalleryCols(node);
		const items: GalleryItem[] = node.children
			.filter((c): c is ShortcodeNode => c.kind === 'shortcode' && c.name === 'figure')
			.map((child) => {
				const attrs = attrsFromNode(child, app, sourcePath);
				return {
					resolvedSrc: resolveImageSrc(app, attrs.src, sourcePath),
					alt: attrs.alt,
					caption: attrs.caption,
				};
			});

		console.log('[hugo] gallery: adding GalleryWidget cols=', cols, 'items=', items.length);
		builder.add(start, end, Decoration.replace({ widget: new GalleryWidget(cols, items), block: true }));
	}

	return builder.finish();
}

function makeGalleryStateField(app: App): StateField<DecorationSet> {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildGalleryDecorations(state, app);
		},
		update(decorations, tr: Transaction) {
			if (!tr.docChanged && !tr.selection) return decorations;
			return buildGalleryDecorations(tr.state, app);
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});
}

export function createFigureEditorExtension(app: App) {
	const figureField = makeFigureStateField(app);
	const galleryField = makeGalleryStateField(app);
	return [figureField, galleryField];
}

/* ---------------------------------------------------------------------------
 * Markdown post-processor — reading view
 * ------------------------------------------------------------------------- */

/**
 * Walk forward through `startEl`'s siblings (inclusive) looking for the first
 * `<p>` whose text content contains `{{< /gallery`. Returns the array of
 * sibling elements from `startEl` through the closing tag paragraph, or null
 * if no close tag is found within the same parent.
 */
function collectGalleryParagraphs(startEl: HTMLElement): HTMLElement[] | null {
	const result: HTMLElement[] = [];
	let el: Element | null = startEl;

	while (el !== null) {
		if (el instanceof HTMLElement) {
			result.push(el);
			if (el !== startEl && el.textContent?.includes('{{< /gallery')) {
				return result;
			}
		}
		el = el.nextElementSibling;
	}

	// No closing tag found in the same parent.
	return null;
}

export function registerFigurePostProcessor(app: App, plugin: Plugin): void {
	plugin.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
		const { sourcePath } = context;
		console.log('[hugo] post-processor called, sourcePath=', sourcePath, 'element.innerHTML snippet=', element.innerHTML.slice(0, 200));

		// --- Pass 1: replace gallery shortcodes ---
		// Work off a snapshot of current <p> elements because we'll mutate the DOM.
		const paragraphs = Array.from(element.querySelectorAll('p'));
		console.log('[hugo] post-processor found', paragraphs.length, 'paragraphs');

		for (const p of paragraphs) {
			// Skip if already removed by a prior iteration (e.g. a sibling of a
			// previously processed gallery).
			if (!p.isConnected) continue;

			const text = p.textContent ?? '';
			const galleryMatch = GALLERY_OPEN_RE.test(text);
			console.log('[hugo] paragraph text=', JSON.stringify(text.slice(0, 80)), 'galleryMatch=', galleryMatch);
			if (!galleryMatch) continue;

			// Collect this <p> and all siblings up to and including the close tag.
			const run = collectGalleryParagraphs(p);
			console.log('[hugo] collectGalleryParagraphs returned', run === null ? 'null' : `${run.length} elements`);
			if (run === null) continue;

			// Join the text of the run to feed into the parser.
			const joined = run.map((el) => el.textContent ?? '').join('\n');
			console.log('[hugo] joined gallery text (first 200)=', JSON.stringify(joined.slice(0, 200)));

			let ast;
			try {
				ast = parse(joined);
			} catch (e) {
				console.log('[hugo] gallery parse error:', e);
				continue;
			}

			const galleries = findShortcodes(ast, 'gallery');
			console.log('[hugo] found', galleries.length, 'gallery nodes in AST');
			if (galleries.length === 0) continue;

			// Build replacement DOM: one gallery div per parsed gallery node.
			const fragment = document.createDocumentFragment();
			for (const node of galleries) {
				const el = buildGalleryElement(app, node, sourcePath);
				console.log('[hugo] built gallery div with', el.children.length, 'items');
				fragment.appendChild(el);
			}

			// Replace the entire run of <p> elements with the gallery div(s).
			// Insert before the first element, then remove all elements in the run.
			run[0]!.before(fragment);
			for (const el of run) el.remove();
		}

		// --- Pass 2: replace standalone figure shortcodes ---
		// Re-query so we only visit <p>s still in the DOM after the gallery pass.
		element.querySelectorAll('p').forEach((p) => {
			const text = p.textContent ?? '';
			if (!FIGURE_RE.test(text)) return;

			let ast;
			try {
				ast = parse(text);
			} catch {
				return;
			}

			const figures = findShortcodes(ast, 'figure');
			if (figures.length === 0) return;

			console.log('[hugo] replacing', figures.length, 'standalone figure(s) in paragraph');
			// Replace the paragraph with one <figure> element per shortcode found.
			const fragment = document.createDocumentFragment();
			for (const node of figures) {
				fragment.appendChild(buildFigureElement(app, attrsFromNode(node, app, sourcePath), sourcePath));
			}
			p.replaceWith(fragment);
		});
	});
}

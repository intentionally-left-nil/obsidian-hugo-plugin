import type { App, TFile } from 'obsidian';
import { setIcon } from 'obsidian';
import type { ImageEntry, ReferencedImageEntry, UnreferencedImageEntry } from '../types';
import { isExternalUrl, isInsidePostBundle } from '../utils/paths';

export interface ImageCardCallbacks {
	onAltChanged(entry: ReferencedImageEntry, value: string): void;
	onCaptionChanged(entry: ReferencedImageEntry, value: string): void;
	onMaxHeightChanged(entry: ReferencedImageEntry, value: string): void;
	onCoverChanged(entry: ReferencedImageEntry, isCover: boolean): void;
	onInsert(entry: UnreferencedImageEntry): void;
	onDelete(entry: ImageEntry): void;
}

const DEBOUNCE_MS = 300;

export function renderCard(
	parent: HTMLElement,
	app: App,
	post: TFile,
	entry: ImageEntry,
	callbacks: ImageCardCallbacks,
): void {
	const card = parent.createDiv({ cls: 'hugo-image-card' });
	if (entry.kind === 'referenced' && entry.isCover) card.addClass('is-cover');
	if (entry.kind === 'unreferenced') card.addClass('is-unreferenced');

	renderThumbnail(card, app, entry);

	const fields = card.createDiv({ cls: 'hugo-image-fields' });

	// Top row: src path + delete button
	const srcRow = fields.createDiv({ cls: 'hugo-image-src-row' });
	srcRow.createDiv({ cls: 'hugo-image-src', text: entry.src });
	const deleteBtn = srcRow.createEl('button', {
		cls: 'hugo-image-delete-btn',
		attr: { 'aria-label': 'Delete image' },
	});
	setIcon(deleteBtn, 'trash-2');
	deleteBtn.addEventListener('click', () => callbacks.onDelete(entry));

	if (entry.kind === 'referenced') {
		renderReferencedFields(fields, post, entry, callbacks);
	} else {
		renderUnreferencedActions(fields, entry, callbacks);
	}
}

function renderThumbnail(card: HTMLElement, app: App, entry: ImageEntry): void {
	const thumb = card.createDiv({ cls: 'hugo-image-thumb' });
	const file = entry.kind === 'referenced' ? entry.file : entry.file;
	if (file) {
		const url = app.vault.getResourcePath(file);
		const img = thumb.createEl('img');
		img.src = url;
		img.alt = entry.kind === 'referenced' ? entry.alt : '';
	} else if (isExternalUrl(entry.src)) {
		const img = thumb.createEl('img');
		img.src = entry.src;
		img.alt = entry.kind === 'referenced' ? entry.alt : '';
		img.referrerPolicy = 'no-referrer';
	} else {
		thumb.createDiv({
			cls: 'hugo-image-thumb-empty',
			text: entry.src,
		});
	}
}

function renderReferencedFields(
	fields: HTMLElement,
	post: TFile,
	entry: ReferencedImageEntry,
	callbacks: ImageCardCallbacks,
): void {
	const sourceLabel = describeSource(entry);
	if (sourceLabel !== null) {
		fields.createDiv({ cls: 'hugo-image-source-badge', text: sourceLabel });
	}

	const altRow = fields.createDiv({ cls: 'hugo-image-input-row' });
	altRow.createEl('span', { cls: 'hugo-image-input-label', text: 'A', attr: { title: 'Alt text' } });
	const altInput = altRow.createEl('textarea', {
		cls: 'hugo-image-input',
		attr: { placeholder: 'Alt text', rows: '1' },
	});
	altInput.value = entry.alt;
	registerExpandingTextarea(altInput);
	registerDebouncedTextarea(altInput, (value) => callbacks.onAltChanged(entry, value));

	const captionRow = fields.createDiv({ cls: 'hugo-image-input-row' });
	captionRow.createEl('span', { cls: 'hugo-image-input-label', text: 'C', attr: { title: 'Caption' } });
	const captionInput = captionRow.createEl('textarea', {
		cls: 'hugo-image-input',
		attr: { placeholder: 'Caption', rows: '1' },
	});
	captionInput.value = entry.caption;
	registerExpandingTextarea(captionInput);
	registerDebouncedTextarea(captionInput, (value) => callbacks.onCaptionChanged(entry, value));

	// Max height — only for shortcode-backed figure entries (not cover-only or gallery-item).
	const src = entry.source;
	if (src.kind === 'figure' || src.kind === 'figure-cover') {
		const maxhRow = fields.createDiv({ cls: 'hugo-image-input-row' });
		maxhRow.createEl('span', { cls: 'hugo-image-input-label', text: 'H', attr: { title: 'Max height (px)' } });
		const maxhInput = maxhRow.createEl('input', {
			type: 'text',
			cls: 'hugo-image-maxheight-input',
			attr: { placeholder: 'Max height (px)', inputmode: 'numeric', pattern: '[0-9]*' },
		});
		maxhInput.value = entry.maxheight;
		registerDebouncedInput(maxhInput, (value) => callbacks.onMaxHeightChanged(entry, value));
	}

	const coverRow = fields.createDiv({ cls: 'hugo-image-cover-row' });
	const coverCheckbox = coverRow.createEl('input', { type: 'checkbox' });
	coverCheckbox.checked = entry.isCover;
	const id = `hugo-image-cover-${cryptoRandom()}`;
	coverCheckbox.id = id;
	const label = coverRow.createEl('label', { text: 'Cover image', attr: { for: id } });

	const postFolder = post.parent?.path ?? '';
	const eligible = isInsidePostBundle(entry.src, postFolder);
	if (!eligible) {
		coverCheckbox.disabled = true;
		label.setAttr('title', 'Cover image must live inside the post folder.');
	}

	coverCheckbox.addEventListener('change', () => {
		callbacks.onCoverChanged(entry, coverCheckbox.checked);
	});
}

function renderUnreferencedActions(
	fields: HTMLElement,
	entry: UnreferencedImageEntry,
	callbacks: ImageCardCallbacks,
): void {
	fields.createDiv({
		cls: 'hugo-image-source-badge',
		text: 'Not referenced in post',
	});
	const actions = fields.createDiv({ cls: 'hugo-image-actions' });
	const button = actions.createEl('button', {
		cls: 'hugo-image-insert mod-cta',
		text: 'Insert figure',
	});
	button.addEventListener('click', () => callbacks.onInsert(entry));
}

function describeSource(entry: ReferencedImageEntry): string | null {
	switch (entry.source.kind) {
		case 'cover':
			return 'Cover (frontmatter)';
		case 'figure-cover':
			return 'Cover (frontmatter + figure cover=true)';
		case 'figure':
			return null;
		case 'gallery-item':
			return `Gallery ${entry.source.galleryIndex + 1} • item ${entry.source.childIndex + 1}`;
	}
}

function registerExpandingTextarea(textarea: HTMLTextAreaElement): void {
	const collapse = (): void => {
		textarea.rows = 1;
	};
	const expand = (): void => {
		// Temporarily auto-size to content height, then convert to rows
		textarea.style.height = 'auto';
		const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
		const padding =
			parseFloat(getComputedStyle(textarea).paddingTop) +
			parseFloat(getComputedStyle(textarea).paddingBottom);
		const rows = Math.max(1, Math.round((textarea.scrollHeight - padding) / lineHeight));
		textarea.style.height = '';
		textarea.rows = rows;
	};
	textarea.addEventListener('focus', expand);
	textarea.addEventListener('input', expand);
	textarea.addEventListener('blur', collapse);
}

function registerDebouncedTextarea(textarea: HTMLTextAreaElement, onChange: (value: string) => void): void {
	let timer: number | null = null;
	textarea.addEventListener('input', () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			onChange(textarea.value);
		}, DEBOUNCE_MS);
	});
	textarea.addEventListener('blur', () => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
			onChange(textarea.value);
		}
	});
}

function registerDebouncedInput(input: HTMLInputElement, onChange: (value: string) => void): void {
	let timer: number | null = null;
	input.addEventListener('input', () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			onChange(input.value);
		}, DEBOUNCE_MS);
	});
	input.addEventListener('blur', () => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
			onChange(input.value);
		}
	});
}

function cryptoRandom(): string {
	return Math.random().toString(36).slice(2, 10);
}

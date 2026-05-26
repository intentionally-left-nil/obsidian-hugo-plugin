/**
 * Modal that collects the title and category for a new Hugo blog post.
 * Modelled after AddImageModal.
 */

import { Modal, type App } from 'obsidian';
import type { CategoryEntry } from '../utils/categories';

export interface NewBlogChoice {
	title: string;
	category: CategoryEntry;
}

/**
 * Simple two-field modal: Title (text input) + Category (select).
 * Calls `onSubmit` then closes; the caller owns creation and error handling.
 */
export class NewBlogModal extends Modal {
	private readonly categories: CategoryEntry[];
	private readonly onSubmit: (choice: NewBlogChoice) => void;

	private titleInput: HTMLInputElement | null = null;
	private categorySelect: HTMLSelectElement | null = null;
	private createButton: HTMLButtonElement | null = null;
	private errorEl: HTMLElement | null = null;

	constructor(
		app: App,
		categories: CategoryEntry[],
		onSubmit: (choice: NewBlogChoice) => void,
	) {
		super(app);
		this.categories = categories;
		this.onSubmit = onSubmit;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('hugo-new-blog-modal');

		contentEl.createEl('h2', { text: 'New blog post' });

		// ── Title ────────────────────────────────────────────────────────────
		const titleRow = contentEl.createDiv({ cls: 'hugo-new-blog-field' });
		titleRow.createEl('label', { text: 'Title', attr: { for: 'hugo-new-blog-title' } });
		const titleInput = titleRow.createEl('input', {
			type: 'text',
			attr: { id: 'hugo-new-blog-title', placeholder: 'My awesome post' },
		});
		titleInput.addEventListener('input', () => this.updateCreateButton());
		titleInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.handleSubmit();
		});
		this.titleInput = titleInput;

		// ── Category ─────────────────────────────────────────────────────────
		const catRow = contentEl.createDiv({ cls: 'hugo-new-blog-field' });
		catRow.createEl('label', { text: 'Category', attr: { for: 'hugo-new-blog-category' } });

		if (this.categories.length === 0) {
			catRow.createEl('p', {
				cls: 'hugo-new-blog-no-categories',
				text: 'No categories found. Check that the category/ folder exists next to your vault.',
			});
		} else {
			const select = catRow.createEl('select', {
				attr: { id: 'hugo-new-blog-category' },
			});
			for (const cat of this.categories) {
				select.createEl('option', { value: cat.slug, text: cat.title });
			}
			this.categorySelect = select;
		}

		// ── Inline error ──────────────────────────────────────────────────────
		this.errorEl = contentEl.createDiv({ cls: 'hugo-new-blog-error' });
		this.errorEl.style.display = 'none';

		// ── Actions ───────────────────────────────────────────────────────────
		const actions = contentEl.createDiv({ cls: 'hugo-new-blog-actions' });
		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const createBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Create' });
		createBtn.disabled = true;
		createBtn.addEventListener('click', () => this.handleSubmit());
		this.createButton = createBtn;

		// Auto-focus title.
		setTimeout(() => titleInput.focus(), 0);
		this.updateCreateButton();
	}

	override onClose(): void {
		this.contentEl.empty();
		this.titleInput = null;
		this.categorySelect = null;
		this.createButton = null;
		this.errorEl = null;
	}

	/** Show an inline error message without closing the modal. */
	showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.textContent = message;
		this.errorEl.style.display = '';
	}

	private updateCreateButton(): void {
		if (!this.createButton) return;
		const titleOk = (this.titleInput?.value.trim().length ?? 0) > 0;
		const catOk = this.categories.length > 0;
		this.createButton.disabled = !(titleOk && catOk);
	}

	private handleSubmit(): void {
		if (this.createButton?.disabled) return;

		const title = this.titleInput?.value.trim() ?? '';
		if (!title) return;

		const slug = this.categorySelect?.value ?? this.categories[0]?.slug;
		if (!slug) return;

		const category = this.categories.find((c) => c.slug === slug);
		if (!category) return;

		this.onSubmit({ title, category });
		this.close();
	}
}

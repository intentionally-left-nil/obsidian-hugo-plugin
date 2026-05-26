/**
 * Main-pane view that lists all Hugo blog posts in the vault, newest first.
 *
 * Columns: Cover thumbnail · Title · Date · Category · Tags
 * Double-click a row to open the post in a new tab.
 * "New blog" button scaffolds a post via NewBlogModal + createBlogPost().
 */

import {
	ItemView,
	Notice,
	TFile,
	type App,
	type WorkspaceLeaf,
} from 'obsidian';
import { FileSystemAdapter } from 'obsidian';
import { listHugoPosts, sortBlogsByDate, type BlogSummary } from '../utils/blogs';
import { loadCategoriesFromDisk, type CategoryEntry } from '../utils/categories';
import { createBlogPost, DuplicatePostError, type CreateBlogAdapter } from '../utils/create-blog';
import { NewBlogModal } from './new-blog-modal';

export const VIEW_TYPE_HUGO_BLOGS = 'hugo-blogs-view';

const MAX_TAGS_SHOWN = 4;

export class HugoBlogsView extends ItemView {
	private readonly app2: App;
	private posts: BlogSummary[] = [];
	private categories: CategoryEntry[] = [];
	private categoriesLoadError: string | null = null;
	private renderTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, app: App) {
		super(leaf);
		this.app2 = app;
	}

	getViewType(): string {
		return VIEW_TYPE_HUGO_BLOGS;
	}

	getDisplayText(): string {
		return 'Hugo blogs';
	}

	getIcon(): string {
		return 'newspaper';
	}

	override async onOpen(): Promise<void> {
		// Re-render when frontmatter changes propagate through the metadata cache.
		this.registerEvent(this.app2.metadataCache.on('resolved', () => this.scheduleRender()));
		this.registerEvent(
			this.app2.metadataCache.on('changed', (file) => {
				if (file.name === 'index.md') this.scheduleRender();
			}),
		);

		// Re-render when posts are created, deleted, or renamed.
		this.registerEvent(
			this.app2.vault.on('create', (f) => {
				if (f instanceof TFile && f.name === 'index.md') this.scheduleRender();
			}),
		);
		this.registerEvent(
			this.app2.vault.on('delete', (f) => {
				if (f instanceof TFile && f.name === 'index.md') this.scheduleRender();
			}),
		);
		this.registerEvent(
			this.app2.vault.on('rename', (f, _old) => {
				if (f instanceof TFile && f.name === 'index.md') this.scheduleRender();
			}),
		);

		// Load categories and do the initial render.
		await this.reloadCategories();
		this.render();
	}

	override onClose(): Promise<void> {
		if (this.renderTimer !== null) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		return Promise.resolve();
	}

	// ── Category loading ─────────────────────────────────────────────────────

	private async reloadCategories(): Promise<void> {
		const basePath = this.getVaultBasePath();
		if (!basePath) {
			this.categoriesLoadError = 'Cannot determine vault path (non-filesystem vault?).';
			return;
		}
		try {
			this.categories = await loadCategoriesFromDisk(basePath);
			this.categoriesLoadError = null;
		} catch (err) {
			this.categoriesLoadError =
				err instanceof Error ? err.message : 'Failed to load categories.';
			this.categories = [];
		}
	}

	private getVaultBasePath(): string | null {
		const adapter = this.app2.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		return null;
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	private scheduleRender(): void {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			this.render();
		}, 100);
	}

	private render(): void {
		if (this.shouldSkipRender()) return;

		this.posts = sortBlogsByDate(listHugoPosts(this.app2));

		const container = this.contentEl;
		container.empty();
		container.addClass('hugo-blogs-view');

		this.renderHeader(container);

		if (this.posts.length === 0) {
			container.createDiv({
				cls: 'hugo-blogs-empty',
				text: 'No Hugo posts found.',
			});
			return;
		}

		this.renderTable(container);
	}

	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: 'hugo-blogs-header' });
		header.createEl('h2', { text: 'Hugo blogs', cls: 'hugo-blogs-title' });
		const right = header.createDiv({ cls: 'hugo-blogs-header-right' });
		right.createSpan({
			cls: 'hugo-blogs-count',
			text: `${this.posts.length} post${this.posts.length === 1 ? '' : 's'}`,
		});
		const newBtn = right.createEl('button', { cls: 'hugo-blogs-new-btn mod-cta', text: '+ New blog' });
		newBtn.addEventListener('click', () => void this.handleNewBlog());
	}

	private renderTable(container: HTMLElement): void {
		const table = container.createEl('table', { cls: 'hugo-blogs-table' });

		// Header row
		const thead = table.createEl('thead');
		const hrow = thead.createEl('tr');
		for (const label of ['Cover', 'Title', 'Date', 'Category', 'Tags']) {
			hrow.createEl('th', { text: label });
		}

		const tbody = table.createEl('tbody');
		for (const post of this.posts) {
			this.renderRow(tbody, post);
		}
	}

	private renderRow(tbody: HTMLElement, post: BlogSummary): void {
		const tr = tbody.createEl('tr', { cls: 'hugo-blogs-row' });
		tr.title = 'Double-click to open';

		tr.addEventListener('dblclick', () => {
			void this.app2.workspace.getLeaf('tab').openFile(post.file);
		});

		// Cover
		const coverTd = tr.createEl('td', { cls: 'hugo-blogs-td-cover' });
		if (post.coverFile) {
			const img = coverTd.createEl('img', { cls: 'hugo-blogs-thumb' });
			img.src = this.app2.vault.getResourcePath(post.coverFile);
			img.alt = post.coverAlt;
		} else {
			coverTd.createDiv({ cls: 'hugo-blogs-thumb-placeholder' });
		}

		// Title + draft badge
		const titleTd = tr.createEl('td', { cls: 'hugo-blogs-td-title' });
		titleTd.createSpan({ text: post.title, cls: 'hugo-blogs-post-title' });
		if (post.draft) {
			titleTd.createSpan({ cls: 'hugo-blogs-draft-badge', text: 'Draft' });
		}

		// Date
		const dateTd = tr.createEl('td', { cls: 'hugo-blogs-td-date' });
		dateTd.textContent = post.date ? formatDate(post.date) : '—';

		// Category
		const catTd = tr.createEl('td', { cls: 'hugo-blogs-td-category' });
		if (post.categorySlugs.length > 0) {
			const firstSlug = post.categorySlugs[0]!;
			const catEntry = this.categories.find((c) => c.slug === firstSlug);
			catTd.createSpan({ text: catEntry?.title ?? firstSlug });
			if (post.categorySlugs.length > 1) {
				catTd.createSpan({
					cls: 'hugo-blogs-overflow',
					text: ` +${post.categorySlugs.length - 1}`,
				});
			}
		}

		// Tags
		const tagsTd = tr.createEl('td', { cls: 'hugo-blogs-td-tags' });
		const shown = post.tags.slice(0, MAX_TAGS_SHOWN);
		const overflow = post.tags.length - shown.length;
		for (const tag of shown) {
			tagsTd.createSpan({ cls: 'hugo-blogs-tag', text: tag });
		}
		if (overflow > 0) {
			tagsTd.createSpan({ cls: 'hugo-blogs-overflow', text: `+${overflow} more` });
		}
	}

	private shouldSkipRender(): boolean {
		const active = document.activeElement;
		if (!active) return false;
		if (
			!(active instanceof HTMLInputElement) &&
			!(active instanceof HTMLTextAreaElement) &&
			!(active instanceof HTMLSelectElement)
		) {
			return false;
		}
		return this.contentEl.contains(active);
	}

	// ── New blog flow ─────────────────────────────────────────────────────────

	private async handleNewBlog(): Promise<void> {
		// Always reload categories so they're fresh when the modal opens.
		await this.reloadCategories();

		if (this.categories.length === 0) {
			new Notice(
				this.categoriesLoadError ??
					'No categories found. Check that the category/ folder exists next to your vault.',
			);
			return;
		}

		const openModal = (): void => {
			const modal = new NewBlogModal(this.app2, this.categories, (choice) => {
				void this.runCreate(choice.title, choice.category, openModal);
			});
			modal.open();
		};
		openModal();
	}

	private async runCreate(
		title: string,
		category: CategoryEntry,
		reopenModal: () => void,
	): Promise<void> {
		const adapter = makeObsidianCreateAdapter(this.app2);
		try {
			const newFile = await createBlogPost(adapter, { title, category });
			new Notice(`Created "${title}"`);
			await this.app2.workspace.getLeaf('tab').openFile(newFile);
		} catch (err) {
			if (err instanceof DuplicatePostError) {
				new Notice(err.message);
				reopenModal();
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`Hugo blogs: ${msg}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Obsidian adapter for createBlogPost
// ---------------------------------------------------------------------------

function makeObsidianCreateAdapter(app: App): CreateBlogAdapter {
	return {
		folderExists(path: string): boolean {
			return app.vault.getAbstractFileByPath(path) !== null;
		},
		async createFolder(path: string): Promise<void> {
			await app.vault.createFolder(path);
		},
		async createFile(path: string, contents: string): Promise<TFile> {
			return app.vault.create(path, contents);
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
	const pad2 = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

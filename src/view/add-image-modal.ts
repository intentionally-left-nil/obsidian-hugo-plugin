import { Modal, type App } from 'obsidian';

export type AddImageChoice =
	| { kind: 'file'; file: File }
	| { kind: 'url'; url: string; filename: string };

type Tab = 'disk' | 'url';

/**
 * Modal that lets the user add an image to the current post's images/ folder,
 * either by picking a file from disk or supplying a remote URL.
 */
export class AddImageModal extends Modal {
	private onSubmit: (choice: AddImageChoice) => void;

	private activeTab: Tab = 'disk';

	// Disk tab state
	private pickedFile: File | null = null;
	private fileLabel: HTMLSpanElement | null = null;

	// URL tab state
	private urlInput: HTMLInputElement | null = null;
	private filenameInput: HTMLInputElement | null = null;

	// Shared
	private addButton: HTMLButtonElement | null = null;
	private tabContents: Map<Tab, HTMLElement> = new Map();
	private tabButtons: Map<Tab, HTMLElement> = new Map();

	constructor(app: App, onSubmit: (choice: AddImageChoice) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	override onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('hugo-add-image-modal');

		contentEl.createEl('h2', { text: 'Add image' });

		// Tab bar
		const tabBar = contentEl.createDiv({ cls: 'hugo-add-image-tabs' });
		this.buildTabButton(tabBar, 'disk', 'From disk');
		this.buildTabButton(tabBar, 'url', 'From URL');

		// Tab content area
		const diskContent = contentEl.createDiv({ cls: 'hugo-add-image-tab-content' });
		this.tabContents.set('disk', diskContent);
		this.buildDiskTab(diskContent);

		const urlContent = contentEl.createDiv({ cls: 'hugo-add-image-tab-content' });
		this.tabContents.set('url', urlContent);
		this.buildUrlTab(urlContent);

		// Buttons row
		const actions = contentEl.createDiv({ cls: 'hugo-add-image-actions' });
		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const addBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Add image' });
		addBtn.disabled = true;
		this.addButton = addBtn;
		addBtn.addEventListener('click', () => this.handleSubmit());

		this.switchTab('disk');
	}

	override onClose(): void {
		this.contentEl.empty();
		this.pickedFile = null;
		this.fileLabel = null;
		this.urlInput = null;
		this.filenameInput = null;
		this.addButton = null;
		this.tabContents.clear();
		this.tabButtons.clear();
	}

	private buildTabButton(bar: HTMLElement, tab: Tab, label: string): void {
		const btn = bar.createDiv({ cls: 'hugo-add-image-tab-btn', text: label });
		btn.addEventListener('click', () => this.switchTab(tab));
		this.tabButtons.set(tab, btn);
	}

	private buildDiskTab(container: HTMLElement): void {
		const row = container.createDiv({ cls: 'hugo-add-image-file-row' });

		// Hidden real file input — we trigger it from the button.
		const fileInput = row.createEl('input', { type: 'file' });
		fileInput.accept = 'image/*';
		fileInput.style.display = 'none';

		const chooseBtn = row.createEl('button', { text: 'Choose file…' });
		chooseBtn.addEventListener('click', () => fileInput.click());

		const label = row.createEl('span', {
			cls: 'hugo-add-image-file-label',
			text: 'No file chosen',
		});
		this.fileLabel = label;

		fileInput.addEventListener('change', () => {
			const file = fileInput.files?.[0] ?? null;
			this.pickedFile = file;
			if (label) label.textContent = file ? file.name : 'No file chosen';
			this.updateAddButton();
		});
	}

	private buildUrlTab(container: HTMLElement): void {
		const urlRow = container.createDiv({ cls: 'hugo-add-image-input-row' });
		urlRow.createEl('label', { text: 'URL' });
		const urlInput = urlRow.createEl('input', { type: 'text', attr: { placeholder: 'https://example.com/photo.jpg' } });
		urlInput.addEventListener('input', () => this.updateAddButton());
		urlInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.handleSubmit();
		});
		this.urlInput = urlInput;

		const nameRow = container.createDiv({ cls: 'hugo-add-image-input-row' });
		nameRow.createEl('label', { text: 'Save as (optional)' });
		const nameInput = nameRow.createEl('input', { type: 'text', attr: { placeholder: 'photo.jpg' } });
		nameInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.handleSubmit();
		});
		this.filenameInput = nameInput;
	}

	private switchTab(tab: Tab): void {
		this.activeTab = tab;

		for (const [t, el] of this.tabContents) {
			el.style.display = t === tab ? '' : 'none';
		}
		for (const [t, btn] of this.tabButtons) {
			btn.toggleClass('is-active', t === tab);
		}

		this.updateAddButton();

		// Auto-focus the relevant input.
		if (tab === 'url') {
			setTimeout(() => this.urlInput?.focus(), 0);
		}
	}

	private updateAddButton(): void {
		if (!this.addButton) return;
		if (this.activeTab === 'disk') {
			this.addButton.disabled = this.pickedFile === null;
		} else {
			const url = this.urlInput?.value.trim() ?? '';
			this.addButton.disabled = url.length === 0;
		}
	}

	private handleSubmit(): void {
		if (this.addButton?.disabled) return;

		if (this.activeTab === 'disk') {
			if (!this.pickedFile) return;
			this.onSubmit({ kind: 'file', file: this.pickedFile });
		} else {
			const url = this.urlInput?.value.trim() ?? '';
			if (!url) return;
			const filename = this.filenameInput?.value.trim() ?? '';
			this.onSubmit({ kind: 'url', url, filename });
		}

		this.close();
	}
}

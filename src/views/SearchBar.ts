// ──────────────────────────────────────────────────────────────────────────────
// SearchBar.ts  —  Footer search input shared across all canvas views.
//
// Lives at the bottom of MapTheMindView's canvas panel. Forwards debounced
// query terms to a host callback; the host drives the SearchService and
// routes results to the active view.
// ──────────────────────────────────────────────────────────────────────────────

export interface SearchBarOptions {
	/** Called when the term changes (debounced). Empty string = clear. */
	onSearch:    (term: string) => void;
	/** Optional: focus the result list when ↓ is pressed in the input. */
	onFocusResults?: () => void;
	placeholder?: string;
	debounceMs?:  number;
}

export class SearchBar {
	private readonly opts: SearchBarOptions;
	private root:       HTMLElement | null = null;
	private input:      HTMLInputElement | null = null;
	private actionSlot: HTMLElement | null = null;
	private timer:      number | null = null;

	constructor(opts: SearchBarOptions) { this.opts = opts; }

	render(parent: HTMLElement): HTMLElement {
		this.root  = parent.createDiv({ cls: "neuro-search-bar" });
		const icon = this.root.createSpan({ cls: "neuro-search-bar-icon" });
		icon.textContent = "🔎";

		this.input = this.root.createEl("input", {
			type: "text",
			cls:  "neuro-search-bar-input",
			attr: { placeholder: this.opts.placeholder ?? "Search notes…" },
		}) as HTMLInputElement;

		this.input.addEventListener("input", () => this.scheduleDispatch());
		this.input.addEventListener("keydown", evt => {
			if (evt.key === "Escape") {
				this.clear();
				evt.preventDefault();
			} else if (evt.key === "ArrowDown") {
				this.opts.onFocusResults?.();
				evt.preventDefault();
			}
		});

		const clearBtn = this.root.createEl("button", {
			text: "×",
			cls:  "neuro-search-bar-clear",
			attr: { "aria-label": "Clear search" },
		});
		clearBtn.addEventListener("click", () => this.clear());

		this.actionSlot = this.root.createDiv({ cls: "neuro-search-bar-actions" });

		return this.root;
	}

	/** Container to the right of the clear button — host views drop extra
	 *  controls (e.g. "+ Create note") here so the search bar is the single
	 *  footer toolbar. */
	getActionSlot(): HTMLElement | null { return this.actionSlot; }

	clear(): void {
		if (this.input) this.input.value = "";
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.opts.onSearch("");
	}

	destroy(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.root?.remove();
		this.root       = null;
		this.input      = null;
		this.actionSlot = null;
	}

	private scheduleDispatch(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		const wait = this.opts.debounceMs ?? 400;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const term = this.input?.value ?? "";
			this.opts.onSearch(term);
		}, wait);
	}
}

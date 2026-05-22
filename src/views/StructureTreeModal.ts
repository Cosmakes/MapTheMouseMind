// ──────────────────────────────────────────────────────────────────────────────
// views/StructureTreeModal.ts  —  Hierarchical Allen structure tree picker.
//
// Opens as a Modal showing the full CCFv3 structure hierarchy.  The user can
// expand/collapse nodes and filter with a search box.  Clicking a node calls
// the onSelect callback and closes the modal.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal } from "obsidian";
import type { AllenStructureFlat } from "../api/allenStructureCache";
import {
	getChildren,
	searchStructures,
} from "../api/allenStructureCache";

export interface StructureTreeModalOptions {
	/**
	 * Restrict the tree to the descendants of this structure (exclusive — the
	 * root itself is not shown as a selectable row, only its children).
	 *
	 * For a whole-brain picker, callers pass the active provider's
	 * `rootStructureId` (mouse 997). Subtree pickers (e.g. "browse hippocampal
	 * descendants") pass the relevant id.
	 */
	rootId: number;
	/** Optional override for the modal heading. */
	title?: string;
}

export class StructureTreeModal extends Modal {
	private tree:     Map<number, AllenStructureFlat>;
	private onSelect: (structure: AllenStructureFlat) => void;
	private opts:     StructureTreeModalOptions;
	private expanded  = new Set<number>();
	private searchQuery = "";

	constructor(
		app:      App,
		tree:     Map<number, AllenStructureFlat>,
		onSelect: (structure: AllenStructureFlat) => void,
		opts:     StructureTreeModalOptions,
	) {
		super(app);
		this.tree     = tree;
		this.onSelect = onSelect;
		this.opts     = opts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("neuro-structure-tree-modal");

		contentEl.createEl("h2", { text: this.opts.title ?? "Select brain structure" });

		// ── Search box ─────────────────────────────────────────────────────────
		const searchInput = contentEl.createEl("input", {
			type:  "text",
			cls:   "neuro-tree-search",
			attr:  { placeholder: "Search structures…" },
		});
		searchInput.addEventListener("input", () => {
			this.searchQuery = searchInput.value.trim();
			this.renderTree(treeContainer);
		});

		// ── Tree container ─────────────────────────────────────────────────────
		const treeContainer = contentEl.createDiv({ cls: "neuro-structure-tree" });
		this.renderTree(treeContainer);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── Rendering ───────────────────────────────────────────────────────────────

	private renderTree(container: HTMLElement): void {
		container.empty();

		if (this.searchQuery.length >= 2) {
			this.renderSearchResults(container);
		} else {
			const roots = getChildren(this.opts.rootId, this.tree);
			if (roots.length === 0) {
				container.createEl("p", {
					text: "This structure has no Allen subdivisions.",
					cls:  "neuro-tree-empty",
				});
				return;
			}
			roots.sort((a: AllenStructureFlat, b: AllenStructureFlat) =>
				a.st_level - b.st_level || a.name.localeCompare(b.name));
			for (const node of roots) {
				this.renderNode(container, node, 0);
			}
		}
	}

	private renderSearchResults(container: HTMLElement): void {
		const all = searchStructures(this.searchQuery, this.tree);
		const matches = all.filter(n => this.isDescendantOfRoot(n.id));
		if (matches.length === 0) {
			container.createEl("p", { text: "No structures found.", cls: "neuro-tree-empty" });
			return;
		}
		for (const node of matches) {
			this.renderNode(container, node, 0, true);
		}
	}

	private isDescendantOfRoot(id: number): boolean {
		const root = this.opts.rootId;
		if (id === root) return true;
		let cur = this.tree.get(id);
		while (cur && cur.parent_structure_id !== null) {
			if (cur.parent_structure_id === root) return true;
			cur = this.tree.get(cur.parent_structure_id);
		}
		return false;
	}

	private renderNode(
		parent:     HTMLElement,
		node:       AllenStructureFlat,
		depth:      number,
		flatSearch: boolean = false,
	): void {
		const children = getChildren(node.id, this.tree);
		const hasChildren = children.length > 0;
		const isExpanded  = this.expanded.has(node.id);

		const row = parent.createDiv({ cls: "neuro-tree-row" });
		row.style.paddingLeft = `${depth * 16 + 8}px`;

		// Toggle icon
		const toggleEl = row.createDiv({ cls: "neuro-tree-toggle" });
		if (hasChildren && !flatSearch) {
			toggleEl.setText(isExpanded ? "▼" : "▶");
			toggleEl.addEventListener("click", (e) => {
				e.stopPropagation();
				if (isExpanded) {
					this.expanded.delete(node.id);
				} else {
					this.expanded.add(node.id);
				}
				const treeContainer = this.contentEl.querySelector(".neuro-structure-tree") as HTMLElement | null;
				if (treeContainer) this.renderTree(treeContainer);
			});
		} else {
			toggleEl.setText("·");
			toggleEl.style.opacity = "0.3";
		}

		// Color swatch
		const swatchEl = row.createEl("span", { cls: "neuro-tree-swatch" });
		swatchEl.style.backgroundColor = `#${node.color_hex_triplet}`;

		// Name + acronym
		row.createEl("span", {
			text: node.name,
			cls: "neuro-tree-name",
		});
		row.createEl("span", {
			text: ` [${node.acronym}]`,
			cls: "neuro-tree-acronym",
		});

		// Click to select
		row.addEventListener("click", () => {
			this.onSelect(node);
			this.close();
		});
		row.addClass("neuro-tree-selectable");

		// Render expanded children
		if (hasChildren && isExpanded && !flatSearch) {
			const childrenContainer = parent.createDiv();
			children.sort((a, b) => a.name.localeCompare(b.name));
			for (const child of children) {
				this.renderNode(childrenContainer, child, depth + 1);
			}
		}
	}
}


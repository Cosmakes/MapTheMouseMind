// ──────────────────────────────────────────────────────────────────────────────
// InsertRegionModal.ts  —  Fuzzy-search modal for inserting a brain region link
//
// Invoked via the "Insert brain region reference" editor command.
// On selection the modal:
//   1. Creates a brain-region note for the chosen region if one doesn't exist.
//   2. Inserts a wikilink at the current editor cursor.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Editor, FuzzyMatch, FuzzySuggestModal, TFile } from "obsidian";
import type NeuroMindmapPlugin from "./main";
import type { AllenStructureFlat } from "./api/allenStructureCache";
import { pathFor } from "./paths";

// ── Region item ───────────────────────────────────────────────────────────────

interface RegionItem {
	id:      number;   // Allen structure ID
	acronym: string;
	name:    string;
}

// ── Modal ──────────────────────────────────────────────────────────────────────

export class InsertRegionModal extends FuzzySuggestModal<RegionItem> {
	private editor:      Editor;
	private plugin:      NeuroMindmapPlugin;
	private structTree:  Map<number, AllenStructureFlat>;

	constructor(
		app:        App,
		editor:     Editor,
		plugin:     NeuroMindmapPlugin,
		structTree: Map<number, AllenStructureFlat>,
	) {
		super(app);
		this.editor     = editor;
		this.plugin     = plugin;
		this.structTree = structTree;
		this.setPlaceholder("Search brain regions…");
	}

	getItems(): RegionItem[] {
		const items: RegionItem[] = [];
		for (const node of this.structTree.values()) {
			// Only include named structures (exclude root 997)
			if (node.id !== 997) {
				items.push({ id: node.id, acronym: node.acronym, name: node.name });
			}
		}
		return items;
	}

	getItemText(item: RegionItem): string {
		return `${item.name} [${item.acronym}]`;
	}

	renderSuggestion(match: FuzzyMatch<RegionItem>, el: HTMLElement): void {
		el.createDiv({ cls: "suggestion-content" }).createDiv({
			cls:  "suggestion-title",
			text: match.item.name,
		});
		el.createDiv({ cls: "suggestion-aux suggestion-flair", text: match.item.acronym });
	}

	async onChooseItem(item: RegionItem): Promise<void> {
		const notePath = await this.ensureRegionNote(item);
		const link = notePath
			? `[[${notePath}|${item.name}]]`
			: `[[${item.acronym}|${item.name}]]`;
		this.editor.replaceSelection(link);
	}

	private async ensureRegionNote(item: RegionItem): Promise<string | null> {
		const folder   = pathFor(this.plugin, "regions");
		const slug     = item.acronym.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		const fileName = `${slug}.md`;
		const fullPath = `${folder}/${fileName}`;
		const linkPath = `${folder}/${slug}`;

		const existing = this.app.vault.getAbstractFileByPath(fullPath);
		if (existing instanceof TFile) return linkPath;

		const content = `---
entity_type: brain-region
tags: [brain-region]
region_name: "${item.name}"
region_id: ${slug}
allen_id: ${item.id}
---

# ${item.name}

`;
		try { await this.app.vault.adapter.mkdir(folder); } catch { /* exists */ }
		await this.app.vault.create(fullPath, content);
		return linkPath;
	}
}

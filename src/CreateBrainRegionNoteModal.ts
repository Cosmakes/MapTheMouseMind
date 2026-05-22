// ──────────────────────────────────────────────────────────────────────────────
// CreateBrainRegionNoteModal.ts
//
// Creates a brain-region note linked to an Allen CCFv3 structure.
// The user picks the structure from the hierarchical StructureTreeModal; the
// modal auto-fills name, region_id, allen_id, and allen_ancestor_ids.
// After the note is created, background downloads start for the region mesh
// and its immediate parent mesh (for 3D context).
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice, Setting, stringifyYaml } from "obsidian";
import type NeuroMindmapPlugin from "./main";
import type { AllenStructureFlat } from "./api/allenStructureCache";
import { getAncestors } from "./api/allenStructureCache";
import { pathFor } from "./paths";
import { BrainRegionFrontmatter } from "./types";
import { StructureTreeModal } from "./views/StructureTreeModal";

export class CreateBrainRegionNoteModal extends Modal {
	private plugin:      NeuroMindmapPlugin;
	private structTree:  Map<number, AllenStructureFlat>;
	private prefillId:   number | undefined;

	// Form state
	private selectedStructure: AllenStructureFlat | null = null;
	private noteName = "";

	constructor(
		app:        App,
		plugin:     NeuroMindmapPlugin,
		structTree: Map<number, AllenStructureFlat>,
		prefillAllenId?: number,
	) {
		super(app);
		this.plugin     = plugin;
		this.structTree = structTree;
		this.prefillId  = prefillAllenId;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Add brain region note" });

		// ── Structure picker ───────────────────────────────────────────────────
		const provider = this.plugin.provider;
		const pickerRow = new Setting(contentEl)
			.setName("Brain structure")
			.setDesc(`Pick from the Allen ${provider.brainLabel} Atlas.`);

		const previewEl = contentEl.createDiv({ cls: "neuro-structure-preview" });
		previewEl.style.marginBottom = "12px";

		pickerRow.addButton(btn =>
			btn
				.setButtonText("Browse Allen Atlas…")
				.onClick(() => {
					new StructureTreeModal(
						this.app,
						this.structTree,
						(s) => this.selectStructure(s, previewEl),
						{ rootId: this.plugin.provider.rootStructureId },
					).open();
				})
		);

		// Pre-fill if caller passed an allenId (e.g. from 3D click)
		if (this.prefillId !== undefined) {
			const prefill = this.structTree.get(this.prefillId);
			if (prefill) this.selectStructure(prefill, previewEl);
		}

		// ── Note title ─────────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName("Note title")
			.setDesc("Short descriptive title (used as filename).")
			.addText(t =>
				t
					.setPlaceholder("e.g. CA1 overview")
					.onChange(v => { this.noteName = v.trim(); })
			);

		// ── Buttons ────────────────────────────────────────────────────────────
		new Setting(contentEl)
			.addButton(btn =>
				btn
					.setButtonText("Create note")
					.setCta()
					.onClick(() => void this.onSubmit())
			)
			.addButton(btn =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── Internal ───────────────────────────────────────────────────────────────

	private selectStructure(s: AllenStructureFlat, previewEl: HTMLElement): void {
		this.selectedStructure = s;
		const ancestors = getAncestors(s.id, this.structTree);
		const parentName = ancestors[0]?.name ?? "—";
		previewEl.empty();
		const inner = previewEl.createDiv({ cls: "neuro-structure-preview-inner" });
		const swatch = inner.createEl("span", { cls: "neuro-tree-swatch" });
		swatch.style.backgroundColor = `#${s.color_hex_triplet}`;
		inner.createEl("strong", { text: s.name });
		inner.createEl("span", { text: ` [${s.acronym}]  — part of ${parentName}`, cls: "neuro-tree-acronym" });
		if (!this.noteName) {
			this.noteName = s.name;
			// Update text input if it exists
			const input = this.contentEl.querySelector<HTMLInputElement>("input[type=text]");
			if (input) input.value = s.name;
		}
	}

	private async onSubmit(): Promise<void> {
		if (!this.selectedStructure) {
			new Notice("Please select a brain structure.");
			return;
		}
		if (!this.noteName) {
			new Notice("Please enter a note title.");
			return;
		}

		const s         = this.selectedStructure;
		const ancestors = getAncestors(s.id, this.structTree);

		const folderPath = pathFor(this.plugin, "regions");
		const slug       = slugify(this.noteName);
		const filePath   = `${folderPath}/${slug}.md`;

		if (!this.app.vault.getFolderByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}

		const fm: BrainRegionFrontmatter = {
			entity_type:        "brain-region",
			tags:               ["brain-region"],
			region_name:        s.name,
			region_id:          s.acronym.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
			allen_id:           s.id,
			allen_ancestor_ids: ancestors.map(a => a.id),
		};

		const parentNode = ancestors[0];
		if (parentNode) {
			fm.parent_region = parentNode.acronym.toLowerCase();
		}

		const content = `---\n${stringifyYaml(fm)}---\n\n# ${this.noteName}\n`;

		try {
			const newFile = await this.app.vault.create(filePath, content);
			this.close();
			await this.app.workspace.getLeaf().openFile(newFile);
			new Notice(`Created: ${slug}.md`);
		} catch (err) {
			new Notice(`Failed to create note: ${(err as Error).message}`);
			return;
		}

		// Background: download region mesh + parent mesh for 3D context
		void this.downloadMeshesInBackground(s.id, ancestors[0]?.id);
	}

	private async downloadMeshesInBackground(
		allenId:  number,
		parentId: number | undefined,
	): Promise<void> {
		const provider = this.plugin.provider;
		const adapter  = this.app.vault.adapter;
		const cacheDir = provider.meshCacheDir;
		try { await adapter.mkdir(cacheDir); } catch { /* exists */ }

		for (const id of [allenId, parentId].filter((x): x is number => x !== undefined)) {
			const path = `${cacheDir}/${id}.obj`;
			if (await adapter.exists(path)) continue;
			try {
				const obj = await provider.fetchStructureMeshObj(id);
				await adapter.write(path, obj);
			} catch {
				// Non-fatal — mesh will be downloaded on next load.
			}
		}
	}
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

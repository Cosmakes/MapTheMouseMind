// ──────────────────────────────────────────────────────────────────────────────
// CreateTopicModal.ts
//
// Unified "Create note" modal — single entry point used at every level
// (whole brain / viewpoint / cell). The user fills four things:
//
//   1. Title
//   2. Tags  — chips with autocomplete from existing vault tags
//   3. Brain regions — chips, picked via the hierarchical StructureTreeModal
//   4. Body  — large textarea taking up the bulk of the modal
//
// Provenance (level / viewpoint_id / cell_id) is supplied by the caller and
// written to frontmatter so search can scope correctly. Backrefs to the
// creation context are also rendered as Obsidian wikilinks at the top of
// the body, so the new note shows up in the graph view.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice, TFile } from "obsidian";
import {
	TopicFrontmatter,
	TopicScope,
} from "./types";
import {
	notesFolderForBrain,
	notesFolderForCell,
	notesFolderForViewpoint,
	writeTopicNote,
} from "./topics";
import type { AllenStructureFlat } from "./api/allenStructureCache";
import { StructureTreeModal } from "./views/StructureTreeModal";

export interface CreateTopicModalOptions {
	/** Pre-filled scope entries — shown as chips, user can remove/add. */
	prefillScope?:  TopicScope[];
	/** Folder root (e.g. "neuro") — matches NeuroMindmapSettings.defaultFolder. */
	folderRoot:     string;
	/** Allen structure tree — required to show the hierarchical region picker. */
	structureTree:  Map<number, AllenStructureFlat>;
	/** Whole-brain root id — scopes the region picker. */
	rootStructureId: number;
	/** Where this note is being taken — determines target folder + provenance. */
	level:          "brain" | "viewpoint" | "cell";
	/** Viewpoint context (required for level: viewpoint | cell). */
	viewpointFile?: TFile;
	/** Cell context (required for level: cell). */
	cellFile?:      TFile;
}

export class CreateTopicModal extends Modal {
	private title:     string = "";
	private body:      string = "";
	private tags:      string[]      = [];
	private scopeList: TopicScope[]  = [];
	private opts:      CreateTopicModalOptions;

	private tagsListEl:  HTMLElement | null = null;
	private scopeListEl: HTMLElement | null = null;

	constructor(app: App, opts: CreateTopicModalOptions) {
		super(app);
		this.opts = opts;
		this.scopeList = [...(opts.prefillScope ?? [])];
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("neuro-create-note-modal");
		contentEl.addClass("neuro-create-note-content");
		contentEl.createEl("h2", { text: "Create note" });

		// ── Title ────────────────────────────────────────────────────────────
		const titleRow = contentEl.createDiv({ cls: "neuro-create-note-row" });
		titleRow.createEl("label", { text: "Title", cls: "neuro-create-note-label" });
		const titleInput = titleRow.createEl("input", {
			type: "text",
			cls:  "neuro-create-note-title",
			attr: { placeholder: "Note title…" },
		}) as HTMLInputElement;
		titleInput.addEventListener("input", () => { this.title = titleInput.value.trim(); });

		// ── Tags ─────────────────────────────────────────────────────────────
		const tagsRow = contentEl.createDiv({ cls: "neuro-create-note-row" });
		tagsRow.createEl("label", { text: "Tags", cls: "neuro-create-note-label" });
		this.tagsListEl = tagsRow.createDiv({ cls: "neuro-create-note-chips" });

		const tagInputWrap = tagsRow.createDiv({ cls: "neuro-create-note-chip-add" });
		const tagListId    = "neuro-create-note-tag-list";
		const tagDatalist  = tagInputWrap.createEl("datalist", { attr: { id: tagListId } });
		for (const t of this.collectVaultTags()) {
			tagDatalist.createEl("option", { attr: { value: t } });
		}
		const tagInput = tagInputWrap.createEl("input", {
			type: "text",
			cls:  "neuro-create-note-chip-input",
			attr: { placeholder: "Add tag…", list: tagListId },
		}) as HTMLInputElement;
		const commitTag = () => {
			const v = tagInput.value.trim().replace(/^#+/, "");
			if (!v) return;
			if (!this.tags.includes(v)) this.tags.push(v);
			tagInput.value = "";
			this.renderTagChips();
		};
		tagInput.addEventListener("keydown", evt => {
			if (evt.key === "Enter" || evt.key === ",") {
				evt.preventDefault();
				commitTag();
			} else if (evt.key === "Backspace" && tagInput.value === "" && this.tags.length > 0) {
				this.tags.pop();
				this.renderTagChips();
			}
		});
		tagInput.addEventListener("blur", () => { if (tagInput.value.trim()) commitTag(); });
		this.renderTagChips();

		// ── Regions ──────────────────────────────────────────────────────────
		const regionsRow = contentEl.createDiv({ cls: "neuro-create-note-row" });
		regionsRow.createEl("label", { text: "Regions", cls: "neuro-create-note-label" });
		this.scopeListEl = regionsRow.createDiv({ cls: "neuro-create-note-chips" });

		const regionAdd = regionsRow.createDiv({ cls: "neuro-create-note-chip-add" });
		const regionBtn = regionAdd.createEl("button", {
			text: "+ Add region",
			cls:  "neuro-create-note-add-region",
		});
		regionBtn.addEventListener("click", () => {
			new StructureTreeModal(
				this.app,
				this.opts.structureTree,
				(structure) => {
					if (!this.scopeList.some(s => s.allen_id === structure.id)) {
						this.scopeList.push({ allen_id: structure.id });
					}
					this.renderRegionChips();
				},
				{
					title:  "Pick a region this note is about",
					rootId: this.opts.rootStructureId,
				},
			).open();
		});
		this.renderRegionChips();

		// ── Body ─────────────────────────────────────────────────────────────
		const bodyRow = contentEl.createDiv({ cls: "neuro-create-note-row neuro-create-note-row--body" });
		bodyRow.createEl("label", { text: "Body", cls: "neuro-create-note-label" });
		const bodyArea = bodyRow.createEl("textarea", {
			cls:  "neuro-create-note-body",
			attr: { placeholder: "Write the note (markdown supported)…", rows: "16" },
		}) as HTMLTextAreaElement;
		bodyArea.addEventListener("input", () => { this.body = bodyArea.value; });

		// ── Buttons ──────────────────────────────────────────────────────────
		const actions = contentEl.createDiv({ cls: "neuro-create-note-actions" });
		const cancelBtn = actions.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const createBtn = actions.createEl("button", {
			text: "Create note",
			cls:  "mod-cta",
		});
		createBtn.addEventListener("click", () => { void this.onSubmit(); });

		// Allow Cmd/Ctrl+Enter from the body to submit.
		bodyArea.addEventListener("keydown", evt => {
			if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
				evt.preventDefault();
				void this.onSubmit();
			}
		});

		titleInput.focus();
	}

	onClose(): void { this.contentEl.empty(); }

	// ── Chip rendering ────────────────────────────────────────────────────────

	private renderTagChips(): void {
		const el = this.tagsListEl;
		if (!el) return;
		el.empty();
		for (let i = 0; i < this.tags.length; i++) {
			const tag = this.tags[i]!;
			const chip = el.createDiv({ cls: "neuro-create-note-chip" });
			chip.createSpan({ text: `#${tag}` });
			const rm = chip.createEl("button", { text: "×", cls: "neuro-create-note-chip-remove" });
			rm.addEventListener("click", () => {
				this.tags.splice(i, 1);
				this.renderTagChips();
			});
		}
	}

	private renderRegionChips(): void {
		const el = this.scopeListEl;
		if (!el) return;
		el.empty();
		for (let i = 0; i < this.scopeList.length; i++) {
			const s = this.scopeList[i]!;
			const chip = el.createDiv({ cls: "neuro-create-note-chip" });
			chip.createSpan({ text: formatScope(s, this.opts.structureTree) });
			const rm = chip.createEl("button", { text: "×", cls: "neuro-create-note-chip-remove" });
			rm.addEventListener("click", () => {
				this.scopeList.splice(i, 1);
				this.renderRegionChips();
			});
		}
	}

	// ── Tag harvest ───────────────────────────────────────────────────────────

	private collectVaultTags(): string[] {
		// app.metadataCache.getTags() returns Record<"#tag", count>. The cast
		// is necessary because the public types don't expose this method but
		// it's been part of the API since 0.12.
		const raw = (this.app.metadataCache as unknown as { getTags?(): Record<string, number> }).getTags?.() ?? {};
		const entries: { tag: string; count: number }[] = [];
		for (const key of Object.keys(raw)) {
			const tag = key.replace(/^#+/, "");
			if (!tag) continue;
			entries.push({ tag, count: raw[key] ?? 0 });
		}
		entries.sort((a, b) => b.count - a.count);
		const seen = new Set<string>();
		const result: string[] = [];
		for (const { tag } of entries) {
			if (seen.has(tag)) continue;
			seen.add(tag);
			result.push(tag);
		}
		return result;
	}

	// ── Submit ────────────────────────────────────────────────────────────────

	private async onSubmit(): Promise<void> {
		if (!this.title) {
			new Notice("Please enter a title.");
			return;
		}

		const allTags = ["topic"];
		for (const t of this.tags) if (!allTags.includes(t)) allTags.push(t);

		const fm: TopicFrontmatter = {
			entity_type: "topic",
			tags:        allTags,
			topic_name:  this.title,
			scope:       this.scopeList,
			level:       this.opts.level,
		};
		if (this.opts.level !== "brain" && this.opts.viewpointFile) {
			fm.viewpoint_id = this.opts.viewpointFile.parent?.name
				?? this.opts.viewpointFile.basename;
		}
		if (this.opts.level === "cell" && this.opts.cellFile) {
			fm.cell_id = this.opts.cellFile.basename;
		}

		const body = buildNoteBody(this.body, this.scopeList, this.opts);

		const folderPath = this.resolveFolder();
		if (!folderPath) {
			new Notice("Missing context to determine target folder for this note.");
			return;
		}

		try {
			const file = await writeTopicNote(this.app, folderPath, fm, body);
			this.close();
			await this.app.workspace.getLeaf("split").openFile(file);
			new Notice(`Created: ${file.basename}.md`);
		} catch (err) {
			new Notice(`Failed to create note: ${(err as Error).message}`);
		}
	}

	/** Computes target folder from level + context. */
	private resolveFolder(): string | null {
		switch (this.opts.level) {
			case "brain":
				return notesFolderForBrain(this.opts.folderRoot);
			case "viewpoint":
				if (!this.opts.viewpointFile) return null;
				return notesFolderForViewpoint(this.opts.viewpointFile);
			case "cell":
				if (!this.opts.viewpointFile) return null;
				return notesFolderForCell(this.opts.viewpointFile);
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatScope(
	s:    TopicScope,
	tree: Map<number, AllenStructureFlat>,
): string {
	if (s.allen_id !== undefined) {
		const node = tree.get(s.allen_id);
		return node ? `${node.acronym}` : `allen:${s.allen_id}`;
	}
	if (s.cell) return `cell:${s.cell}`;
	return "(empty)";
}

function buildNoteBody(
	userBody: string,
	scope:    TopicScope[],
	opts:     CreateTopicModalOptions,
): string {
	const lines: string[] = [];
	const created: string[] = [];
	if (opts.viewpointFile) created.push(`[[${opts.viewpointFile.basename}]]`);
	if (opts.cellFile)      created.push(`[[${opts.cellFile.basename}]]`);
	if (created.length > 0) lines.push(`> Created in: ${created.join(" · ")}`);

	const regionLinks: string[] = [];
	for (const s of scope) {
		if (s.allen_id === undefined) continue;
		const node = opts.structureTree.get(s.allen_id);
		if (node) regionLinks.push(`[[${node.acronym}]]`);
	}
	if (regionLinks.length > 0) lines.push(`> Regions: ${regionLinks.join(" ")}`);

	const header = lines.join("\n");
	if (header && userBody.trim()) return `${header}\n\n${userBody}`;
	if (header) return header;
	return userBody;
}

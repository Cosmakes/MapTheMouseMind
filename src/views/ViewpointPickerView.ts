// ──────────────────────────────────────────────────────────────────────────────
// views/ViewpointPickerView.ts  —  The middle-step picker between a 3D region
// click and the 2D slice scrubber.
//
// Shows:
//   • All existing viewpoints for the current Allen structure
//   • A "Create new viewpoint" card that enters slice-picker mode
// ──────────────────────────────────────────────────────────────────────────────

import type { App, TFile } from "obsidian";
import type { ViewpointFrontmatter } from "../types";
import type { AllenStructureFlat } from "../api/allenStructureCache";
import { discoverViewpoints, parseViewpointBody } from "../viewpoints";
import { HelpModal } from "../HelpModal";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ViewpointPickerOptions {
	app:            App;
	allenId:        number;
	structureTree:  Map<number, AllenStructureFlat>;
	/** Folder under which to look for viewpoint notes. */
	viewpointsRoot?: string;
	onSelect:       (file: TFile) => void;
	onCreateNew:    () => void;
}

export class ViewpointPickerView {
	private opts: ViewpointPickerOptions;

	constructor(opts: ViewpointPickerOptions) {
		this.opts = opts;
	}

	render(container: HTMLElement): void {
		container.empty();
		container.addClass("neuro-viewpoint-picker");

		const node = this.opts.structureTree.get(this.opts.allenId);
		const header = container.createDiv({ cls: "neuro-viewpoint-picker-header" });
		header.createEl("h3", {
			text: node ? `${node.name} [${node.acronym}]` : `Structure ${this.opts.allenId}`,
			cls:  "neuro-viewpoint-picker-title",
		});
		header.createEl("p", {
			text: "Pick an existing viewpoint or create a new one from a 2D section.",
			cls:  "neuro-viewpoint-picker-sub",
		});

		const helpBtn = header.createEl("button", {
			text: "?",
			cls:  "neuro-help-btn neuro-viewpoint-picker-help-btn",
			attr: { title: "Help for the viewpoint picker" },
		});
		helpBtn.addEventListener("click", () => new HelpModal(this.opts.app, "picker").open());

		const grid = container.createDiv({ cls: "neuro-viewpoint-grid" });

		// ── Existing viewpoints ───────────────────────────────────────────────
		const files = discoverViewpoints(this.opts.app, this.opts.allenId, this.opts.viewpointsRoot);
		for (const file of files) {
			this.renderExistingCard(grid, file);
		}

		// ── Create new card ──────────────────────────────────────────────────
		const createCard = grid.createDiv({ cls: "neuro-viewpoint-card neuro-viewpoint-card--new" });
		createCard.createEl("div", { text: "+", cls: "neuro-viewpoint-card-plus" });
		createCard.createEl("div", { text: "Create new viewpoint", cls: "neuro-viewpoint-card-title" });
		createCard.createEl("div", {
			text: "Pick a slice from the coronal/sagittal sections.",
			cls:  "neuro-viewpoint-card-desc",
		});
		createCard.addEventListener("click", () => this.opts.onCreateNew());
	}

	private renderExistingCard(grid: HTMLElement, file: TFile): void {
		const fm = this.opts.app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<ViewpointFrontmatter> | undefined;

		const card = grid.createDiv({ cls: "neuro-viewpoint-card" });

		const previewWrap = card.createDiv({ cls: "neuro-viewpoint-card-preview" });
		void this.renderPreview(previewWrap, file, fm);

		card.createEl("div", {
			text: fm?.viewpoint_name ?? file.basename,
			cls:  "neuro-viewpoint-card-title",
		});

		const meta: string[] = [];
		if (fm?.plane) meta.push(fm.plane);
		if (typeof fm?.ap_mm === "number") meta.push(`AP ${fm.ap_mm.toFixed(2)} mm`);
		if (meta.length > 0) {
			card.createEl("div", { text: meta.join(" · "), cls: "neuro-viewpoint-card-desc" });
		}

		card.addEventListener("click", () => this.opts.onSelect(file));
	}

	private async renderPreview(
		wrap: HTMLElement,
		file: TFile,
		fm:   Partial<ViewpointFrontmatter> | undefined,
	): Promise<void> {
		let content: string;
		try {
			content = await this.opts.app.vault.read(file);
		} catch {
			return;
		}
		const parsed = parseViewpointBody(content);
		if (!parsed || parsed.layers.length === 0) return;

		const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		svg.setAttribute("xmlns", SVG_NS);
		svg.setAttribute("viewBox", fm?.view_box ?? "0 0 1000 1000");
		svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
		svg.setAttribute("class", "neuro-viewpoint-card-svg");

		for (const layer of parsed.layers) {
			const path = document.createElementNS(SVG_NS, "path") as SVGPathElement;
			path.setAttribute("d", layer.d);
			path.setAttribute("fill",   layer.color ? `#${layer.color}` : "var(--background-modifier-border)");
			path.setAttribute("stroke", "var(--background-modifier-border)");
			path.setAttribute("stroke-width", "2");
			path.setAttribute("vector-effect", "non-scaling-stroke");
			svg.appendChild(path);
		}

		wrap.appendChild(svg);
	}
}

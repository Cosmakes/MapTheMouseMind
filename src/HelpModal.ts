// ──────────────────────────────────────────────────────────────────────────────
// HelpModal.ts  —  Context-aware help.
//
// The "?" button in each view opens this modal with a `topic` matching the
// current view. The settings tab opens it with `topic: "general"` for a full
// plugin overview.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal } from "obsidian";

export type HelpTopic =
	| "general"
	| "brain3d"
	| "picker"
	| "slicePicker"
	| "viewpoint"
	| "cell";

export class HelpModal extends Modal {
	private topic: HelpTopic;

	constructor(app: App, topic: HelpTopic = "general") {
		super(app);
		this.topic = topic;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("neuro-help-modal");

		switch (this.topic) {
			case "general":     this.renderGeneral(contentEl);     break;
			case "brain3d":     this.renderBrain3D(contentEl);     break;
			case "picker":      this.renderPicker(contentEl);      break;
			case "slicePicker": this.renderSlicePicker(contentEl); break;
			case "viewpoint":   this.renderViewpoint(contentEl);   break;
			case "cell":        this.renderCell(contentEl);        break;
		}

		const btnRow = contentEl.createDiv({ cls: "neuro-help-modal-buttons" });
		const closeBtn = btnRow.createEl("button", { text: "Close", cls: "mod-cta" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void { this.contentEl.empty(); }

	// ── General overview (settings tab) ──────────────────────────────────────

	private renderGeneral(el: HTMLElement): void {
		el.createEl("h2", { text: "Neuro Mindmap — how it works" });

		el.createEl("h3", { text: "What this plugin is for" });
		el.createEl("p", {
			text: "Your Obsidian vault becomes a hierarchical neuroscience database rooted in real brain atlases (Allen CCFv3 for mouse). You browse from whole brain → region → subregion → cells, and you take notes about anything you learn along the way. Notes are plain markdown with typed frontmatter, so the vault remains fully usable without the plugin.",
		});

		el.createEl("h3", { text: "Navigating" });
		const nav = el.createEl("ol");
		nav.createEl("li", { text: "Click the brain ribbon icon (or run 'Open MapTheMind view')." });
		nav.createEl("li", { text: "Click a region in the 3D brain to drill in." });
		nav.createEl("li", { text: "Pick a slice (coronal or sagittal) to save a viewpoint — a 2D schematic of that slice restricted to your region." });
		nav.createEl("li", { text: "Inside a viewpoint: rotate (↺ ↻), zoom (scroll), pan (drag), and click a subregion to focus it." });

		el.createEl("h3", { text: "Note types" });
		const types = el.createEl("ul");
		addType(types, "brain-region", "A brain structure (e.g. CA1). Anchored by Allen structure ID.");
		addType(types, "cell-type",    "A specific cell type living in a region/layer (e.g. CA1 pyramidal). Can carry dendrite/axon targets and a NeuroMorpho morphology source — or be created as a schematic glyph whose soma shape and dendrite layout you configure in the placement panel.");
		addType(types, "viewpoint",    "A 2D schematic of one Allen slice — generated when you pick a slice in the region view.");
		addType(types, "topic",        "An atomic concept note (mechanism, circuit, phenomenon). Scoped to one or more anatomical anchors so the viewpoint side panel surfaces it where it applies.");

		el.createEl("h3", { text: "Taking notes while reading a paper" });
		el.createEl("p", {
			text: "The paper-note anti-pattern is to write everything into one long note per paper. When you revisit a concept later, you can't retrieve it. Instead:",
		});
		const wf = el.createEl("ol");
		wf.createEl("li", { text: "Make a paper note (in a folder of your choice) with the paper's metadata." });
		wf.createEl("li", { text: "For each distinct concept the paper teaches you, create a topic note anchored to the region(s) or cell(s) it applies to." });
		wf.createEl("li", { text: "Link topics together with typed relations (mechanism_of, input_to, evidence_for, …) — those become navigable." });
		wf.createEl("li", { text: "Tag cross-cutting topics with a theme (e.g. 'coding-and-memory'). The theme note's backlinks become the index." });
		wf.createEl("li", { text: "Link from the paper note to the topics it supports using plain [[wikilinks]]. Obsidian backlinks then show 'which papers support this concept' for free." });

		el.createEl("h3", { text: "Example — pattern separation" });
		el.createEl("p", {
			text: "You read a paper about pattern separation involving a dendritic integration mechanism in CA3 upon a specific input from DG. Split it into three atomic topics:",
		});
		const ex = el.createEl("ul");
		const a = ex.createEl("li");
		a.appendText("pattern-separation.md");
		a.createEl("em", { text: " — the concept (scope: broad)" });
		const b = ex.createEl("li");
		b.appendText("dg-ca3-mossy-projection.md");
		b.createEl("em", { text: " — the circuit (scope: DG + CA3); related: mechanism_of → pattern-separation" });
		const c = ex.createEl("li");
		c.appendText("ca3-dendritic-integration.md");
		c.createEl("em", { text: " — the cellular mechanism (scope: CA3); related: mechanism_of → pattern-separation" });

		el.createEl("h3", { text: "Search syntax" });
		el.createEl("p", {
			text: "The search bar at the bottom runs a case-insensitive substring search across title, summary, themes, and body of every note in scope. Multiple whitespace-separated tokens are ANDed: 'mossy fiber' returns notes containing both 'mossy' and 'fiber' anywhere. To AND multi-word phrases, separate them with uppercase AND (whitespace-bounded): 'CA3 AND mossy fiber' returns notes that contain both the substring 'ca3' and the substring 'mossy fiber'. Lowercase 'and' is treated as a normal word.",
		});

		el.createEl("h3", { text: "Per-view help" });
		el.createEl("p", {
			text: "Every view has its own ? button in the header — open it to see only what that view does.",
		});
	}

	// ── 3D whole-brain view ──────────────────────────────────────────────────

	private renderBrain3D(el: HTMLElement): void {
		el.createEl("h2", { text: "3D brain view" });
		el.createEl("p", {
			text: "Whole-brain Allen mesh, rendered in 3D. This is the entry point — click a region to drill into it.",
		});

		el.createEl("h3", { text: "Navigation" });
		const nav = el.createEl("ul");
		nav.createEl("li", { text: "Click any region with a brain-region note → opens its viewpoint (or the picker, if you haven't created one yet)." });
		nav.createEl("li", { text: "Hover any mesh → tooltip with name + acronym." });
		nav.createEl("li", { text: "Drag the canvas to rotate the camera (default on). Click-to-open is default off so accidental drags don't drill in. Both modes are independent toggles in plugin settings — turn click-to-open on if you prefer one-click navigation." });

		el.createEl("h3", { text: "Camera controls (top-right)" });
		const cam = el.createEl("ul");
		cam.createEl("li", { text: "↑ ↓ ← → — rotate the camera around the brain." });
		cam.createEl("li", { text: "+ / − — zoom in / out." });
		cam.createEl("li", { text: "The view angle is persisted across sessions — re-opening the plugin leaves you where you left off." });

		el.createEl("h3", { text: "Layer panel (bottom-left)" });
		el.createEl("p", {
			text: "Toggles the visibility of individual structure meshes. Useful for revealing deeper structures hidden behind cortex, or for isolating a single region.",
		});

		el.createEl("h3", { text: "Search" });
		el.createEl("p", {
			text: "Type in the search bar at the bottom. Notes that live at deeper levels (inside viewpoints) appear as dots placed on the structure they belong to. Multiple dots from the same structure are split across hemispheres so they're visually distinguishable. Click a dot to open the note. Multiple terms are ANDed; use uppercase AND between phrases for multi-word matches (e.g. 'CA3 AND mossy fiber').",
		});
	}

	// ── Viewpoint picker ─────────────────────────────────────────────────────

	private renderPicker(el: HTMLElement): void {
		el.createEl("h2", { text: "Viewpoint picker" });
		el.createEl("p", {
			text: "Lists every saved viewpoint for the current brain structure, plus a card to create a new one.",
		});

		el.createEl("h3", { text: "What is a viewpoint?" });
		el.createEl("p", {
			text: "A viewpoint is a 2D schematic of one Allen slice (coronal or sagittal) restricted to a single structure. It's the canvas you take cell-level and topic-level notes against. Every viewpoint carries the slice's plane and AP coordinate so the 3D view can place it correctly in space.",
		});

		el.createEl("h3", { text: "Actions" });
		const acts = el.createEl("ul");
		acts.createEl("li", { text: "Click an existing card → opens that viewpoint." });
		acts.createEl("li", { text: 'Click "Create new viewpoint" → opens the slice picker.' });
		acts.createEl("li", { text: "The picker is also reachable from inside any viewpoint, via the 'Viewpoints' button in the header." });
	}

	// ── Slice picker (AllenSectionViewer with selection) ─────────────────────

	private renderSlicePicker(el: HTMLElement): void {
		el.createEl("h2", { text: "Slice picker" });
		el.createEl("p", {
			text: "Scrub through Allen reference-atlas sections to find the slice you want to take notes against. Saving the slice creates a new viewpoint.",
		});

		el.createEl("h3", { text: "Picking a plane" });
		el.createEl("p", {
			text: "Toggle between coronal and sagittal at the top. The section list reloads to match the chosen plane.",
		});

		el.createEl("h3", { text: "Scrubbing" });
		const scrub = el.createEl("ul");
		scrub.createEl("li", { text: "Use the slider beneath the section to step through AP positions." });
		scrub.createEl("li", { text: "The current AP coordinate is shown next to the slider." });

		el.createEl("h3", { text: "Saving" });
		el.createEl("p", {
			text: 'Click "Use this slice" to open the create-viewpoint modal. The viewpoint will only include polygons of the current structure and its descendants — outer regions are filtered out so the schematic stays focused.',
		});
	}

	// ── Viewpoint (2D schematic) ─────────────────────────────────────────────

	private renderViewpoint(el: HTMLElement): void {
		el.createEl("h2", { text: "Viewpoint view" });
		el.createEl("p", {
			text: "A 2D schematic of one Allen slice restricted to the current structure. The canvas you take notes against — cells get placed onto subregions, topics get scoped to specific layers.",
		});

		el.createEl("h3", { text: "Header controls" });
		const hdr = el.createEl("ul");
		hdr.createEl("li", { text: "Rotate slider — rotates the schematic. The angle is persisted." });
		hdr.createEl("li", { text: "⟲ — reset rotation, pan, and zoom to defaults." });
		hdr.createEl("li", { text: 'Viewpoints — back to the picker for this structure.' });
		hdr.createEl("li", { text: 'Open note — opens the viewpoint markdown file.' });

		el.createEl("h3", { text: "Canvas interaction" });
		const canv = el.createEl("ul");
		canv.createEl("li", { text: "Hover a subregion → tooltip with name + acronym." });
		canv.createEl("li", { text: "Click a subregion → focuses it. The side panel switches to show its cells, with '+ Add cell'." });
		canv.createEl("li", { text: "Scroll to zoom; drag to pan." });
		canv.createEl("li", { text: "Cell-dense layers (e.g. pyramidal / granule) are rendered darker by default, matching the Allen atlas." });

		el.createEl("h3", { text: "Adding cells" });
		el.createEl("p", {
			text: "Focus a subregion and click '+ Add cell'. Either pick a NeuroMorpho reconstruction or choose 'Create schematic cell (no morphology)' to draw a stylised glyph.",
		});
		const place = el.createEl("ul");
		place.createEl("li", { text: "Drag the preview to move it; the side panel sliders set x/y, scale, and rotation." });
		place.createEl("li", { text: "Keyboard while placing: ↑ ↓ ← → nudge · r / R rotate · + / − zoom · Esc cancels. These shortcuts pause while you're typing in the Name field, so letters like 'r' go into the cell name instead of rotating." });
		const schem = place.createEl("li");
		schem.appendText("Schematic cells gain five extra rows: ");
		schem.createEl("strong", { text: "shape" });
		schem.appendText(" (circle / triangle / oval — oriented by rotation), ");
		schem.createEl("strong", { text: "primary dendrites" });
		schem.appendText(" (count of cosmetic radiating dendrites), ");
		schem.createEl("strong", { text: "spread °" });
		schem.appendText(" (angular fan, 360 = full radial, 0 = stacked along rotation), ");
		schem.createEl("strong", { text: "branch depth" });
		schem.appendText(" (recursive forks per dendrite), and ");
		schem.createEl("strong", { text: "arborization" });
		schem.appendText(" (fork-angle width + taper).");
		place.createEl("li", { text: "Shape settings live on the cell-type note's frontmatter, so the cell looks the same in every viewpoint. Per-viewpoint position/scale/rotation lives under 'placements'." });

		el.createEl("h3", { text: "Side panel (right)" });
		el.createEl("p", {
			text: "Topics scoped to the current region/layer appear here, grouped by theme. Search filters them in place. '+ Add topic' pre-fills the scope with whatever you have focused.",
		});

		el.createEl("h3", { text: "Search" });
		el.createEl("p", {
			text: "Hits at this viewpoint show in the side panel; hits one level deeper (cell-scoped notes inside this viewpoint) appear as in-canvas dots. Multiple terms are ANDed by default; use uppercase AND between phrases to keep multi-word terms together — e.g. 'CA3 AND mossy fiber'.",
		});
	}

	// ── Cell view ────────────────────────────────────────────────────────────

	private renderCell(el: HTMLElement): void {
		el.createEl("h2", { text: "Cell view" });
		el.createEl("p", {
			text: "A single cell's morphology, with its compartments (soma, axon, dendrites) selectable for note-taking.",
		});

		el.createEl("h3", { text: "Header" });
		const hdr = el.createEl("ul");
		hdr.createEl("li", { text: "Title shows cell name + class (pyramidal, interneuron, …)." });
		hdr.createEl("li", { text: "Open note — opens the cell markdown file." });

		el.createEl("h3", { text: "Selecting a compartment" });
		el.createEl("p", {
			text: "Click a compartment in the morphology panel (or in the navigator's Compartments list). The current selection auto-fills the scope of any topic note you create — so a topic added while 'apical dendrite' is selected becomes scoped to that compartment of this cell.",
		});

		el.createEl("h3", { text: "Side panel" });
		el.createEl("p", {
			text: "Topics scoped to this cell (or the active compartment) are listed here, grouped by theme. Newly created per-compartment notes appear without needing a navigation round-trip.",
		});

		el.createEl("h3", { text: "Search" });
		el.createEl("p", {
			text: "Direct hits at the cell level show in the side panel. There is no deeper level than this — searches scoped here only return cell-anchored notes. Multiple terms are ANDed; use uppercase AND between phrases for multi-word matches.",
		});
	}
}

function addType(parent: HTMLElement, name: string, desc: string): void {
	const li = parent.createEl("li");
	li.createEl("code", { text: name });
	li.appendText(" — " + desc);
}

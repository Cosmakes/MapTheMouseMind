// ──────────────────────────────────────────────────────────────────────────────
// CreateViewpointModal.ts
//
// Opened from the Allen section viewer when the user clicks "Use this slice".
// Prompts for a name (pre-filled from structure + AP position) and optional
// notes, then writes the viewpoint note and invokes a completion callback so
// the nav stack can pop back to the picker.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type NeuroMindmapPlugin from "./main";
import { mouseRoot } from "./paths";
import { ViewpointPayload, writeViewpointNote } from "./viewpoints";

export class CreateViewpointModal extends Modal {
	private plugin:  NeuroMindmapPlugin;
	private payload: ViewpointPayload;
	private onDone:  (file: TFile) => void;

	private name:  string;
	private notes: string = "";

	constructor(
		app:             App,
		plugin:          NeuroMindmapPlugin,
		payload:         ViewpointPayload,
		defaultName:     string,
		onDone:          (file: TFile) => void,
	) {
		super(app);
		this.plugin  = plugin;
		this.payload = payload;
		this.name    = defaultName;
		this.onDone  = onDone;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save viewpoint" });

		contentEl.createEl("p", {
			cls:  "neuro-modal-desc",
			text: `${this.payload.layers.length} subregion${this.payload.layers.length === 1 ? "" : "s"} captured from AP ${this.payload.ap_mm.toFixed(2)} mm (${this.payload.plane}).`,
		});

		new Setting(contentEl)
			.setName("Viewpoint name")
			.setDesc("Used as the note title and filename.")
			.addText(t =>
				t
					.setValue(this.name)
					.onChange(v => { this.name = v.trim(); })
			);

		new Setting(contentEl)
			.setName("Notes (optional)")
			.setDesc("Free-text notes to include in the viewpoint note.")
			.addTextArea(t =>
				t
					.setPlaceholder("e.g. reference plate for Schaffer collateral pathway")
					.onChange(v => { this.notes = v; })
			);

		new Setting(contentEl)
			.addButton(btn =>
				btn
					.setButtonText("Save viewpoint")
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

	private async onSubmit(): Promise<void> {
		if (!this.name) {
			new Notice("Please enter a viewpoint name.");
			return;
		}
		try {
			const file = await writeViewpointNote(
				this.app,
				mouseRoot(this.plugin),
				this.name,
				this.notes,
				this.payload,
			);
			this.close();
			new Notice(`Saved viewpoint: ${file.basename}`);
			this.onDone(file);
		} catch (err) {
			new Notice(`Failed to save viewpoint: ${(err as Error).message}`);
		}
	}
}

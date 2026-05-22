// ──────────────────────────────────────────────────────────────────────────────
// CreateConnectionModal.ts
//
// Creates an explicit connection note (entity_type: connection).
// These notes are scanned by MapTheMindView and rendered as thick colored
// arrows in the schematic slice viewer.
// ──────────────────────────────────────────────────────────────────────────────

import { App, Modal, Notice, Setting, stringifyYaml } from "obsidian";
import type NeuroMindmapPlugin from "./main";
import { pathFor } from "./paths";
import { ConnectionDirection, ConnectionFrontmatter } from "./types";

const DIRECTIONS: { value: ConnectionDirection; label: string }[] = [
	{ value: "efferent",      label: "Efferent (→ output from source)" },
	{ value: "afferent",      label: "Afferent (← input to source)" },
	{ value: "bidirectional", label: "Bidirectional (↔)" },
	{ value: "modulatory",    label: "Modulatory (neuromodulatory)" },
];

const STRENGTHS = [
	{ value: "strong",   label: "Strong" },
	{ value: "moderate", label: "Moderate" },
	{ value: "weak",     label: "Weak" },
];

export class CreateConnectionModal extends Modal {
	private source    = "";
	private target    = "";
	private label     = "";
	private direction: ConnectionDirection = "efferent";
	private strength  = "moderate";

	private plugin: NeuroMindmapPlugin;

	constructor(app: App, plugin: NeuroMindmapPlugin, prefillSource?: string) {
		super(app);
		this.plugin = plugin;
		if (prefillSource) this.source = prefillSource;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "New connection note" });
		contentEl.createEl("p", {
			text: "A connection note records an anatomical or functional link between two regions or layers.",
			cls: "neuro-modal-desc",
		});

		new Setting(contentEl)
			.setName("Source")
			.setDesc("region_id or layer_id of the source entity (e.g. CA3, stratum_pyramidale).")
			.addText(text =>
				text.setPlaceholder("e.g. CA3")
					.setValue(this.source)
					.onChange(v => { this.source = v.trim(); })
			);

		new Setting(contentEl)
			.setName("Target")
			.setDesc("region_id or layer_id of the target entity.")
			.addText(text =>
				text.setPlaceholder("e.g. CA1")
					.onChange(v => { this.target = v.trim(); })
			);

		new Setting(contentEl)
			.setName("Label")
			.setDesc("Optional short description, e.g. 'Schaffer collateral'.")
			.addText(text =>
				text.setPlaceholder("e.g. Schaffer collateral")
					.onChange(v => { this.label = v.trim(); })
			);

		new Setting(contentEl)
			.setName("Direction")
			.addDropdown(drop => {
				DIRECTIONS.forEach(({ value, label }) => drop.addOption(value, label));
				drop.setValue(this.direction);
				drop.onChange(v => { this.direction = v as ConnectionDirection; });
			});

		new Setting(contentEl)
			.setName("Strength")
			.addDropdown(drop => {
				STRENGTHS.forEach(({ value, label }) => drop.addOption(value, label));
				drop.setValue(this.strength);
				drop.onChange(v => { this.strength = v; });
			});

		new Setting(contentEl)
			.addButton(btn =>
				btn.setButtonText("Create connection note").setCta()
					.onClick(() => { void this.onSubmit(); })
			)
			.addButton(btn =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async onSubmit(): Promise<void> {
		if (!this.source) { new Notice("Please enter a source."); return; }
		if (!this.target) { new Notice("Please enter a target."); return; }

		const folderPath = pathFor(this.plugin, "connections");
		const fileName   = `${slugify(this.source)}-${slugify(this.target)}`;
		const filePath   = `${folderPath}/${fileName}.md`;

		if (!this.app.vault.getFolderByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}

		const fm: ConnectionFrontmatter = {
			entity_type: "connection",
			tags:        ["connection"],
			source:      this.source,
			target:      this.target,
			direction:   this.direction,
			strength:    this.strength as "strong" | "moderate" | "weak",
		};
		if (this.label) fm.label = this.label;

		const heading = this.label
			? `# ${this.label}`
			: `# ${this.source} → ${this.target}`;
		const content = `---\n${stringifyYaml(fm)}---\n\n${heading}\n`;

		try {
			const newFile = await this.app.vault.create(filePath, content);
			this.close();
			await this.app.workspace.getLeaf().openFile(newFile);
			new Notice(`Created: ${fileName}.md`);
		} catch (err) {
			new Notice(`Failed: ${(err as Error).message}`);
		}
	}
}

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

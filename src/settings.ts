import { App, PluginSettingTab, Setting } from "obsidian";
import type NeuroMindmapPlugin from "./main";
import { HelpModal } from "./HelpModal";

export interface NeuroMindmapSettings {
	/** Root folder where all plugin-generated notes are stored. */
	defaultFolder: string;
	/**
	 * Map of last-opened viewpoint, keyed by stringified Allen ID.
	 * Lets the depth-1 drill-in auto-route to the most recent viewpoint
	 * for each region rather than always showing the picker.
	 */
	lastViewpointByAllenId: Record<string, string>;
	/**
	 * Persisted 3D camera state for the whole-brain viewer; restored on
	 * every visit so the user sees the brain at the angle they left it.
	 */
	brain3DCamera: { theta: number; phi: number; radius: number } | null;
	/** When true, dragging on the 3D canvas rotates the camera (default on). */
	brain3DDragToRotate: boolean;
	/** When true, a single click on a region mesh opens that region's viewpoint
	 *  (default off — prevents accidental drilling-in while rotating). */
	brain3DClickToOpen: boolean;
}

export const DEFAULT_SETTINGS: NeuroMindmapSettings = {
	defaultFolder:          "neuro",
	lastViewpointByAllenId: {},
	brain3DCamera:          null,
	brain3DDragToRotate:    true,
	brain3DClickToOpen:     false,
};

export class NeuroSettingsTab extends PluginSettingTab {
	plugin: NeuroMindmapPlugin;

	constructor(app: App, plugin: NeuroMindmapPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("How this plugin works")
			.setDesc("Open an overview of the navigation model, note types, and the atomic-topic workflow.")
			.addButton(btn =>
				btn.setButtonText("Show help")
					.setCta()
					.onClick(() => new HelpModal(this.app).open())
			);

		new Setting(containerEl)
			.setName("Default folder")
			.setDesc("Root folder for notes created by the plugin (e.g. neuro). Mouse notes are stored under this folder.")
			.addText(text =>
				text
					.setPlaceholder("neuro")
					.setValue(this.plugin.settings.defaultFolder)
					.onChange(async value => {
						this.plugin.settings.defaultFolder = value.trim() || "neuro";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("3D view: drag to rotate")
			.setDesc("Drag on the 3D brain canvas to rotate the camera. The ↑↓←→ buttons still work either way.")
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.brain3DDragToRotate)
					.onChange(async value => {
						this.plugin.settings.brain3DDragToRotate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("3D view: click to open region")
			.setDesc("Clicking a region in the 3D brain opens its viewpoint. Disabled by default to avoid accidental navigation while rotating.")
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.brain3DClickToOpen)
					.onChange(async value => {
						this.plugin.settings.brain3DClickToOpen = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

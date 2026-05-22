// ──────────────────────────────────────────────────────────────────────────────
// topics.ts  —  Discovery and creation helpers for topic notes.
//
// Mirrors the metadataCache scan pattern used by viewpoints.ts. No caching:
// metadataCache lookups are cheap and these queries run at panel-render time.
// ──────────────────────────────────────────────────────────────────────────────

import { App, TFile, stringifyYaml } from "obsidian";
import type {
	Compartment,
	TopicFrontmatter,
	TopicScope,
} from "./types";

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Returns topic notes whose `scope[]` contains an entry matching the query.
 * An entry matches if any of its provided keys (allen_id, cell) equals the
 * corresponding query field. A topic with empty scope matches only when the
 * caller passes `includeUnscoped: true` (used for the "global" list view).
 */
export function getTopicsForScope(
	app:   App,
	query: { allenId?: number; cell?: string; compartment?: Compartment },
	opts:  { includeUnscoped?: boolean } = {},
): TFile[] {
	const result: TFile[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			Partial<TopicFrontmatter> | undefined;
		if (fm?.entity_type !== "topic") continue;
		const scope = Array.isArray(fm.scope) ? fm.scope : [];
		if (scope.length === 0) {
			if (opts.includeUnscoped) result.push(file);
			continue;
		}
		if (scope.some(s => scopeMatches(s, query))) result.push(file);
	}
	return result;
}

function scopeMatches(
	s: TopicScope,
	q: { allenId?: number; cell?: string; compartment?: Compartment },
): boolean {
	if (q.allenId !== undefined && s.allen_id === q.allenId) return true;
	if (q.cell !== undefined && s.cell === q.cell) {
		// When the caller restricts by compartment, the scope entry must agree.
		// A scope without a compartment matches "any compartment" only when the
		// caller isn't filtering by compartment.
		if (q.compartment === undefined)         return true;
		if (s.compartment === q.compartment)     return true;
		// Treat basal/apical as instances of the broader "dendrite" filter.
		if (q.compartment === "dendrite" &&
		    (s.compartment === "basal" || s.compartment === "apical" || s.compartment === "dendrite")) return true;
	}
	return false;
}

// ── Folder helpers ────────────────────────────────────────────────────────────
//
// Notes are filed by *where they were taken*:
//   brain     → <folderRoot>/notes/
//   viewpoint → <viewpoint-folder>/notes/
//   cell      → <viewpoint-folder>/cell-notes/   (one folder per viewpoint;
//                cell-notes are differentiated by their `cell_id` frontmatter)
//
// Cells stay as flat files at <viewpoint-folder>/cells/<cell>.md, so a
// cell-note's location is keyed off the viewpoint folder, not the cell file.

export function notesFolderForBrain(folderRoot: string): string {
	return `${folderRoot}/notes`;
}

export function notesFolderForViewpoint(viewpointFile: TFile): string {
	const parent = viewpointFile.parent?.path ?? "";
	return parent ? `${parent}/notes` : "notes";
}

export function notesFolderForCell(viewpointFile: TFile): string {
	const parent = viewpointFile.parent?.path ?? "";
	return parent ? `${parent}/cell-notes` : "cell-notes";
}

// ── Writing ───────────────────────────────────────────────────────────────────

/**
 * Creates a topic note in the given folder. Returns the new TFile. Callers
 * are responsible for opening it afterwards. The folder will be created if
 * it doesn't exist. The body is inserted verbatim after the heading; callers
 * pre-render any backlink blocks they want to embed.
 */
export async function writeTopicNote(
	app:        App,
	folderPath: string,
	fm:         TopicFrontmatter,
	body:       string,
): Promise<TFile> {
	if (!app.vault.getFolderByPath(folderPath)) {
		await app.vault.createFolder(folderPath);
	}
	const slug     = uniqueSlug(app, folderPath, slugify(fm.topic_name));
	const filePath = `${folderPath}/${slug}.md`;

	const trimmed = body.trim();
	const fullBody = `# ${fm.topic_name}\n\n${trimmed ? `${trimmed}\n` : ""}`;
	const content = `---\n${stringifyYaml(fm)}---\n\n${fullBody}`;
	return app.vault.create(filePath, content);
}

// ── Slug helpers (duplicated from viewpoints.ts to keep modules decoupled) ───

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "topic";
}

function uniqueSlug(app: App, folder: string, base: string): string {
	let slug = base;
	let n = 2;
	while (app.vault.getAbstractFileByPath(`${folder}/${slug}.md`)) {
		slug = `${base}-${n}`;
		n++;
	}
	return slug;
}

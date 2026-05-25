// ──────────────────────────────────────────────────────────────────────────────
// search.ts  —  Cross-view search across topic notes.
//
// A *direct* hit is a note taken at the current scope level (and same
// viewpoint/cell, where applicable). A *deeper* hit is a note taken at a
// strictly deeper level that still falls within the current scope — those
// are surfaced as spatial markers/callouts in the active view.
//
// The service indexes title + summary + themes + body; bodies are fetched
// lazily via app.vault.cachedRead and cached by mtime so re-queries are
// cheap. Cache invalidation is wired to `vault.modify` and
// `metadataCache.changed` events.
// ──────────────────────────────────────────────────────────────────────────────

import { App, EventRef, TFile } from "obsidian";
import type { TopicFrontmatter, TopicScope } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchScope {
	level: "brain" | "viewpoint" | "cell";
	viewpointId?: string;
	cellId?:      string;
	/** Allen IDs whose notes count as "in this viewpoint" — the structure
	 *  itself plus all descendants. Required for level !== "brain". */
	descendantIds?: Set<number>;
}

export interface SearchHit {
	file:     TFile;
	level:    "brain" | "viewpoint" | "cell";
	viewpointId?: string;
	cellId?:      string;
	scope:    TopicScope[];
	title:    string;
	/** ~120-char excerpt around the first match. */
	snippet:  string;
	/** Where the hit applies in 3D — used for marker placement at parent levels. */
	anchorAllenId?: number;
}

export interface SearchResults {
	direct: SearchHit[];
	deeper: SearchHit[];
}

// ── Implementation ────────────────────────────────────────────────────────────

interface BodyCacheEntry {
	mtime: number;
	body:  string;
}

export class SearchService {
	private readonly app: App;
	private bodyCache = new Map<string, BodyCacheEntry>();
	private modifyRef:  EventRef | null = null;
	private deleteRef:  EventRef | null = null;
	private renameRef:  EventRef | null = null;
	private metaRef:    EventRef | null = null;

	constructor(app: App) {
		this.app = app;
		this.modifyRef = app.vault.on("modify", f => {
			if (f instanceof TFile) this.bodyCache.delete(f.path);
		});
		this.deleteRef = app.vault.on("delete", f => {
			if (f instanceof TFile) this.bodyCache.delete(f.path);
		});
		this.renameRef = app.vault.on("rename", (f, oldPath) => {
			this.bodyCache.delete(oldPath);
			if (f instanceof TFile) this.bodyCache.delete(f.path);
		});
		// Frontmatter-only edits don't trigger `modify` reliably.
		this.metaRef = app.metadataCache.on("changed", file => {
			this.bodyCache.delete(file.path);
		});
	}

	destroy(): void {
		if (this.modifyRef) this.app.vault.offref(this.modifyRef);
		if (this.deleteRef) this.app.vault.offref(this.deleteRef);
		if (this.renameRef) this.app.vault.offref(this.renameRef);
		if (this.metaRef)   this.app.metadataCache.offref(this.metaRef);
		this.bodyCache.clear();
	}

	/**
	 * Runs a case-insensitive substring search. Whitespace-separated terms
	 * are AND-combined — every term must appear somewhere in title/summary/
	 * themes/body. The literal uppercase keyword `AND` (whitespace-bounded)
	 * splits the query into multi-word phrases instead of single tokens,
	 * so `CA3 AND mossy fiber` requires both "ca3" and "mossy fiber" to
	 * appear. Returns matches partitioned into direct (current level) and
	 * deeper (nested below). Out-of-scope hits are silently dropped.
	 */
	async query(term: string, scope: SearchScope): Promise<SearchResults> {
		const direct: SearchHit[] = [];
		const deeper: SearchHit[] = [];
		const raw = term.trim();
		const needles = /\s+AND\s+/.test(raw)
			? raw.split(/\s+AND\s+/).map(p => p.trim().toLowerCase()).filter(p => p.length > 0)
			: raw.toLowerCase().split(/\s+/).filter(t => t.length > 0);
		if (needles.length === 0) return { direct, deeper };

		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
				Partial<TopicFrontmatter> | undefined;
			if (fm?.entity_type !== "topic") continue;

			const noteLevel: "brain" | "viewpoint" | "cell" = fm.level ?? "brain";
			const placement = classifyPlacement(noteLevel, fm, scope);
			if (placement === "out-of-scope") continue;

			const title    = fm.topic_name ?? file.basename;
			const summary  = fm.summary ?? "";
			const themes   = (fm.themes ?? []).join(" ");
			const haystackHead = `${title}\n${summary}\n${themes}`.toLowerCase();

			// AND match: every needle must hit either the head or the body.
			const headHits = needles.map(n => haystackHead.includes(n));
			const allInHead = headHits.every(h => h);

			let matchSnippet: string | null = null;
			if (allInHead) {
				const firstNeedle = needles[0]!;
				matchSnippet = excerpt(`${title} — ${summary}`.trim(), firstNeedle);
			} else {
				const body = await this.readBody(file);
				const lowerBody = body.toLowerCase();
				let firstHitIdx = -1;
				let firstHitNeedle = "";
				let allMatch = true;
				for (let i = 0; i < needles.length; i++) {
					const n = needles[i]!;
					if (headHits[i]) {
						if (firstHitIdx < 0) {
							firstHitIdx = lowerBody.indexOf(n);
							firstHitNeedle = n;
						}
						continue;
					}
					const idx = lowerBody.indexOf(n);
					if (idx < 0) { allMatch = false; break; }
					if (firstHitIdx < 0 || idx < firstHitIdx) {
						firstHitIdx = idx;
						firstHitNeedle = n;
					}
				}
				if (!allMatch) continue;
				if (firstHitIdx < 0) {
					matchSnippet = excerpt(`${title} — ${summary}`.trim(), needles[0]!);
				} else {
					matchSnippet = excerpt(body, firstHitNeedle, firstHitIdx);
				}
			}

			const scopeArr = Array.isArray(fm.scope) ? fm.scope : [];
			const hit: SearchHit = {
				file,
				level:        noteLevel,
				scope:        scopeArr,
				title,
				snippet:      matchSnippet,
				anchorAllenId: pickAnchor(scopeArr),
			};
			if (fm.viewpoint_id) hit.viewpointId = fm.viewpoint_id;
			if (fm.cell_id)      hit.cellId      = fm.cell_id;

			if (placement === "direct") direct.push(hit);
			else                        deeper.push(hit);
		}

		return { direct, deeper };
	}

	private async readBody(file: TFile): Promise<string> {
		const cached = this.bodyCache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) return cached.body;

		const raw  = await this.app.vault.cachedRead(file);
		const body = stripFrontmatter(raw);
		this.bodyCache.set(file.path, { mtime: file.stat.mtime, body });
		return body;
	}
}

// ── Placement logic ───────────────────────────────────────────────────────────

type Placement = "direct" | "deeper" | "out-of-scope";

function classifyPlacement(
	noteLevel: "brain" | "viewpoint" | "cell",
	fm:        Partial<TopicFrontmatter>,
	scope:     SearchScope,
): Placement {
	const depth = LEVEL_DEPTH[noteLevel];
	const scopeDepth = LEVEL_DEPTH[scope.level];

	// Notes shallower than the current scope (e.g. brain-level notes when
	// the user is viewing a specific viewpoint) are intentionally hidden.
	if (depth < scopeDepth) return "out-of-scope";

	if (depth === scopeDepth) {
		// Direct hit only when the same viewpoint/cell is implied.
		if (scope.level === "viewpoint") {
			return fm.viewpoint_id === scope.viewpointId ? "direct" : "out-of-scope";
		}
		if (scope.level === "cell") {
			return (fm.viewpoint_id === scope.viewpointId && fm.cell_id === scope.cellId)
				? "direct"
				: "out-of-scope";
		}
		return "direct"; // brain — only one bucket
	}

	// depth > scopeDepth → deeper. Must still fall within current container.
	if (scope.level === "brain") {
		// Any nested note is in scope.
		return "deeper";
	}
	if (scope.level === "viewpoint") {
		// Cell-level note inside same viewpoint folder.
		if (noteLevel === "cell" && fm.viewpoint_id === scope.viewpointId) return "deeper";
		return "out-of-scope";
	}
	// scope.level === "cell" — no deeper level exists.
	return "out-of-scope";
}

const LEVEL_DEPTH: Record<"brain" | "viewpoint" | "cell", number> = {
	brain:     0,
	viewpoint: 1,
	cell:      2,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickAnchor(scopes: TopicScope[]): number | undefined {
	for (const s of scopes) {
		if (s.allen_id !== undefined) return s.allen_id;
	}
	return undefined;
}

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\n---", 3);
	if (end < 0) return raw;
	const after = raw.slice(end + 4);
	return after.replace(/^\s*\n/, "");
}

function excerpt(text: string, needle: string, hintIdx?: number): string {
	const lower = text.toLowerCase();
	const idx   = hintIdx ?? lower.indexOf(needle);
	if (idx < 0) return text.slice(0, 120);
	const radius = 60;
	const start  = Math.max(0, idx - radius);
	const end    = Math.min(text.length, idx + needle.length + radius);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, " ").trim();
}

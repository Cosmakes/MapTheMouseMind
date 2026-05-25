// ──────────────────────────────────────────────────────────────────────────────
// views/SearchPreviewCard.ts  —  Floating search-result preview card.
//
// Builds a single card shared across overlays at every level. A card may
// represent one note (single block: title + snippet + region chips) or a
// cluster of notes that share a spatial anchor (cell, region, …) — the
// cluster case shows a stacked, scrollable list inside the same card so
// dense regions don't pile up dozens of overlay elements.
// ──────────────────────────────────────────────────────────────────────────────

import type { App, TFile } from "obsidian";
import type { SearchHit } from "../search";
import type { AllenStructureFlat } from "../api/allenStructureCache";

export interface PreviewCardOptions {
	app:  App;
	tree: Map<number, AllenStructureFlat>;
	/** Search term to highlight in snippets. */
	term: string;
	/** One or more hits to render. When > 1, the card shows a stacked list. */
	hits: SearchHit[];
	/** Click handler for opening a hit's file. */
	onOpen: (file: TFile) => void;
}

/**
 * Appends the card to `parent` and returns the card root, so the caller can
 * remove or reposition it.
 */
export function renderPreviewCard(
	parent: HTMLElement,
	opts:   PreviewCardOptions,
): HTMLElement {
	const card = parent.createDiv({ cls: "neuro-preview-card" });

	// ── Header ──────────────────────────────────────────────────────────────
	const header = card.createDiv({ cls: "neuro-preview-card-header" });
	const first = opts.hits[0];
	header.createSpan({
		text: opts.hits.length === 1 && first
			? first.title
			: `${opts.hits.length} notes`,
		cls:  "neuro-preview-card-title",
	});

	// Aggregated region badges (deduped across all hits in the cluster).
	const regionChips = card.createDiv({ cls: "neuro-preview-card-regions" });
	const seen = new Set<string>();
	for (const h of opts.hits) {
		for (const s of h.scope) {
			if (s.allen_id === undefined) continue;
			const node = opts.tree.get(s.allen_id);
			if (!node || seen.has(node.acronym)) continue;
			seen.add(node.acronym);
			regionChips.createSpan({
				text: node.acronym,
				cls:  "neuro-preview-card-region-chip",
			});
		}
	}
	if (seen.size === 0) regionChips.remove();

	// ── Hit list ────────────────────────────────────────────────────────────
	const list = card.createDiv({ cls: "neuro-preview-card-list" });
	if (opts.hits.length > 3) list.addClass("is-scrollable");
	for (const hit of opts.hits) {
		const row = list.createDiv({ cls: "neuro-preview-card-row" });
		if (opts.hits.length > 1) {
			row.createDiv({ text: hit.title, cls: "neuro-preview-card-row-title" });
		}
		const snip = row.createDiv({ cls: "neuro-preview-card-snippet" });
		appendHighlighted(snip, hit.snippet, opts.term);
		row.addEventListener("click", evt => {
			evt.stopPropagation();
			opts.onOpen(hit.file);
		});
	}

	return card;
}

/** Wraps each occurrence of any query phrase in `<mark>`. The query is split
 *  the same way the searcher splits it: uppercase whitespace-bounded `AND`
 *  produces phrases; otherwise per-token highlighting. Case-insensitive
 *  match, preserves original casing in the rendered text. */
function appendHighlighted(parent: HTMLElement, text: string, term: string): void {
	const raw = term.trim();
	if (!raw) { parent.setText(text); return; }
	const phrases = (/\s+AND\s+/.test(raw)
		? raw.split(/\s+AND\s+/).map(p => p.trim())
		: raw.split(/\s+/)
	).filter(p => p.length > 0).map(p => p.toLowerCase());
	if (phrases.length === 0) { parent.setText(text); return; }

	const lower = text.toLowerCase();
	let i = 0;
	while (i < text.length) {
		let bestIdx = -1;
		let bestLen = 0;
		for (const p of phrases) {
			const j = lower.indexOf(p, i);
			if (j < 0) continue;
			if (bestIdx < 0 || j < bestIdx || (j === bestIdx && p.length > bestLen)) {
				bestIdx = j;
				bestLen = p.length;
			}
		}
		if (bestIdx < 0) {
			parent.appendChild(document.createTextNode(text.slice(i)));
			return;
		}
		if (bestIdx > i) parent.appendChild(document.createTextNode(text.slice(i, bestIdx)));
		const mark = document.createElement("mark");
		mark.textContent = text.slice(bestIdx, bestIdx + bestLen);
		parent.appendChild(mark);
		i = bestIdx + bestLen;
	}
}

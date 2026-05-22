// ──────────────────────────────────────────────────────────────────────────────
// api/allenStructureCache.ts  —  Allen structure tree: load, cache, query.
//
// The full mouse CCFv3 structure tree (~1300 nodes) is downloaded once from the
// Allen API and stored as a flat JSON array in the plugin cache directory.
// All subsequent lookups are served from the in-memory Map<id, node>.
// ──────────────────────────────────────────────────────────────────────────────

import type { DataAdapter } from "obsidian";
import { fetchFullStructureTree } from "./allenAtlas";

// ── Cache helpers ──────────────────────────────────────────────────────────────

const CACHE_FILE = "structure-tree.json";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Lightweight, serialisable representation of one Allen CCFv3 structure. */
export interface AllenStructureFlat {
	id: number;
	name: string;
	acronym: string;
	/** 6-char hex without '#', e.g. "70FF71". */
	color_hex_triplet: string;
	parent_structure_id: number | null;
	st_level: number;
}

/**
 * Loads the structure tree from disk cache, or fetches + caches it on first run.
 * Returns a Map keyed by structure ID for O(1) lookups.
 */
export async function loadOrFetchStructureTree(
	graphUrl: string,
	cacheDir: string,
	adapter:  DataAdapter,
): Promise<Map<number, AllenStructureFlat>> {
	try { await adapter.mkdir(cacheDir); } catch { /* already exists */ }

	const cachePath = `${cacheDir}/${CACHE_FILE}`;

	if (await adapter.exists(cachePath)) {
		try {
			const raw   = await adapter.read(cachePath);
			const nodes = JSON.parse(raw) as AllenStructureFlat[];
			return buildMap(nodes);
		} catch {
			// Corrupt cache — fall through to re-fetch.
		}
	}

	const full  = await fetchFullStructureTree(graphUrl);
	const nodes: AllenStructureFlat[] = full.map(n => ({
		id:                  n.id,
		name:                n.name,
		acronym:             n.acronym,
		color_hex_triplet:   n.color_hex_triplet,
		parent_structure_id: n.parent_structure_id,
		st_level:            n.st_level,
	}));

	await adapter.write(cachePath, JSON.stringify(nodes));
	return buildMap(nodes);
}

function buildMap(nodes: AllenStructureFlat[]): Map<number, AllenStructureFlat> {
	const map = new Map<number, AllenStructureFlat>();
	for (const n of nodes) map.set(n.id, n);
	return map;
}

// ── Tree queries ───────────────────────────────────────────────────────────────

/**
 * Returns the immediate children of the given structure ID.
 */
export function getChildren(
	id:   number,
	tree: Map<number, AllenStructureFlat>,
): AllenStructureFlat[] {
	const result: AllenStructureFlat[] = [];
	for (const node of tree.values()) {
		if (node.parent_structure_id === id) result.push(node);
	}
	return result;
}

// Children-adjacency cache, keyed by tree Map identity. Built once per tree.
let childrenAdjCache: {
	tree: Map<number, AllenStructureFlat>;
	map:  Map<number, number[]>;
} | null = null;

function buildChildrenAdjacency(
	tree: Map<number, AllenStructureFlat>,
): Map<number, number[]> {
	if (childrenAdjCache?.tree === tree) return childrenAdjCache.map;
	const map = new Map<number, number[]>();
	for (const node of tree.values()) {
		if (node.parent_structure_id === null) continue;
		const list = map.get(node.parent_structure_id);
		if (list) list.push(node.id);
		else map.set(node.parent_structure_id, [node.id]);
	}
	childrenAdjCache = { tree, map };
	return map;
}

/**
 * Returns `id` plus all transitive descendants in the tree.
 *
 * Allen reference-atlas SVGs annotate only leaf structures, so any lookup
 * against an internal node (e.g. CA1 = 382) must be expanded to its leaves
 * (e.g. {382, 391, 399, 407, 415}) to find matching SVG paths.
 */
export function getDescendantIds(
	id:   number,
	tree: Map<number, AllenStructureFlat>,
): Set<number> {
	const adj = buildChildrenAdjacency(tree);
	const out = new Set<number>([id]);
	const stack = [id];
	while (stack.length > 0) {
		const cur = stack.pop() as number;
		const kids = adj.get(cur);
		if (!kids) continue;
		for (const k of kids) {
			if (!out.has(k)) { out.add(k); stack.push(k); }
		}
	}
	return out;
}

/**
 * Returns the ordered ancestor chain for a structure, root-last.
 * Does not include the structure itself.
 * e.g. CA1 (382) → [Hippocampal formation (1080), Cerebral cortex (688), …, root (997)]
 */
export function getAncestors(
	id:   number,
	tree: Map<number, AllenStructureFlat>,
): AllenStructureFlat[] {
	const ancestors: AllenStructureFlat[] = [];
	let current = tree.get(id);
	while (current && current.parent_structure_id !== null) {
		const parent = tree.get(current.parent_structure_id);
		if (!parent) break;
		ancestors.push(parent);
		current = parent;
	}
	return ancestors;
}

/**
 * Returns the top-20 structures whose name or acronym contains `query`
 * (case-insensitive).  Results are ordered by st_level (shallower first).
 */
export function searchStructures(
	query: string,
	tree:  Map<number, AllenStructureFlat>,
): AllenStructureFlat[] {
	const q = query.toLowerCase();
	const matches: AllenStructureFlat[] = [];
	for (const node of tree.values()) {
		if (
			node.name.toLowerCase().includes(q) ||
			node.acronym.toLowerCase().includes(q)
		) {
			matches.push(node);
		}
	}
	matches.sort((a, b) => a.st_level - b.st_level);
	return matches.slice(0, 20);
}


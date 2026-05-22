// ──────────────────────────────────────────────────────────────────────────────
// api/neuromorpho.ts  —  NeuroMorpho.org fetch + SWC parse + 2D projection.
//
// Public endpoint docs: https://neuromorpho.org/apiReference.html
//
// Fetch flow for an identifier "neuromorpho:<name>":
//   1. GET https://neuromorpho.org/api/neuron/name/<name>   → neuron record
//   2. GET https://neuromorpho.org/dableFiles/<archive>/CNG%20version/<name>.CNG.swc
//      where <archive> comes from record.archive (lowercased) — SWC file
//   3. Cache the SWC text at <cacheDir>/<name>.swc for offline reuse
// ──────────────────────────────────────────────────────────────────────────────

import { requestUrl, type DataAdapter } from "obsidian";
import type {
	MorphologyCandidate,
	MorphologyQuery,
	MorphologySource,
} from "./morphologySource";

export interface SwcNode {
	id: number;
	type: number;   // 1=soma, 2=axon, 3=basal dendrite, 4=apical dendrite
	x: number;
	y: number;
	z: number;
	radius: number;
	parent: number; // -1 if root
}

export interface Point2D {
	x: number;
	y: number;
	parent: number;
	type: number;
	radius: number;
}

const CACHE_DIR = "morphology-cache";

/**
 * Resolves a "neuromorpho:<name>" identifier to a parsed SWC node list,
 * using the on-disk cache when available.
 */
export async function fetchNeuronSwc(
	identifier: string,
	adapter:    DataAdapter,
): Promise<SwcNode[]> {
	const name = identifier.replace(/^neuromorpho:/i, "").trim();
	if (!name) throw new Error("Empty neuromorpho identifier.");

	try { await adapter.mkdir(CACHE_DIR); } catch { /* exists */ }
	const cachePath = `${CACHE_DIR}/${sanitize(name)}.swc`;

	if (await adapter.exists(cachePath)) {
		try {
			return parseSwc(await adapter.read(cachePath));
		} catch { /* fall through to re-fetch */ }
	}

	const record = await fetchNeuronRecord(name);
	const archive = (record.archive ?? "").toLowerCase();
	if (!archive) throw new Error(`No archive for neuron "${name}".`);

	const swcText = await fetchSwcFile(archive, name);
	try { await adapter.write(cachePath, swcText); } catch { /* cache write failure is non-fatal */ }
	return parseSwc(swcText);
}

interface NeuronRecord {
	neuron_name?: string;
	archive?: string;
}

async function fetchNeuronRecord(name: string): Promise<NeuronRecord> {
	const url = `https://neuromorpho.org/api/neuron/name/${encodeURIComponent(name)}`;
	const res = await requestUrl({ url, throw: false });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`NeuroMorpho lookup failed (HTTP ${res.status}) for "${name}".`);
	}
	return res.json as NeuronRecord;
}

async function fetchSwcFile(archive: string, name: string): Promise<string> {
	const url =
		`https://neuromorpho.org/dableFiles/${encodeURIComponent(archive)}` +
		`/CNG%20version/${encodeURIComponent(name)}.CNG.swc`;
	const res = await requestUrl({ url, throw: false });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`SWC fetch failed (HTTP ${res.status}) for "${name}".`);
	}
	return res.text;
}

/** Parses an SWC file body into an array of typed nodes. */
export function parseSwc(text: string): SwcNode[] {
	const nodes: SwcNode[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 7) continue;
		const [sId, sType, sX, sY, sZ, sR, sP] = parts;
		const node: SwcNode = {
			id:     parseInt(sId!, 10),
			type:   parseInt(sType!, 10),
			x:      parseFloat(sX!),
			y:      parseFloat(sY!),
			z:      parseFloat(sZ!),
			radius: parseFloat(sR!),
			parent: parseInt(sP!, 10),
		};
		if ([node.id, node.type, node.x, node.y, node.z, node.radius, node.parent]
				.some(v => !Number.isFinite(v))) continue;
		nodes.push(node);
	}
	return nodes;
}

/**
 * Projects 3D SWC nodes to 2D for a given viewing plane.
 *   coronal  → drop Z, keep (x, y)      (AP is the discarded axis)
 *   sagittal → drop X, keep (z, y)
 *
 * Note: SWC y-axis is conventionally down (dorsal-ventral), so we negate it
 * to match typical Allen 2D atlas rendering (dorsal up).
 */
export function project2d(
	nodes: SwcNode[],
	plane: "coronal" | "sagittal",
): Point2D[] {
	return nodes.map(n => ({
		x:       plane === "coronal" ? n.x : n.z,
		y:       -n.y,
		parent:  n.parent,
		type:    n.type,
		radius:  n.radius,
	}));
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

// ──────────────────────────────────────────────────────────────────────────────
// Neuron search — used by AddCellModal to populate the candidate list.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Heuristic map from Allen layer-suffix to likely NeuroMorpho cell_type
 * strings. NeuroMorpho's cell_type field is free-text authored by uploaders,
 * so this is best-effort: missing entries just mean we don't re-rank.
 */
const LAYER_CELL_TYPE_HINTS: Record<string, string[]> = {
	sp:   ["pyramidal"],
	sg:   ["granule"],
	so:   ["interneuron", "basket"],
	sr:   ["interneuron"],
	slm:  ["interneuron", "oriens"],
	mo:   ["granule"],
	po:   ["molecular"],
};

/**
 * Allen acronym → NeuroMorpho free-text brain_region terms.
 *
 * NeuroMorpho uses descriptive names ("hippocampus", "entorhinal cortex",
 * "dentate gyrus"), not Allen codes ("HIP", "ENT", "HPF"). The NeuroMorpho
 * API ORs terms within the array, so we pass every plausible term at once
 * and let the server return the union.
 *
 * Keys cover the Allen acronyms most likely to appear as `parent_region_id`
 * in viewpoint frontmatter. Leaf-layer acronyms (CA1sp, DGsg, …) map to the
 * corresponding NeuroMorpho layer term so a neuron tagged with that specific
 * layer still matches.
 */
const ALLEN_TO_NEUROMORPHO: Record<string, string[]> = {
	// Hippocampal formation
	HPF:   ["hippocampus", "dentate gyrus", "entorhinal cortex"],
	HIP:   ["hippocampus"],
	CA:    ["hippocampus", "CA1", "CA3"],
	CA1:   ["CA1", "hippocampus"],
	CA2:   ["CA2", "hippocampus"],
	CA3:   ["CA3", "hippocampus"],
	DG:    ["dentate gyrus", "hippocampus"],
	SUB:   ["subiculum", "hippocampus"],
	ENT:   ["entorhinal cortex"],
	ENTl:  ["entorhinal cortex"],
	ENTm:  ["entorhinal cortex"],
	// Cortex
	Isocortex: ["neocortex"],
	CTX:   ["neocortex"],
	MO:    ["primary motor"],
	MOp:   ["primary motor"],
	MOs:   ["primary motor"],
	SS:    ["somatosensory", "primary somatosensory"],
	SSp:   ["primary somatosensory"],
	SSs:   ["somatosensory"],
	VIS:   ["primary visual"],
	VISp:  ["primary visual"],
	PL:    ["prelimbic", "prefrontal"],
	ILA:   ["prefrontal"],
	ACA:   ["prefrontal"],
	ORB:   ["prefrontal"],
	// Subcortical
	STR:   ["striatum", "basal ganglia"],
	CP:    ["striatum"],
	ACB:   ["nucleus accumbens", "ventral striatum"],
	TH:    ["thalamus"],
	HY:    ["hypothalamus"],
	AMY:   ["amygdala"],
	BLA:   ["basolateral amygdala complex", "amygdala"],
	SN:    ["substantia nigra"],
	SNc:   ["substantia nigra"],
	SNr:   ["substantia nigra"],
	MB:    ["midbrain tegmentum"],
	CB:    ["cerebellum", "cerebellar cortex"],
	CBX:   ["cerebellar cortex"],
	// Leaf layer aliases (hippocampus)
	CA1sp: ["pyramidal layer", "CA1"],
	CA2sp: ["pyramidal layer", "CA2"],
	CA3sp: ["pyramidal layer", "CA3"],
	CA1so: ["CA1"],
	CA3so: ["CA3"],
	CA1sr: ["stratum radiatum", "CA1"],
	CA3sr: ["stratum radiatum", "CA3"],
	CA1slm: ["CA1"],
	DGsg:  ["granule layer", "stratum granulosum", "dentate gyrus"],
	DGmo:  ["molecular layer", "dentate gyrus"],
	DGpo:  ["dentate gyrus"],
};

/** Expands an Allen acronym to NeuroMorpho brain_region terms. Falls back to
 *  the acronym itself when no alias is known — some Allen codes (CA1, CA3,
 *  DG) happen to appear verbatim in NeuroMorpho. */
function allenToNeuroMorphoRegions(acronym: string): string[] {
	const hit = ALLEN_TO_NEUROMORPHO[acronym];
	if (hit && hit.length > 0) return hit;
	return [acronym];
}

const SEARCH_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface NeuroMorphoRecord {
	neuron_name?: string;
	archive?:     string;
	species?:     string;
	brain_region?: string[];
	cell_type?:   string[];
	strain?:      string;
}

interface NeuroMorphoSearchResponse {
	_embedded?: { neuronResources?: NeuroMorphoRecord[] };
	page?: { totalElements?: number };
}

interface SearchCacheBlob {
	fetchedAt:  number;
	candidates: MorphologyCandidate[];
}

/**
 * Returns a MorphologySource implementation backed by NeuroMorpho.org.
 * Callers pass the vault DataAdapter so results can be cached on disk.
 */
export function createNeuroMorphoSource(adapter: DataAdapter): MorphologySource {
	return {
		id:    "neuromorpho",
		label: "NeuroMorpho.org",
		async search(query: MorphologyQuery): Promise<MorphologyCandidate[]> {
			return searchNeurons(query, adapter);
		},
	};
}

/**
 * Searches NeuroMorpho for neurons in the focused leaf's parent region,
 * re-ranks by layer hints, and caches the result on disk for TTL days.
 */
export async function searchNeurons(
	query:   MorphologyQuery,
	adapter: DataAdapter,
): Promise<MorphologyCandidate[]> {
	const cachePath = `${CACHE_DIR}/search-neuromorpho-` +
		`${sanitize(query.regionAcronym)}-${query.species}.json`;

	try { await adapter.mkdir(CACHE_DIR); } catch { /* exists */ }

	// Disk cache
	if (await adapter.exists(cachePath)) {
		try {
			const blob = JSON.parse(await adapter.read(cachePath)) as SearchCacheBlob;
			if (Date.now() - blob.fetchedAt < SEARCH_CACHE_TTL_MS) {
				return blob.candidates;
			}
		} catch { /* fall through to re-fetch */ }
	}

	const candidates = await fetchNeuroMorphoCandidates(query);

	// Don't pin empty results to disk — a later retry is cheap, and empties
	// may reflect a transient Allen↔NeuroMorpho region-name mismatch.
	if (candidates.length > 0) {
		try {
			const blob: SearchCacheBlob = { fetchedAt: Date.now(), candidates };
			await adapter.write(cachePath, JSON.stringify(blob));
		} catch { /* non-fatal */ }
	}

	return candidates;
}

async function fetchNeuroMorphoCandidates(
	query: MorphologyQuery,
): Promise<MorphologyCandidate[]> {
	// AddCellModal handles the leaf→parent→…→root fallback chain, so this
	// function queries exactly one Allen region. NeuroMorpho's array ORs
	// values within a field, so we expand the acronym to all plausible
	// NeuroMorpho free-text terms in one shot.
	const regionTerms = allenToNeuroMorphoRegions(query.regionAcronym);
	const criteria: Record<string, string[]> = {
		brain_region: regionTerms,
		species:      [query.species],
	};

	const url = "https://neuromorpho.org/api/neuron/select?size=200";
	const res = await requestUrl({
		url,
		method:  "POST",
		headers: { "Content-Type": "application/json" },
		body:    JSON.stringify(criteria),
		throw:   false,
	});
	// NeuroMorpho returns 404 with a "Requested neuron(s) not found" body when
	// the query matches zero neurons — treat as an empty result set.
	if (res.status === 404) return [];
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`NeuroMorpho search failed (HTTP ${res.status}).`);
	}

	const data = res.json as NeuroMorphoSearchResponse;
	const records = data._embedded?.neuronResources ?? [];

	const hints = layerHints(query.leafAcronym);
	const scored = records
		.filter(r => !!r.neuron_name)
		.map(r => ({
			record: r,
			score:  hints.length === 0 ? 0 : cellTypeScore(r.cell_type ?? [], hints),
		}));

	// If we have hints, prefer hinted records — but don't drop unhinted ones
	// entirely (the user may want to verify the heuristic).
	scored.sort((a, b) => b.score - a.score);

	return scored.map(({ record }) => recordToCandidate(record));
}

function cellTypeScore(types: string[], hints: string[]): number {
	const hay = types.join(" ").toLowerCase();
	let score = 0;
	for (const h of hints) if (hay.includes(h)) score++;
	return score;
}

function layerHints(leafAcronym: string): string[] {
	const lower = leafAcronym.toLowerCase();
	for (const suffix of Object.keys(LAYER_CELL_TYPE_HINTS)) {
		if (lower.endsWith(suffix)) return LAYER_CELL_TYPE_HINTS[suffix]!;
	}
	return [];
}

function recordToCandidate(r: NeuroMorphoRecord): MorphologyCandidate {
	const name = r.neuron_name ?? "";
	const extra: Record<string, string> = {};
	if (r.archive) extra.archive = r.archive;
	if (r.strain)  extra.strain  = r.strain;
	return {
		identifier:  `neuromorpho:${name}`,
		name,
		cellType:    (r.cell_type    ?? []).join(", "),
		brainRegion: (r.brain_region ?? []).join(", "),
		species:     r.species ?? "",
		source:      "NeuroMorpho.org",
		extra,
	};
}

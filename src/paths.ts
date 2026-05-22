// ──────────────────────────────────────────────────────────────────────────────
// paths.ts  —  Vault folder layout.
//
// Every kind of generated note lives under `${defaultFolder}/mouse/${kind}`.
// All discovery and creation code calls `pathFor(...)` rather than hard-coding
// subpaths, so changing the layout is a one-line edit.
// ──────────────────────────────────────────────────────────────────────────────

import type NeuroMindmapPlugin from "./main";

export type NoteKind =
	| "regions"
	| "cells"
	| "viewpoints"
	| "topics"
	| "themes"
	| "connections";

/** Vault path of the folder where notes of `kind` should be stored. */
export function pathFor(plugin: NeuroMindmapPlugin, kind: NoteKind): string {
	return `${plugin.settings.defaultFolder}/mouse/${kind}`;
}

/** Root folder under which all generated notes live —
 *  `${defaultFolder}/mouse`. Used by helpers that append their own subpath
 *  (e.g. `writeViewpointNote` appends `/viewpoints`, `notesFolderForBrain`
 *  appends `/notes`). */
export function mouseRoot(plugin: NeuroMindmapPlugin): string {
	return `${plugin.settings.defaultFolder}/mouse`;
}

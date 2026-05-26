// ──────────────────────────────────────────────────────────────────────────────
// views/BrainViewer3D.ts  —  Interactive Three.js 3D brain viewer (Allen Atlas)
//
// Rendering pipeline
// ──────────────────
// 1. On construction: downloads (and caches) the CCFv3 whole-brain OBJ
//    (structure 997) and renders it as a transparent outline.
// 2. For each region note passed in `regionNotes` (allenId → color): loads the
//    corresponding OBJ and shows it as a colored solid mesh.
// 3. Ancestor meshes (parent context) are loaded semi-transparently and can be
//    toggled in the layer panel.
//
// Interaction
// ───────────
// • Button-based camera controls overlaid top-right (↑↓←→ rotate, +/− zoom)
// • Raycaster on mousemove → hover highlight
// • Click → onRegionClick(allenId) callback
// • Layer toggle panel overlaid bottom-left
//
// Disposal
// ────────
// Always call dispose() when the view closes to release the WebGL context.
// ──────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { type App, type TFile } from "obsidian";
import type { SearchHit } from "../search";
import { type AllenStructureFlat } from "../api/allenStructureCache";
import type { AtlasProvider } from "../atlas";
import type { ViewpointFrontmatter } from "../types";
import { renderPreviewCard } from "./SearchPreviewCard";
import { HelpModal } from "../HelpModal";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Maximum number of preview cards rendered at once; the rest collapse to
 *  black dots that swap in on hover. */
const EXPANDED_CARD_LIMIT = 3;
/** Minimum distance, in screen pixels, between a preview card's centre and
 *  its anchor dot. Mandatory: the layout searches for an angle that keeps
 *  the card on-canvas at this distance rather than reducing the gap. */
const CARD_OUTWARD_OFFSET_PX = 220;
/** Padding (px) kept between adjacent cards when resolving overlaps. */
const CARD_OVERLAP_PAD_PX = 12;
/** Padding (px) between a card edge and the canvas edge after clamping. */
const CARD_EDGE_PAD_PX = 10;
/** Step (px) by which an overlapping card is pushed further outward per
 *  iteration, and the iteration cap (so the loop can never spin forever). */
const CARD_PUSH_STEP_PX  = 18;
const CARD_PUSH_MAX_ITER = 40;

// ── Options ────────────────────────────────────────────────────────────────────

export interface BrainViewer3DOptions {
	app:      App;
	cacheDir: string;
	/** Atlas provider — used for mesh fetching, the CCF → Three.js
	 *  coordinate transform, and the bregma origin for ap_mm. */
	provider: AtlasProvider;
	/** Called when the user clicks a loaded region mesh. */
	onRegionClick?: (allenId: number) => void;
	/** Region notes to render as colored overlays. The map is keyed by allenId
	 *  and carries both the 6-char hex (no '#') used for mesh tinting and the
	 *  user-chosen display name (from the note's `region_name` frontmatter). */
	regionNotes: Map<number, { color: string; name: string }>;
	/** Ancestor IDs (immediate parent first, root last) for context meshes. */
	ancestorIds?: number[];
	/** Allen structure tree — used by preview cards to render region chips. */
	structureTree: Map<number, AllenStructureFlat>;
	/** Optional initial camera state (spherical coords). When omitted the
	 *  viewer falls back to its built-in default angle. */
	initialCamera?: { theta: number; phi: number; radius: number };
	/** Fired (debounced) whenever the user changes the camera so the host
	 *  can persist it. */
	onCameraChange?: (camera: { theta: number; phi: number; radius: number }) => void;
	/** Live read of the user's interaction-mode toggles. The viewer calls this
	 *  on every input event, so changes in plugin settings take effect
	 *  immediately without remounting the view. If omitted, defaults to
	 *  drag-to-rotate enabled and click-to-open disabled. */
	getInteractionModes?: () => { dragToRotate: boolean; clickToOpen: boolean };
}

// ── Viewer ────────────────────────────────────────────────────────────────────

export class BrainViewer3D {
	private container:   HTMLElement;
	private headerEl!:   HTMLElement;
	private canvasWrap!: HTMLElement;
	private app:         App;
	private opts:        BrainViewer3DOptions;
	private cacheDir:    string;

	private renderer!: THREE.WebGLRenderer;
	private scene!:    THREE.Scene;
	private camera!:   THREE.PerspectiveCamera;
	private raycaster  = new THREE.Raycaster();
	private pointer    = new THREE.Vector2();

	private spherical  = { theta: Math.PI, phi: Math.PI / 3, radius: 18 };
	private renderPending = false;
	private animFrameId:  number | null = null;
	private resizeObs!:   ResizeObserver;

	/** Clickable region meshes: allenId → mesh list */
	private regionMeshes   = new Map<number, THREE.Mesh[]>();
	/** Ancestor meshes (context, semi-transparent): allenId → mesh list */
	private ancestorMeshes = new Map<number, THREE.Mesh[]>();
	/** Whole-brain outline meshes */
	private outlineMeshes: THREE.Mesh[] = [];

	private hoveredId: number | null = null;

	private layerPanel: HTMLElement | null = null;

	// ── Search overlays ──────────────────────────────────────────────────────
	// One anchor per viewpoint with deeper hits. Both the dot and the card
	// live in HTML overlays sibling to the WebGL canvas and are reprojected
	// each frame from the viewpoint's slice-centre (in scene coordinates).
	private searchAnchors:    Search3DAnchor[] = [];
	private overlayCardsEl:   HTMLElement   | null = null;
	private overlayLinesEl:   SVGSVGElement | null = null;
	private searchTerm:       string = "";
	private hoverPromotedRank: number | null = null;

	constructor(container: HTMLElement, app: App, opts: BrainViewer3DOptions) {
		this.container = container;
		this.app       = app;
		this.opts      = opts;
		this.cacheDir  = opts.cacheDir;

		if (opts.initialCamera) {
			this.spherical = { ...opts.initialCamera };
		}

		this.container.addClass("neuro-3d-root");
		this.headerEl   = this.container.createDiv({ cls: "neuro-3d-header" });
		this.canvasWrap = this.container.createDiv({ cls: "neuro-3d-canvas-wrap" });

		this.initRenderer();
		this.initScene();
		this.addHeaderControls();
		this.attachInputListeners();

		this.resizeObs = new ResizeObserver(() => this.handleResize());
		this.resizeObs.observe(this.canvasWrap);

		this.requestRender();

		// Async: load whole-brain outline + region/ancestor meshes
		void this.loadAllMeshes();
	}

	// ── Init ──────────────────────────────────────────────────────────────────────

	private initRenderer(): void {
		const { width, height } = this.canvasWrap.getBoundingClientRect();
		const w = width  || 520;
		const h = height || 380;

		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setSize(w, h);
		this.renderer.shadowMap.enabled = false;
		this.canvasWrap.appendChild(this.renderer.domElement);

		this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 200);
		this.updateCameraFromSpherical();
	}

	private initScene(): void {
		this.scene = new THREE.Scene();

		const hemi = new THREE.HemisphereLight(0xfff8f0, 0x202030, 0.6);
		this.scene.add(hemi);

		const key = new THREE.DirectionalLight(0xffffff, 0.9);
		key.position.set(6, 10, 8);
		this.scene.add(key);

		const fill = new THREE.DirectionalLight(0xc0d8ff, 0.35);
		fill.position.set(-8, 2, 4);
		this.scene.add(fill);
	}

	// ── Mesh loading ──────────────────────────────────────────────────────────────

	private async loadAllMeshes(): Promise<void> {
		await this.loadWholeBrainOutline();
		for (const [allenId, entry] of this.opts.regionNotes) {
			await this.loadRegionMesh(allenId, entry.color);
		}
		for (const ancestorId of this.opts.ancestorIds ?? []) {
			await this.loadAncestorMesh(ancestorId);
		}
		this.rebuildLayerPanel();
	}

	private async loadWholeBrainOutline(): Promise<void> {
		try {
			const geo = await this.buildGeometryForStructure(this.opts.provider.rootStructureId);
			if (!geo) return;

			// Transparent solid
			const solidMat = new THREE.MeshPhongMaterial({
				color:       0xaabbcc,
				transparent: true,
				opacity:     0.06,
				depthWrite:  false,
				side:        THREE.FrontSide,
			});
			const solidMesh = new THREE.Mesh(geo, solidMat);
			solidMesh.userData = { layerType: "outline" };
			this.scene.add(solidMesh);
			this.outlineMeshes.push(solidMesh);

			// Wireframe overlay
			const wireMat = new THREE.MeshBasicMaterial({
				color:       0x8899bb,
				transparent: true,
				opacity:     0.10,
				wireframe:   true,
			});
			const wireMesh = new THREE.Mesh(geo, wireMat);
			wireMesh.userData = { layerType: "outline" };
			this.scene.add(wireMesh);
			this.outlineMeshes.push(wireMesh);

			this.requestRender();
		} catch (err) {
			console.warn("[neuro-mindmap] Whole-brain mesh load failed:", err);
		}
	}

	/** Loads and adds a colored solid mesh for a brain region note. */
	private async loadRegionMesh(allenId: number, hexColor: string): Promise<void> {
		if (this.regionMeshes.has(allenId)) return;
		try {
			const geo = await this.buildGeometryForStructure(allenId);
			if (!geo) return;

			const mat = new THREE.MeshPhongMaterial({
				color:       new THREE.Color(`#${hexColor}`),
				transparent: true,
				opacity:     0.70,
				shininess:   50,
				side:        THREE.FrontSide,
			});
			const mesh = new THREE.Mesh(geo, mat);
			mesh.userData = { allenId, layerType: "region", baseColor: hexColor };
			this.scene.add(mesh);
			this.regionMeshes.set(allenId, [mesh]);
			this.requestRender();
		} catch (err) {
			console.warn(`[neuro-mindmap] Region mesh ${allenId} failed:`, err);
		}
	}

	/** Loads a semi-transparent ancestor mesh for 3D context. */
	private async loadAncestorMesh(allenId: number): Promise<void> {
		if (this.ancestorMeshes.has(allenId)) return;
		if (allenId === this.opts.provider.rootStructureId) return;
		try {
			const geo = await this.buildGeometryForStructure(allenId);
			if (!geo) return;

			const mat = new THREE.MeshPhongMaterial({
				color:       0x99aacc,
				transparent: true,
				opacity:     0.08,
				depthWrite:  false,
				side:        THREE.FrontSide,
			});
			const mesh = new THREE.Mesh(geo, mat);
			mesh.userData = { allenId, layerType: "ancestor" };
			this.scene.add(mesh);
			this.ancestorMeshes.set(allenId, [mesh]);
			this.requestRender();
		} catch (err) {
			console.warn(`[neuro-mindmap] Ancestor mesh ${allenId} failed:`, err);
		}
	}

	// ── Geometry build ─────────────────────────────────────────────────────────

	private async buildGeometryForStructure(
		allenId: number,
	): Promise<THREE.BufferGeometry | null> {
		const objText = await this.loadOrFetchObj(allenId);
		return this.parseObjGeometry(objText);
	}

	// ── OBJ cache & transform ──────────────────────────────────────────────────

	private async loadOrFetchObj(allenId: number): Promise<string> {
		const adapter   = this.app.vault.adapter;
		const cachePath = `${this.cacheDir}/${allenId}.obj`;
		try { await adapter.mkdir(this.cacheDir); } catch { /* exists */ }

		if (await adapter.exists(cachePath)) {
			return adapter.read(cachePath);
		}

		const objText = await this.opts.provider.fetchStructureMeshObj(allenId);
		await adapter.write(cachePath, objText);
		return objText;
	}

	private parseObjGeometry(objText: string): THREE.BufferGeometry | null {
		const loader = new OBJLoader();
		const group  = loader.parse(objText);
		let geo: THREE.BufferGeometry | null = null;
		group.traverse(child => {
			if (!geo && child instanceof THREE.Mesh) {
				geo = child.geometry as THREE.BufferGeometry;
			}
		});
		if (!geo) return null;
		this.transformCcfGeometry(geo);
		return geo;
	}

	private transformCcfGeometry(geo: THREE.BufferGeometry): void {
		const pos = geo.attributes.position as THREE.BufferAttribute;
		if (!pos) return;
		const ccfToThree = this.opts.provider.ccfToThree;
		for (let i = 0; i < pos.count; i++) {
			const [tx, ty, tz] = ccfToThree(pos.getX(i), pos.getY(i), pos.getZ(i));
			pos.setXYZ(i, tx, ty, tz);
		}
		pos.needsUpdate = true;
		geo.computeBoundingBox();
		geo.computeVertexNormals();
	}

	// ── Public update API ─────────────────────────────────────────────────────────

	/** Called when vault notes change — reloads region meshes as needed. */
	async updateRegionNotes(notes: Map<number, { color: string; name: string }>): Promise<void> {
		this.opts.regionNotes = notes;
		// Remove meshes for notes that no longer exist
		for (const [allenId, meshes] of this.regionMeshes) {
			if (!notes.has(allenId)) {
				meshes.forEach(m => {
					this.scene.remove(m);
					m.geometry.dispose();
					(m.material as THREE.Material).dispose();
				});
				this.regionMeshes.delete(allenId);
			}
		}
		// Add new meshes
		for (const [allenId, entry] of notes) {
			if (!this.regionMeshes.has(allenId)) {
				await this.loadRegionMesh(allenId, entry.color);
			}
		}
		this.rebuildLayerPanel();
		this.requestRender();
	}

	// ── Layer toggle panel ─────────────────────────────────────────────────────────

	private rebuildLayerPanel(): void {
		if (this.layerPanel) this.layerPanel.remove();

		const panel = this.canvasWrap.createDiv({ cls: "neuro-layer-panel" });
		this.layerPanel = panel;

		const addRow = (
			label:    string,
			hexColor: string | null,
			meshes:   THREE.Mesh[],
			visible:  boolean,
		): void => {
			const row     = panel.createDiv({ cls: "neuro-layer-row" });
			const cb      = row.createEl("input");
			cb.type        = "checkbox";
			cb.checked     = visible;
			cb.addEventListener("change", () => {
				meshes.forEach(m => { m.visible = cb.checked; });
				this.requestRender();
			});
			if (hexColor) {
				const swatch = row.createEl("span", { cls: "neuro-tree-swatch" });
				swatch.style.backgroundColor = hexColor;
			}
			row.createEl("span", { text: label, cls: "neuro-layer-label" });
		};

		addRow("Whole brain", null, this.outlineMeshes, true);

		for (const [allenId, meshes] of this.regionMeshes) {
			const note = this.opts.regionNotes.get(allenId);
			addRow(
				note?.name ?? `Structure ${allenId}`,
				note ? `#${note.color}` : null,
				meshes,
				true,
			);
		}

		for (const [allenId, meshes] of this.ancestorMeshes) {
			addRow(`${allenId} (parent)`, null, meshes, true);
		}
	}

	// ── Highlighting ───────────────────────────────────────────────────────────────

	private setHoverHighlight(allenId: number | null, on: boolean): void {
		if (allenId === null) return;
		const meshes = this.regionMeshes.get(allenId) ?? [];
		for (const m of meshes) {
			const mat = m.material as THREE.MeshPhongMaterial;
			if (on) {
				mat.emissive.setHex(0x334455);
				mat.opacity = Math.min(1.0, (mat.opacity ?? 0.70) + 0.20);
			} else {
				mat.emissive.setHex(0x000000);
				mat.opacity = 0.70;
			}
		}
		this.requestRender();
	}

	// ── Camera ─────────────────────────────────────────────────────────────────────

	private updateCameraFromSpherical(): void {
		const { theta, phi, radius } = this.spherical;
		this.camera.position.set(
			radius * Math.sin(phi) * Math.sin(theta),
			radius * Math.cos(phi),
			radius * Math.sin(phi) * Math.cos(theta),
		);
		this.camera.lookAt(0, 0, 0);
	}

	rotateHorizontal(delta: number): void {
		this.spherical.theta += delta;
		this.updateCameraFromSpherical();
		this.requestRender();
		this.scheduleCameraPersist();
	}

	rotateVertical(delta: number): void {
		this.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.spherical.phi + delta));
		this.updateCameraFromSpherical();
		this.requestRender();
		this.scheduleCameraPersist();
	}

	zoom(factor: number): void {
		this.spherical.radius = Math.max(5, Math.min(40, this.spherical.radius * factor));
		this.updateCameraFromSpherical();
		this.requestRender();
		this.scheduleCameraPersist();
	}

	private cameraPersistTimer: number | null = null;
	/** Debounces camera-state persistence to avoid hammering settings save
	 *  during a rotate-drag. Fires 250ms after the last camera change. */
	private scheduleCameraPersist(): void {
		if (!this.opts.onCameraChange) return;
		if (this.cameraPersistTimer !== null) {
			window.clearTimeout(this.cameraPersistTimer);
		}
		this.cameraPersistTimer = window.setTimeout(() => {
			this.cameraPersistTimer = null;
			this.opts.onCameraChange?.({ ...this.spherical });
		}, 250);
	}

	// ── Render-on-demand ───────────────────────────────────────────────────────────

	private requestRender(): void {
		if (this.renderPending) return;
		this.renderPending = true;
		this.animFrameId = requestAnimationFrame(() => {
			this.renderPending = false;
			this.animFrameId   = null;
			this.renderer.render(this.scene, this.camera);
			this.updateOverlayPositions();
		});
	}

	// ── Controls ───────────────────────────────────────────────────────────────────

	private addHeaderControls(): void {
		const STEP = Math.PI / 4;

		const rotGroup = this.headerEl.createDiv({ cls: "neuro-3d-header-group" });
		rotGroup.createEl("span", { text: "Rotate", cls: "neuro-3d-header-label" });
		const rotBtns: [string, () => void][] = [
			["←", () => this.rotateHorizontal(-STEP)],
			["↑", () => this.rotateVertical(-STEP)],
			["↓", () => this.rotateVertical(+STEP)],
			["→", () => this.rotateHorizontal(+STEP)],
		];
		for (const [label, fn] of rotBtns) {
			rotGroup.createEl("button", { cls: "neuro-viewer-btn", text: label })
				.addEventListener("click", fn);
		}

		const zoomGroup = this.headerEl.createDiv({ cls: "neuro-3d-header-group" });
		zoomGroup.createEl("span", { text: "Zoom", cls: "neuro-3d-header-label" });
		zoomGroup.createEl("button", { cls: "neuro-viewer-btn", text: "+" })
			.addEventListener("click", () => this.zoom(0.8));
		zoomGroup.createEl("button", { cls: "neuro-viewer-btn", text: "−" })
			.addEventListener("click", () => this.zoom(1.25));

		this.headerEl.createDiv({ cls: "neuro-3d-header-spacer" });

		const helpBtn = this.headerEl.createEl("button", {
			text: "?",
			cls:  "neuro-viewer-btn neuro-viewer-help-btn",
			attr: { title: "Help for the 3D brain view" },
		});
		helpBtn.addEventListener("click", () => new HelpModal(this.app, "brain3d").open());
	}

	// ── Input events ───────────────────────────────────────────────────────────────

	private attachInputListeners(): void {
		const canvas = this.renderer.domElement;

		// Hover highlight — runs on every pointer move including during a drag.
		canvas.addEventListener("pointermove", (e: PointerEvent) => {
			this.updatePointer(e);
			this.handleHover();
			this.handleDragRotate(e);
		});

		canvas.addEventListener("mouseleave", () => {
			if (this.hoveredId !== null) {
				this.setHoverHighlight(this.hoveredId, false);
				this.hoveredId = null;
				canvas.style.cursor = "default";
			}
		});

		// Drag-to-rotate + click-to-open with a 4px move threshold so a tiny
		// twitch during a click doesn't get classified as a drag (and so a
		// long drag doesn't fire a stray click on release).
		canvas.addEventListener("pointerdown", (e: PointerEvent) => {
			if (e.button !== 0) return;
			this.drag.active = true;
			this.drag.moved  = false;
			this.drag.downX  = this.drag.lastX = e.clientX;
			this.drag.downY  = this.drag.lastY = e.clientY;
			canvas.setPointerCapture(e.pointerId);
		});

		const endDrag = (e: PointerEvent): void => {
			if (!this.drag.active) return;
			const wasMoved = this.drag.moved;
			this.drag.active = false;
			this.drag.moved  = false;
			canvas.releasePointerCapture?.(e.pointerId);

			const modes = this.opts.getInteractionModes?.()
				?? { dragToRotate: true, clickToOpen: false };
			if (!wasMoved && modes.clickToOpen
				&& this.hoveredId !== null && this.opts.onRegionClick) {
				this.opts.onRegionClick(this.hoveredId);
			}
		};
		canvas.addEventListener("pointerup", endDrag);
		canvas.addEventListener("pointercancel", endDrag);
	}

	private drag = {
		active: false,
		moved:  false,
		downX:  0, downY: 0,
		lastX:  0, lastY: 0,
	};

	private handleDragRotate(e: PointerEvent): void {
		if (!this.drag.active) return;
		const DRAG_THRESHOLD_PX    = 4;
		const DRAG_ROT_SENSITIVITY = 0.005;  // rad / px — ~57° per 200px swipe

		if (!this.drag.moved && Math.hypot(
			e.clientX - this.drag.downX, e.clientY - this.drag.downY,
		) > DRAG_THRESHOLD_PX) {
			this.drag.moved = true;
		}
		const modes = this.opts.getInteractionModes?.()
			?? { dragToRotate: true, clickToOpen: false };
		if (!this.drag.moved || !modes.dragToRotate) return;

		const dx = e.clientX - this.drag.lastX;
		const dy = e.clientY - this.drag.lastY;
		if (dx !== 0) this.rotateHorizontal(-dx * DRAG_ROT_SENSITIVITY);
		if (dy !== 0) this.rotateVertical( -dy * DRAG_ROT_SENSITIVITY);
		this.drag.lastX = e.clientX;
		this.drag.lastY = e.clientY;
	}

	private updatePointer(e: MouseEvent): void {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.pointer.set(
			 ((e.clientX - rect.left)  / rect.width)  * 2 - 1,
			-((e.clientY - rect.top)   / rect.height) * 2 + 1,
		);
	}

	/** True while a search is showing preview anchors. Used to suppress
	 *  region hover (re-tint + cursor change) so the cards don't reflow as
	 *  the user moves the mouse over the brain. */
	private get searchActive(): boolean {
		return this.searchAnchors.length > 0 || this.searchTerm !== "";
	}

	private handleHover(): void {
		if (this.searchActive) return;
		this.raycaster.setFromCamera(this.pointer, this.camera);

		const targets: THREE.Mesh[] = [];
		this.regionMeshes.forEach(meshes => targets.push(...meshes));

		const hits  = this.raycaster.intersectObjects(targets, false);
		const newId = (hits[0]?.object.userData as { allenId?: number } | undefined)
			?.allenId ?? null;

		if (newId === this.hoveredId) return;

		if (this.hoveredId !== null) this.setHoverHighlight(this.hoveredId, false);
		if (newId !== null)          this.setHoverHighlight(newId, true);
		this.hoveredId = newId;
		this.renderer.domElement.style.cursor = newId !== null ? "pointer" : "default";
	}

	// ── Resize ─────────────────────────────────────────────────────────────────────

	private handleResize(): void {
		const { width, height } = this.canvasWrap.getBoundingClientRect();
		if (!width || !height) return;
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
		this.requestRender();
	}

	// ── Search overlay (deeper hits) ───────────────────────────────────────────

	/**
	 * Render preview cards for deeper-level hits, **grouped by viewpoint**.
	 * For each viewpoint that has hits we walk up the structure tree from
	 * the viewpoint's `allen_id` until we find an ancestor whose mesh is
	 * both loaded and currently visible (i.e. not toggled off in the layer
	 * panel). When several viewpoints resolve to the same parent mesh
	 * (e.g. dorsal + ventral hippocampus both falling back to the
	 * hippocampus mesh), their anchors are placed on alternating
	 * hemispheres so the dots are visually distinguishable. Viewpoints
	 * whose structure (or any ancestor) is not displayed in the 3D scene
	 * are silently dropped.
	 *
	 * Top EXPANDED_CARD_LIMIT anchors (by hit count) start expanded; the
	 * rest render as black dots that swap their card in on hover.
	 */
	applyDeeperHits(term: string, hits: SearchHit[]): void {
		this.clearDeeperHits();
		this.searchTerm = term;

		// Search is now active — clear any in-flight hover so the highlight
		// doesn't linger while hover handlers are gated.
		if (this.hoveredId !== null) {
			this.setHoverHighlight(this.hoveredId, false);
			this.hoveredId = null;
			this.renderer.domElement.style.cursor = "default";
		}

		// Group hits by viewpoint.
		const groups = new Map<string, SearchHit[]>();
		for (const h of hits) {
			if (!h.viewpointId) continue;
			const list = groups.get(h.viewpointId) ?? [];
			list.push(h);
			groups.set(h.viewpointId, list);
		}
		if (groups.size === 0) return;

		const vpIndex = this.buildViewpointIndex();

		interface PreCandidate {
			viewpointId:   string;
			viewpointFile: TFile;
			hits:          SearchHit[];
			fm:            ViewpointFrontmatter;
			mesh:          THREE.Mesh;
		}
		interface Candidate {
			viewpointId:   string;
			viewpointFile: TFile;
			hits:          SearchHit[];
			centroid:      THREE.Vector3;
			mesh:          THREE.Mesh;
		}

		const pre: PreCandidate[] = [];
		for (const [vpId, vpHits] of groups) {
			const entry = vpIndex.get(vpId);
			if (!entry) continue;
			const resolved = this.findVisibleAncestor(entry.fm.allen_id);
			if (!resolved) continue;
			pre.push({
				viewpointId:   vpId,
				viewpointFile: entry.file,
				hits:          vpHits,
				fm:            entry.fm,
				mesh:          resolved.mesh,
			});
		}
		if (pre.length === 0) return;

		// Stable order so the "first" anchor in each mesh group is
		// deterministic — the highest-hit-count viewpoint gets the
		// right hemisphere.
		pre.sort((a, b) => {
			if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
			return a.viewpointId.localeCompare(b.viewpointId);
		});

		const meshSeq = new Map<THREE.Mesh, number>();
		const candidates: Candidate[] = [];
		for (const p of pre) {
			const seq = meshSeq.get(p.mesh) ?? 0;
			meshSeq.set(p.mesh, seq + 1);
			const hemisphere: "left" | "right" = seq % 2 === 0 ? "right" : "left";

			const centroid = this.computeViewpointAnchor3D(p.fm, p.mesh, hemisphere);
			if (!centroid) continue;
			candidates.push({
				viewpointId:   p.viewpointId,
				viewpointFile: p.viewpointFile,
				hits:          p.hits,
				centroid,
				mesh:          p.mesh,
			});
		}
		if (candidates.length === 0) return;

		this.ensureOverlayLayers();

		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i]!;
			const isExpanded = i < EXPANDED_CARD_LIMIT;

			const dot = this.overlayCardsEl!.createDiv({ cls: "neuro-search-preview-dot" });
			dot.setAttr("title",
				`${c.hits.length} note${c.hits.length === 1 ? "" : "s"}: `
				+ c.hits.map(h => h.title).join(", "));
			dot.addEventListener("click", () => {
				const first = c.hits[0];
				if (first) void this.app.workspace.getLeaf("split").openFile(first.file);
			});

			const card = this.overlayCardsEl!.createDiv({ cls: "neuro-search-preview-card-wrap" });
			renderPreviewCard(card, {
				app:    this.app,
				tree:   this.opts.structureTree,
				term:   this.searchTerm,
				hits:   c.hits,
				onOpen: file => void this.app.workspace.getLeaf("split").openFile(file),
			});

			const anchor: Search3DAnchor = {
				viewpointId:   c.viewpointId,
				viewpointFile: c.viewpointFile,
				hits:          c.hits,
				centroid:      c.centroid,
				mesh:          c.mesh,
				rank:          i,
				expanded:      isExpanded,
				dot, card, line: null,
			};
			this.searchAnchors.push(anchor);

			// Entrance animation: dot fades in first, then the leader line
			// draws out, then the card fades in. CSS handles the staggered
			// timing via animation-delay on each `.is-entering` piece.
			dot.classList.add("is-entering");
			card.classList.add("is-entering");

			dot.addEventListener("mouseenter", () => {
				if (anchor.rank < EXPANDED_CARD_LIMIT) return;
				this.hoverPromotedRank = anchor.rank;
				this.applyAnchorVisibility();
			});
			dot.addEventListener("mouseleave", () => {
				if (this.hoverPromotedRank === anchor.rank) {
					this.hoverPromotedRank = null;
					this.applyAnchorVisibility();
				}
			});
		}

		this.applyAnchorVisibility();
		this.requestRender();
	}

	clearDeeperHits(): void {
		for (const o of this.searchAnchors) {
			o.dot.remove();
			o.card.remove();
			o.line?.remove();
		}
		this.searchAnchors = [];
		this.hoverPromotedRank = null;
		this.searchTerm = "";
		if (this.overlayCardsEl && this.overlayCardsEl.children.length === 0) {
			this.overlayCardsEl.remove();
			this.overlayCardsEl = null;
		}
		if (this.overlayLinesEl && this.overlayLinesEl.children.length === 0) {
			this.overlayLinesEl.remove();
			this.overlayLinesEl = null;
		}
		this.requestRender();
	}

	/** Vault-wide map of viewpoint slug → frontmatter + file. The slug is the
	 *  viewpoint folder name, which is what `SearchHit.viewpointId` carries. */
	private buildViewpointIndex(): Map<string, { file: TFile; fm: ViewpointFrontmatter }> {
		const idx = new Map<string, { file: TFile; fm: ViewpointFrontmatter }>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
				Partial<ViewpointFrontmatter> | undefined;
			if (fm?.entity_type !== "viewpoint") continue;
			if (typeof fm.allen_id !== "number") continue;
			const vpId = file.parent?.name ?? file.basename;
			idx.set(vpId, { file, fm: fm as ViewpointFrontmatter });
		}
		return idx;
	}

	/** Walks ancestors via `parent_structure_id` until a loaded **and visible**
	 *  mesh is found. Returns the mesh together with the Allen ID it was
	 *  registered under (which may be a parent of `startId`). Null if no
	 *  ancestor up to the root is currently displayed. */
	private findVisibleAncestor(startId: number):
		{ mesh: THREE.Mesh; allenId: number } | null
	{
		const tree = this.opts.structureTree;
		let id: number | null = startId;
		while (id !== null) {
			const meshes = this.regionMeshes.get(id) ?? this.ancestorMeshes.get(id);
			if (meshes && meshes.length > 0) {
				const visible = meshes.find(m => m.visible);
				if (visible) return { mesh: visible, allenId: id };
			}
			const node = tree.get(id);
			id = node?.parent_structure_id ?? null;
		}
		return null;
	}

	/** Anatomical anchor for a viewpoint dot in world (Three.js) coordinates.
	 *
	 *  Hemisphere-aware centroid of mesh vertices that lie within a thin
	 *  slab around the viewpoint's slice plane. Allen reference-atlas meshes
	 *  are bilateral, so a plain bbox centre lands at scene-X ≈ 0 (the
	 *  midline gap between hemispheres). Filtering vertices by hemisphere
	 *  pulls the anchor onto actual mesh tissue; the slab filter further
	 *  snaps to the viewpoint's AP depth. Per-frame raycasting in
	 *  `projectAnchorToCanvas` then resolves the dot's screen position to
	 *  the first front-facing surface hit. */
	private computeViewpointAnchor3D(
		vpFm:       ViewpointFrontmatter,
		mesh:       THREE.Mesh,
		hemisphere: "left" | "right",
	): THREE.Vector3 | null {
		const pos = mesh.geometry.attributes.position as
			THREE.BufferAttribute | undefined;
		if (!pos) return null;

		const provider = this.opts.provider;
		let sliceAxis: "x" | "z" | null = null;
		let sliceCoord = 0;
		if (typeof vpFm.ap_mm === "number") {
			const apUm = provider.bregmaUm - vpFm.ap_mm * 1000;
			// The only ccfToThree component we need is the one along the slice
			// axis, which depends on a single input axis — the others can be 0.
			if (vpFm.plane === "coronal") {
				sliceAxis  = "z";
				sliceCoord = provider.ccfToThree(apUm, 0, 0)[2];
			} else if (vpFm.plane === "sagittal") {
				sliceAxis  = "x";
				sliceCoord = provider.ccfToThree(0, 0, apUm)[0];
			}
		}

		const SLAB_HALF_MM = 0.5;
		const sign = hemisphere === "right" ? 1 : -1;

		let sx = 0, sy = 0, sz = 0, n = 0;
		for (let i = 0; i < pos.count; i++) {
			const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
			if (sign * x < 0) continue;
			if (sliceAxis === "z" && Math.abs(z - sliceCoord) > SLAB_HALF_MM) continue;
			if (sliceAxis === "x" && Math.abs(x - sliceCoord) > SLAB_HALF_MM) continue;
			sx += x; sy += y; sz += z; n++;
		}

		// Slab missed (e.g. ap_mm outside the structure's AP extent) — fall
		// back to all vertices on the chosen hemisphere.
		if (n === 0) {
			for (let i = 0; i < pos.count; i++) {
				const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
				if (sign * x < 0) continue;
				sx += x; sy += y; sz += z; n++;
			}
		}
		if (n === 0) return null;

		const centre = new THREE.Vector3(sx / n, sy / n, sz / n);
		mesh.updateMatrixWorld();
		centre.applyMatrix4(mesh.matrixWorld);
		return centre;
	}

	/** Projects an anchor to NDC space via a raycast through the resolved
	 *  mesh: shoots from the camera through the anchor's anatomical centre
	 *  and uses the first front-facing surface hit. Falls back to projecting
	 *  the centre directly if the ray misses (rare — happens only when the
	 *  camera looks straight into a concavity past the silhouette). */
	private projectAnchorToCanvas(a: Search3DAnchor): THREE.Vector3 {
		const dir = new THREE.Vector3()
			.subVectors(a.centroid, this.camera.position).normalize();
		this.raycaster.set(this.camera.position, dir);
		const hits = this.raycaster.intersectObject(a.mesh, false);
		const target = hits.length > 0 ? hits[0]!.point : a.centroid;
		return target.clone().project(this.camera);
	}

	private ensureOverlayLayers(): void {
		if (!this.overlayCardsEl) {
			this.overlayCardsEl = this.canvasWrap.createDiv({ cls: "neuro-search-preview-overlay" });
		}
		if (!this.overlayLinesEl) {
			const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
			svg.setAttribute("class", "neuro-search-preview-lines");
			this.overlayCardsEl.appendChild(svg);
			this.overlayLinesEl = svg;
		}
	}

	/** Decides which anchors render their card vs. only their dot, based on
	 *  rank + the optional hover-promotion. Always shows EXPANDED_CARD_LIMIT
	 *  cards (or fewer if there aren't enough anchors). */
	private applyAnchorVisibility(): void {
		const linesSvg = this.overlayLinesEl;
		if (!linesSvg) return;

		const visible = new Set<number>();
		for (let r = 0; r < Math.min(EXPANDED_CARD_LIMIT, this.searchAnchors.length); r++) {
			visible.add(r);
		}
		if (this.hoverPromotedRank !== null && !visible.has(this.hoverPromotedRank)) {
			let lowestRank = -1;
			for (const r of visible) if (r > lowestRank) lowestRank = r;
			if (lowestRank >= 0) visible.delete(lowestRank);
			visible.add(this.hoverPromotedRank);
		}

		for (const anchor of this.searchAnchors) {
			const isExpanded = visible.has(anchor.rank);
			anchor.expanded = isExpanded;
			anchor.card.toggleClass("is-visible", isExpanded);
			anchor.dot.toggleClass("is-promoted", anchor.rank === this.hoverPromotedRank);

			if (isExpanded && !anchor.line) {
				const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
				line.setAttribute("class", "neuro-search-preview-line is-entering");
				linesSvg.appendChild(line);
				anchor.line = line;
			} else if (!isExpanded && anchor.line) {
				anchor.line.remove();
				anchor.line = null;
			}
		}
		this.updateOverlayPositions();
		this.requestRender();
	}

	private updateOverlayPositions(): void {
		if (this.searchAnchors.length === 0) return;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const w = rect.width;
		const h = rect.height;
		// Dots, cards, and the leader-line SVG all live inside `overlayCardsEl`
		// (which is `inset:0` of `canvasWrap`). To keep the three in lock-step,
		// every coordinate written below is expressed relative to that overlay
		// box: offset = renderer canvas pos − overlay box pos.
		const overlayRect = this.overlayCardsEl?.getBoundingClientRect()
			?? this.canvasWrap.getBoundingClientRect();
		const offsetX = rect.left - overlayRect.left;
		const offsetY = rect.top  - overlayRect.top;
		if (this.overlayLinesEl) {
			// SVG fills the overlay box; coords inside use overlay-local pixels.
			this.overlayLinesEl.setAttribute("width",  String(overlayRect.width));
			this.overlayLinesEl.setAttribute("height", String(overlayRect.height));
		}
		const cx = w / 2;
		const cy = h / 2;

		// First pass: project each anchor, position its dot, and record its
		// natural outward angle (away from canvas centre).
		interface Placement {
			anchor:    Search3DAnchor;
			dotX:      number; dotY: number;
			baseAngle: number;
			cardX:     number; cardY: number;
			halfW:     number; halfH: number;
		}
		// Obstacles: in-canvas UI overlays the cards must avoid (the layer
		// panel is the main one). Coordinates are in canvas-local pixels.
		const obstacles: Array<{ x: number; y: number; halfW: number; halfH: number }> = [];
		if (this.layerPanel) {
			const r = this.layerPanel.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				obstacles.push({
					x:     (r.left + r.right) / 2 - rect.left,
					y:     (r.top  + r.bottom) / 2 - rect.top,
					halfW: r.width  / 2,
					halfH: r.height / 2,
				});
			}
		}

		const placements: Placement[] = [];
		for (const a of this.searchAnchors) {
			// Raycast from the camera through the anatomical anchor (mesh
			// bbox centre, slice-axis snapped). The first front-facing hit
			// projects to the same screen pixel as the anchor itself but
			// guarantees we're picking a point on the mesh — useful for
			// concave structures where the bbox centre sits in a gap.
			const v = this.projectAnchorToCanvas(a);
			const sx = (v.x * 0.5 + 0.5) * w;
			const sy = (1 - (v.y * 0.5 + 0.5)) * h;
			a.dot.style.left = `${offsetX + sx}px`;
			a.dot.style.top  = `${offsetY + sy}px`;

			const baseAngle = Math.atan2(sy - cy, sx - cx);

			placements.push({
				anchor: a,
				dotX: sx, dotY: sy,
				baseAngle,
				cardX: sx + Math.cos(baseAngle) * CARD_OUTWARD_OFFSET_PX,
				cardY: sy + Math.sin(baseAngle) * CARD_OUTWARD_OFFSET_PX,
				halfW: a.card.offsetWidth  / 2,
				halfH: a.card.offsetHeight / 2,
			});
		}

		// Second pass: place each visible card. Search over (angle deviation,
		// distance) starting from the natural angle and the mandatory minimum
		// distance — pick the closest fit that stays inside the canvas and
		// doesn't overlap a previously placed card. Distance never drops below
		// CARD_OUTWARD_OFFSET_PX, so the dot→card gap is preserved.
		const expanded = placements.filter(p => p.anchor.expanded);
		expanded.sort((a, b) => a.anchor.rank - b.anchor.rank);
		const placed: Placement[] = [];
		const angleDeltas: number[] = [0];
		for (let s = 1; s <= 12; s++) {
			const rad = (s * 15) * Math.PI / 180;
			angleDeltas.push(rad);
			angleDeltas.push(-rad);
		}
		for (const p of expanded) {
			let placedOk = false;
			outer: for (let push = 0; push < CARD_PUSH_MAX_ITER; push++) {
				const distance = CARD_OUTWARD_OFFSET_PX + push * CARD_PUSH_STEP_PX;
				for (const delta of angleDeltas) {
					const a = p.baseAngle + delta;
					const cx2 = p.dotX + Math.cos(a) * distance;
					const cy2 = p.dotY + Math.sin(a) * distance;
					if (cx2 - p.halfW - CARD_EDGE_PAD_PX < 0) continue;
					if (cx2 + p.halfW + CARD_EDGE_PAD_PX > w) continue;
					if (cy2 - p.halfH - CARD_EDGE_PAD_PX < 0) continue;
					if (cy2 + p.halfH + CARD_EDGE_PAD_PX > h) continue;
					let collided = false;
					for (const q of placed) {
						if (
							Math.abs(cx2 - q.cardX) < p.halfW + q.halfW + CARD_OVERLAP_PAD_PX &&
							Math.abs(cy2 - q.cardY) < p.halfH + q.halfH + CARD_OVERLAP_PAD_PX
						) { collided = true; break; }
					}
					if (collided) continue;
					for (const o of obstacles) {
						if (
							Math.abs(cx2 - o.x) < p.halfW + o.halfW + CARD_OVERLAP_PAD_PX &&
							Math.abs(cy2 - o.y) < p.halfH + o.halfH + CARD_OVERLAP_PAD_PX
						) { collided = true; break; }
					}
					if (collided) continue;
					p.cardX = cx2;
					p.cardY = cy2;
					placedOk = true;
					break outer;
				}
			}
			if (!placedOk) {
				// Fallback only when no on-canvas / non-overlapping pose exists
				// (very small viewport). Clamp to keep the card visible.
				const minX = p.halfW + CARD_EDGE_PAD_PX;
				const maxX = w - p.halfW - CARD_EDGE_PAD_PX;
				const minY = p.halfH + CARD_EDGE_PAD_PX;
				const maxY = h - p.halfH - CARD_EDGE_PAD_PX;
				if (maxX > minX) p.cardX = Math.min(Math.max(p.cardX, minX), maxX);
				if (maxY > minY) p.cardY = Math.min(Math.max(p.cardY, minY), maxY);
			}
			placed.push(p);
		}

		// Third pass: write final positions for all placements (including
		// non-expanded anchors, which still have a default cardX/cardY).
		for (const p of placements) {
			p.anchor.card.style.left = `${offsetX + p.cardX}px`;
			p.anchor.card.style.top  = `${offsetY + p.cardY}px`;
			if (p.anchor.line) {
				p.anchor.line.setAttribute("x1", String(offsetX + p.dotX));
				p.anchor.line.setAttribute("y1", String(offsetY + p.dotY));
				p.anchor.line.setAttribute("x2", String(offsetX + p.cardX));
				p.anchor.line.setAttribute("y2", String(offsetY + p.cardY));
			}
		}
	}

	// ── Disposal ───────────────────────────────────────────────────────────────────

	dispose(): void {
		if (this.animFrameId !== null) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
		if (this.cameraPersistTimer !== null) {
			window.clearTimeout(this.cameraPersistTimer);
			this.cameraPersistTimer = null;
			// Flush so a quick close doesn't drop a pending camera change.
			this.opts.onCameraChange?.({ ...this.spherical });
		}
		this.resizeObs.disconnect();
		this.clearDeeperHits();

		this.scene.traverse(obj => {
			if (!(obj instanceof THREE.Mesh)) return;
			obj.geometry.dispose();
			const mat = obj.material;
			if (Array.isArray(mat)) mat.forEach(m => m.dispose());
			else mat.dispose();
		});
		this.renderer.dispose();
		this.renderer.domElement.remove();
		this.layerPanel?.remove();
	}
}

interface Search3DAnchor {
	/** Viewpoint folder slug — matches `SearchHit.viewpointId`. */
	viewpointId:   string;
	viewpointFile: TFile;
	hits:          SearchHit[];
	/** World-space anatomical anchor (resolved mesh's bbox centre with the
	 *  slice axis snapped to the viewpoint's `ap_mm`). Each frame we raycast
	 *  from the camera through this point and use the first front-facing
	 *  surface hit on `mesh` for the dot's screen position. */
	centroid:      THREE.Vector3;
	/** Resolved mesh (the viewpoint's structure or its first visible
	 *  ancestor) — raycast target each frame. */
	mesh:          THREE.Mesh;
	rank:          number;
	expanded:      boolean;
	dot:           HTMLDivElement;
	card:          HTMLDivElement;
	line:          SVGLineElement | null;
}

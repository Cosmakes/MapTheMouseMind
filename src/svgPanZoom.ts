// ──────────────────────────────────────────────────────────────────────────────
// svgPanZoom.ts  —  Reusable pan + zoom behaviour for an <svg>.
//
// Attaches wheel-zoom (about cursor) and mouse-drag pan to an SVG element.
// The SVG must have an initial `viewBox` attribute; the helper mutates that
// attribute as the user interacts. Double-click resets to the initial box.
// ──────────────────────────────────────────────────────────────────────────────

export interface PanZoomHandle {
	destroy: () => void;
	reset:   () => void;
}

interface Box { x: number; y: number; w: number; h: number; }

export function attachPanZoom(svg: SVGSVGElement): PanZoomHandle {
	const initial = parseViewBox(svg.getAttribute("viewBox"));
	let box: Box = { ...initial };
	applyBox(svg, box);

	const minW = initial.w * 0.05;  // up to 20× zoom-in
	const maxW = initial.w * 10;    // up to 10× zoom-out

	let dragging = false;
	let lastX = 0, lastY = 0;

	const onWheel = (evt: WheelEvent) => {
		evt.preventDefault();
		const rect = svg.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		// Cursor position in viewBox coordinates
		const fx = (evt.clientX - rect.left) / rect.width;
		const fy = (evt.clientY - rect.top)  / rect.height;
		const cx = box.x + fx * box.w;
		const cy = box.y + fy * box.h;

		const factor = evt.deltaY < 0 ? 1 / 1.1 : 1.1;
		let newW = box.w * factor;
		let newH = box.h * factor;
		if (newW < minW) { newW = minW; newH = minW * (box.h / box.w); }
		if (newW > maxW) { newW = maxW; newH = maxW * (box.h / box.w); }

		box = {
			x: cx - fx * newW,
			y: cy - fy * newH,
			w: newW,
			h: newH,
		};
		applyBox(svg, box);
	};

	const onMouseDown = (evt: MouseEvent) => {
		if (evt.button !== 0) return;
		dragging = true;
		lastX = evt.clientX;
		lastY = evt.clientY;
		svg.style.cursor = "grabbing";
	};

	const onMouseMove = (evt: MouseEvent) => {
		if (!dragging) return;
		const rect = svg.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const dx = (evt.clientX - lastX) / rect.width  * box.w;
		const dy = (evt.clientY - lastY) / rect.height * box.h;
		lastX = evt.clientX;
		lastY = evt.clientY;
		box.x -= dx;
		box.y -= dy;
		applyBox(svg, box);
	};

	const onMouseUp = () => {
		if (!dragging) return;
		dragging = false;
		svg.style.cursor = "grab";
	};

	const onDblClick = () => {
		box = { ...initial };
		applyBox(svg, box);
	};

	svg.style.cursor = "grab";
	svg.addEventListener("wheel",     onWheel, { passive: false });
	svg.addEventListener("mousedown", onMouseDown);
	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup",   onMouseUp);
	svg.addEventListener("dblclick",  onDblClick);

	return {
		destroy: () => {
			svg.removeEventListener("wheel",     onWheel);
			svg.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup",   onMouseUp);
			svg.removeEventListener("dblclick",  onDblClick);
		},
		reset: () => { box = { ...initial }; applyBox(svg, box); },
	};
}

function parseViewBox(raw: string | null): Box {
	if (!raw) return { x: 0, y: 0, w: 1000, h: 1000 };
	const parts = raw.trim().split(/\s+/).map(Number);
	if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
		return { x: 0, y: 0, w: 1000, h: 1000 };
	}
	return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
}

function applyBox(svg: SVGSVGElement, box: Box): void {
	svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
}

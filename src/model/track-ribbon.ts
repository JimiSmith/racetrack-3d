import type { Triangle } from '../types/model.js';
import type { ProjectedNode } from '../types/geometry.js';
import { createVertex, addQuad, normalizeVector } from './mesh-primitives.js';
import { BASE_THICKNESS_MM } from './base-plate.js';

export const TRACK_HEIGHT_MM = 3;
export const TRACK_WIDTH_METRES = 12;
export const MAX_RIBBON_SECTION_STEP_METRES = 4;

export function normalizeProjectedPath(projectedNodes: ProjectedNode[] | null | undefined): ProjectedNode[] {
  if (!projectedNodes?.length) {
    return [];
  }

  const normalized: ProjectedNode[] = [];

  for (const node of projectedNodes) {
    if (!Number.isFinite(node?.x) || !Number.isFinite(node?.y)) {
      continue;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && previous.x === node.x && previous.y === node.y) {
      continue;
    }

    normalized.push(node);
  }

  if (normalized.length > 2) {
    const first = normalized[0]!;
    const last = normalized[normalized.length - 1]!;
    if (first.x === last.x && first.y === last.y) {
      normalized.pop();
    }
  }

  return normalized;
}

export function buildRaisedRibbonMesh(
  projectedNodes: ProjectedNode[] | null | undefined,
  scale: number,
  forceOpen = false,
): Triangle[] | null {
  const path = normalizeProjectedPath(projectedNodes);

  if (path.length < 2) {
    return null;
  }

  const isClosed = !forceOpen && path.length > 2;
  const bottomZ = BASE_THICKNESS_MM;
  const halfWidth = TRACK_WIDTH_METRES / 2;

  type Section = {
    topLeft: ReturnType<typeof createVertex>;
    topRight: ReturnType<typeof createVertex>;
    bottomLeft: ReturnType<typeof createVertex>;
    bottomRight: ReturnType<typeof createVertex>;
  };

  const sections: Section[] = [];
  const segmentCount = isClosed ? path.length : path.length - 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const start = path[index]!;
    const end = path[(index + 1) % path.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const direction = normalizeVector(dx, dy);
    const segmentLength = Math.hypot(dx, dy);

    if (!direction || segmentLength === 0) {
      continue;
    }

    const offsetX = -direction.y * halfWidth;
    const offsetY = direction.x * halfWidth;
    const sampleCount = Math.max(1, Math.ceil(segmentLength / MAX_RIBBON_SECTION_STEP_METRES));

    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const x = start.x + dx * t;
      const y = start.y + dy * t;
      const elevation = (start.elevation ?? 0) + ((end.elevation ?? start.elevation ?? 0) - (start.elevation ?? 0)) * t;
      const section: Section = {
        topLeft: createVertex((x + offsetX) * scale, (y + offsetY) * scale, bottomZ + TRACK_HEIGHT_MM + elevation * scale),
        topRight: createVertex((x - offsetX) * scale, (y - offsetY) * scale, bottomZ + TRACK_HEIGHT_MM + elevation * scale),
        bottomLeft: createVertex((x + offsetX) * scale, (y + offsetY) * scale, bottomZ),
        bottomRight: createVertex((x - offsetX) * scale, (y - offsetY) * scale, bottomZ),
      };

      const previous = sections[sections.length - 1];

      if (
        previous
        && previous.topLeft.x === section.topLeft.x
        && previous.topLeft.y === section.topLeft.y
        && previous.topRight.x === section.topRight.x
        && previous.topRight.y === section.topRight.y
      ) {
        continue;
      }

      sections.push(section);
    }
  }

  if (sections.length < 2) {
    return null;
  }

  const triangles: Triangle[] = [];
  const sectionSegmentCount = isClosed ? sections.length : sections.length - 1;

  for (let index = 0; index < sectionSegmentCount; index += 1) {
    const current = sections[index]!;
    const next = sections[(index + 1) % sections.length]!;

    addQuad(triangles, current.topLeft, current.topRight, next.topRight, next.topLeft);
    addQuad(triangles, current.bottomLeft, next.bottomLeft, next.bottomRight, current.bottomRight);
    addQuad(triangles, current.bottomLeft, current.topLeft, next.topLeft, next.bottomLeft);
    addQuad(triangles, current.bottomRight, next.bottomRight, next.topRight, current.topRight);
  }

  if (!isClosed) {
    const start = sections[0]!;
    const end = sections[sections.length - 1]!;

    addQuad(triangles, start.bottomRight, start.bottomLeft, start.topLeft, start.topRight);
    addQuad(triangles, end.bottomLeft, end.bottomRight, end.topRight, end.topLeft);
  }

  return triangles;
}

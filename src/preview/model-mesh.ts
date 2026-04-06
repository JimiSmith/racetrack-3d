import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vertex } from '../types/model.js';

const PREVIEW_CREASE_ANGLE = Math.PI / 3;

type Triangle = [Vertex, Vertex, Vertex];

function vertexKey(vertex: Vertex): string {
  return `${vertex.x},${vertex.y},${vertex.z}`;
}

export function buildPreviewGeometry(
  triangles: Triangle[],
  creaseAngle: number = PREVIEW_CREASE_ANGLE,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  if (!Array.isArray(triangles) || triangles.length === 0) {
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    return geometry;
  }

  const vertices: number[] = [];
  const indices: number[] = [];
  const vertexIndexes = new Map<string, number>();

  for (const triangle of triangles) {
    for (const vertex of triangle) {
      const key = vertexKey(vertex);
      let index = vertexIndexes.get(key);

      if (index === undefined) {
        index = vertices.length / 3;
        vertexIndexes.set(key, index);
        vertices.push(vertex.x, vertex.y, vertex.z);
      }

      indices.push(index);
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geometry.setIndex(indices);

  return toCreasedNormals(geometry, creaseAngle);
}

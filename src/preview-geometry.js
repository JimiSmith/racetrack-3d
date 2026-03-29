import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PREVIEW_CREASE_ANGLE = Math.PI / 3;

function vertexKey(vertex) {
  return `${vertex.x},${vertex.y},${vertex.z}`;
}

export function buildPreviewGeometry(triangles, creaseAngle = PREVIEW_CREASE_ANGLE) {
  const geometry = new THREE.BufferGeometry();

  if (!Array.isArray(triangles) || triangles.length === 0) {
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    return geometry;
  }

  const vertices = [];
  const indices = [];
  const vertexIndexes = new Map();

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

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { buildPreviewGeometry } from './model-mesh.js';
import { splitModelTriangles } from '../model/triangle-groups.js';
import type { TrackModel } from '../types/model.js';

const PREVIEW_BACKGROUND = '#0f0f13';

let container: HTMLElement | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let controls: OrbitControls | null = null;
let modelGroup: THREE.Group | null = null;
let resizeObserver: ResizeObserver | null = null;

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose();
    }
    return;
  }

  material?.dispose();
}

function clearModel(): void {
  if (!modelGroup) {
    return;
  }

  while (modelGroup.children.length > 0) {
    const child = modelGroup.children[modelGroup.children.length - 1] as THREE.Mesh;
    modelGroup.remove(child);
    child.geometry?.dispose();
    if (child.material) {
      disposeMaterial(child.material as THREE.Material | THREE.Material[]);
    }
  }
}

function renderFrame(): void {
  controls?.update();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function resizeRenderer(): void {
  if (!container || !renderer || !camera) {
    return;
  }

  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);

  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderFrame();
}

function fitCameraToModel(): void {
  if (!modelGroup || !camera || !controls) {
    return;
  }

  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) {
    camera.position.set(120, -180, 140);
    controls.target.set(0, 0, 0);
    renderFrame();
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 1.8;

  camera.near = Math.max(0.1, maxDim / 100);
  camera.far = maxDim * 20;
  // Model is flat in XZ plane (Y-up after rotation).
  // Start from above and slightly in front so the circuit is immediately visible.
  camera.position.set(center.x, center.y + distance * 1.4, center.z + distance * 0.6);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.minDistance = maxDim * 0.35;
  controls.maxDistance = maxDim * 8;
  renderFrame();
}

export function initPreview(): void {
  if (renderer) {
    return;
  }

  container = document.getElementById('preview');
  if (!container) {
    throw new Error('Preview container not found');
  }

  scene = new THREE.Scene();
  scene.background = new THREE.Color(PREVIEW_BACKGROUND);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Allow full vertical rotation (over the top and underneath)
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;

  scene.add(new THREE.AmbientLight(0xffffff, 1.8));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(180, -220, 240);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  fillLight.position.set(-120, 160, 120);
  scene.add(fillLight);

  modelGroup = new THREE.Group();
  // Our geometry has Z-up; Three.js expects Y-up.
  // Rotate the group so the flat circuit lies in the XZ ground plane.
  modelGroup.rotation.x = -Math.PI / 2;
  scene.add(modelGroup);

  container.replaceChildren(renderer.domElement);

  resizeObserver = new ResizeObserver(() => resizeRenderer());
  resizeObserver.observe(container);

  resizeRenderer();
  fitCameraToModel();
  // Animation loop handles everything — do NOT also listen to 'change' or
  // controls.update() inside renderFrame will dispatch 'change', causing infinite recursion.
  renderer.setAnimationLoop(renderFrame);
}

export function updatePreview(model: Partial<TrackModel> | null | undefined): void {
  if (!renderer) {
    initPreview();
  }

  clearModel();

  if (!model?.triangles?.length) {
    renderFrame();
    return;
  }

  const { baseTriangles, secondaryTrackTriangles, trackTriangles } = splitModelTriangles(model);

  if (baseTriangles.length > 0) {
    modelGroup!.add(
      new THREE.Mesh(
        buildPreviewGeometry(baseTriangles),
        new THREE.MeshStandardMaterial({ color: '#000000', roughness: 0.85, metalness: 0.05 }),
      ),
    );
  }

  if (secondaryTrackTriangles?.length > 0) {
    modelGroup!.add(
      new THREE.Mesh(
        buildPreviewGeometry(secondaryTrackTriangles),
        new THREE.MeshStandardMaterial({ color: '#888888', roughness: 0.75, metalness: 0.05 }),
      ),
    );
  }

  if (trackTriangles.length > 0) {
    modelGroup!.add(
      new THREE.Mesh(
        buildPreviewGeometry(trackTriangles),
        new THREE.MeshStandardMaterial({ color: '#E8002D', roughness: 0.7, metalness: 0.08 }),
      ),
    );
  }

  fitCameraToModel();
}

import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';

const BASE_THICKNESS_MM = 8;
const PREVIEW_BACKGROUND = '#0f0f13';

let container;
let scene;
let camera;
let renderer;
let controls;
let modelGroup;
let resizeObserver;

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    for (const entry of material) {
      entry.dispose();
    }
    return;
  }

  material?.dispose();
}

function clearModel() {
  if (!modelGroup) {
    return;
  }

  while (modelGroup.children.length > 0) {
    const child = modelGroup.children[modelGroup.children.length - 1];
    modelGroup.remove(child);
    child.geometry?.dispose();
    disposeMaterial(child.material);
  }
}

function renderFrame() {
  controls?.update();
  renderer?.render(scene, camera);
}

function resizeRenderer() {
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

function buildGeometry(triangles) {
  const positions = new Float32Array(triangles.length * 9);
  let offset = 0;

  for (const triangle of triangles) {
    for (const vertex of triangle) {
      positions[offset] = vertex.x;
      positions[offset + 1] = vertex.y;
      positions[offset + 2] = vertex.z;
      offset += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  return geometry;
}

function fitCameraToModel() {
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
  camera.position.set(
    center.x + distance * 0.7,
    center.y - distance * 1.15,
    center.z + distance,
  );
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.minDistance = maxDim * 0.35;
  controls.maxDistance = maxDim * 8;
  controls.update();
  renderFrame();
}

export function initPreview() {
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

  controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3.0;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.8;
  controls.dynamicDampingFactor = 0.12;

  scene.add(new THREE.AmbientLight(0xffffff, 1.8));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(180, -220, 240);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  fillLight.position.set(-120, 160, 120);
  scene.add(fillLight);

  modelGroup = new THREE.Group();
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

export function updatePreview(model) {
  if (!renderer) {
    initPreview();
  }

  clearModel();

  if (!model?.triangles?.length) {
    renderFrame();
    return;
  }

  const baseTriangles = [];
  const trackTriangles = [];

  for (const triangle of model.triangles) {
    if (triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM)) {
      baseTriangles.push(triangle);
    } else {
      trackTriangles.push(triangle);
    }
  }

  if (baseTriangles.length > 0) {
    modelGroup.add(new THREE.Mesh(
      buildGeometry(baseTriangles),
      new THREE.MeshStandardMaterial({ color: '#000000', flatShading: true, roughness: 0.85, metalness: 0.05 }),
    ));
  }

  if (trackTriangles.length > 0) {
    modelGroup.add(new THREE.Mesh(
      buildGeometry(trackTriangles),
      new THREE.MeshStandardMaterial({ color: '#E8002D', flatShading: true, roughness: 0.7, metalness: 0.08 }),
    ));
  }

  fitCameraToModel();
}

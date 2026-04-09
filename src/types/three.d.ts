declare module 'three' {
  export class Color {
    constructor(color: string | number);
  }
  export class Scene {
    background: Color | null;
    add(...objects: Object3D[]): this;
  }
  export class Object3D {
    children: Object3D[];
    rotation: Euler;
    position: Vector3;
    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
  }
  export class Euler {
    x: number;
    y: number;
    z: number;
  }
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
  }
  export class Box3 {
    setFromObject(object: Object3D): this;
    isEmpty(): boolean;
    getCenter(target: Vector3): Vector3;
    getSize(target: Vector3): Vector3;
  }
  export class PerspectiveCamera extends Object3D {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    near: number;
    far: number;
    updateProjectionMatrix(): void;
  }
  export class WebGLRenderer {
    constructor(parameters?: { antialias?: boolean });
    domElement: HTMLCanvasElement;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: Scene, camera: PerspectiveCamera): void;
    setAnimationLoop(callback: (() => void) | null): void;
  }
  export class AmbientLight extends Object3D {
    constructor(color?: number | string, intensity?: number);
  }
  export class DirectionalLight extends Object3D {
    constructor(color?: number | string, intensity?: number);
    position: Vector3;
  }
  export class Group extends Object3D {}
  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): this;
    getAttribute(name: string): BufferAttribute;
    setIndex(index: number[]): this;
    index: null | { count: number };
    dispose(): void;
  }
  export class BufferAttribute {
    constructor(array: Float32Array, itemSize: number);
    count: number;
    getX(index: number): number;
    getY(index: number): number;
    getZ(index: number): number;
  }
  export class Material {
    dispose(): void;
  }
  export class MeshStandardMaterial extends Material {
    constructor(parameters?: { color?: string; roughness?: number; metalness?: number });
  }
  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    geometry: BufferGeometry;
    material: Material | Material[];
  }
}

declare module 'three/examples/jsm/controls/OrbitControls.js' {
  import { PerspectiveCamera } from 'three';
  export class OrbitControls {
    constructor(camera: PerspectiveCamera, domElement: HTMLElement);
    enableDamping: boolean;
    dampingFactor: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    minDistance: number;
    maxDistance: number;
    target: import('three').Vector3;
    update(): void;
  }
}

declare module 'three/examples/jsm/utils/BufferGeometryUtils.js' {
  import { BufferGeometry } from 'three';
  export function toCreasedNormals(geometry: BufferGeometry, creaseAngle?: number): BufferGeometry;
}

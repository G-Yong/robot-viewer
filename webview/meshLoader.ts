import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ResourceResponse } from "../src/protocol";
import { post, log } from "./vscodeApi";

interface Pending {
  resolve: (r: { data: Uint8Array; ext: string }) => void;
  reject: (e: Error) => void;
}

const pending = new Map<number, Pending>();
let nextId = 1;

export function handleResourceResponse(response: ResourceResponse): void {
  const p = pending.get(response.requestId);
  if (!p) {
    return;
  }
  pending.delete(response.requestId);
  if (response.ok && response.data) {
    p.resolve({ data: base64ToBytes(response.data), ext: response.ext ?? "" });
  } else {
    p.reject(new Error(response.error ?? "resource load failed"));
  }
}

function fetchResource(uri: string): Promise<{ data: Uint8Array; ext: string }> {
  const requestId = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    post({ type: "requestResource", requestId, uri });
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`resource timeout: ${uri}`));
      }
    }, 30000);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0xbfc4c9,
  roughness: 0.7,
  metalness: 0.1,
});

/**
 * Mesh loader for urdf-loader. Requests raw file bytes from the extension host
 * (which handles package:// and path resolution) and parses them locally.
 */
export function loadMesh(
  path: string,
  _manager: THREE.LoadingManager,
  onComplete: (obj: THREE.Object3D, err?: Error) => void
): void {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  fetchResource(path)
    .then(({ data, ext: realExt }) => {
      const type = (realExt || ext) as string;
      try {
        onComplete(parseMesh(type, data, path));
      } catch (e) {
        log("error", `parse failed for ${path}: ${(e as Error).message}`);
        onComplete(new THREE.Group(), e as Error);
      }
    })
    .catch((e: Error) => {
      log("warn", `mesh load failed for ${path}: ${e.message}`);
      // urdf-loader requires an Object3D; give it an empty placeholder.
      onComplete(new THREE.Group(), e);
    });
}

function parseMesh(type: string, data: Uint8Array, path: string): THREE.Object3D {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;

  switch (type) {
    case "stl": {
      const geometry = new STLLoader().parse(buffer);
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, defaultMaterial.clone());
    }
    case "dae": {
      const text = new TextDecoder().decode(data);
      const basePath = path.substring(0, path.lastIndexOf("/") + 1);
      const collada = new ColladaLoader().parse(text, basePath);
      return collada.scene;
    }
    case "obj": {
      const text = new TextDecoder().decode(data);
      return new OBJLoader().parse(text);
    }
    case "glb":
    case "gltf": {
      let result: THREE.Object3D | null = null;
      new GLTFLoader().parse(buffer, "", (gltf) => {
        result = gltf.scene;
      });
      if (!result) {
        throw new Error("glTF parse produced no scene");
      }
      return result;
    }
    default:
      throw new Error(`unsupported mesh type: .${type}`);
  }
}

// The only Three.js parts the immersive Office uses. tools/build-three.mjs
// bundles this file (tree-shaken, minified) into src/hub-ui/vendor/three.js,
// which the Office loads on demand (never on other routes).
export {
  ACESFilmicToneMapping, AdditiveBlending, AgXToneMapping, AnimationClip, AnimationMixer, BackSide, Bone, Box3, BoxGeometry, BufferAttribute, BufferGeometry,
  CanvasTexture, CapsuleGeometry, CircleGeometry, ClampToEdgeWrapping, Color, CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, DynamicDrawUsage,
  EquirectangularReflectionMapping, Euler, ExtrudeGeometry, Float32BufferAttribute, FloatType, Fog, FrontSide, Group, HalfFloatType, HemisphereLight,
  InstancedBufferAttribute, InstancedMesh, LatheGeometry, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, LinearToneMapping, LoopOnce, LoopRepeat,
  MathUtils, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, NoColorSpace, NormalBlending, Object3D,
  PCFShadowMap, PCFSoftShadowMap, PerspectiveCamera, Plane, PlaneGeometry, PMREMGenerator, PointLight, Quaternion, QuaternionKeyframeTrack, RGBAFormat,
  Raycaster, RepeatWrapping, RingGeometry, SRGBColorSpace, Scene, ShaderMaterial, Shape, ShapeGeometry, Skeleton, SkinnedMesh, SphereGeometry, SpotLight,
  Sprite, SpriteMaterial, TorusGeometry, TubeGeometry, CatmullRomCurve3, UnsignedByteType, Uint16BufferAttribute, Vector2, Vector3, Vector4, VectorKeyframeTrack,
  NumberKeyframeTrack, WebGLRenderTarget, WebGLRenderer, REVISION,
} from 'three';
// Image-based lighting fallback (when the HDR environment cannot load).
export { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
// Asset loaders: HDR environments (EXR) and Basis-compressed textures (KTX2).
export { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
export { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// Geometry helpers: bevelled boxes (light catches real edges) and merging.
export { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
export { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// Post: AgX output, restrained bloom at night, ambient occlusion on High only.
export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
export { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
export { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
export { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';

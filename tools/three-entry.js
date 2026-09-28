// The only Three.js parts the immersive Office uses. tools/build-three.mjs
// bundles this file (tree-shaken, minified) into src/hub-ui/vendor/three.js.
export {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, CapsuleGeometry, CircleGeometry, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Fog, Group, HemisphereLight, IcosahedronGeometry, LinearFilter,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PointLight, QuadraticBezierCurve3,
  Raycaster, RingGeometry, SRGBColorSpace, Scene, Shape, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, TubeGeometry, Vector2, Vector3, WebGLRenderer,
  REVISION,
} from 'three';

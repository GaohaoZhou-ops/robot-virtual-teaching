import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import {
  Bot,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Database,
  FileSearch,
  FolderOpen,
  GitBranch,
  Glasses,
  History,
  House,
  Layers2,
  List,
  Map as MapIcon,
  MousePointer2,
  Play,
  Plus,
  Route,
  ScanLine,
  Server,
  ShieldAlert,
  ShieldCheck,
  Tablet,
  Usb,
  X,
  Zap,
} from 'lucide-react';
import HeightRange from './components/HeightRange.jsx';
import IndependentWorkspaceDialog from './components/IndependentWorkspaceDialog.jsx';
import WorkspaceCacheDialog from './components/WorkspaceCacheDialog.jsx';
import NewIndependentTeachingDialog from './components/NewIndependentTeachingDialog.jsx';
import IndependentTeachingNameDialog from './components/IndependentTeachingNameDialog.jsx';
import IndependentTeachingExportDialog from './components/IndependentTeachingExportDialog.jsx';
import { buildIndependentMapTeachingExport } from './lib/independentTeachingExport.js';
import { defaultIndependentTeachingName, validateIndependentTeachingName } from './lib/independentTeachingName.js';
import Inspector from './components/Inspector.jsx';
import Map2DView from './components/Map2DView.jsx';
import MapDetailsDialog from './components/MapDetailsDialog.jsx';
import PointCloudViewer from './components/PointCloudViewer.jsx';
import ProjectLoadDialog from './components/ProjectLoadDialog.jsx';
import ProjectImportErrorDialog from './components/ProjectImportErrorDialog.jsx';
import ProjectExportButton from './components/ProjectExportButton.jsx';
import ProjectExportDialog from './components/ProjectExportDialog.jsx';
import RobotPicker from './components/RobotPicker.jsx';
import RobotPresetDialog from './components/RobotPresetDialog.jsx';
import RobotPresetManagerDialog from './components/RobotPresetManagerDialog.jsx';
import SpaceMouseControl from './components/SpaceMouseControl.jsx';
import StartPage from './components/StartPage.jsx';
import { WorkSyncControl, WorkSyncAuthorization } from './components/WorkSyncControl.jsx';
import { useWorkSync } from './hooks/useWorkSync.js';
import VisionWorkbenchBridge from './components/VisionWorkbenchBridge.jsx';
import { isVisionWorkbench } from './lib/visionWorkbench.js';
import { useProjectImportProgress } from './hooks/useProjectImportProgress.js';
import { syncDocument, retainSyncReferences } from './lib/workSyncDocument.js';
import ModelEditorPage from './components/ModelEditorPage.jsx';
import ModelPairEditorPage from './components/ModelPairEditorPage.jsx';
import TeachingDataPage from './components/TeachingDataPage.jsx';
import TeachingPlaybackDock from './components/TeachingPlaybackDock.jsx';
import TeachingTransferDialog from './components/TeachingTransferDialog.jsx';
import IPadTeachingDialog from './components/IPadTeachingDialog.jsx';
import IPadTeachingMenu from './components/IPadTeachingMenu.jsx';
import VisionSceneShareDialog from './components/VisionSceneShareDialog.jsx';
import IPadScreenCollaboration from './components/IPadScreenCollaboration.jsx';
import { screenPoseCaptureState } from './lib/ipadScreenControl.js';
import { analyzeParkingPointDrift } from './lib/teachingParkingDrift.js';
import WorkbenchToolbar from './components/WorkbenchToolbar.jsx';
import RobotJointLimitDialog from './components/RobotJointLimitDialog.jsx';
import RobotJointLimitSettings, { RobotJointCouplingSettings } from './components/RobotJointLimitSettings.jsx';
import { RobotJointCouplingContext, RobotJointLimitContext, RobotJointSoftRangesContext } from './components/RobotJointLimitContext.js';
import { ARM_SOFT_LIMIT_RATIO, normalizeArmSoftLimitOverrides, normalizeArmSoftLimitRatio } from './lib/robotJointLimits.js';
import { normalizeArmJointCouplingEnabled } from './lib/robotJointCoupling.js';
import MobileTeachingSolveDialog from './components/MobileTeachingSolveDialog.jsx';
import MobileTeachingComputeDock from './components/MobileTeachingComputeDock.jsx';
import { buildMobileSolvedTask, MOBILE_SOLVE_VERSION, validateMobileSolveOptions } from './lib/mobileTeachingSolver.js';
import { mobileReferenceFromPreset } from './lib/mobileTeachingReference.js';
import { mobileSolutionMapPose } from './lib/mobileTeachingParking.js';
import AbxTeachingExportDialog from './components/AbxTeachingExportDialog.jsx';
import AbxRouteExportDialog from './components/AbxRouteExportDialog.jsx';
import { abxRobotModel, readAbxRobotPackage } from './lib/abxTeachingExport.js';
import { abxRouteToProject, buildAbxRouteDocuments, readAbxRoute } from './lib/abxRoute.js';
import { mergeAbxImport, readAbxTeachingFile } from './lib/abxTeachingImport.js';
import { IPadModelMismatchError, ipadResultTask } from './lib/ipadTeaching.js';
import { mobileDeviceKey, mobileDeviceLabel } from './lib/ipadProtocol.js';
import { createTeachingAlignment, extractTeachingWorkspace, hasLoadedMapWorkspace, placeTeachingWorkspace, writeBackTeachingWorkspace } from './lib/teachingTransfer.js';
import { mapRouteSyncStatus, syncMapRouteToIndependent } from './lib/mapRouteSync.js';
import { connectivityCopy, connectivityTopology, inspectConnectivity } from './lib/graph.js';
import {
  buildTeachingWaypoints,
  navigationEdgesForWaypoints,
  parkingWaypointPose,
  removeTeachingWaypoints,
  TEMPORARY_MAP_ROUTE_SOURCE,
  teachingParkingName,
  waypointRobotPose,
  updateTeachingWaypoint,
  withoutTemporaryMapNavigation,
} from './lib/teachingNavigation.js';
import {
  buildExport,
  clampSlice,
  createId,
  downloadJson,
  fetchBufferWithProgress,
  normalizeProject,
  normalizeTeachingTasks,
  normalizeTeachingSpaceMode,
  readFileWithProgress,
  teachingCoordinateFrame,
} from './lib/io.js';
import { buildTeachingDataExport, buildTeachingParkingPointCopy } from './lib/teachingData.js';
import { writeClipboardText } from './lib/clipboard.js';
import { normalizeIgnoredCollisionJoints } from './lib/robotCollisionSettings.js';
import {
  normalizeRobotDescriptor,
  normalizeRobotJointValues,
  normalizeRobotPose,
  registerPortableRobotPackage,
  releasePortableRobotPackage,
} from './lib/robotLoader.js';
import {
  defaultRobotJointLocks,
  normalizeRobotJointLocks,
} from './lib/robotJointLocks.js';
import { sha256ArrayBuffer } from './lib/hash.js';
import {
  normalizeMeshRenderQuality,
  prepareMapGeometryTopology,
} from './lib/mapGeometry.js';
import { createSpaceMouseInputState } from './lib/spaceMouse.js';
import {
  buildRobotPresetFile, createRobotJointPreset, isRobotJointPreset, presetJointDefinitions, presetMatchesRobot,
  robotPresetValuesForEditing, validateRobotPresetName,
} from './lib/robotJointPresets.js';
import { withSharedRobotPresets } from './lib/sharedRobotPresets.js';
import { insertTeachingPreset } from './lib/teachingPresetInsertion.js';
import { moveTeachingPose } from './lib/teachingPoseOrder.js';
import {
  buildTeachingTaskTrajectory,
  sampleTeachingTrajectorySegment,
} from './lib/teachingPlayback.js';
import {
  activateWorkspaceMode,
  activateWorkspaceRecovery,
  commitWorkspaceTransfer,
  commitMapWorkspaceConfig,
  fetchServiceSession,
  finalizeWorkspaceRecovery,
  loadWorkspaceViews,
  loadWorkspaceConfig,
  loadWorkspaceSnapshot,
  loadWorkSyncCheckpoint,
  loadProjectCompanions,
  loadSharedRobotPresets,
  importSharedRobotPresets,
  loadIndependentDisplaySource,
  listIndependentWorkspaces,
  renameIndependentWorkspace,
  deleteIndependentWorkspace,
  clearAllWorkspaceCaches,
  prepareWorkspaceSession,
  resetWorkspaceSession,
  restoreLinkedWorkspaces,
  restoreWorkspaceCollection,
  saveWorkspaceConfig,
  saveWorkSyncCheckpoint,
  saveWorkspaceMap,
  saveWorkspaceViews,
  switchIndependentWorkspace,
} from './lib/sessionStore.js';
import { linkedWorkspaceRelation, prepareLinkedProjectImport } from './lib/linkedProject.js';
import { prepareWorkspaceCollectionImport } from './lib/projectWorkspaceCollection.js';
import { placedObjectLayers, recoverPlacedObjectLayers } from './lib/placedObjectRendering.js';
import {
  clearProjectDirectoryBinding,
  loadProjectDirectoryBinding,
  saveProjectDirectoryBinding,
} from './lib/projectDirectoryStore.js';
import {
  clearProjectSaveTarget,
  clearAllProjectSaveTargets,
  ensureProjectWritePermission,
  loadProjectSaveTarget,
  rememberProjectSaveTarget,
} from './lib/projectSaveTarget.js';

const initialValidation = { status: 'idle', unreachableCount: 0, checkedAt: null };
const pointColorModes = new Set(['height', 'source', 'white']);
const APP_PAGE_HOME = 'home';
const APP_PAGE_WORKBENCH = 'workbench';
const APP_PAGE_TEACHING_DATA = 'teaching-data';
const APP_PAGE_MODEL_EDITOR = 'model-editor';
const APP_PAGE_MODEL_PAIR_EDITOR = 'model-editor/dual';
const PROJECT_GUIDE_FILE_ACCEPT = '.json,.zip';

const teachingModeLabel = (mode) => mode === 'independent' ? '独立示教' : '地图示教';
const assertProjectMode = (actualMode, requestedMode) => {
  if (normalizeTeachingSpaceMode(actualMode) === normalizeTeachingSpaceMode(requestedMode)) return;
  const error = new Error(
    `所选工程属于“${teachingModeLabel(actualMode)}”，当前入口为“${teachingModeLabel(requestedMode)}”。请返回主页面选择“${teachingModeLabel(actualMode)}”后再加载。`,
  );
  error.code = 'PROJECT_MODE_MISMATCH';
  throw error;
};

const createIdleTeachingPlayback = () => ({
  status: 'idle',
  taskId: '',
  taskName: '',
  phase: '',
  segmentIndex: 0,
  segmentCount: 0,
  parkingPointName: '',
  poseName: '',
  poseOrdinal: 0,
  poseCount: 0,
  reachedPoseIds: [],
  reachedPoseCount: 0,
  elapsedDurationMs: 0,
  totalDurationMs: 0,
  overallProgress: 0,
  segmentProgress: 0,
  speed: 1,
  cycle: 0,
  followRobot: false,
});

const teachingPlaybackStateFromRuntime = (runtime, status = runtime?.status || 'idle') => {
  const segment = runtime?.plan?.segments?.[runtime.segmentIndex] || null;
  if (!runtime || !segment) return createIdleTeachingPlayback();
  const reachedPoseIds = runtime.reachedPoseIds instanceof Set
    ? [...runtime.reachedPoseIds]
    : [];
  const segmentProgress = segment.durationMs > 0
    ? Math.max(0, Math.min(1, runtime.segmentElapsedMs / segment.durationMs))
    : 1;
  const elapsedDurationMs = Math.min(
    runtime.plan.totalDurationMs,
    segment.startOffsetMs + runtime.segmentElapsedMs,
  );
  return {
    status,
    taskId: runtime.plan.taskId,
    taskName: runtime.plan.taskName,
    phase: segment.phase,
    segmentIndex: runtime.segmentIndex,
    segmentCount: runtime.plan.segments.length,
    parkingPointId: segment.target?.parkingPointId || '',
    parkingPointName: segment.target?.parkingPointName || '',
    poseId: segment.target?.poseId || '',
    poseName: segment.target?.poseName || '',
    poseOrdinal: segment.target?.poseOrdinal || 0,
    poseCount: runtime.plan.poseCount,
    reachedPoseIds,
    reachedPoseCount: reachedPoseIds.length,
    elapsedDurationMs,
    totalDurationMs: runtime.plan.totalDurationMs,
    overallProgress: runtime.plan.totalDurationMs > 0
      ? elapsedDurationMs / runtime.plan.totalDurationMs
      : 1,
    segmentProgress,
    speed: runtime.speed,
    cycle: runtime.cycle,
    followRobot: Boolean(runtime.followRobot),
  };
};

const markTeachingPlaybackPoseReached = (runtime, segment) => {
  const poseId = segment?.phase === 'hold' ? segment.target?.poseId : '';
  if (!poseId || !(runtime?.reachedPoseIds instanceof Set)) return false;
  const previousSize = runtime.reachedPoseIds.size;
  runtime.reachedPoseIds.add(poseId);
  return runtime.reachedPoseIds.size !== previousSize;
};

const appPageFromLocation = () => {
  if (typeof window === 'undefined') return APP_PAGE_HOME;
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.endsWith('/teaching-data')) return APP_PAGE_TEACHING_DATA;
  if (path.endsWith('/model-editor/dual')) return APP_PAGE_MODEL_PAIR_EDITOR;
  if (path.endsWith('/model-editor')) return APP_PAGE_MODEL_EDITOR;
  if (path.endsWith('/workbench')) return APP_PAGE_WORKBENCH;
  return APP_PAGE_HOME;
};

const formatRecoveryTimestamp = (value) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '保存时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
};

const defaultLimits = {
  minSpeed: 0.2,
  maxSpeed: 1,
  minAcceleration: -0.8,
  maxAcceleration: 0.8,
};

const defaultMotion = {
  direction: 'forward',
  enable3DObstacleAvoidance: true,
};

const waitForPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));

const normalizeTimestamp = (value) => {
  if (!value) return null;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const GEOMETRY_CACHE_VERSION = 1;

const clampJointValue = (rawValue, definition) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 0;
  const lower = definition?.lower === null || definition?.lower === undefined
    ? Number.NaN
    : Number(definition.lower);
  const upper = definition?.upper === null || definition?.upper === undefined
    ? Number.NaN
    : Number(definition.upper);
  return Math.max(
    Number.isFinite(lower) ? lower : Number.NEGATIVE_INFINITY,
    Math.min(Number.isFinite(upper) ? upper : Number.POSITIVE_INFINITY, parsed),
  );
};

function serializeBounds(box) {
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

function serializeSphere(sphere) {
  return {
    center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z },
    radius: sphere.radius,
  };
}

function exactArrayBuffer(array) {
  if (array.byteOffset === 0 && array.byteLength === array.buffer.byteLength) return array.buffer;
  return array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength);
}

function packColorAttribute(attribute) {
  if (!attribute?.array?.length || attribute.itemSize < 3) return null;
  if (
    attribute.array instanceof Uint8Array
    && attribute.itemSize === 3
    && attribute.normalized
  ) {
    return attribute.array;
  }
  const source = attribute.array;
  const packed = new Uint8Array(attribute.count * 3);
  let scale = source.BYTES_PER_ELEMENT === 1 ? 1 : 255;
  if (source.BYTES_PER_ELEMENT !== 1) {
    const sampleLength = Math.min(source.length, 4096);
    for (let index = 0; index < sampleLength; index += 1) {
      if (Math.abs(source[index]) > 1.5) {
        scale = 1;
        break;
      }
    }
  }
  for (let point = 0; point < attribute.count; point += 1) {
    const sourceOffset = point * attribute.itemSize;
    const targetOffset = point * 3;
    packed[targetOffset] = Math.round(Math.max(0, Math.min(255, source[sourceOffset] * scale)));
    packed[targetOffset + 1] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 1] * scale)),
    );
    packed[targetOffset + 2] = Math.round(
      Math.max(0, Math.min(255, source[sourceOffset + 2] * scale)),
    );
  }
  return packed;
}

function createGeometryCache(
  geometry,
  bounds,
  sourceByteLength,
  sourceHash = null,
  sourceHashKind = 'file',
  sourceDetails = {},
) {
  const positionAttribute = geometry.getAttribute('position');
  const sourcePositions = positionAttribute?.array;
  if (!sourcePositions?.length) throw new Error('无法缓存空点云');
  const positions = sourcePositions instanceof Float32Array
    ? sourcePositions
    : Float32Array.from(sourcePositions);
  const colors = packColorAttribute(geometry.getAttribute('color'));
  const sourceIndex = geometry.getIndex()?.array || null;
  const meshIndices = sourceIndex instanceof Uint16Array || sourceIndex instanceof Uint32Array
    ? sourceIndex
    : sourceIndex?.length ? Uint32Array.from(sourceIndex) : null;
  const sphere = geometry.boundingSphere;
  return {
    geometryCacheVersion: GEOMETRY_CACHE_VERSION,
    byteLength: Number(sourceByteLength) || positions.byteLength + (colors?.byteLength || 0),
    pointCount: positionAttribute.count,
    positionBuffer: exactArrayBuffer(positions),
    colorBuffer: colors ? exactArrayBuffer(colors) : null,
    indexBuffer: meshIndices ? exactArrayBuffer(meshIndices) : null,
    indexComponentType: meshIndices instanceof Uint16Array ? 'uint16' : 'uint32',
    faceCount: meshIndices ? Math.floor(meshIndices.length / 3) : 0,
    bounds,
    sphere: sphere ? serializeSphere(sphere) : null,
    sourceHash,
    sourceHashKind,
    sourceBlob: sourceDetails.sourceBlob instanceof Blob ? sourceDetails.sourceBlob : null,
    fileModifiedAt: normalizeTimestamp(sourceDetails.fileModifiedAt),
    mimeType: String(sourceDetails.mimeType || 'application/octet-stream'),
    loadedAt: normalizeTimestamp(sourceDetails.loadedAt),
    sourceKind: String(sourceDetails.sourceKind || 'unknown'),
    ...(sourceDetails.teachingGroupId ? { teachingGroupId: sourceDetails.teachingGroupId } : {}),
    teachingSpaceMode: normalizeTeachingSpaceMode(sourceDetails.teachingSpaceMode),
    coordinateFrame: teachingCoordinateFrame(sourceDetails.teachingSpaceMode),
  };
}

function restoreGeometryFromCache(record) {
  if (
    record?.geometryCacheVersion !== GEOMETRY_CACHE_VERSION
    || !(record.positionBuffer instanceof ArrayBuffer)
  ) {
    throw new Error('点云几何缓存版本无效');
  }

  const positions = new Float32Array(record.positionBuffer);
  if (!positions.length || positions.length % 3 !== 0) {
    throw new Error('点云几何缓存坐标无效');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (record.colorBuffer instanceof ArrayBuffer) {
    const colors = new Uint8Array(record.colorBuffer);
    if (colors.length === positions.length) {
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    }
  }
  if (record.indexBuffer instanceof ArrayBuffer) {
    const indices = record.indexComponentType === 'uint16'
      ? new Uint16Array(record.indexBuffer)
      : new Uint32Array(record.indexBuffer);
    if (indices.length >= 3) {
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }
  }

  const cachedBounds = record.bounds;
  if (cachedBounds?.min && cachedBounds?.max) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(cachedBounds.min.x, cachedBounds.min.y, cachedBounds.min.z),
      new THREE.Vector3(cachedBounds.max.x, cachedBounds.max.y, cachedBounds.max.z),
    );
  } else {
    geometry.computeBoundingBox();
  }

  if (record.sphere?.center && Number.isFinite(record.sphere.radius)) {
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(
        record.sphere.center.x,
        record.sphere.center.y,
        record.sphere.center.z,
      ),
      record.sphere.radius,
    );
  } else {
    geometry.computeBoundingSphere();
  }
  geometry.userData.geometrySource = 'session-cache';
  return geometry;
}

function suggestedSlice(positions, bounds) {
  const values = [];
  const count = positions.length / 3;
  const stride = Math.max(1, Math.floor(count / 60000));
  for (let index = 2; index < positions.length; index += stride * 3) {
    const value = positions[index];
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  if (!values.length) return [bounds.min.z, bounds.max.z];
  const at = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
  const low = at(0.12);
  const high = at(0.72);
  return high > low ? [low, high] : [bounds.min.z, bounds.max.z];
}

export default function App() {
  const mapInputRef = useRef(null);
  const independentCloudInputRef = useRef(null);
  const newIndependentDialogRevisionRef = useRef(0);
  const independentSwitchBusyRef = useRef(false);
  const independentChoiceLoadingRef = useRef(false);
  const pathInputRef = useRef(null);
  const abxTeachingInputRef = useRef(null);
  const abxRouteInputRef = useRef(null);
  const abxImportBusyRef = useRef(false);
  const projectDirectoryInputRef = useRef(null);
  const mapDetailsButtonRef = useRef(null);
  const robotMenuButtonRef = useRef(null);
  const robotPresetReturnFocusRef = useRef(null);
  const devicesMenuButtonRef = useRef(null);
  const toastTimerRef = useRef(null);
  const view2dRef = useRef(null);
  const view3dRef = useRef(null);
  const sessionIdRef = useRef(null);
  const sessionReadyRef = useRef(false);
  const sessionSaveTimerRef = useRef(null);
  const sessionWriteChainRef = useRef(Promise.resolve());
  const workspaceSwitchingRef = useRef(false);
  const sessionFailureNotifiedRef = useRef(false);
  const hydrationRevisionRef = useRef(0);
  const latestWorkspaceRef = useRef(null);
  const focusRevisionRef = useRef(0);
  const robotNotificationRef = useRef('');
  const defaultRobotJointLocksPendingRef = useRef(false);
  const cameraTeachingRevisionRef = useRef(0);
  const zividCaptureProviderRef = useRef(null);
  const parkingMergePlannerRef = useRef(null);
  const mobileTeachingSolverRef = useRef(null);
  const mobileTeachingRunRef = useRef(null);
  const teachingCaptureBusyRef = useRef(false);
  const projectExportBusyRef = useRef(false);
  const projectSaveTargetRevisionRef = useRef(0);
  const [abxExportSnapshot, setAbxExportSnapshot] = useState(null);
  const [independentExportDialog, setIndependentExportDialog] = useState(null);
  const teachingExportBusyRef = useRef(false);
  const [abxRouteExport, setAbxRouteExport] = useState(null);
  const [abxImportBusy, setAbxImportBusy] = useState(false);
  const [mapRouteSync, setMapRouteSync] = useState({ available: false, checking: true, reason: '正在检查地图路径…' });
  const [mapRouteSyncEnabled, setMapRouteSyncEnabled] = useState(false);
  const [syncedMapOrigin, setSyncedMapOrigin] = useState(null);
  const [mapRouteSyncBusy, setMapRouteSyncBusy] = useState(false);
  const mapRouteSyncBusyRef = useRef(false);
  const projectDirectoryRef = useRef(null);
  const projectDirectoryWriteChainRef = useRef(Promise.resolve());
  const projectDirectoryFailureNotifiedRef = useRef(false);
  const projectLoadDialogRevisionRef = useRef(0);
  const projectGuideModeRef = useRef(null);
  const projectDirectoryModeRef = useRef(null);
  const portableRobotPackageRef = useRef(null);
  const teachingPlaybackFrameRef = useRef(null);
  const teachingPlaybackRuntimeRef = useRef(null);
  const spaceMouseInputRef = useRef(createSpaceMouseInputState());
  const main3DCanvasRef = useRef(null);
  const collaborationViewportRef = useRef(null);
  const [appPage, setAppPage] = useState(appPageFromLocation);
  const [startPageMode, setStartPageMode] = useState(null);
  const [workspaceTransfer, setWorkspaceTransfer] = useState(null);
  const [independentTeachingName, setIndependentTeachingName] = useState('');
  const [independentNameDialog, setIndependentNameDialog] = useState(null);
  const [independentHistory, setIndependentHistory] = useState({ status: 'idle', entries: [] });
  const [independentWorkspaceDialog, setIndependentWorkspaceDialog] = useState(null);
  const [cacheActionDialog, setCacheActionDialog] = useState(null);
  const [newIndependentDialog, setNewIndependentDialog] = useState(null);
  const [directoryAutosaveSuspended, setDirectoryAutosaveSuspended] = useState(false);
  const [teachingTransferDialog, setTeachingTransferDialog] = useState(null);
  const [ipadTeachingOpen, setIPadTeachingOpen] = useState(false);
  const [ipadScreenOpen, setIPadScreenOpen] = useState(false);
  useEffect(() => { if (appPage !== APP_PAGE_WORKBENCH) setIPadScreenOpen(false); }, [appPage]);
  const [mobileSolveTaskId, setMobileSolveTaskId] = useState(null);
  const [mobileSolveSampleId, setMobileSolveSampleId] = useState(null);
  const [mobilePoseSelection, setMobilePoseSelection] = useState(null);
  const [mobileComputation, setMobileComputation] = useState(null);
  const [ipadTeachingEntry, setIPadTeachingEntry] = useState({ action: 'pairing' });
  const teachingTransferBusyRef = useRef(false);
  const [mapData, setMapData] = useState(null);
  const [teachingSpaceMode, setTeachingSpaceMode] = useState('map');
  const [heightRange, setHeightRange] = useState([0, 1]);
  const [heightRangeCollapsed, setHeightRangeCollapsed] = useState(true);
  const [showSlice3D, setShowSlice3D] = useState(true);
  const [storedWaypoints, setWaypoints] = useState([]);
  const [storedEdges, setEdges] = useState([]);
  const [abxRoutes, setAbxRoutes] = useState([]);
  const [mode, setMode] = useState('select');
  const [connectionSourceId, setConnectionSourceId] = useState(null);
  const [selectedWaypointId, setSelectedWaypointId] = useState(null);
  const [selectedMapOrigin, setSelectedMapOrigin] = useState(false);
  const [robotWaypointLocation, setRobotWaypointLocation] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [validation, setValidation] = useState(initialValidation);
  const [projectionStats, setProjectionStats] = useState({ selectedCount: 0 });
  const [restoredView2d, setRestoredView2d] = useState(null);
  const [restoredView3d, setRestoredView3d] = useState(null);
  const [pointColorMode, setPointColorMode] = useState('height');
  const [placedObjectColorMode, setPlacedObjectColorMode] = useState('height');
  const layerRecoveryAttemptRef = useRef(null);
  const [meshRenderQuality, setMeshRenderQuality] = useState('auto');
  const [showPaths3D, setShowPaths3D] = useState(true);
  const [showParkingPoints3D, setShowParkingPoints3D] = useState(true);
  const [showWaypoints3D, setShowWaypoints3D] = useState(true);
  const [showWaypointNames3D, setShowWaypointNames3D] = useState(true);
  const [showPathNames3D, setShowPathNames3D] = useState(false);
  const [showHeightLegend3D, setShowHeightLegend3D] = useState(true);
  const [showRobotModel, setShowRobotModel] = useState(true);
  const [collapsedPanel, setCollapsedPanel] = useState(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorPageRequest, setInspectorPageRequest] = useState(null);
  const [mapDetailsOpen, setMapDetailsOpen] = useState(false);
  const [displaySettingsContainer, setDisplaySettingsContainer] = useState(null);
  const [synchronizedFocus, setSynchronizedFocus] = useState(null);
  const [selectedRobot, setSelectedRobot] = useState(null);
  const [visionSceneOpen, setVisionSceneOpen] = useState(false);
  const [robotLoadState, setRobotLoadState] = useState({ status: 'idle' });
  const [robotPose, setRobotPose] = useState(() => normalizeRobotPose(null));
  const [robotJointValues, setRobotJointValues] = useState({});
  const [robotArmSoftLimitRatio, setRobotArmSoftLimitRatio] = useState(ARM_SOFT_LIMIT_RATIO);
  const [robotArmSoftLimitOverrides, setRobotArmSoftLimitOverrides] = useState({});
  const [robotJointLimitDraft, setRobotJointLimitDraft] = useState(null);
  const [robotArmJointCouplingEnabled, setRobotArmJointCouplingEnabled] = useState(true);
  const [lockedRobotJointNames, setLockedRobotJointNames] = useState([]);
  const [ignoredRobotCollisionJointNames, setIgnoredRobotCollisionJointNames] = useState([]);
  const [robotControlEnabled, setRobotControlEnabled] = useState(false);
  const [robotHeightLocked, setRobotHeightLocked] = useState(false);
  const [robotCollisionProtectionEnabled, setRobotCollisionProtectionEnabled] = useState(true);
  const [teachingTasks, setTeachingTasks] = useState([]);
  const [activeTeachingTaskId, setActiveTeachingTaskId] = useState(null);
  const [activeTeachingParkingPointId, setActiveTeachingParkingPointId] = useState(null);
  const teachingSourceSelectionsRef = useRef(new Map());
  const [robotParkingGhost, setRobotParkingGhost] = useState(null);
  const robotParkingGhostRef = useRef(null);
  robotParkingGhostRef.current = robotParkingGhost;
  const [jointPoses, setJointPoses] = useState([]);
  const sharedRobotPresetsRef = useRef(null);
  const [robotPresetDraft, setRobotPresetDraft] = useState(null);
  const [robotPresetManager, setRobotPresetManager] = useState(null);
  const robotSettingsModalOpen = Boolean(robotPresetDraft || robotPresetManager || robotJointLimitDraft);
  const robotPresetJoints = useMemo(() => presetJointDefinitions(robotLoadState.movableJoints), [robotLoadState.movableJoints]);
  const projectRobotPresets = useMemo(() => jointPoses.filter(isRobotJointPreset), [jointPoses]);
  const robotPresets = useMemo(() => projectRobotPresets.filter((pose) => presetMatchesRobot(pose, selectedRobot)),
    [projectRobotPresets, selectedRobot]);
  const [zividCameraPoses, setZividCameraPoses] = useState({});
  const [cameraTeachingCommand, setCameraTeachingCommand] = useState(null);
  const [cameraTeachingResult, setCameraTeachingResult] = useState({
    status: 'idle',
    revision: 0,
  });
  const [teachingCaptureState, setTeachingCaptureState] = useState({
    status: 'idle',
    message: '',
  });
  const [parkingMergePlannerReady, setParkingMergePlannerReady] = useState(false);
  const [mobileTeachingSolverReady, setMobileTeachingSolverReady] = useState(false);
  const [projectExportState, setProjectExportState] = useState({
    status: 'idle',
    byteLength: 0,
  });
  const [projectExportDialog, setProjectExportDialog] = useState(null);
  const [projectSaveTarget, setProjectSaveTarget] = useState(null);
  const activeProjectSaveTarget = projectSaveTarget?.mapId === mapData?.mapId
    && projectSaveTarget?.teachingSpaceMode === teachingSpaceMode ? projectSaveTarget : null;
  const [projectDirectoryState, setProjectDirectoryState] = useState({
    status: 'detached',
    name: '',
    savedAt: null,
    writable: false,
  });
  const [projectLoadDialog, setProjectLoadDialog] = useState({
    open: false,
    mode: 'map',
    directory: { status: 'idle' },
  });
  const [projectImportError, setProjectImportError] = useState(null);
  const {
    state: projectImportProgress, current: projectImportProgressRef,
    begin: beginProjectImport, step: advanceProjectImport, finish: finishProjectImport,
    cancel: cancelProjectImport, prepareReload: checkpointProjectImport,
  } = useProjectImportProgress();
  const [teachingPlayback, setTeachingPlayback] = useState(createIdleTeachingPlayback);
  const [polylineTeachingBusy, setPolylineTeachingBusy] = useState(false);
  const [polylineTeachingOpen, setPolylineTeachingOpen] = useState(false);
  const [polylineTeachingContainer, setPolylineTeachingContainer] = useState(null);
  const [polylineTeachingRequest, setPolylineTeachingRequest] = useState(null);
  useEffect(() => { setPolylineTeachingRequest(null); }, [mapData?.mapId, selectedRobot?.id, teachingSpaceMode]);
  useEffect(() => {
    if (appPage !== APP_PAGE_WORKBENCH) {
      setPolylineTeachingRequest(null);
      setPolylineTeachingOpen(false);
    }
  }, [appPage]);
  useEffect(() => {
    setInspectorCollapsed(false);
  }, [polylineTeachingOpen]);
  const finishPolylineTeachingRequest = useCallback((id) => {
    setPolylineTeachingRequest((current) => current?.id === id ? null : current);
  }, []);
  const [sessionState, setSessionState] = useState({ status: 'checking', restored: false });
  const [cachedWorkspaces, setCachedWorkspaces] = useState({
    map: null,
    independent: null,
  });
  const [lastProjectRecovery, setLastProjectRecovery] = useState(null);
  const [loadState, setLoadState] = useState({
    loading: true,
    progress: 0.08,
    phase: '检查工作会话',
    detail: '正在确认服务实例并查找上次快照',
  });
  const [toast, setToast] = useState(null);
  const closeMapDetails = useCallback(() => setMapDetailsOpen(false), []);
  const closeRobotPreset = useCallback(() => setRobotPresetDraft(null), []);
  const closeRobotPresetManager = useCallback(() => setRobotPresetManager(null), []);
  const closeRobotJointLimits = useCallback(() => setRobotJointLimitDraft(null), []);
  const robotJointLimitsDisabledReason = robotLoadState.status !== 'loaded' ? '加载机器人后可调整关节软限位。'
    : !robotLoadState.movableJoints?.some((joint) => joint.softLimitRatio) ? '当前模型没有可配置的双臂或腰部关节。'
      : sessionState.status !== 'ready' || loadState.loading ? '工程就绪后可调整关节软限位。'
        : teachingCaptureState.status === 'capturing' ? '采集完成后可调整关节软限位。'
          : (polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)) ? '停止轨迹播放或折线任务后可调整关节软限位。'
            : mobileComputation ? '结束示教计算后可调整关节软限位。' : '';
  useEffect(() => {
    if (robotJointLimitDraft && (appPage !== APP_PAGE_WORKBENCH
      || robotJointLimitDraft.robot !== selectedRobot || robotJointLimitDraft.mapId !== mapData?.mapId
      || robotJointLimitDraft.teachingSpaceMode !== teachingSpaceMode)) setRobotJointLimitDraft(null);
  }, [appPage, mapData?.mapId, selectedRobot, teachingSpaceMode, robotJointLimitDraft]);
  const robotPresetManagerReady = Boolean(mapData && sessionState.status === 'ready'
    && !loadState.loading && teachingCaptureState.status !== 'capturing');
  const robotPresetReady = Boolean(selectedRobot && robotLoadState.status === 'loaded'
    && robotPresetJoints.length && sessionState.status === 'ready' && !loadState.loading
    && teachingCaptureState.status !== 'capturing');
  useEffect(() => {
    if (robotPresetDraft && (appPage !== APP_PAGE_WORKBENCH
      || !presetMatchesRobot(robotPresetDraft, selectedRobot) || robotPresetDraft.mapId !== mapData?.mapId)) {
      setRobotPresetDraft(null);
    }
  }, [appPage, mapData?.mapId, robotPresetDraft, selectedRobot]);
  useEffect(() => {
    if (robotPresetManager && (appPage !== APP_PAGE_WORKBENCH
      || robotPresetManager.mapId !== mapData?.mapId || robotPresetManager.teachingSpaceMode !== teachingSpaceMode)) {
      setRobotPresetManager(null);
    }
  }, [appPage, mapData?.mapId, robotPresetManager, teachingSpaceMode]);
  const coordinateFrame = teachingCoordinateFrame(teachingSpaceMode);
  const isIndependentTeachingSpace = teachingSpaceMode === 'independent';
  const visibleMapOriginPose = isIndependentTeachingSpace && mapRouteSyncEnabled
    && syncedMapOrigin?.mapId === mapData?.mapId ? syncedMapOrigin?.pose : null;
  const independentSwitchBlocked = loadState.loading || sessionState.status !== 'ready'
    || teachingCaptureState.status === 'capturing' || projectExportBusyRef.current || abxImportBusy
    || mapRouteSyncBusy || robotLoadState.status === 'pending' || robotLoadState.status === 'loading'
    || ['running', 'pausing', 'paused'].includes(mobileComputation?.status)
    || ['playing', 'paused'].includes(teachingPlayback.status) || polylineTeachingBusy;
  const alternateTeachingMode = isIndependentTeachingSpace ? 'map' : 'independent';
  const activeCollapsedPanel = isIndependentTeachingSpace ? null : collapsedPanel;
  const coordinateFrameLabel = isIndependentTeachingSpace ? 'VIRTUAL_ORIGIN' : 'MAP';
  const activeTeachingTask = teachingTasks.find((task) => task.id === activeTeachingTaskId);
  const mobileSaveDisabledReason = sessionState.status !== 'ready' ? '请等待当前工程就绪。'
    : robotLoadState.status !== 'loaded' ? '请先加载计算时使用的机器人。'
      : ['running', 'pausing', 'paused'].includes(mobileComputation?.status) ? '姿态计算尚未结束，请等待完成或取消后保存。' : '';
  const mobileSolveDisabledReason = sessionState.status !== 'ready' ? '正在恢复工程，请稍候。'
    : !selectedRobot ? '请先在本窗口加载机器人，再开始计算。'
      : robotLoadState.status === 'error' ? `机器人加载失败：${robotLoadState.message || '模型无法读取'}。请重新选择模型重试。`
        : robotLoadState.status !== 'loaded' ? '正在加载机器人，完成后即可开始计算。'
          : !mobileTeachingSolverReady ? '正在准备运动学求解器，请稍候。' : '';
  const teachingDevice = activeTeachingTask?.mobileCapture ? mobileDeviceKey(activeTeachingTask.mobileCapture) : 'desktop';
  const teachingSource = teachingDevice === 'desktop' ? 'desktop' : 'mobile';
  const desktopTeachingTasks = useMemo(() => teachingTasks.filter((task) => !task.mobileCapture), [teachingTasks]);
  const abxRobotBindingKey = teachingTasks.filter((task) => task.abx
    && task.robot?.id !== selectedRobot?.id).map((task) => task.id).join('|');
  useEffect(() => {
    if (!abxRobotBindingKey || selectedRobot?.format !== 'urdf') return undefined;
    const controller = new AbortController();
    (async () => {
      try {
        const model = abxRobotModel(await readAbxRobotPackage(selectedRobot, portableRobotPackageRef.current, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        const matches = (task) => task.abx?.models?.length === 1 && task.abx.models[0] === model
          && task.robot?.id !== selectedRobot.id;
        const matchingIds = new Set(latestWorkspaceRef.current.teachingTasks.filter(matches).map((task) => task.id));
        const descriptor = { id: selectedRobot.id, relativePath: selectedRobot.relativePath, name: selectedRobot.name };
        setTeachingTasks((current) => current.map((task) => matches(task)
          ? { ...task, robot: descriptor } : task));
        setJointPoses((current) => current.map((pose) => matchingIds.has(pose.abx?.taskId)
          ? { ...pose, robot: descriptor } : pose));
      } catch { /* A model that cannot be read remains explicitly unbound. */ }
    })();
    return () => controller.abort();
  }, [abxRobotBindingKey, selectedRobot]);
  const mobileTeachingTasks = useMemo(() => teachingTasks.filter((task) => task.mobileCapture), [teachingTasks]);
  const mobileTasksByDevice = useMemo(() => ({
    ipad: mobileTeachingTasks.filter((task) => mobileDeviceKey(task.mobileCapture) === 'ipad'),
    vision: mobileTeachingTasks.filter((task) => mobileDeviceKey(task.mobileCapture) === 'vision'),
  }), [mobileTeachingTasks]);
  const workbenchTeachingTasks = teachingDevice === 'desktop' ? desktopTeachingTasks : mobileTasksByDevice[teachingDevice];
  const teachingSources = useMemo(() => [
    { id: 'desktop', label: '电脑端示教', tasks: desktopTeachingTasks },
    { id: 'ipad', label: 'iPad / iPhone 示教', tasks: mobileTasksByDevice.ipad },
    { id: 'vision', label: 'Vision Pro 示教', tasks: mobileTasksByDevice.vision },
  ].filter((source) => source.id === 'desktop' || source.tasks.length).map((source) => ({
    id: source.id, label: source.label, taskCount: source.tasks.length,
    poseCount: source.tasks.reduce((total, task) => total + (task.mobileCapture?.samples.length
      || task.parkingPoints.reduce((count, point) => count + point.poses.length, 0)), 0),
  })), [desktopTeachingTasks, mobileTasksByDevice]);
  const selectedMobilePose = useMemo(() => {
    if (!mobilePoseSelection || activeTeachingTask?.id !== mobilePoseSelection.taskId) return null;
    const sample = activeTeachingTask.mobileCapture?.samples.find((item) => item.id === mobilePoseSelection.sampleId);
    return sample ? { task: activeTeachingTask, sample } : null;
  }, [mobilePoseSelection, activeTeachingTask]);
  const waypoints = useMemo(() => buildTeachingWaypoints(storedWaypoints, teachingTasks, {
    mapData,
    coordinateFrame,
  }), [storedWaypoints, teachingTasks, mapData, coordinateFrame]);
  const edges = useMemo(() => navigationEdgesForWaypoints(storedEdges, waypoints), [storedEdges, waypoints]);
  const arrivedWaypointId = useMemo(() => {
    if (!robotWaypointLocation || !selectedRobot
      || robotWaypointLocation.mapId !== mapData?.mapId
      || robotWaypointLocation.teachingSpaceMode !== teachingSpaceMode
      || robotWaypointLocation.robotKey !== (selectedRobot.id || selectedRobot.relativePath)) return null;
    const point = waypoints.find((item) => robotWaypointLocation.sourceWaypointId
      ? item.source === TEMPORARY_MAP_ROUTE_SOURCE && item.sourceWaypointId === robotWaypointLocation.sourceWaypointId
      : item.id === robotWaypointLocation.waypointId);
    if (!point) return null;
    const target = waypointRobotPose(point, robotPose.position.z);
    if (!target) return null;
    const yawDelta = ((robotPose.rpy.yaw - point.pose.yaw) % 360 + 540) % 360 - 180;
    // Compare against the station at the calibrated robot height. Arm edits
    // keep the arrival marker; moving the base away in map XY clears it.
    return Math.hypot(robotPose.position.x - target.position.x, robotPose.position.y - target.position.y) <= 0.001
      && Math.abs(yawDelta) <= 0.01 ? point.id : null;
  }, [mapData?.mapId, robotPose, robotWaypointLocation, selectedRobot, teachingSpaceMode, waypoints]);
  const navigationTopology = useMemo(() => connectivityTopology(waypoints, edges), [waypoints, edges]);

  latestWorkspaceRef.current = {
    abxRoutes,
    mapRouteSyncEnabled,
    workspaceTransfer,
    independentTeachingName,
    directoryAutosaveSuspended,
    mapData,
    teachingSpaceMode,
    heightRange,
    showSlice3D,
    waypoints,
    edges,
    mode,
    connectionSourceId,
    selectedWaypointId,
    robotWaypointLocation,
    selectedEdgeId,
    validation,
    pointColorMode,
    placedObjectColorMode,
    meshRenderQuality,
    showPaths3D,
    showParkingPoints3D,
    showWaypoints3D,
    showWaypointNames3D,
    showPathNames3D,
    showHeightLegend3D,
    collapsedPanel,
    inspectorCollapsed,
    selectedRobot,
    robotPose,
    robotJointValues,
    lockedRobotJointNames,
    ignoredRobotCollisionJointNames,
    robotArmSoftLimitRatio,
    robotArmSoftLimitOverrides,
    robotArmJointCouplingEnabled,
    robotHeightLocked,
    teachingTasks,
    activeTeachingTaskId,
    activeTeachingParkingPointId,
    jointPoses,
  };

  useEffect(() => {
    const run = mobileTeachingRunRef.current;
    if (!run) return;
    const task = teachingTasks.find((item) => item.id === run.taskId);
    if (run.map !== mapData || run.robot !== selectedRobot || run.workspaceId !== sessionIdRef.current
      || run.armSoftLimitRatio !== robotArmSoftLimitRatio
      || run.armSoftLimitOverrides !== robotArmSoftLimitOverrides
      || run.armJointCouplingEnabled !== robotArmJointCouplingEnabled
      || run.sourceCapture !== task?.mobileCapture || run.sourceTransform !== JSON.stringify(task?.mobileTransform)) {
      mobileTeachingRunRef.current = null;
      run.controller.abort();
      setMobileComputation(null);
      setMobileSolveTaskId(null);
    }
  }, [mapData, selectedRobot, teachingTasks, teachingSpaceMode, robotArmSoftLimitRatio, robotArmSoftLimitOverrides, robotArmJointCouplingEnabled]);

  useEffect(() => () => {
    mobileTeachingRunRef.current?.controller.abort();
    mobileTeachingRunRef.current = null;
  }, []);

  useEffect(() => {
    if (!mapData?.mapId || !activeTeachingTask) return;
    teachingSourceSelectionsRef.current.set(`${teachingSpaceMode}:${mapData.mapId}:${teachingDevice}`, {
      taskId: activeTeachingTask.id,
      parkingPointId: activeTeachingParkingPointId,
    });
  }, [mapData?.mapId, teachingSpaceMode, teachingDevice, activeTeachingTask, activeTeachingParkingPointId]);

  useEffect(() => {
    // Follow task/parking selection, without overriding later manual navigation
    // selections when an existing point is merely renamed or moved.
    const point = latestWorkspaceRef.current.waypoints.find((candidate) => (
      candidate.id === activeTeachingParkingPointId && candidate.teachingTaskId === activeTeachingTaskId
    ));
    setSelectedWaypointId(point?.id || null);
    setSelectedEdgeId(null);
    setSelectedMapOrigin(false);
  }, [activeTeachingTaskId, activeTeachingParkingPointId]);

  useEffect(() => {
    setSelectedMapOrigin(false);
  }, [mapData?.geometry, teachingSpaceMode, visibleMapOriginPose, polylineTeachingOpen]);

  useEffect(() => {
    if (selectedWaypointId || selectedEdgeId) setSelectedMapOrigin(false);
  }, [selectedWaypointId, selectedEdgeId]);

  useEffect(() => {
    const ids = new Set(waypoints.map((point) => point.id));
    if (selectedWaypointId && !ids.has(selectedWaypointId)) setSelectedWaypointId(null);
    if (connectionSourceId && !ids.has(connectionSourceId)) setConnectionSourceId(null);
    if (selectedEdgeId && !edges.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null);
  }, [waypoints, edges, selectedWaypointId, selectedEdgeId, connectionSourceId]);

  useEffect(() => {
    // Restored map-route points get fresh temporary IDs after an async rebuild.
    if (robotWaypointLocation?.sourceWaypointId && mapRouteSyncEnabled && mapRouteSync.checking) return;
    if (robotWaypointLocation && !arrivedWaypointId && !loadState.loading
      && sessionState.status === 'ready' && robotLoadState.status !== 'pending'
      && robotLoadState.status !== 'loading') setRobotWaypointLocation(null);
  }, [arrivedWaypointId, loadState.loading, mapRouteSync.checking, mapRouteSyncEnabled,
    robotLoadState.status, robotWaypointLocation, sessionState.status]);

  useEffect(() => {
    const geometry = mapData?.geometry;
    return () => geometry?.dispose?.();
  }, [mapData?.geometry]);

  useEffect(() => {
    setRobotParkingGhost((current) => {
      if (!current) return current;
      const task = teachingTasks.find((item) => item.id === current.taskId);
      const parkingPoint = task?.parkingPoints?.find(
        (item) => item.id === current.parkingPointId,
      );
      const pose = current.poseId
        ? parkingPoint?.poses?.find((item) => item.id === current.poseId)
        : null;
      const currentMapKey = mapData?.sourceHash || mapData?.mapId || mapData?.name || '';
      const currentRobotKey = selectedRobot?.id || selectedRobot?.relativePath || '';
      if (
        !parkingPoint
        || (current.poseId && !pose)
        || !currentMapKey
        || !currentRobotKey
        || current.mapKey !== currentMapKey
        || current.robotKey !== currentRobotKey
      ) return null;
      const targetPose = normalizeRobotPose(parkingPoint.mapPose);
      const targetChanged = !current.editing && Object.entries(parkingWaypointPose(targetPose))
        .some(([axis, value]) => parkingWaypointPose(current.targetPose)[axis] !== value);
      if (
        current.parkingPointName !== parkingPoint.name
        || current.taskName !== task.name
        || current.poseName !== (pose?.name || '')
        || targetChanged
      ) {
        return {
          ...current,
          parkingPointName: parkingPoint.name,
          taskName: task.name,
          poseName: pose?.name || '',
          ...(targetChanged ? { targetPose, revision: createId('robot-parking-ghost') } : {}),
        };
      }
      return current;
    });
  }, [
    mapData?.mapId,
    mapData?.name,
    mapData?.sourceHash,
    selectedRobot?.id,
    selectedRobot?.relativePath,
    teachingTasks,
  ]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      if (teachingPlaybackFrameRef.current !== null) {
        window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
      }
      teachingPlaybackFrameRef.current = null;
      teachingPlaybackRuntimeRef.current = null;
      releasePortableRobotPackage(portableRobotPackageRef.current?.resourceId);
    },
    [],
  );

  useEffect(() => {
    const syncPageFromHistory = () => {
      const nextPage = appPageFromLocation();
      setAppPage(nextPage);
    };
    window.addEventListener('popstate', syncPageFromHistory);
    return () => window.removeEventListener('popstate', syncPageFromHistory);
  }, []);

  useEffect(() => {
    document.title = appPage === APP_PAGE_TEACHING_DATA
      ? '示教数据 · 虚拟示教平台'
      : appPage === APP_PAGE_MODEL_PAIR_EDITOR
        ? '双模型处理 · 虚拟示教平台'
      : appPage === APP_PAGE_MODEL_EDITOR
        ? '模型编辑 · 虚拟示教平台'
      : appPage === APP_PAGE_WORKBENCH
        ? '工作台 · 虚拟示教平台'
        : '虚拟示教平台';
  }, [appPage]);

  const navigateAppPage = useCallback((nextPage, options = {}) => {
    const normalized = [APP_PAGE_HOME, APP_PAGE_WORKBENCH, APP_PAGE_TEACHING_DATA, APP_PAGE_MODEL_EDITOR, APP_PAGE_MODEL_PAIR_EDITOR]
      .includes(nextPage)
      ? nextPage
      : APP_PAGE_HOME;
    const targetPath = normalized === APP_PAGE_HOME
      ? '/'
      : `/${normalized}`;
    if (normalized === APP_PAGE_HOME) {
      setStartPageMode(options.teachingSpaceMode == null
        ? null
        : normalizeTeachingSpaceMode(options.teachingSpaceMode));
    }
    if (window.location.pathname !== targetPath) {
      const method = options.replace ? 'replaceState' : 'pushState';
      window.history[method]({ atlasPage: normalized }, '', targetPath);
    }
    setAppPage(normalized);
  }, []);

  const notify = useCallback((message, kind = 'success') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, kind });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const revision = ++projectSaveTargetRevisionRef.current;
    setProjectSaveTarget(null);
    if (!mapData?.mapId) return undefined;
    loadProjectSaveTarget(mapData.mapId, teachingSpaceMode)
      .then((target) => {
        if (revision === projectSaveTargetRevisionRef.current) setProjectSaveTarget(target);
      })
      .catch(() => { /* Saving remains available through Save As if storage is blocked. */ });
    return () => { projectSaveTargetRevisionRef.current += 1; };
  }, [mapData?.mapId, teachingSpaceMode]);

  const reportSessionFailure = useCallback(
    (error) => {
      console.warn('工作会话自动保护失败', error);
      sessionReadyRef.current = false;
      setSessionState({ status: 'error', restored: false });
      if (!sessionFailureNotifiedRef.current) {
        sessionFailureNotifiedRef.current = true;
        notify('自动保护暂不可用，请使用“工程 → 另存为工程”保存备份', 'warning');
      }
    },
    [notify],
  );

  const reportProjectDirectoryFailure = useCallback(
    (error) => {
      console.warn('工程目录增量保存失败', error);
      const binding = projectDirectoryRef.current;
      setProjectDirectoryState({
        status: 'error',
        name: binding?.name || '',
        savedAt: binding?.savedAt || null,
        writable: Boolean(binding?.handle),
        error: error?.message || '工程目录写入失败',
      });
      if (!projectDirectoryFailureNotifiedRef.current) {
        projectDirectoryFailureNotifiedRef.current = true;
        notify(`工程目录自动保存失败：${error?.message || '请重新加载工程目录'}`, 'warning');
      }
    },
    [notify],
  );

  const persistWorkspaceNow = useCallback(() => {
    if (workspaceSwitchingRef.current) return Promise.resolve();
    const sessionId = sessionIdRef.current;
    const current = latestWorkspaceRef.current;
    if (!sessionReadyRef.current || !sessionId || !current) return Promise.resolve();

    const mapId = current.mapData?.mapId || null;
    saveWorkspaceViews(
      sessionId,
      mapId,
      {
        view2d: view2dRef.current,
        view3d: view3dRef.current,
      },
      current.teachingSpaceMode,
    );

    const project = current.mapData
      ? buildExport({
          transfer: current.workspaceTransfer,
          independentTeachingName: current.independentTeachingName,
          directoryAutosaveSuspended: current.directoryAutosaveSuspended,
          mapData: current.mapData,
          teachingSpaceMode: current.teachingSpaceMode,
          heightRange: current.heightRange,
          waypoints: current.waypoints,
          edges: current.edges,
          abxRoutes: current.abxRoutes,
          view2d: view2dRef.current,
          view3d: view3dRef.current,
          robot: current.selectedRobot,
          robotPose: current.robotPose,
          robotJointValues: current.robotJointValues,
          lockedRobotJointNames: current.lockedRobotJointNames,
          ignoredRobotCollisionJointNames: current.ignoredRobotCollisionJointNames,
          robotArmSoftLimitRatio: current.robotArmSoftLimitRatio,
          robotArmSoftLimitOverrides: current.robotArmSoftLimitOverrides,
          robotArmJointCouplingEnabled: current.robotArmJointCouplingEnabled,
          robotHeightLocked: current.robotHeightLocked,
          teachingTasks: current.teachingTasks,
          jointPoses: current.jointPoses,
          meshRenderQuality: current.meshRenderQuality,
          pointColorMode: current.pointColorMode,
          placedObjectColorMode: current.placedObjectColorMode,
          showPaths3D: current.showPaths3D,
          showParkingPoints3D: current.showParkingPoints3D,
          showWaypoints3D: current.showWaypoints3D,
          showWaypointNames3D: current.showWaypointNames3D,
          showPathNames3D: current.showPathNames3D,
          showHeightLegend3D: current.showHeightLegend3D,
          activeTeachingTaskId: current.activeTeachingTaskId,
          activeTeachingParkingPointId: current.activeTeachingParkingPointId,
          collapsedPanel: current.collapsedPanel,
          inspectorCollapsed: current.inspectorCollapsed,
        })
      : null;
    const snapshot = {
      schemaVersion: 1,
      project,
      ui: {
        teachingSpaceMode: current.teachingSpaceMode,
        mapRouteSyncEnabled: current.teachingSpaceMode === 'independent' && current.mapRouteSyncEnabled,
        mode: current.mode,
        connectionSourceId: current.connectionSourceId,
        selectedWaypointId: current.selectedWaypointId,
        robotWaypointLocation: current.robotWaypointLocation,
        selectedEdgeId: current.selectedEdgeId,
        activeTeachingTaskId: current.activeTeachingTaskId,
        activeTeachingParkingPointId: current.activeTeachingParkingPointId,
        validation: current.validation,
        pointColorMode: current.pointColorMode,
        placedObjectColorMode: current.placedObjectColorMode,
        meshRenderQuality: current.meshRenderQuality,
        showPaths3D: current.showPaths3D,
        showParkingPoints3D: current.showParkingPoints3D,
        showWaypoints3D: current.showWaypoints3D,
        showWaypointNames3D: current.showWaypointNames3D,
        showPathNames3D: current.showPathNames3D,
        showHeightLegend3D: current.showHeightLegend3D,
        showSlice3D: current.showSlice3D,
        collapsedPanel: current.collapsedPanel,
        inspectorCollapsed: current.inspectorCollapsed,
        robotHeightLocked: current.robotHeightLocked,
        selectedRobot: current.selectedRobot
          ? {
              ...current.selectedRobot,
              origin: current.robotPose,
              joints: current.robotJointValues,
              lockedJoints: current.lockedRobotJointNames,
              collisionIgnoredJoints: current.ignoredRobotCollisionJointNames,
              armSoftLimitRatio: current.robotArmSoftLimitRatio,
              armSoftLimitOverrides: current.robotArmSoftLimitOverrides,
              armJointCouplingEnabled: current.robotArmJointCouplingEnabled,
              heightLocked: current.robotHeightLocked,
            }
          : null,
      },
    };
    sessionWriteChainRef.current = sessionWriteChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await saveWorkspaceConfig(
          sessionId,
          mapId,
          snapshot,
          current.teachingSpaceMode,
          { presetLibrary: project ? sharedRobotPresetsRef.current : undefined },
        );
        if (saved?.presetLibrary) sharedRobotPresetsRef.current = saved.presetLibrary;
        return saved;
      })
      .catch(reportSessionFailure);

    const directoryBinding = projectDirectoryRef.current;
    if (directoryBinding?.handle && project) {
      const expectedHandle = directoryBinding.handle;
      setProjectDirectoryState((currentState) => ({
        ...currentState,
        status: 'saving',
        name: directoryBinding.name,
        writable: true,
      }));
      projectDirectoryWriteChainRef.current = projectDirectoryWriteChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const activeBinding = projectDirectoryRef.current;
          if (!activeBinding || activeBinding.handle !== expectedHandle) return null;
          const { updateProjectDirectory } = await import('./lib/projectArchive.js');
          const result = await updateProjectDirectory(expectedHandle, project, {
            manifest: activeBinding.manifest,
            rawPayload: activeBinding.rawPayload,
          });
          if (projectDirectoryRef.current?.handle !== expectedHandle) return result;
          projectDirectoryRef.current = {
            ...activeBinding,
            manifest: result.manifest,
            rawPayload: result.rawPayload,
            savedAt: result.savedAt,
          };
          projectDirectoryFailureNotifiedRef.current = false;
          setProjectDirectoryState({
            status: 'synced',
            name: activeBinding.name,
            savedAt: result.savedAt,
            writable: true,
          });
          return result;
        })
        .catch(reportProjectDirectoryFailure);
    }
    return Promise.allSettled([
      sessionWriteChainRef.current,
      projectDirectoryWriteChainRef.current,
    ]);
  }, [reportProjectDirectoryFailure, reportSessionFailure]);

  const queueWorkspaceSave = useCallback(() => {
    if (!sessionReadyRef.current) return;
    if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null;
      persistWorkspaceNow();
    }, 180);
  }, [persistWorkspaceNow]);

  const invalidateConnectivity = useCallback(() => {
    setValidation(initialValidation);
    setEdges((current) => current.some((edge) => edge.status !== 'unchecked')
      ? current.map((edge) => ({ ...edge, status: 'unchecked' }))
      : current);
  }, []);

  const applySyncedMapRoute = useCallback((synced) => {
    const current = latestWorkspaceRef.current;
    setWaypoints((points) => [...withoutTemporaryMapNavigation(points, []).waypoints, ...synced.waypoints]);
    setEdges((paths) => [...withoutTemporaryMapNavigation(current.waypoints, paths).edges, ...synced.edges]);
    setSyncedMapOrigin({ mapId: current.mapData?.mapId, pose: synced.mapOrigin });
    setValidation(initialValidation);
  }, []);

  useEffect(() => {
    if (teachingSpaceMode !== 'independent' || sessionState.status !== 'ready' || loadState.loading || !mapData) return undefined;
    let cancelled = false;
    const sessionId = sessionIdRef.current;
    setMapRouteSync({ available: false, checking: true, reason: '正在检查地图路径…' });
    loadWorkspaceConfig(sessionId, 'map').then((config) => {
      if (cancelled || workspaceSwitchingRef.current || !sessionReadyRef.current || sessionIdRef.current !== sessionId) return;
      const status = mapRouteSyncStatus(mapData, workspaceTransfer, config);
      setMapRouteSync(status);
      const current = latestWorkspaceRef.current;
      // Only remember the opt-in in this workspace's UI cache. On return,
      // rebuild the disposable graph from the latest absolute map route.
      if (status.available && current.mapRouteSyncEnabled && !mapRouteSyncBusyRef.current
        && !current.waypoints.some((point) => point.source === TEMPORARY_MAP_ROUTE_SOURCE)) {
        applySyncedMapRoute(syncMapRouteToIndependent(mapData, workspaceTransfer, config));
      }
    }).catch((error) => {
      if (!cancelled) setMapRouteSync({ available: false, reason: error.message });
    });
    return () => { cancelled = true; };
  }, [mapData, teachingSpaceMode, workspaceTransfer, sessionState.status, loadState.loading,
    mapRouteSyncEnabled, applySyncedMapRoute,
    cachedWorkspaces.map?.mapId, cachedWorkspaces.map?.waypointCount, cachedWorkspaces.map?.edgeCount]);

  const syncMapRoute = async () => {
    const source = latestWorkspaceRef.current;
    if (mapRouteSyncBusyRef.current || loadState.loading || workspaceSwitchingRef.current
      || !sessionReadyRef.current || source.teachingSpaceMode !== 'independent') return;
    const sessionId = sessionIdRef.current;
    mapRouteSyncBusyRef.current = true;
    setMapRouteSyncBusy(true);
    try {
      // Always recompute from the latest absolute route, never from a prior projection.
      const config = await loadWorkspaceConfig(sessionId, 'map');
      const current = latestWorkspaceRef.current;
      if (current.mapData !== source.mapData || current.teachingSpaceMode !== 'independent'
        || current.workspaceTransfer !== source.workspaceTransfer || sessionIdRef.current !== sessionId
        || workspaceSwitchingRef.current) throw new Error('同步期间工程已切换，请在目标工程重新同步');
      const status = mapRouteSyncStatus(current.mapData, current.workspaceTransfer, config);
      setMapRouteSync(status);
      const synced = syncMapRouteToIndependent(current.mapData, current.workspaceTransfer, config);
      applySyncedMapRoute(synced);
      setMapRouteSyncEnabled(true);
      setSelectedWaypointId(null);
      setSelectedEdgeId(null);
      setConnectionSourceId(null);
      setShowWaypoints3D(true);
      // Commit the opt-in before reporting success; a quick reload must not
      // depend on the normal debounced save or an asynchronous pagehide write.
      latestWorkspaceRef.current = { ...current, mapRouteSyncEnabled: true };
      await persistWorkspaceNow();
      if (!sessionReadyRef.current) throw new Error('同步状态尚未保存成功，请重试');
      notify(`已同步 ${synced.waypoints.length} 个导航点 / ${synced.edges.length} 条路径到独立模型坐标系 · 临时副本，不写回地图`, 'success');
    } catch (error) {
      notify(error.message || '地图路径同步失败', 'error');
    } finally {
      mapRouteSyncBusyRef.current = false;
      setMapRouteSyncBusy(false);
    }
  };

  useEffect(() => {
    // Restoring a checked graph already provides a fresh result for this topology.
    // Actual point/connection changes still invalidate the result and its colors.
    if (validation.topology !== navigationTopology) invalidateConnectivity();
  }, [invalidateConnectivity, navigationTopology, validation.topology]);

  const installMapGeometry = useCallback(
    async (geometry, name, options = {}) => {
      const {
        preserveGraph = false,
        preferredSlice = null,
        preferredView = null,
        preferredView3d = null,
        persistSnapshot = true,
        announce = true,
        keepLoading = false,
        mapId = createId('map'),
        sourceByteLength = 0,
        geometrySource = 'ply-parse',
        sourceHash = null,
        sourceHashKind = 'file',
        sourceBlob = null,
        sourceModifiedAt = null,
        sourceMimeType = 'application/octet-stream',
        sourceKind = 'unknown',
        loadedAt = null,
        teachingGroupId = null,
        teachingSpaceMode: requestedTeachingSpaceMode = 'map',
      } = options;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const positions = geometry.getAttribute('position')?.array;
      if (!positions?.length || !geometry.boundingBox) {
        throw new Error('PLY 文件中没有可用的顶点坐标');
      }

      const packedColors = packColorAttribute(geometry.getAttribute('color'));
      if (packedColors) {
        geometry.setAttribute('color', new THREE.BufferAttribute(packedColors, 3, true));
      }
      const meshInfo = prepareMapGeometryTopology(geometry);
      geometry.userData.geometrySource = geometrySource;
      const colors = geometry.getAttribute('color')?.array || null;
      const bounds = serializeBounds(geometry.boundingBox);
      const nextSlice = clampSlice(preferredSlice || suggestedSlice(positions, bounds), bounds);
      const normalizedByteLength = Math.max(0, Number(sourceByteLength) || 0);
      const normalizedLoadedAt = normalizeTimestamp(loadedAt) || new Date().toISOString();
      const normalizedTeachingSpaceMode = normalizeTeachingSpaceMode(requestedTeachingSpaceMode);
      const mapCoordinateFrame = teachingCoordinateFrame(normalizedTeachingSpaceMode);
      const nextMap = {
        mapId,
        name,
        pointCount: positions.length / 3,
        faceCount: meshInfo.faceCount,
        meshInfo,
        bounds,
        positions,
        colors,
        geometry,
        geometrySource,
        sourceHash,
        sourceHashKind,
        sourceBlob: sourceBlob instanceof Blob ? sourceBlob : null,
        byteLength: normalizedByteLength,
        fileModifiedAt: normalizeTimestamp(sourceModifiedAt),
        mimeType: String(sourceMimeType || 'application/octet-stream'),
        loadedAt: normalizedLoadedAt,
        sourceKind: String(sourceKind || 'unknown'),
        ...(teachingGroupId ? { teachingGroupId } : {}),
        teachingSpaceMode: normalizedTeachingSpaceMode,
        coordinateFrame: mapCoordinateFrame,
        virtualOrigin: { x: 0, y: 0, z: 0 },
        metadataOnly: false,
      };
      setMapData(nextMap);
      setTeachingSpaceMode(normalizedTeachingSpaceMode);
      setHeightRange(nextSlice);
      setRestoredView2d(preferredView);
      view2dRef.current = preferredView;
      setRestoredView3d(preferredView3d);
      view3dRef.current = preferredView3d;
      setProjectionStats({ selectedCount: 0 });
      setSynchronizedFocus(null);
      if (!preserveGraph) {
        setWorkspaceTransfer(null);
        setIndependentTeachingName(normalizedTeachingSpaceMode === 'independent' ? defaultIndependentTeachingName(name) : '');
        setMapRouteSyncEnabled(false);
        setSyncedMapOrigin(null);
        setDirectoryAutosaveSuspended(false);
        setWaypoints([]);
        setAbxRoutes([]);
        setEdges([]);
        setSelectedWaypointId(null);
        setSelectedEdgeId(null);
        setConnectionSourceId(null);
        setValidation(initialValidation);
        setRobotPose(normalizeRobotPose(null));
        setRobotJointValues({});
        setLockedRobotJointNames([]);
        setIgnoredRobotCollisionJointNames([]);
        setRobotArmSoftLimitRatio(ARM_SOFT_LIMIT_RATIO);
        setRobotArmSoftLimitOverrides({});
        setRobotArmJointCouplingEnabled(true);
        setRobotControlEnabled(false);
        setRobotHeightLocked(false);
        setRobotCollisionProtectionEnabled(true);
        setTeachingTasks([]);
        setActiveTeachingTaskId(null);
        setActiveTeachingParkingPointId(null);
        setJointPoses(withSharedRobotPresets([], sharedRobotPresetsRef.current?.poses || []));
        setCameraTeachingCommand(null);
        setCameraTeachingResult({ status: 'idle', revision: 0 });
        setTeachingCaptureState({ status: 'idle', message: '' });
      }

      if (persistSnapshot && sessionReadyRef.current && sessionIdRef.current) {
        setLoadState({
          loading: true,
          progress: 1,
          phase: '缓存已解析地图',
          detail: meshInfo.hasMesh
            ? '正在保存点云、颜色与面索引，后续刷新无需再次解析 PLY'
            : '正在保存坐标缓存，后续刷新无需再次解析 PLY',
        });
        try {
          await saveWorkspaceMap(
            sessionIdRef.current,
            mapId,
            name,
            {
              ...createGeometryCache(
                geometry,
                bounds,
                sourceByteLength,
                sourceHash,
                sourceHashKind,
                {
                  fileModifiedAt: nextMap.fileModifiedAt,
                  mimeType: nextMap.mimeType,
                  loadedAt: nextMap.loadedAt,
                  sourceKind: nextMap.sourceKind,
                  sourceBlob: nextMap.sourceBlob,
                  teachingSpaceMode: nextMap.teachingSpaceMode,
                  teachingGroupId: nextMap.teachingGroupId,
                },
              ),
              portableRobotPackage: portableRobotPackageRef.current
                ? {
                    ...portableRobotPackageRef.current,
                    resourceId: undefined,
                  }
                : null,
            },
            nextMap.teachingSpaceMode,
          );
        } catch (error) {
          reportSessionFailure(error);
        }
      }

      if (!keepLoading) setLoadState({ loading: false, progress: 1, phase: '' });
      if (announce) {
        notify(
          meshInfo.hasMesh
            ? `${name} 已加载 · ${(positions.length / 3).toLocaleString('zh-CN')} 点 / ${meshInfo.faceCount.toLocaleString('zh-CN')} 面`
            : `${name} 已加载 · ${(positions.length / 3).toLocaleString('zh-CN')} 点`,
        );
      }
      return nextMap;
    },
    [notify, reportSessionFailure],
  );

  const processMapBuffer = useCallback(
    async (buffer, name, options = {}) => {
      setLoadState({
        loading: true,
        progress: 1,
        phase: '解析地图结构',
        detail: '首次载入正在构建点云、网格与空间索引',
      });
      await waitForPaint();
      let geometry;
      try {
        const sourceHashPromise = options.sourceHash
          ? Promise.resolve(options.sourceHash)
          : sha256ArrayBuffer(buffer).catch(() => null);
        const loader = new PLYLoader();
        geometry = loader.parse(buffer);
        const sourceHash = await sourceHashPromise;
        return await installMapGeometry(geometry, name, {
          ...options,
          sourceByteLength: buffer.byteLength,
          sourceBlob: new Blob([buffer], { type: options.sourceMimeType || 'application/octet-stream' }),
          geometrySource: options.geometrySource || 'ply-parse',
          sourceHash,
          sourceHashKind: options.sourceHashKind || 'file',
        });
      } catch (error) {
        geometry?.dispose?.();
        setLoadState({ loading: false, progress: 0, phase: '' });
        throw error;
      }
    },
    [installMapGeometry],
  );

  const processMapCache = useCallback(
    async (record, options = {}) => {
      setLoadState({
        loading: true,
        progress: 1,
        phase: '恢复地图缓存',
        detail: record.indexBuffer
          ? '正在直接装载已解析坐标与面索引，跳过 PLY 解析'
          : '正在直接装载已解析坐标，跳过 PLY 解析',
      });
      await waitForPaint();
      let geometry;
      try {
        geometry = restoreGeometryFromCache(record);
        return await installMapGeometry(geometry, record.name, {
          ...options,
          persistSnapshot: false,
          sourceByteLength: record.byteLength,
          sourceBlob: record.sourceBlob || record.blob || null,
          geometrySource: 'session-cache',
          mapId: record.mapId,
          sourceHash: record.sourceHash || null,
          sourceHashKind: record.sourceHashKind || 'file',
          teachingGroupId: record.teachingGroupId,
          sourceModifiedAt: record.fileModifiedAt || null,
          sourceMimeType: record.mimeType || 'application/octet-stream',
          sourceKind: record.sourceKind || 'session-cache',
          loadedAt: record.loadedAt || record.savedAt || null,
          teachingSpaceMode: options.teachingSpaceMode ?? record.teachingSpaceMode ?? 'map',
        });
      } catch (error) {
        geometry?.dispose?.();
        setLoadState({ loading: false, progress: 0, phase: '' });
        throw error;
      }
    },
    [installMapGeometry],
  );

  useEffect(() => {
    const revision = ++hydrationRevisionRef.current;
    const isCurrent = () => hydrationRevisionRef.current === revision;

    const restoreWorkspace = async () => {
      try {
        const service = await fetchServiceSession().catch(() => ({ sessionId: createId('workspace') }));
        if (!isCurrent()) return;
        const presetLibrary = await loadSharedRobotPresets();
        if (!isCurrent()) return;
        sharedRobotPresetsRef.current = presetLibrary;
        const stored = await prepareWorkspaceSession(service.sessionId, { preserveExisting: true });
        if (!isCurrent()) return;
        const identity = { sessionId: stored.sessionId };
        sessionIdRef.current = identity.sessionId;
        if (projectImportProgressRef.current?.resuming
          && projectImportProgressRef.current.sessionId !== identity.sessionId) cancelProjectImport();

        if (projectImportProgressRef.current?.resuming) advanceProjectImport(0.94, '恢复地图与机器人');
        setLastProjectRecovery(stored.recovery || null);
        setCachedWorkspaces({
          map: stored.workspaceSlots?.map || null,
          independent: stored.workspaceSlots?.independent || null,
        });

        let restored = false;
        let repaired = false;
        let restoredTeachingSpaceMode = normalizeTeachingSpaceMode(stored.activeMode);
        let restoredDirectorySuspended = false;
        try {
          const configMatchesMap =
            !stored.map || (stored.config && stored.config.mapId === stored.map.mapId);
          const snapshot = configMatchesMap ? stored.config?.config : null;
          const project = snapshot?.project ? normalizeProject(snapshot.project) : null;
          if (project) project.jointPoses = withSharedRobotPresets(project.jointPoses, presetLibrary.poses);
          setWorkspaceTransfer(project?.workspace?.transfer || null);
          setIndependentTeachingName(project?.workspace?.independentTeachingName || '');
          setMapRouteSyncEnabled(project?.workspace?.teachingSpaceMode === 'independent'
            && snapshot?.ui?.mapRouteSyncEnabled === true);
          setSyncedMapOrigin(null);
          restoredDirectorySuspended = project?.workspace?.directoryAutosaveSuspended === true;
          setDirectoryAutosaveSuspended(restoredDirectorySuspended);
          restoredTeachingSpaceMode = normalizeTeachingSpaceMode(
            project?.workspace?.teachingSpaceMode
            ?? snapshot?.ui?.teachingSpaceMode
            ?? stored.map?.teachingSpaceMode
            ?? stored.activeMode,
          );
          setTeachingSpaceMode(restoredTeachingSpaceMode);
          const storedRobotPackage = stored.map?.portableRobotPackage || null;
          const portableResourceId = storedRobotPackage
            ? registerPortableRobotPackage(storedRobotPackage)
            : null;
          if (storedRobotPackage) {
            portableRobotPackageRef.current = {
              ...storedRobotPackage,
              resourceId: portableResourceId,
            };
          }
          const restoredRobot = normalizeRobotDescriptor(
            portableResourceId
              ? {
                  ...(project?.robot || snapshot?.ui?.selectedRobot),
                  portableResourceId,
                }
              : project?.robot || snapshot?.ui?.selectedRobot,
          );
          const restoredMapId = stored.map?.mapId || stored.config?.mapId || null;
          const instantViews = loadWorkspaceViews(
            identity.sessionId,
            restoredMapId,
            restoredTeachingSpaceMode,
          );
          const recoveryViews = stored.config?.workspaceViews || stored.map?.workspaceViews || null;
          const preferredView2d = instantViews?.view2d
            ?? recoveryViews?.view2d
            ?? project?.view2d
            ?? null;
          const preferredView3d = instantViews?.view3d
            ?? recoveryViews?.view3d
            ?? project?.view3d
            ?? null;
          setCollapsedPanel(
            snapshot?.ui?.collapsedPanel === '3d' || snapshot?.ui?.collapsedPanel === '2d'
              ? snapshot.ui.collapsedPanel
              : null,
          );
          setInspectorCollapsed(snapshot?.ui?.inspectorCollapsed === true);
          setMeshRenderQuality(normalizeMeshRenderQuality(
            snapshot?.ui?.meshRenderQuality ?? project?.rendering?.meshQuality,
          ));
          setShowPaths3D((snapshot?.ui?.showPaths3D ?? project?.workspace?.showPaths3D) !== false);
          setShowParkingPoints3D((snapshot?.ui?.showParkingPoints3D ?? project?.workspace?.showParkingPoints3D) !== false);
          setShowWaypoints3D(snapshot?.ui?.showWaypoints3D !== false);
          setShowWaypointNames3D(
            (snapshot?.ui?.showWaypointNames3D ?? project?.workspace?.showWaypointNames3D) !== false,
          );
          setShowPathNames3D(
            (snapshot?.ui?.showPathNames3D ?? project?.workspace?.showPathNames3D) === true,
          );
          setShowHeightLegend3D(
            (snapshot?.ui?.showHeightLegend3D ?? project?.workspace?.showHeightLegend3D) !== false,
          );
          const restoredObjectColor = snapshot?.ui?.placedObjectColorMode ?? snapshot?.project?.workspace?.placedObjectColorMode
            ?? snapshot?.ui?.pointColorMode ?? project?.workspace?.pointColorMode;
          setPlacedObjectColorMode(pointColorModes.has(restoredObjectColor) ? restoredObjectColor : 'height');
          setShowSlice3D(snapshot?.ui?.showSlice3D !== false);
          defaultRobotJointLocksPendingRef.current = false;
          setSelectedRobot(restoredRobot);
          setRobotPose(
            restoredRobot
              ? normalizeRobotPose(project?.robot?.origin || restoredRobot.origin)
              : normalizeRobotPose(null),
          );
          setRobotJointValues(
            restoredRobot ? normalizeRobotJointValues(project?.robot?.joints || restoredRobot.joints) : {},
          );
          setLockedRobotJointNames(
            restoredRobot
              ? normalizeRobotJointLocks(
                  project?.robot?.lockedJoints
                  ?? snapshot?.ui?.selectedRobot?.lockedJoints,
                )
              : [],
          );
          setRobotHeightLocked(Boolean(
            restoredRobot
            && (
              project?.robot?.heightLocked
              ?? snapshot?.ui?.robotHeightLocked
              ?? snapshot?.ui?.selectedRobot?.heightLocked
            )
          ));
          setIgnoredRobotCollisionJointNames(restoredRobot
            ? normalizeIgnoredCollisionJoints(project?.robot?.collisionIgnoredJoints
              ?? snapshot?.ui?.selectedRobot?.collisionIgnoredJoints) : []);
          setRobotArmSoftLimitRatio(normalizeArmSoftLimitRatio(restoredRobot
            ? project?.robot?.armSoftLimitRatio ?? snapshot?.ui?.selectedRobot?.armSoftLimitRatio : undefined));
          setRobotArmSoftLimitOverrides(normalizeArmSoftLimitOverrides(restoredRobot
            ? project?.robot?.armSoftLimitOverrides ?? snapshot?.ui?.selectedRobot?.armSoftLimitOverrides : undefined));
          setRobotArmJointCouplingEnabled(normalizeArmJointCouplingEnabled(restoredRobot
            ? project?.robot?.armJointCouplingEnabled ?? snapshot?.ui?.selectedRobot?.armJointCouplingEnabled : undefined));
          setRobotControlEnabled(false);
          setRobotLoadState({ status: restoredRobot ? 'pending' : 'idle' });
          restored = restored || Boolean(restoredRobot);

          if (
            stored.map?.geometryCacheVersion === GEOMETRY_CACHE_VERSION
            && stored.map.positionBuffer instanceof ArrayBuffer
          ) {
            await processMapCache(stored.map, {
              preserveGraph: true,
              preferredSlice: project?.slice,
              preferredView: preferredView2d,
              preferredView3d,
              teachingSpaceMode: restoredTeachingSpaceMode,
              announce: false,
              keepLoading: true,
            });
            if (!isCurrent()) return;
            if (projectImportProgressRef.current?.resuming) advanceProjectImport(0.97, '恢复示教结果与视角');
            restored = true;
          } else if (stored.map?.blob) {
            setLoadState({
              loading: true,
              progress: 0.3,
              phase: '恢复上次地图',
              detail: `${stored.map.name} · ${Number(stored.map.byteLength || 0).toLocaleString('zh-CN')} bytes`,
            });
            const buffer = await stored.map.blob.arrayBuffer();
            if (!isCurrent()) return;
            const restoredMap = await processMapBuffer(buffer, stored.map.name, {
              preserveGraph: true,
              preferredSlice: project?.slice,
              preferredView: preferredView2d,
              preferredView3d,
              teachingSpaceMode: restoredTeachingSpaceMode,
              persistSnapshot: false,
              announce: false,
              keepLoading: true,
              mapId: stored.map.mapId,
              geometrySource: 'legacy-ply-cache',
            });
            if (!isCurrent()) return;
            setLoadState({
              loading: true,
              progress: 1,
              phase: '升级点云缓存',
              detail: '旧版快照仅需此次解析，正在转换为已解析坐标缓存',
            });
            await saveWorkspaceMap(
              identity.sessionId,
              stored.map.mapId,
              stored.map.name,
              createGeometryCache(
                restoredMap.geometry,
                restoredMap.bounds,
                buffer.byteLength,
                restoredMap.sourceHash,
                restoredMap.sourceHashKind,
                {
                  fileModifiedAt: restoredMap.fileModifiedAt,
                  mimeType: restoredMap.mimeType,
                  loadedAt: restoredMap.loadedAt,
                  sourceKind: restoredMap.sourceKind,
                  sourceBlob: restoredMap.sourceBlob,
                  teachingSpaceMode: restoredMap.teachingSpaceMode,
                },
              ),
              restoredTeachingSpaceMode,
            );
            if (!isCurrent()) return;
            restored = true;
          } else if (project?.map?.bounds) {
            const bounds = project.map.bounds;
            setMapData({
              mapId: stored.config?.mapId || createId('map-meta'),
              name: project.map.fileName || '未绑定地图',
              pointCount: Number(project.map.pointCount) || 0,
              faceCount: Number(project.map.faceCount) || 0,
              bounds,
              positions: null,
              colors: null,
              geometry: null,
              sourceHash: project.map.sourceHash || null,
              sourceHashKind: project.map.sourceHashKind || 'file',
              teachingGroupId: project.map.teachingGroupId,
              byteLength: Math.max(0, Number(project.map.byteLength) || 0),
              fileModifiedAt: normalizeTimestamp(
                project.map.fileModifiedAt || project.map.modifiedAt,
              ),
              mimeType: String(project.map.mimeType || 'application/octet-stream'),
              loadedAt: normalizeTimestamp(project.map.loadedAt),
              sourceKind: String(project.map.sourceKind || 'project-metadata'),
              teachingSpaceMode: restoredTeachingSpaceMode,
              coordinateFrame: teachingCoordinateFrame(restoredTeachingSpaceMode),
              virtualOrigin: { x: 0, y: 0, z: 0 },
              geometrySource: 'project-metadata',
              metadataOnly: true,
            });
            setHeightRange(
              clampSlice(project.slice || [bounds.min.z, bounds.max.z], bounds),
            );
            setRestoredView2d(preferredView2d);
            view2dRef.current = preferredView2d;
            setRestoredView3d(preferredView3d);
            view3dRef.current = preferredView3d;
            restored = true;
          }

          if (project) {
            const pointIds = new Set(project.waypoints.map((point) => point.id));
            const edgeIds = new Set(project.edges.map((edge) => edge.id));
            const teachingTaskIds = new Set(
              project.teachingTasks.map((task) => task.id),
            );
            const savedValidation = snapshot?.ui?.validation;
            const checked = savedValidation?.status !== 'idle' && (
              ['connected', 'partial'].includes(savedValidation?.status)
              || project.edges.some((edge) => edge.status !== 'unchecked')
            );
            const restoredConnectivity = checked ? inspectConnectivity(
              buildTeachingWaypoints(project.waypoints, project.teachingTasks, {
                mapData: stored.map || { ...project.map, name: project.map?.fileName },
                coordinateFrame: restoredTeachingSpaceMode === 'independent' ? 'virtual_origin' : 'map',
              }), project.edges,
            ) : null;

            setWaypoints(project.waypoints);
            setAbxRoutes(project.abxRoutes);
            setEdges(restoredConnectivity ? project.edges.map((edge) => ({
              ...edge, status: restoredConnectivity.edgeStatus.get(edge.id),
            })) : project.edges);
            setTeachingTasks(project.teachingTasks);
            setJointPoses(project.jointPoses);
            const restoredTeachingTaskId = snapshot?.ui?.activeTeachingTaskId === null
              ? project.teachingTasks.find((task) => !task.mobileCapture)?.id || null
              : teachingTaskIds.has(snapshot?.ui?.activeTeachingTaskId)
                ? snapshot.ui.activeTeachingTaskId
                : project.teachingTasks[0]?.id || null;
            const restoredTeachingTask = project.teachingTasks.find(
              (task) => task.id === restoredTeachingTaskId,
            );
            const restoredParkingPointIds = new Set(
              (restoredTeachingTask?.parkingPoints || []).map((parkingPoint) => parkingPoint.id),
            );
            setActiveTeachingTaskId(restoredTeachingTaskId);
            setActiveTeachingParkingPointId(
              restoredParkingPointIds.has(snapshot?.ui?.activeTeachingParkingPointId)
                ? snapshot.ui.activeTeachingParkingPointId
                : restoredTeachingTask?.parkingPoints?.[0]?.id || null,
            );
            if (!stored.map && project.slice) {
              setHeightRange(
                project.map?.bounds
                  ? clampSlice(project.slice, project.map.bounds)
                  : project.slice,
              );
            }
            setRestoredView2d(preferredView2d);
            view2dRef.current = preferredView2d;
            setRestoredView3d(preferredView3d);
            view3dRef.current = preferredView3d;
            setMode(['select', 'box', 'add', 'connect'].includes(snapshot?.ui?.mode) ? snapshot.ui.mode : 'select');
            setConnectionSourceId(
              pointIds.has(snapshot?.ui?.connectionSourceId)
                ? snapshot.ui.connectionSourceId
                : null,
            );
            setSelectedWaypointId(
              pointIds.has(snapshot?.ui?.selectedWaypointId)
                ? snapshot.ui.selectedWaypointId
                : null,
            );
            setRobotWaypointLocation(snapshot?.ui?.robotWaypointLocation || null);
            setSelectedEdgeId(
              edgeIds.has(snapshot?.ui?.selectedEdgeId) ? snapshot.ui.selectedEdgeId : null,
            );
            setPointColorMode(
              pointColorModes.has(snapshot?.ui?.pointColorMode)
                ? snapshot.ui.pointColorMode
                : 'height',
            );
            setValidation(
              restoredConnectivity
                ? { ...restoredConnectivity.validation, checkedAt: savedValidation?.checkedAt || null }
                : initialValidation,
            );
            restored = restored
              || project.waypoints.length > 0
              || project.edges.length > 0
              || project.teachingTasks.length > 0
              || project.jointPoses.length > 0
              || Boolean(restoredRobot);
          }
        } catch (error) {
          console.warn('已忽略损坏的工作区快照', error);
          releasePortableRobotPackage(portableRobotPackageRef.current?.resourceId);
          portableRobotPackageRef.current = null;
          await resetWorkspaceSession(identity.sessionId);
          if (!isCurrent()) return;
          setMapData(null);
          setWorkspaceTransfer(null);
          setIndependentTeachingName('');
          setMapRouteSyncEnabled(false);
          setSyncedMapOrigin(null);
          setDirectoryAutosaveSuspended(false);
          restoredDirectorySuspended = false;
          setTeachingSpaceMode('map');
          restoredTeachingSpaceMode = 'map';
          setCachedWorkspaces({ map: null, independent: null });
          setWaypoints([]);
          setAbxRoutes([]);
          setEdges([]);
          setHeightRange([0, 1]);
          setShowSlice3D(true);
          setPointColorMode('height');
          setPlacedObjectColorMode('height');
          setMeshRenderQuality('auto');
          setShowPaths3D(true);
          setShowParkingPoints3D(true);
          setShowWaypoints3D(true);
          setShowWaypointNames3D(true);
          setShowPathNames3D(false);
          setShowHeightLegend3D(true);
          setCollapsedPanel(null);
          setInspectorCollapsed(false);
          defaultRobotJointLocksPendingRef.current = false;
          setSelectedRobot(null);
          setRobotPose(normalizeRobotPose(null));
          setRobotJointValues({});
          setLockedRobotJointNames([]);
          setIgnoredRobotCollisionJointNames([]);
          setRobotArmSoftLimitRatio(ARM_SOFT_LIMIT_RATIO);
          setRobotArmSoftLimitOverrides({});
          setRobotArmJointCouplingEnabled(true);
          setRobotControlEnabled(false);
          setRobotHeightLocked(false);
          setTeachingTasks([]);
          setActiveTeachingTaskId(null);
          setActiveTeachingParkingPointId(null);
          setJointPoses(withSharedRobotPresets([], sharedRobotPresetsRef.current?.poses || []));
          setRobotLoadState({ status: 'idle' });
          setRestoredView2d(null);
          view2dRef.current = null;
          setRestoredView3d(null);
          view3dRef.current = null;
          repaired = true;
        }

        if (stored.activatedRecoveryId && restored && !repaired) {
          try {
            const finalized = await finalizeWorkspaceRecovery(stored.activatedRecoveryId);
            if (!isCurrent()) return;
            if (finalized) setLastProjectRecovery(null);
          } catch (error) {
            console.warn('上一次工程已恢复，但临时恢复副本未能清理', error);
          }
        }

        try {
          const savedDirectory = await loadProjectDirectoryBinding(restoredTeachingSpaceMode);
          if (!restoredDirectorySuspended && savedDirectory?.sessionId === identity.sessionId && savedDirectory.handle) {
            const {
              queryProjectDirectoryPermission,
              readProjectDirectoryMetadata,
            } = await import('./lib/projectArchive.js');
            const permission = await queryProjectDirectoryPermission(savedDirectory.handle, false);
            if (permission === 'granted') {
              const metadata = await readProjectDirectoryMetadata(savedDirectory.handle);
              assertProjectMode(
                normalizeProject(metadata.rawPayload).workspace.teachingSpaceMode,
                restoredTeachingSpaceMode,
              );
              projectDirectoryRef.current = {
                handle: savedDirectory.handle,
                name: savedDirectory.name || metadata.name,
                projectFile: metadata.projectPath,
                manifest: metadata.manifest,
                rawPayload: metadata.rawPayload,
                savedAt: metadata.manifest.updatedAt || savedDirectory.savedAt || null,
                teachingSpaceMode: restoredTeachingSpaceMode,
              };
              setProjectDirectoryState({
                status: 'synced',
                name: savedDirectory.name || metadata.name,
                savedAt: metadata.manifest.updatedAt || savedDirectory.savedAt || null,
                writable: true,
              });
            } else {
              setProjectDirectoryState({
                status: 'permission',
                name: savedDirectory.name || savedDirectory.handle.name || '工程目录',
                savedAt: savedDirectory.savedAt || null,
                writable: false,
              });
            }
          } else if (savedDirectory) {
            // Keep the remembered folder across service sessions. It remains detached
            // until the user explicitly loads it from the project loader.
            projectDirectoryRef.current = null;
          }
        } catch (error) {
          console.warn('工程目录关联恢复失败', error);
          projectDirectoryRef.current = null;
          setProjectDirectoryState({
            status: 'detached',
            name: '',
            savedAt: null,
            writable: false,
          });
        }

        sessionReadyRef.current = true;
        sessionFailureNotifiedRef.current = false;
        setSessionState({ status: 'ready', restored });
        setLoadState({ loading: false, progress: 1, phase: '' });
        if (projectImportProgressRef.current?.resuming) finishProjectImport();

        if (stored.activatedRecoveryId && restored && !repaired) {
          notify('上一次未完成工程已完整恢复', 'success');
        } else if (stored.restarted && stored.recovery) {
          notify('检测到服务重启，未完成工程已保护，可前往“示教数据”页面恢复', 'info');
        } else if (stored.restarted) {
          notify('服务已重启，已建立全新工作会话', 'info');
        } else if (repaired) {
          notify('上次快照无法读取，已安全重置', 'warning');
        } else if (restored) {
          notify('已恢复上次工作现场', 'success');
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (projectImportProgressRef.current?.resuming) {
          const { sourceName, mode } = projectImportProgressRef.current;
          cancelProjectImport();
          setProjectImportError({ sourceName, mode, message: error?.message || '无法恢复工程现场' });
        }
        setLoadState({ loading: false, progress: 0, phase: '' });
        reportSessionFailure(error);
      }
    };

    restoreWorkspace();
    return () => {
      if (hydrationRevisionRef.current === revision) hydrationRevisionRef.current += 1;
    };
  }, [notify, processMapBuffer, processMapCache, reportSessionFailure,
    advanceProjectImport, cancelProjectImport, finishProjectImport, projectImportProgressRef]);

  useEffect(() => {
    if (teachingSpaceMode !== 'map' || !mapData?.positions || sessionState.status !== 'ready'
      || workspaceTransfer?.kind !== 'placement' || placedObjectLayers(mapData, workspaceTransfer)?.complete) return;
    const key = `${mapData.mapId}:${workspaceTransfer.id}`;
    if (layerRecoveryAttemptRef.current === key) return;
    layerRecoveryAttemptRef.current = key;
    let cancelled = false;
    let finished = false;
    recoverPlacedObjectLayers(mapData, workspaceTransfer,
      (identity) => loadIndependentDisplaySource(sessionIdRef.current, identity), () => !cancelled)
      .then((layers) => {
        finished = true;
        if (!cancelled && layers) setWorkspaceTransfer((current) => current === workspaceTransfer
          ? { ...current, geometryLayers: layers } : current);
      }).catch((error) => { finished = true; console.warn('旧工程独立对象显示分组未能恢复', error); });
    return () => {
      cancelled = true;
      if (!finished && layerRecoveryAttemptRef.current === key) layerRecoveryAttemptRef.current = null;
    };
  }, [mapData, teachingSpaceMode, workspaceTransfer, sessionState.status]);

  useEffect(() => {
    queueWorkspaceSave();
  }, [
    workspaceTransfer,
    independentTeachingName,
    mapRouteSyncEnabled,
    directoryAutosaveSuspended,
    collapsedPanel,
    connectionSourceId,
    edges,
    heightRange,
    showSlice3D,
    inspectorCollapsed,
    mapData?.mapId,
    meshRenderQuality,
    mode,
    pointColorMode,
    placedObjectColorMode,
    queueWorkspaceSave,
    selectedEdgeId,
    selectedWaypointId,
    robotWaypointLocation,
    selectedRobot,
    robotPose,
    robotJointValues,
    lockedRobotJointNames,
    ignoredRobotCollisionJointNames,
    robotArmSoftLimitRatio,
    robotArmSoftLimitOverrides,
    robotArmJointCouplingEnabled,
    robotHeightLocked,
    teachingTasks,
    teachingSpaceMode,
    abxRoutes,
    activeTeachingTaskId,
    activeTeachingParkingPointId,
    jointPoses,
    sessionState.status,
    showPaths3D,
    showParkingPoints3D,
    showWaypoints3D,
    showWaypointNames3D,
    showPathNames3D,
    showHeightLegend3D,
    validation,
    waypoints,
  ]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') persistWorkspaceNow();
    };
    window.addEventListener('pagehide', persistWorkspaceNow);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('pagehide', persistWorkspaceNow);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    };
  }, [persistWorkspaceNow]);

  const detachProjectDirectory = useCallback((message = '') => {
    if (!projectDirectoryRef.current && projectDirectoryState.status === 'detached') return;
    projectDirectoryRef.current = null;
    projectDirectoryFailureNotifiedRef.current = false;
    setProjectDirectoryState({
      status: 'detached',
      name: '',
      savedAt: null,
      writable: false,
    });
    clearProjectDirectoryBinding(teachingSpaceMode).catch(() => undefined);
    if (message) notify(message, 'info');
  }, [notify, projectDirectoryState.status, teachingSpaceMode]);

  const loadExample = useCallback(
    async (options = {}) => {
      const targetMode = normalizeTeachingSpaceMode(options.teachingSpaceMode);
      const replacesActiveWorkspace = targetMode === teachingSpaceMode && Boolean(
        mapData
        || selectedRobot
        || waypoints.length
        || edges.length
        || teachingTasks.length
        || jointPoses.length,
      );
      const replacesCachedWorkspace = targetMode !== teachingSpaceMode
        && Boolean(cachedWorkspaces[targetMode]?.available);
      if (
        !options.preserveGraph
        && (replacesActiveWorkspace || replacesCachedWorkspace)
        && !window.confirm('加载示例地图会替换地图示教缓存，独立示教缓存不会受影响。继续吗？')
      ) return;
      const previousMode = teachingSpaceMode;
      const previousDirectoryBinding = projectDirectoryRef.current;
      const previousDirectoryState = projectDirectoryState;
      setLoadState({ loading: true, progress: 0, phase: '读取示例地图' });
      try {
        if (!options.preserveGraph) {
          if (sessionSaveTimerRef.current) {
            window.clearTimeout(sessionSaveTimerRef.current);
            sessionSaveTimerRef.current = null;
          }
          await persistWorkspaceNow();
        }
        let responseMetadata = null;
        const buffer = await fetchBufferWithProgress(
          '/xian_map.ply',
          (progress) => setLoadState({ loading: true, progress, phase: '读取示例地图' }),
          (metadata) => { responseMetadata = metadata; },
        );
        if (!options.preserveGraph) {
          if (targetMode === previousMode) {
            if (projectDirectoryRef.current) {
              detachProjectDirectory('地图已更换；原地图示教工程目录已解除关联');
            }
          } else {
            projectDirectoryRef.current = null;
            projectDirectoryFailureNotifiedRef.current = false;
            setProjectDirectoryState({
              status: 'detached',
              name: '',
              savedAt: null,
              writable: false,
            });
            await clearProjectDirectoryBinding(targetMode).catch(() => undefined);
          }
        }
        await processMapBuffer(buffer, 'xian_map.ply', {
          ...options,
          teachingSpaceMode: targetMode,
          sourceModifiedAt: options.sourceModifiedAt ?? responseMetadata?.modifiedAt,
          sourceMimeType: options.sourceMimeType ?? responseMetadata?.mimeType,
          sourceKind: options.sourceKind || 'example-map',
        });
      } catch (error) {
        if (!options.preserveGraph && targetMode !== previousMode) {
          projectDirectoryRef.current = previousDirectoryBinding;
          setProjectDirectoryState(previousDirectoryState);
        }
        setLoadState({ loading: false, progress: 0, phase: '' });
        notify(error.message || '示例地图加载失败', 'error');
      }
    },
    [
      cachedWorkspaces,
      detachProjectDirectory,
      edges.length,
      jointPoses.length,
      mapData,
      notify,
      persistWorkspaceNow,
      processMapBuffer,
      projectDirectoryState,
      selectedRobot,
      teachingSpaceMode,
      teachingTasks.length,
      waypoints.length,
    ],
  );

  const handlePointCloudFile = async (event, requestedMode = 'map') => {
    const sourcePage = appPage;
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const nextTeachingSpaceMode = normalizeTeachingSpaceMode(requestedMode);
    const independent = nextTeachingSpaceMode === 'independent';
    if (!file.name.toLowerCase().endsWith('.ply')) {
      notify('请选择 .ply 点云文件', 'error');
      return;
    }
    const previousMode = teachingSpaceMode;
    const previousDirectoryBinding = projectDirectoryRef.current;
    const previousDirectoryState = projectDirectoryState;
    navigateAppPage(APP_PAGE_WORKBENCH);
    const loadingPhase = independent ? '创建独立示教空间' : '读取本地地图';
    setLoadState({
      loading: true,
      progress: 0,
      phase: loadingPhase,
      detail: independent ? `${file.name} · 原点将设为点云 (0, 0, 0)` : file.name,
    });
    try {
      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      await persistWorkspaceNow();
      const buffer = await readFileWithProgress(file, (progress) =>
        setLoadState({
          loading: true,
          progress,
          phase: loadingPhase,
          detail: independent ? '正在载入点云并建立 virtual_origin 坐标系' : file.name,
        }),
      );
      if (nextTeachingSpaceMode === previousMode) {
        if (projectDirectoryRef.current) {
          detachProjectDirectory(
            independent
              ? '独立示教空间已更换；原独立示教工程目录已解除关联'
              : '地图已更换；原地图示教工程目录已解除关联',
          );
        }
      } else {
        projectDirectoryRef.current = null;
        projectDirectoryFailureNotifiedRef.current = false;
        setProjectDirectoryState({
          status: 'detached',
          name: '',
          savedAt: null,
          writable: false,
        });
        await clearProjectDirectoryBinding(nextTeachingSpaceMode).catch(() => undefined);
      }
      await processMapBuffer(buffer, file.name, {
        teachingSpaceMode: nextTeachingSpaceMode,
        announce: !independent,
        sourceModifiedAt: file.lastModified || null,
        sourceMimeType: file.type || 'application/octet-stream',
        sourceKind: independent ? 'independent-teaching-file' : 'local-file',
      });
      if (independent) {
        notify(`${file.name} 已建立独立示教空间 · 原点 VIRTUAL_ORIGIN (0, 0, 0)`, 'success');
      }
    } catch (error) {
      if (nextTeachingSpaceMode !== previousMode && teachingSpaceMode === previousMode) {
        projectDirectoryRef.current = previousDirectoryBinding;
        setProjectDirectoryState(previousDirectoryState);
      }
      setLoadState({ loading: false, progress: 0, phase: '' });
      notify(error.message || (independent ? '独立示教空间创建失败' : '地图加载失败'), 'error');
      if (sourcePage === APP_PAGE_HOME) navigateAppPage(APP_PAGE_HOME, { replace: true });
    }
  };

  const handleMapFile = (event) => handlePointCloudFile(event, 'map');
  const handleIndependentCloudFile = (event) => handlePointCloudFile(event, 'independent');

  const prepareIndependentHistory = async () => {
    const snapshot = await loadWorkspaceSnapshot(sessionIdRef.current, 'independent');
    const current = latestWorkspaceRef.current;
    const robot = snapshot.config?.config?.project?.robot;
    const { collectProjectRobotResources } = await import('./lib/projectArchive.js');
    const currentRobotPackage = await collectProjectRobotResources(
      current.teachingSpaceMode === 'independent' ? current.selectedRobot : normalizeRobotDescriptor(robot),
      ({ phase, detail }) => setLoadState({ loading: true, progress: 0.8, phase, detail }),
      current.teachingSpaceMode === 'independent'
        ? portableRobotPackageRef.current : snapshot.map?.portableRobotPackage,
    );
    return { expectedConfig: snapshot.config, currentRobotPackage };
  };

  const openNewIndependentDialog = async ({ fromPicker = false } = {}) => {
    if (independentSwitchBlocked || independentSwitchBusyRef.current || workspaceSwitchingRef.current
      || newIndependentDialog || !mapData?.geometry
      || (fromPicker && (!independentWorkspaceDialog || independentWorkspaceDialog.busy))) return;
    const revision = ++newIndependentDialogRevisionRef.current;
    setRobotControlEnabled(false);
    if (fromPicker) setIndependentWorkspaceDialog(null);
    setNewIndependentDialog({ sourceMode: teachingSpaceMode, mapLoading: true, mapSnapshot: null,
      returnToPicker: fromPicker ? independentWorkspaceDialog : null, busy: false, error: '' });
    try {
      if (teachingSpaceMode === 'map') {
        await persistWorkspaceNow();
        if (!sessionReadyRef.current) throw new Error('当前地图示教尚未保存成功，请重试');
      }
      const target = await loadWorkspaceSnapshot(sessionIdRef.current, 'map');
      if (revision !== newIndependentDialogRevisionRef.current) return;
      setNewIndependentDialog((current) => current ? { ...current, mapLoading: false,
        mapSnapshot: hasLoadedMapWorkspace(target) ? target : null } : null);
    } catch (error) {
      if (revision !== newIndependentDialogRevisionRef.current) return;
      setNewIndependentDialog((current) => current ? { ...current, mapLoading: false,
        mapError: `暂时无法读取地图示教：${error.message}` } : null);
    }
  };

  const closeNewIndependentDialog = () => {
    if (independentSwitchBusyRef.current) return;
    newIndependentDialogRevisionRef.current += 1;
    if (newIndependentDialog?.returnToPicker) {
      setIndependentWorkspaceDialog({ ...newIndependentDialog.returnToPicker, error: '' });
    }
    setNewIndependentDialog(null);
  };

  const loadNewIndependentRoute = async (file) => {
    if (!file || !newIndependentDialog?.mapSnapshot || independentSwitchBlocked
      || independentSwitchBusyRef.current || workspaceSwitchingRef.current || abxImportBusyRef.current) return;
    const target = newIndependentDialog.mapSnapshot;
    independentSwitchBusyRef.current = true;
    abxImportBusyRef.current = true;
    setAbxImportBusy(true);
    setNewIndependentDialog((current) => ({ ...current, routeLoading: true, routeError: '', routeNotice: '', error: '' }));
    let savingWorkspace = false;
    try {
      if (!/\.json$/i.test(file.name)) throw new Error('请选择机器人路网 JSON 文件');
      if (file.size > 48 * 1024) throw new Error('路网文件不能超过 48 KiB');
      const imported = abxRouteToProject(readAbxRoute(await file.text()));
      if (!imported.waypoints.length) throw new Error('路网中没有导航点，请选择包含导航点的路网文件');
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      const saved = persistWorkspaceNow();
      workspaceSwitchingRef.current = true;
      savingWorkspace = true;
      await saved;
      if (!sessionReadyRef.current) throw new Error('当前示教结果尚未保存成功，请重试');
      const current = latestWorkspaceRef.current;
      const expectedConfig = await loadWorkspaceConfig(sessionIdRef.current, 'map');
      if (!expectedConfig || expectedConfig.mapId !== target.map.mapId) {
        throw new Error('地图示教已变化，请重新打开新增独立示教窗口后加载路网');
      }
      const project = expectedConfig.config.project;
      const normalized = normalizeProject(project);
      const merged = mergeAbxImport(normalized, imported);
      const graph = buildExport({ teachingSpaceMode: 'map', heightRange: normalized.slice || [0, 0],
        waypoints: merged.waypoints, edges: merged.edges, abxRoutes: merged.abxRoutes });
      const config = { ...expectedConfig.config,
        project: { ...project, abxRoutes: graph.abxRoutes, waypoints: graph.waypoints, paths: graph.paths },
        ui: { ...expectedConfig.config.ui, validation: initialValidation } };
      const { record, summary } = await commitMapWorkspaceConfig(sessionIdRef.current, {
        expectedConfig, config, activeMode: current.teachingSpaceMode,
      });
      if (current.teachingSpaceMode === 'map') {
        latestWorkspaceRef.current = { ...current, abxRoutes: merged.abxRoutes,
          waypoints: merged.waypoints, edges: merged.edges, validation: initialValidation };
        setAbxRoutes(merged.abxRoutes); setWaypoints(merged.waypoints); setEdges(merged.edges);
        setValidation(initialValidation);
      }
      setCachedWorkspaces((current) => ({ ...current, map: summary }));
      setNewIndependentDialog((current) => current ? { ...current, mapSnapshot: { ...target, config: record },
        routeNotice: `路网已加载到地图 · ${imported.waypoints.length} 个导航点 / ${imported.edges.length} 条路径` } : null);
    } catch (error) {
      setNewIndependentDialog((current) => current ? { ...current, routeError: error.message || '路网加载失败，请重试' } : null);
    } finally {
      if (savingWorkspace) workspaceSwitchingRef.current = false;
      independentSwitchBusyRef.current = false;
      abxImportBusyRef.current = false;
      setAbxImportBusy(false);
      setNewIndependentDialog((current) => current ? { ...current, routeLoading: false } : null);
    }
  };

  const createIndependentTeaching = async ({ file, matrix = null, name = defaultIndependentTeachingName(file?.name),
    syncRoute = false, placeInMap = false }) => {
    if (!file || independentSwitchBusyRef.current || workspaceSwitchingRef.current || independentSwitchBlocked
      || !newIndependentDialog || newIndependentDialog.sourceMode !== teachingSpaceMode) return;
    if (!file.name.toLowerCase().endsWith('.ply')) {
      notify('请选择 PLY 点云或模型文件', 'warning');
      return;
    }
    independentSwitchBusyRef.current = true;
    setNewIndependentDialog((current) => ({ ...current, busy: true, error: '' }));
    setLoadState({ loading: true, progress: 0, phase: '新增独立示教', detail: '保存当前工作现场' });
    let geometry;
    try {
      const teachingName = validateIndependentTeachingName(name);
      if ((syncRoute || placeInMap) && !matrix) throw new Error('请先加载转换矩阵，再同步路网或放置进入地图');
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      const saved = persistWorkspaceNow();
      workspaceSwitchingRef.current = true;
      await saved;
      if (!sessionReadyRef.current) throw new Error('当前示教结果尚未保存成功，请重试');
      let targetMap = newIndependentDialog.mapSnapshot;
      if (teachingSpaceMode === 'map' && matrix) {
        // The active map was just saved; use that revision for the atomic commit.
        targetMap = await loadWorkspaceSnapshot(sessionIdRef.current, 'map');
        if (!hasLoadedMapWorkspace(targetMap) || targetMap.map.mapId !== newIndependentDialog.mapSnapshot?.map?.mapId) {
          throw new Error('地图示教已变化，请重新打开新增独立示教窗口后加载转换矩阵');
        }
      }
      const transfer = matrix ? await createTeachingAlignment(targetMap, {
        localToMap: matrix.localToMap, matrixImports: [{ name: matrix.name, values: matrix.values }],
      }) : null;
      const current = latestWorkspaceRef.current;
      const buffer = await readFileWithProgress(file, (progress) => {
        setLoadState({ loading: true, progress: progress * 0.65, phase: '读取新独立模型', detail: file.name });
      });
      setLoadState({ loading: true, progress: 0.7, phase: '校验新独立模型', detail: file.name });
      await waitForPaint();
      geometry = new PLYLoader().parse(buffer);
      const positions = geometry.getAttribute('position')?.array;
      if (!positions?.length || positions.length % 3 || !positions.every(Number.isFinite)) {
        throw new Error('PLY 文件中没有有效的顶点坐标，当前工程已保留');
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      prepareMapGeometryTopology(geometry);
      const archived = await prepareIndependentHistory();
      let robotPackage = archived.currentRobotPackage;
      if (current.teachingSpaceMode === 'map') {
        const { collectProjectRobotResources } = await import('./lib/projectArchive.js');
        robotPackage = await collectProjectRobotResources(current.selectedRobot,
          ({ phase, detail }) => setLoadState({ loading: true, progress: 0.8, phase, detail }),
          portableRobotPackageRef.current);
      }
      const bounds = serializeBounds(geometry.boundingBox);
      const map = {
        ...createGeometryCache(geometry, bounds, buffer.byteLength, await sha256ArrayBuffer(buffer), 'file', {
          sourceBlob: new Blob([buffer], { type: file.type || 'application/octet-stream' }),
          fileModifiedAt: file.lastModified, mimeType: file.type,
          loadedAt: Date.now(), sourceKind: 'independent-teaching-file', teachingSpaceMode: 'independent',
          teachingGroupId: createId('teaching-group'),
        }),
        mapId: createId('map'), name: file.name,
        portableRobotPackage: robotPackage,
      };
      if (syncRoute) {
        const status = mapRouteSyncStatus(map, transfer, targetMap?.config);
        if (!status.available) throw new Error(status.reason);
      }
      const project = buildExport({
        mapData: map, teachingSpaceMode: 'independent',
        independentTeachingName: teachingName,
        heightRange: clampSlice(suggestedSlice(positions, bounds), bounds),
        waypoints: [], edges: [],
        robot: current.selectedRobot, robotPose: normalizeRobotPose(null), robotJointValues: {},
        robotArmSoftLimitRatio: current.robotArmSoftLimitRatio,
        robotArmSoftLimitOverrides: current.robotArmSoftLimitOverrides,
        robotArmJointCouplingEnabled: current.robotArmJointCouplingEnabled,
        meshRenderQuality: current.meshRenderQuality, pointColorMode: current.pointColorMode,
        placedObjectColorMode: current.placedObjectColorMode,
        showPaths3D: current.showPaths3D,
        showParkingPoints3D: current.showParkingPoints3D,
        showWaypoints3D: syncRoute || current.showWaypoints3D, showWaypointNames3D: current.showWaypointNames3D,
        showPathNames3D: current.showPathNames3D,
        showHeightLegend3D: current.showHeightLegend3D,
        collapsedPanel: current.collapsedPanel, inspectorCollapsed: current.inspectorCollapsed,
        directoryAutosaveSuspended: true, transfer,
      });
      const replacement = { map, config: { schemaVersion: 1, project, ui: {
        ...project.workspace, mode: 'select', mapRouteSyncEnabled: syncRoute, selectedRobot: project.robot,
        meshRenderQuality: project.rendering.meshQuality, showSlice3D: current.showSlice3D,
      } } };
      let mapPlacement = null;
      if (placeInMap) {
        setLoadState({ loading: true, progress: 0.85, phase: '放置独立模型到地图', detail: '按转换矩阵合并模型，保留地图已有示教结果' });
        mapPlacement = await placeTeachingWorkspace({ mode: 'independent', map,
          config: { mapId: map.mapId, config: replacement.config } }, targetMap,
        { localToMap: transfer.localToMap, matrixImports: transfer.matrixImports });
      }
      setLoadState({ loading: true, progress: 0.9,
        phase: isIndependentTeachingSpace ? '缓存上一组独立示教' : '创建独立示教工作区',
        detail: '完整保存模型、机器人、示教结果与视角' });
      await switchIndependentWorkspace(sessionIdRef.current, {
        activeMode: current.teachingSpaceMode, ...archived,
        expectedMapConfig: matrix ? targetMap.config : null,
        replacement, mapPlacement,
      });
      window.location.assign('/workbench');
    } catch (error) {
      workspaceSwitchingRef.current = false;
      independentSwitchBusyRef.current = false;
      setLoadState({ loading: false, progress: 0, phase: '' });
      setNewIndependentDialog((current) => current ? { ...current, busy: false,
        error: error?.message || '新增独立示教失败，当前工程已保留' } : null);
    } finally {
      geometry?.dispose();
    }
  };

  const applyImportedProject = async (importProject, sourceName, requestedMode = teachingSpaceMode, options = {}) => {
    const sourcePage = appPage;
    setProjectImportError(null);
    if (workSync.link && !options.fromWorkSync) await workSync.disconnect('正在加载其他工程，同步已断开');
    navigateAppPage(APP_PAGE_WORKBENCH);
    if (sessionSaveTimerRef.current) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    await persistWorkspaceNow();
    const previousDirectoryBinding = projectDirectoryRef.current;
    projectDirectoryRef.current = null;
    // Keep intermediate imports out of both mode caches until the project is ready.
    workspaceSwitchingRef.current = true;
    const previousPortableResourceId = portableRobotPackageRef.current?.resourceId || null;
    let nextPortableResourceId = null;
    let portableResourceCommitted = false;
    let reloadingLinkedProject = false;
    beginProjectImport(sourceName);
    setLoadState({
      loading: true,
      progress: 0.04,
      phase: '读取工程',
      detail: sourceName,
    });
    try {
      const importedFile = await importProject(({ phase, detail, progress }) => {
        advanceProjectImport(0.04 + (Number(progress) || 0) * 0.7, phase);
        setLoadState({
          loading: true,
          progress: 0.08 + (Number(progress) || 0) * 0.42,
          phase,
          detail,
        });
      });
      advanceProjectImport(0.74, '恢复工程数据');
      if (importedFile.workspaceCollection) {
        if (!sessionReadyRef.current) throw new Error('工作会话尚未就绪，无法恢复完整工程');
        const collection = prepareWorkspaceCollectionImport(importedFile.workspaceCollection);
        const activeMode = collection.workspaces[normalizeTeachingSpaceMode(requestedMode)]
          ? normalizeTeachingSpaceMode(requestedMode) : collection.activeMode;
        setLoadState({ loading: true, progress: 0.85, phase: '恢复完整工程与独立示教列表',
          detail: `正在恢复工作区和 ${collection.independentHistory.length} 组独立示教缓存` });
        advanceProjectImport(0.8, '恢复工作区与示教历史');
        await restoreWorkspaceCollection(sessionIdRef.current, collection, activeMode);
        const presetSource = collection.workspaces.map || collection.workspaces.independent;
        sharedRobotPresetsRef.current = await importSharedRobotPresets(sessionIdRef.current, presetSource?.config?.config?.project);
        for (const mode of Object.keys(collection.workspaces)) {
          await clearProjectDirectoryBinding(mode).catch(() => undefined);
        }
        reloadingLinkedProject = true;
        sessionReadyRef.current = false;
        checkpointProjectImport(sessionIdRef.current, activeMode);
        window.location.assign('/workbench');
        return;
      }
      if (importedFile.linkedWorkspaces) {
        if (!sessionReadyRef.current) throw new Error('工作会话尚未就绪，无法恢复双边工程');
        const workspaces = prepareLinkedProjectImport(importedFile.linkedWorkspaces);
        setLoadState({ loading: true, progress: 0.85, phase: '恢复双边完整工程',
          detail: '正在一起恢复地图示教、独立示教及绑定关系' });
        advanceProjectImport(0.8, '恢复工作区与示教结果');
        await restoreLinkedWorkspaces(sessionIdRef.current, workspaces, normalizeTeachingSpaceMode(requestedMode));
        sharedRobotPresetsRef.current = await importSharedRobotPresets(sessionIdRef.current, workspaces.map?.config?.config?.project);
        for (const mode of ['map', 'independent']) {
          await clearProjectDirectoryBinding(mode).catch(() => undefined);
        }
        // Reload through the same hydration path used by workspace switching.
        // Keep autosave blocked so the old UI cannot overwrite the committed pair.
        reloadingLinkedProject = true;
        sessionReadyRef.current = false;
        checkpointProjectImport(sessionIdRef.current, normalizeTeachingSpaceMode(requestedMode));
        window.location.assign('/workbench');
        return;
      }
      const payload = importedFile.payload;
      const project = normalizeProject(payload);
      const importedTeachingSpaceMode = normalizeTeachingSpaceMode(
        project.workspace?.teachingSpaceMode,
      );
      assertProjectMode(importedTeachingSpaceMode, requestedMode);
      const importedDirectorySuspended = !importedFile.directory
        && project.workspace?.directoryAutosaveSuspended === true;
      setWorkspaceTransfer(project.workspace?.transfer || null);
      setIndependentTeachingName(project.workspace?.independentTeachingName || '');
      setMapRouteSyncEnabled(false);
      setSyncedMapOrigin(null);
      setDirectoryAutosaveSuspended(importedDirectorySuspended);
      const portableRobotPackage = importedFile.resources?.robot || null;
      if (portableRobotPackage) {
        nextPortableResourceId = registerPortableRobotPackage(portableRobotPackage);
      }
      const importedRobot = normalizeRobotDescriptor(
        nextPortableResourceId
          ? { ...project.robot, portableResourceId: nextPortableResourceId }
          : project.robot,
      );
      const importedMeshQuality = normalizeMeshRenderQuality(project.rendering?.meshQuality);
      const importedRobotPose = importedRobot
        ? normalizeRobotPose(project.robot?.origin)
        : normalizeRobotPose(null);
      const importedRobotJoints = importedRobot
        ? normalizeRobotJointValues(project.robot?.joints)
        : {};
      const importedLockedJoints = importedRobot
        ? normalizeRobotJointLocks(project.robot?.lockedJoints)
        : [];
      const importedIgnoredCollisionJoints = importedRobot
        ? normalizeIgnoredCollisionJoints(project.robot?.collisionIgnoredJoints) : [];
      const importedArmSoftLimitRatio = normalizeArmSoftLimitRatio(project.robot?.armSoftLimitRatio);
      const importedArmSoftLimitOverrides = normalizeArmSoftLimitOverrides(project.robot?.armSoftLimitOverrides);
      const importedArmJointCouplingEnabled = normalizeArmJointCouplingEnabled(project.robot?.armJointCouplingEnabled);
      const importedRobotHeightLocked = Boolean(
        importedRobot && project.robot?.heightLocked,
      );
      setZividCameraPoses({});
      setCameraTeachingCommand(null);
      setCameraTeachingResult({ status: 'idle', revision: 0 });
      zividCaptureProviderRef.current = null;
      teachingCaptureBusyRef.current = false;
      setTeachingCaptureState({ status: 'idle', message: '' });
      setRobotControlEnabled(false);
      setRobotCollisionProtectionEnabled(true);
      setSynchronizedFocus(null);
      defaultRobotJointLocksPendingRef.current = false;
      setSelectedRobot(importedRobot);
      setRobotPose(importedRobotPose);
      setRobotJointValues(importedRobotJoints);
      setLockedRobotJointNames(importedLockedJoints);
      setIgnoredRobotCollisionJointNames(importedIgnoredCollisionJoints);
      setRobotArmSoftLimitRatio(importedArmSoftLimitRatio);
      setRobotArmSoftLimitOverrides(importedArmSoftLimitOverrides);
      setRobotArmJointCouplingEnabled(importedArmJointCouplingEnabled);
      setRobotHeightLocked(importedRobotHeightLocked);
      setRobotLoadState({ status: importedRobot ? 'pending' : 'idle' });
      let effectiveMap = importedTeachingSpaceMode === teachingSpaceMode ? mapData : null;
      if (importedFile.resources?.map) {
        const portableMapRecord = {
          ...importedFile.resources.map,
          mapId: createId('map-portable'),
          name: importedFile.resources.map.name || project.map?.fileName || sourceName,
          portableRobotPackage,
        };
        setLoadState({
          loading: true,
          progress: 0.56,
          phase: '恢复归档地图',
          detail: `${portableMapRecord.pointCount.toLocaleString('zh-CN')} 点 / ${portableMapRecord.faceCount.toLocaleString('zh-CN')} 面`,
        });
        advanceProjectImport(0.78, '恢复地图与机器人');
        effectiveMap = await processMapCache(portableMapRecord, {
          preserveGraph: true,
          teachingSpaceMode: importedTeachingSpaceMode,
          preferredSlice: project.slice,
          preferredView: project.view2d,
          preferredView3d: project.view3d,
          announce: false,
          keepLoading: true,
        });
        if (sessionReadyRef.current && sessionIdRef.current) {
          advanceProjectImport(0.86, '保存工程结果');
          setLoadState({
            loading: true,
            progress: 0.86,
            phase: '保存便携工程快照',
            detail: '地图与机器人资源将保留到本地工作会话',
          });
          await saveWorkspaceMap(
            sessionIdRef.current,
            portableMapRecord.mapId,
            portableMapRecord.name,
            portableMapRecord,
            importedTeachingSpaceMode,
          );
        }
      }
      if (!importedFile.resources?.map && effectiveMap) {
        effectiveMap = {
          ...effectiveMap,
          teachingSpaceMode: importedTeachingSpaceMode,
          coordinateFrame: teachingCoordinateFrame(importedTeachingSpaceMode),
          virtualOrigin: { x: 0, y: 0, z: 0 },
        };
        setMapData(effectiveMap);
      }
      setTeachingSpaceMode(importedTeachingSpaceMode);
      const importedTaskIds = new Set(project.teachingTasks.map((task) => task.id));
      const importedTaskId = importedTaskIds.has(project.workspace?.activeTeachingTaskId)
        ? project.workspace.activeTeachingTaskId
        : project.teachingTasks[0]?.id || null;
      const importedTask = project.teachingTasks.find((task) => task.id === importedTaskId) || null;
      const importedParkingPointIds = new Set(
        (importedTask?.parkingPoints || []).map((parkingPoint) => parkingPoint.id),
      );
      const importedParkingPointId = importedParkingPointIds.has(
        project.workspace?.activeTeachingParkingPointId,
      )
        ? project.workspace.activeTeachingParkingPointId
        : importedTask?.parkingPoints?.[0]?.id || null;
      const importedPointColorMode = pointColorModes.has(project.workspace?.pointColorMode)
        ? project.workspace.pointColorMode
        : 'height';
      const importedShowPaths3D = project.workspace?.showPaths3D !== false;
      const importedShowParkingPoints3D = project.workspace?.showParkingPoints3D !== false;
      const importedShowWaypoints3D = project.workspace?.showWaypoints3D !== false;
      const importedShowWaypointNames3D = project.workspace?.showWaypointNames3D !== false;
      const importedShowPathNames3D = project.workspace?.showPathNames3D === true;
      const importedShowHeightLegend3D = project.workspace?.showHeightLegend3D !== false;
      const importedObjectColor = project.workspace?.placedObjectColorMode || importedPointColorMode;
      const importedCollapsedPanel = ['2d', '3d'].includes(project.workspace?.collapsedPanel)
        ? project.workspace.collapsedPanel
        : null;
      const importedInspectorCollapsed = project.workspace?.inspectorCollapsed === true;
      const importedChecked = project.edges.some((edge) => edge.status !== 'unchecked');
      const importedConnectivity = importedChecked ? inspectConnectivity(
        buildTeachingWaypoints(project.waypoints, project.teachingTasks, {
          mapData: effectiveMap || { ...project.map, name: project.map?.fileName },
          coordinateFrame: importedTeachingSpaceMode === 'independent' ? 'virtual_origin' : 'map',
        }), project.edges,
      ) : null;
      const importedValidation = importedConnectivity?.validation || initialValidation;
      const importedBounds = effectiveMap?.bounds || project.map?.bounds;
      const importedSlice = project.slice
        ? importedBounds ? clampSlice(project.slice, importedBounds) : project.slice
        : effectiveMap?.positions && importedBounds
          ? clampSlice(suggestedSlice(effectiveMap.positions, importedBounds), importedBounds)
          : heightRange;
      setWaypoints(project.waypoints);
      setAbxRoutes(project.abxRoutes);
      setEdges(importedConnectivity ? project.edges.map((edge) => ({
        ...edge, status: importedConnectivity.edgeStatus.get(edge.id),
      })) : project.edges);
      setTeachingTasks(project.teachingTasks);
      sharedRobotPresetsRef.current = await importSharedRobotPresets(sessionIdRef.current, project.jointPoses);
      project.jointPoses = withSharedRobotPresets(project.jointPoses, sharedRobotPresetsRef.current.poses);
      setJointPoses(project.jointPoses);
      setActiveTeachingTaskId(importedTaskId);
      setActiveTeachingParkingPointId(importedParkingPointId);
      setSelectedWaypointId(null);
      setSelectedEdgeId(null);
      setConnectionSourceId(null);
      setMode('select');
      setMeshRenderQuality(importedMeshQuality);
      setPointColorMode(importedPointColorMode);
      setPlacedObjectColorMode(importedObjectColor);
      setShowPaths3D(importedShowPaths3D);
      setShowParkingPoints3D(importedShowParkingPoints3D);
      setShowWaypoints3D(importedShowWaypoints3D);
      setShowWaypointNames3D(importedShowWaypointNames3D);
      setShowPathNames3D(importedShowPathNames3D);
      setShowHeightLegend3D(importedShowHeightLegend3D);
      setCollapsedPanel(importedCollapsedPanel);
      setInspectorCollapsed(importedInspectorCollapsed);
      setRestoredView2d(project.view2d);
      view2dRef.current = project.view2d;
      setRestoredView3d(project.view3d);
      view3dRef.current = project.view3d;
      setValidation(importedValidation);

      if (project.slice || importedFile.resources?.map) setHeightRange(importedSlice);
      if (!effectiveMap && project.map?.bounds) {
        effectiveMap = {
          mapId: createId('map-meta'),
          name: project.map.fileName || '未绑定地图',
          pointCount: Number(project.map.pointCount) || 0,
          faceCount: Number(project.map.faceCount) || 0,
          bounds: project.map.bounds,
          positions: null,
          colors: null,
          geometry: null,
          sourceHash: project.map.sourceHash || null,
          sourceHashKind: project.map.sourceHashKind || 'file',
          teachingGroupId: project.map.teachingGroupId,
          byteLength: Math.max(0, Number(project.map.byteLength) || 0),
          fileModifiedAt: normalizeTimestamp(
            project.map.fileModifiedAt || project.map.modifiedAt,
          ),
          mimeType: String(project.map.mimeType || 'application/octet-stream'),
          loadedAt: normalizeTimestamp(project.map.loadedAt),
          sourceKind: String(project.map.sourceKind || 'project-metadata'),
          teachingSpaceMode: importedTeachingSpaceMode,
          coordinateFrame: teachingCoordinateFrame(importedTeachingSpaceMode),
          virtualOrigin: { x: 0, y: 0, z: 0 },
          geometrySource: 'project-metadata',
          metadataOnly: true,
        };
        setMapData(effectiveMap);
      }
      if (!effectiveMap) setMapData(null);
      if (previousPortableResourceId && previousPortableResourceId !== nextPortableResourceId) {
        releasePortableRobotPackage(previousPortableResourceId);
      }
      portableRobotPackageRef.current = portableRobotPackage
        ? { ...portableRobotPackage, resourceId: nextPortableResourceId }
        : null;
      portableResourceCommitted = true;
      if (sessionReadyRef.current && sessionIdRef.current && effectiveMap) {
        const importedSnapshot = {
          schemaVersion: 1,
          project: buildExport({
            transfer: project.workspace?.transfer || null,
            independentTeachingName: project.workspace?.independentTeachingName || '',
            directoryAutosaveSuspended: importedDirectorySuspended,
            mapData: effectiveMap,
            teachingSpaceMode: importedTeachingSpaceMode,
            heightRange: importedSlice,
            waypoints: project.waypoints,
            edges: project.edges,
            abxRoutes: project.abxRoutes,
            view2d: project.view2d,
            view3d: project.view3d,
            robot: importedRobot,
            robotPose: importedRobotPose,
            robotJointValues: importedRobotJoints,
            lockedRobotJointNames: importedLockedJoints,
            ignoredRobotCollisionJointNames: importedIgnoredCollisionJoints,
            robotArmSoftLimitRatio: importedArmSoftLimitRatio,
            robotArmSoftLimitOverrides: importedArmSoftLimitOverrides,
            robotArmJointCouplingEnabled: importedArmJointCouplingEnabled,
            robotHeightLocked: importedRobotHeightLocked,
            teachingTasks: project.teachingTasks,
            jointPoses: project.jointPoses,
            meshRenderQuality: importedMeshQuality,
            pointColorMode: importedPointColorMode,
            placedObjectColorMode: importedObjectColor,
            showPaths3D: importedShowPaths3D,
            showParkingPoints3D: importedShowParkingPoints3D,
            showWaypoints3D: importedShowWaypoints3D,
            showWaypointNames3D: importedShowWaypointNames3D,
            showPathNames3D: importedShowPathNames3D,
            showHeightLegend3D: importedShowHeightLegend3D,
            activeTeachingTaskId: importedTaskId,
            activeTeachingParkingPointId: importedParkingPointId,
            collapsedPanel: importedCollapsedPanel,
            inspectorCollapsed: importedInspectorCollapsed,
          }),
          ui: {
            teachingSpaceMode: importedTeachingSpaceMode,
            mode: 'select',
            connectionSourceId: null,
            selectedWaypointId: null,
            selectedEdgeId: null,
            activeTeachingTaskId: importedTaskId,
            activeTeachingParkingPointId: importedParkingPointId,
            validation: importedValidation,
            pointColorMode: importedPointColorMode,
            placedObjectColorMode: importedObjectColor,
            meshRenderQuality: importedMeshQuality,
            showPaths3D: importedShowPaths3D,
            showParkingPoints3D: importedShowParkingPoints3D,
            showWaypoints3D: importedShowWaypoints3D,
            showWaypointNames3D: importedShowWaypointNames3D,
            showPathNames3D: importedShowPathNames3D,
            showHeightLegend3D: importedShowHeightLegend3D,
            collapsedPanel: importedCollapsedPanel,
            inspectorCollapsed: importedInspectorCollapsed,
            robotHeightLocked: importedRobotHeightLocked,
            selectedRobot: importedRobot
              ? {
                  ...importedRobot,
                  origin: importedRobotPose,
                  joints: importedRobotJoints,
                  lockedJoints: importedLockedJoints,
                  collisionIgnoredJoints: importedIgnoredCollisionJoints,
                  armSoftLimitRatio: importedArmSoftLimitRatio,
                  armSoftLimitOverrides: importedArmSoftLimitOverrides,
                  armJointCouplingEnabled: importedArmJointCouplingEnabled,
                  heightLocked: importedRobotHeightLocked,
                }
              : null,
          },
        };
        sessionWriteChainRef.current = sessionWriteChainRef.current
          .catch(() => undefined)
          .then(() => saveWorkspaceConfig(
            sessionIdRef.current,
            effectiveMap.mapId,
            importedSnapshot,
            importedTeachingSpaceMode,
          ));
        await sessionWriteChainRef.current;
      }
      if (importedFile.directory?.handle && importedFile.directory.writable) {
        const directoryBinding = {
          ...importedFile.directory,
          manifest: importedFile.manifest,
          rawPayload: importedFile.rawPayload,
          savedAt: importedFile.manifest?.updatedAt || importedFile.manifest?.exportedAt || null,
          teachingSpaceMode: importedTeachingSpaceMode,
        };
        projectDirectoryRef.current = directoryBinding;
        projectDirectoryFailureNotifiedRef.current = false;
        setProjectDirectoryState({
          status: 'synced',
          name: directoryBinding.name,
          savedAt: directoryBinding.savedAt,
          writable: true,
        });
        try {
          await saveProjectDirectoryBinding({
            handle: directoryBinding.handle,
            name: directoryBinding.name,
            projectFile: directoryBinding.projectFile,
            sessionId: sessionIdRef.current,
            teachingSpaceMode: importedTeachingSpaceMode,
          });
        } catch (error) {
          console.warn('工程目录可用，但刷新后可能需要重新授权', error);
          notify('工程已打开并会增量保存；当前浏览器无法记住目录授权', 'warning');
        }
      } else {
        projectDirectoryRef.current = null;
        await clearProjectDirectoryBinding(importedTeachingSpaceMode).catch(() => undefined);
        setProjectDirectoryState({
          status: importedFile.directory ? 'readonly' : 'detached',
          name: importedFile.directory?.name || '',
          savedAt: null,
          writable: false,
        });
      }
      // Importing another configuration can reuse the same geometry, but must not
      // retain permission to overwrite the previously opened project's ZIP.
      projectSaveTargetRevisionRef.current += 1;
      setProjectSaveTarget(null);
      if (effectiveMap?.mapId) {
        await clearProjectSaveTarget(effectiveMap.mapId, importedTeachingSpaceMode).catch(() => undefined);
      }
      const sourceLabel = importedFile.source === 'directory'
        ? '工程目录'
        : importedFile.source === 'directory-readonly'
          ? '工程目录（只读）'
          : importedFile.source === 'zip'
            ? 'ZIP 工程包'
            : '工程配置';
      notify(
        `${sourceLabel}已加载${importedFile.portable ? '（完整）' : ''} · ${project.waypoints.length} 导航点 / ${project.teachingTasks.length} 示教任务${importedFile.manifest ? ` / ${importedFile.manifest?.statistics?.cameraFrameCount || 0} 相机帧` : ''}${importedFile.portable ? ' · 地图与机器人资源已恢复' : ''}${importedFile.source === 'directory' ? ' · 已启用增量保存' : ''}`,
      );

      const referencedMap = project.map?.fileName;
      if (!importedFile.resources?.map && (!effectiveMap || effectiveMap.metadataOnly) && referencedMap === 'xian_map.ply') {
        await loadExample({
          preserveGraph: true,
          teachingSpaceMode: importedTeachingSpaceMode,
          mapId: effectiveMap?.mapId,
          preferredSlice: project.slice,
          preferredView: project.view2d,
          preferredView3d: project.view3d,
        });
      } else if (project.slice && effectiveMap?.bounds) {
        setHeightRange(clampSlice(project.slice, effectiveMap.bounds));
      }
      setLoadState({ loading: false, progress: 1, phase: '' });
      finishProjectImport();
    } catch (error) {
      cancelProjectImport();
      projectDirectoryRef.current = previousDirectoryBinding;
      if (!portableResourceCommitted && nextPortableResourceId !== previousPortableResourceId) {
        releasePortableRobotPackage(nextPortableResourceId);
      }
      setLoadState({ loading: false, progress: 0, phase: '' });
      setProjectImportError({ sourceName, mode: requestedMode, message: error?.message || '无法读取所选工程' });
      if (sourcePage === APP_PAGE_HOME) navigateAppPage(APP_PAGE_HOME, { replace: true });
      if (options.throwOnError) throw error;
    } finally {
      if (!reloadingLinkedProject) {
        workspaceSwitchingRef.current = false;
        queueWorkspaceSave();
      }
    }
  };

  const loadProjectGuideFile = async (file, targetMode) => {
    if (!file) return;
    if (!/\.(json|zip)$/i.test(file.name)) {
      notify('请选择 JSON 工程配置或 ZIP 工程包', 'warning');
      return;
    }
    await applyImportedProject(async (onProgress) => {
      const { readProjectFile } = await import('./lib/projectArchive.js');
      return readProjectFile(file, { onProgress });
    }, file.name, targetMode);
  };

  const handlePathFile = async (event) => {
    const file = event.target.files?.[0];
    const targetMode = projectGuideModeRef.current ?? teachingSpaceMode;
    projectGuideModeRef.current = null;
    event.target.value = '';
    await loadProjectGuideFile(file, targetMode);
  };

  const handleProjectDirectoryFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    const targetMode = projectDirectoryModeRef.current ?? teachingSpaceMode;
    projectDirectoryModeRef.current = null;
    event.target.value = '';
    if (!files.length) return;
    await applyImportedProject(async (onProgress) => {
      const { readProjectDirectoryFiles } = await import('./lib/projectArchive.js');
      return readProjectDirectoryFiles(files, { onProgress });
    }, files[0]?.webkitRelativePath?.split('/')?.[0] || '工程目录', targetMode);
  };

  const openProjectDirectory = async (requestedMode = teachingSpaceMode, startIn = null) => {
    if (loadState.loading) return;
    const targetMode = normalizeTeachingSpaceMode(requestedMode);
    if (typeof window.showDirectoryPicker !== 'function') {
      projectDirectoryModeRef.current = targetMode;
      projectDirectoryInputRef.current?.click();
      return;
    }
    try {
      const directoryHandle = await window.showDirectoryPicker({
        id: `atlas-project-${targetMode}`,
        mode: 'readwrite',
        ...(startIn ? { startIn } : {}),
      });
      await applyImportedProject(async (onProgress) => {
        const { readProjectDirectoryHandle } = await import('./lib/projectArchive.js');
        return readProjectDirectoryHandle(directoryHandle, {
          onProgress,
          requestPermission: true,
        });
      }, directoryHandle.name || '工程目录', targetMode);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setLoadState({ loading: false, progress: 0, phase: '' });
      setProjectImportError({ sourceName: '工程目录', mode: targetMode,
        message: error?.message || '无法读取所选目录' });
    }
  };

  const openLastProject = useCallback(async (requestedMode = null) => {
    const recovery = lastProjectRecovery;
    if (!recovery?.available) {
      notify('当前没有可恢复的上一次工程', 'info');
      return;
    }
    if (requestedMode !== null) {
      try {
        assertProjectMode(recovery.teachingSpaceMode, requestedMode);
      } catch (error) {
        notify(error.message, 'warning');
        return;
      }
    }
    const current = latestWorkspaceRef.current;
    const hasCurrentWork = Boolean(
      current?.mapData
      || current?.selectedRobot
      || current?.waypoints?.length
      || current?.edges?.length
      || current?.teachingTasks?.length
      || current?.jointPoses?.length,
    );
    if (hasCurrentWork) {
      const confirmed = window.confirm(
        `恢复上一次工程会替换“${teachingModeLabel(recovery.teachingSpaceMode)}”的工作缓存，另一种示教模式的缓存会保留。\n\n待恢复：${recovery.mapName || '未命名工程'}\n保存时间：${formatRecoveryTimestamp(recovery.savedAt)}\n\n是否继续？`,
      );
      if (!confirmed) return;
    }

    const sessionId = sessionIdRef.current;
    const wasSessionReady = sessionReadyRef.current;
    if (sessionSaveTimerRef.current) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    setLoadState({
      loading: true,
      progress: 0.18,
      phase: '恢复上一次工程',
      detail: `正在校验并恢复 ${recovery.mapName || '未完成工程'} 的地图、机器人、示教任务与视角`,
    });

    try {
      await persistWorkspaceNow();
      sessionReadyRef.current = false;
      await sessionWriteChainRef.current.catch(() => undefined);
      await activateWorkspaceRecovery(sessionId, requestedMode);
      window.location.assign('/workbench');
    } catch (error) {
      sessionReadyRef.current = wasSessionReady;
      setLoadState({ loading: false, progress: 0, phase: '' });
      notify(`上一次工程恢复失败：${error.message}`, 'error');
    }
  }, [lastProjectRecovery, notify, persistWorkspaceNow]);

  const setActiveMode = (nextMode) => {
    setSelectedMapOrigin(false);
    setMode(nextMode);
    setConnectionSourceId(null);
    if (nextMode === 'box') notify('框选模式：在二维图空白处按住左键拖框', 'info');
    if (nextMode === 'add') notify('添加模式：在二维截面上点击放置导航点', 'info');
    if (nextMode === 'connect') notify('连接模式：先选择起点，再选择终点', 'info');
  };

  const toggleCollapsedPanel = (panel) => {
    setCollapsedPanel((current) => (current === panel ? null : panel));
  };

  const addWaypoint = useCallback(
    (pose, options = {}) => {
      const source = options.source || 'point-cloud-slice';
      const finitePoseValue = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const point = {
        id: createId('wp'),
        name: `P${String(waypoints.length + 1).padStart(2, '0')}`,
        pose: {
          x: finitePoseValue(pose?.x),
          y: finitePoseValue(pose?.y),
          z: finitePoseValue(pose?.z),
          roll: finitePoseValue(pose?.roll),
          pitch: finitePoseValue(pose?.pitch),
          yaw: finitePoseValue(pose?.yaw),
        },
        source,
      };
      setWaypoints((current) => [...current, point]);
      setSelectedWaypointId(point.id);
      setSelectedEdgeId(null);
      invalidateConnectivity();
      notify(
        options.message
          || (source === 'robot-current-pose'
            ? `${point.name} 已记录机器人当前 ${coordinateFrameLabel} 位姿`
            : `${point.name} 已绑定原始三维坐标`),
        'success',
      );
    },
    [coordinateFrameLabel, invalidateConnectivity, notify, waypoints.length],
  );

  const addWaypointFromToolbar = useCallback(() => {
    setMode('add');
    setConnectionSourceId(null);

    if (!selectedRobot || robotLoadState.status !== 'loaded') {
      notify(
        '二维点选模式已开启；加载机器人后再次点击可直接记录机器人当前位置',
        'info',
      );
      return;
    }

    const currentPose = normalizeRobotPose(robotPose);
    setShowWaypoints3D(true);
    addWaypoint(
      {
        x: currentPose.position.x,
        y: currentPose.position.y,
        z: currentPose.position.z,
        roll: currentPose.rpy.roll,
        pitch: currentPose.rpy.pitch,
        yaw: currentPose.rpy.yaw,
      },
      {
        source: 'robot-current-pose',
        message: `已记录机器人当前位置 · 可继续点击二维截面添加导航点`,
      },
    );
  }, [addWaypoint, notify, robotLoadState.status, robotPose, selectedRobot]);

  const selectWaypoint = useCallback((id) => {
    setSelectedMapOrigin(false);
    setSelectedWaypointId(id);
    setSelectedEdgeId(null);
  }, []);

  const requestSynchronizedFocus = useCallback((type, id) => {
    focusRevisionRef.current += 1;
    setSynchronizedFocus({ type, id, revision: focusRevisionRef.current });
  }, []);

  const requestInspectorPage = useCallback((request) => {
    setInspectorPageRequest({ ...request });
    setInspectorCollapsed(false);
  }, []);

  const selectEdge = useCallback((id) => {
    setSelectedMapOrigin(false);
    setSelectedEdgeId(id);
    setSelectedWaypointId(null);
  }, []);

  const focusEdgeFromInspector = useCallback(
    (id) => {
      selectEdge(id);
      requestSynchronizedFocus('edge', id);
    },
    [requestSynchronizedFocus, selectEdge],
  );

  const clearSelection = useCallback(() => {
    setSelectedMapOrigin(false);
    setSelectedWaypointId(null);
    setSelectedEdgeId(null);
  }, []);

  const connectTarget = useCallback(
    (id) => {
      if (!connectionSourceId) {
        setConnectionSourceId(id);
        setSelectedWaypointId(id);
        setSelectedEdgeId(null);
        notify('起点已锁定，请选择终点', 'info');
        return;
      }
      if (connectionSourceId === id) {
        setConnectionSourceId(null);
        notify('已取消起点选择', 'info');
        return;
      }
      const existing = edges.find((edge) => edge.from === connectionSourceId && edge.to === id);
      if (existing) {
        setSelectedEdgeId(existing.id);
        setSelectedWaypointId(null);
        setConnectionSourceId(null);
        notify('该方向路径已存在，已打开配置', 'info');
        return;
      }
      const edge = {
        id: createId('edge'),
        from: connectionSourceId,
        to: id,
        directed: true,
        limits: { ...defaultLimits },
        motion: { ...defaultMotion },
        status: 'unchecked',
      };
      setEdges((current) => [
        ...current.map((item) => ({ ...item, status: 'unchecked' })),
        edge,
      ]);
      setValidation(initialValidation);
      setConnectionSourceId(null);
      setSelectedWaypointId(null);
      setSelectedEdgeId(edge.id);
      notify('有向路径已创建，请配置运动约束');
    },
    [connectionSourceId, edges, notify],
  );

  const updateWaypoint = useCallback((id, patch) => {
    if (waypoints.some((point) => point.id === id && point.teachingTaskId)) {
      setTeachingTasks((current) => updateTeachingWaypoint(current, id, patch));
      if (patch.pose) invalidateConnectivity();
      return;
    }
    setWaypoints((current) =>
      current.map((point) => (point.id === id ? { ...point, ...patch } : point)),
    );
  }, [invalidateConnectivity, waypoints]);

  const updateEdge = useCallback((id, patch) => {
    setEdges((current) =>
      current.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge)),
    );
  }, []);

  const deleteMapSelection = useCallback(
    ({ waypointIds = [], edgeIds = [] }) => {
      const waypointIdSet = new Set(waypointIds);
      const edgeIdSet = new Set(edgeIds);
      const linkedParking = waypoints.filter((point) => waypointIdSet.has(point.id) && point.teachingTaskId);
      if (linkedParking.length) {
        const poseCount = linkedParking.reduce((count, point) => count + point.teachingPoseCount, 0);
        if (!window.confirm(`这些导航点关联 ${linkedParking.length} 个示教停车点。删除后将同时移除停车点、${poseCount} 个示教姿态及关联路径，是否继续？`)) return false;
      }
      const removedWaypointCount = waypoints.reduce(
        (count, point) => count + (waypointIdSet.has(point.id) ? 1 : 0),
        0,
      );
      const removedEdgeCount = edges.reduce(
        (count, edge) =>
          count
          + (
            edgeIdSet.has(edge.id)
            || waypointIdSet.has(edge.from)
            || waypointIdSet.has(edge.to)
              ? 1
              : 0
          ),
        0,
      );
      if (!removedWaypointCount && !removedEdgeCount) return;

      if (linkedParking.length) {
        setTeachingTasks((current) => removeTeachingWaypoints(current, waypointIdSet));
        if (waypointIdSet.has(activeTeachingParkingPointId)) setActiveTeachingParkingPointId(null);
      }
      setWaypoints((current) =>
        current.filter((point) => !waypointIdSet.has(point.id)),
      );
      setEdges((current) =>
        current
          .filter(
            (edge) =>
              !edgeIdSet.has(edge.id)
              && !waypointIdSet.has(edge.from)
              && !waypointIdSet.has(edge.to),
          )
          .map((edge) => ({ ...edge, status: 'unchecked' })),
      );
      setConnectionSourceId((current) =>
        current && waypointIdSet.has(current) ? null : current,
      );
      setSelectedWaypointId(null);
      setSelectedEdgeId(null);
      setSynchronizedFocus(null);
      setValidation(initialValidation);

      const removed = [];
      if (removedWaypointCount) removed.push(`${removedWaypointCount} 个导航点`);
      if (removedEdgeCount) removed.push(`${removedEdgeCount} 条路径`);
      notify(`已删除 ${removed.join('和')}`, 'info');
    },
    [activeTeachingParkingPointId, edges, notify, waypoints],
  );

  const deleteWaypoint = useCallback(
    (id) => deleteMapSelection({ waypointIds: [id] }),
    [deleteMapSelection],
  );

  const deleteEdge = useCallback(
    (id) => {
      setEdges((current) => current.filter((edge) => edge.id !== id).map((edge) => ({ ...edge, status: 'unchecked' })));
      setSelectedEdgeId(null);
      setValidation(initialValidation);
      notify('路径已删除', 'info');
    },
    [notify],
  );

  const runConnectivity = useCallback(() => {
    const result = inspectConnectivity(waypoints, edges);
    setEdges((current) =>
      current.map((edge) => ({
        ...edge,
        status: result.edgeStatus.get(edge.id) || 'unreachable',
      })),
    );
    const nextValidation = { ...result.validation, checkedAt: new Date().toISOString() };
    setValidation(nextValidation);
    notify(
      `检测完成：${connectivityCopy(nextValidation).detail}`,
      nextValidation.status === 'connected' ? 'success' : 'warning',
    );
    return nextValidation;
  }, [edges, notify, waypoints]);

  const teachingContextMatches = useCallback(
    (task) => {
      if (!task || !selectedRobot || !mapData) return false;
      const taskRobotKey = task.robot?.id || task.robot?.relativePath;
      const currentRobotKey = selectedRobot.id || selectedRobot.relativePath;
      const sameRobot = Boolean(taskRobotKey && currentRobotKey && taskRobotKey === currentRobotKey);
      const sameMap = task.map?.sourceHash && mapData.sourceHash
        ? task.map.sourceHash === mapData.sourceHash
        : task.map?.fileName === mapData.name;
      const sameCoordinateFrame = !task.coordinateFrame
        || task.coordinateFrame === coordinateFrame;
      return sameRobot && sameMap && sameCoordinateFrame;
    },
    [coordinateFrame, mapData, selectedRobot],
  );

  const saveTeachingPolyline = useCallback(async (path) => {
    if (!mapData || !selectedRobot || robotLoadState.status !== 'loaded') return null;
    if (!sessionReadyRef.current || workspaceSwitchingRef.current) throw new Error('请等待工程就绪后再保存折线');
    const timestamp = new Date().toISOString();
    const saved = { ...structuredClone(path), id: path.id || createId('polyline'),
      name: path.name.trim() || '表面折线', createdAt: path.createdAt || timestamp, updatedAt: timestamp };
    const existing = teachingTasks.find((task) => task.polylines?.some((item) => item.id === saved.id) && teachingContextMatches(task));
    const active = teachingTasks.find((task) => task.id === activeTeachingTaskId && !task.mobileCapture && !task.abx && teachingContextMatches(task));
    const target = existing || active || { id: createId('teach-task'), name: '折线示教',
      createdAt: timestamp, updatedAt: timestamp, coordinateFrame,
      robot: { id: selectedRobot.id || selectedRobot.relativePath, name: selectedRobot.name, relativePath: selectedRobot.relativePath },
      map: { id: mapData.mapId || '', fileName: mapData.name || '', sourceHash: mapData.sourceHash || null, teachingSpaceMode, coordinateFrame },
      parkingPoints: [] };
    const update = (task) => ({ ...task, updatedAt: timestamp, polylines: task.polylines?.some((item) => item.id === saved.id)
      ? task.polylines.map((item) => item.id === saved.id ? saved : item) : [...(task.polylines || []), saved] });
    const tasks = teachingTasks.some((task) => task.id === target.id)
      ? teachingTasks.map((task) => task.id === target.id ? update(task) : task) : [...teachingTasks, update(target)];
    // Explicit save must finish before success is shown. An immediate reload
    // must not race the normal 180 ms workspace autosave debounce.
    latestWorkspaceRef.current = { ...latestWorkspaceRef.current, teachingTasks: tasks, activeTeachingTaskId: target.id };
    setTeachingTasks(tasks);
    setActiveTeachingTaskId(target.id);
    await persistWorkspaceNow();
    if (!sessionReadyRef.current) throw new Error('折线已更新，但工程写入失败，请另存工程备份后重试');
    notify(`${saved.name} 已保存至 ${target.name}`, 'success');
    return saved;
  }, [mapData, selectedRobot, robotLoadState.status, teachingTasks, activeTeachingTaskId, teachingContextMatches, coordinateFrame, teachingSpaceMode, notify, persistWorkspaceNow]);

  const deleteTeachingPolyline = useCallback((taskId, pathId) => {
    setTeachingTasks((tasks) => tasks.map((task) => task.id === taskId ? { ...task,
      updatedAt: new Date().toISOString(), polylines: (task.polylines || []).filter((path) => path.id !== pathId) } : task));
  }, []);

  const createTeachingTask = useCallback((options = {}) => {
    if (!mapData?.bounds) {
      notify('请先加载地图，再创建虚拟示教任务', 'warning');
      return;
    }
    if (!selectedRobot || robotLoadState.status !== 'loaded') {
      notify('请先完成机器人模型加载，再创建虚拟示教任务', 'warning');
      return;
    }
    const timestamp = new Date().toISOString();
    const pose = normalizeRobotPose(robotPose);
    const includeCurrentParkingPoint = Boolean(options?.includeCurrentParkingPoint);
    const requestedName = String(options?.name || '').trim();
    const initialParkingPoint = includeCurrentParkingPoint
      ? {
          id: createId('parking-point'),
          name: teachingParkingName(waypoints, pose, '停车点 P01', selectedWaypointId),
          sequence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          mapPose: {
            frameId: coordinateFrame,
            position: { ...pose.position },
            rpy: { ...pose.rpy },
          },
          poses: [],
        }
      : null;
    const task = {
      id: createId('teach-task'),
      name: requestedName || `示教任务 ${String(teachingTasks.length + 1).padStart(2, '0')}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      coordinateFrame,
      robot: {
        id: selectedRobot.id || selectedRobot.relativePath,
        name: selectedRobot.name,
        relativePath: selectedRobot.relativePath,
      },
      map: {
        id: mapData.mapId || '',
        fileName: mapData.name || '',
        sourceHash: mapData.sourceHash || null,
        teachingSpaceMode,
        coordinateFrame,
      },
      parkingPoints: initialParkingPoint ? [initialParkingPoint] : [],
    };
    setRobotParkingGhost(null);
    setTeachingTasks((current) => [...current, task]);
    setActiveTeachingTaskId(task.id);
    setActiveTeachingParkingPointId(initialParkingPoint?.id || null);
    setSelectedWaypointId(initialParkingPoint?.id || null);
    setSelectedEdgeId(null);
    setTeachingCaptureState({ status: 'idle', message: '' });
    notify(
      initialParkingPoint
        ? `${task.name} 已创建 · ${initialParkingPoint.name} 已记录`
        : `${task.name} 已创建 · 可随时添加停车点`,
      'success',
    );
  }, [
    coordinateFrame,
    mapData,
    notify,
    robotLoadState.status,
    robotPose,
    selectedRobot,
    selectedWaypointId,
    teachingSpaceMode,
    teachingTasks.length,
    waypoints,
  ]);

  const selectTeachingTask = useCallback((id, parkingPointId = null) => {
    const task = teachingTasks.find((item) => item.id === id);
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId)
      || task?.parkingPoints?.[0];
    setActiveTeachingTaskId(id);
    setActiveTeachingParkingPointId(parkingPoint?.id || null);
    setSelectedWaypointId(parkingPoint?.id || null);
    setSelectedEdgeId(null);
    setRobotParkingGhost(null);
    setMobilePoseSelection(null);
    setSynchronizedFocus((current) => current?.type === 'mobile-pose' ? null : current);
    setTeachingCaptureState({ status: 'idle', message: '' });
  }, [teachingTasks]);

  const renameTeachingTask = useCallback((id, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === id ? { ...task, name: nextName, updatedAt } : task
    )));
  }, []);

  const deleteTeachingTask = useCallback(
    (id) => {
      const task = teachingTasks.find((item) => item.id === id);
      const remaining = teachingTasks.filter((item) => item.id !== id);
      setTeachingTasks(remaining);
      setRobotParkingGhost((current) => current?.taskId === id ? null : current);
      if (activeTeachingTaskId === id) {
        setActiveTeachingTaskId(remaining[0]?.id || null);
        setActiveTeachingParkingPointId(remaining[0]?.parkingPoints?.[0]?.id || null);
      }
      notify(`${task?.name || '示教任务'} 已删除`, 'info');
    },
    [activeTeachingTaskId, notify, teachingTasks],
  );

  const createTeachingParkingPoint = useCallback(() => {
    const task = teachingTasks.find((item) => item.id === activeTeachingTaskId);
    if (!task) {
      notify('请先新建或选择一个示教任务', 'warning');
      return;
    }
    if (task.abx) {
      notify('原生任务的停车点顺序已保留；请新建虚拟任务添加停车点', 'warning'); return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('当前地图或机器人与该示教任务不一致，无法记录停车点', 'warning');
      return;
    }
    const timestamp = new Date().toISOString();
    const pose = normalizeRobotPose(robotPose);
    const parkingPoints = task.parkingPoints || [];
    const parkingPoint = {
      id: createId('parking-point'),
      name: teachingParkingName(waypoints, pose, `停车点 P${String(parkingPoints.length + 1).padStart(2, '0')}`, selectedWaypointId),
      sequence: parkingPoints.length + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      mapPose: {
        frameId: coordinateFrame,
        position: { ...pose.position },
        rpy: { ...pose.rpy },
      },
      poses: [],
    };
    setRobotParkingGhost(null);
    setTeachingTasks((current) => current.map((item) => (
      item.id === task.id
        ? {
            ...item,
            parkingPoints: [...(item.parkingPoints || []), parkingPoint],
            updatedAt: timestamp,
          }
        : item
    )));
    setActiveTeachingParkingPointId(parkingPoint.id);
    setSelectedWaypointId(parkingPoint.id);
    setSelectedEdgeId(null);
    setTeachingCaptureState({ status: 'idle', message: '' });
    notify(`${parkingPoint.name} 已记录 · ${coordinateFrameLabel} XYZ/RPY`, 'success');
  }, [
    activeTeachingTaskId,
    coordinateFrame,
    coordinateFrameLabel,
    notify,
    robotLoadState.status,
    robotPose,
    selectedWaypointId,
    teachingContextMatches,
    teachingTasks,
    waypoints,
  ]);

  const selectTeachingParkingPoint = useCallback((id) => {
    setActiveTeachingParkingPointId(id);
    setSelectedWaypointId(id);
    setSelectedEdgeId(null);
    setRobotParkingGhost(null);
    setTeachingCaptureState({ status: 'idle', message: '' });
  }, []);

  const previewTeachingParkingPoint = useCallback((id, poseId = null, options = {}) => {
    setMobileComputation((current) => current ? { ...current, preview: null, followLatest: false } : current);
    const task = teachingTasks.find((item) => (
      (item.parkingPoints || []).some((parkingPoint) => parkingPoint.id === id)
    ));
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === id);
    const pose = poseId ? parkingPoint?.poses?.find((item) => item.id === poseId) : null;
    const currentTask = teachingTasks.find((item) => item.id === activeTeachingTaskId);
    const currentParkingPoint = currentTask?.parkingPoints?.find(
      (item) => item.id === activeTeachingParkingPointId,
    );

    setActiveTeachingTaskId(task?.id || activeTeachingTaskId);
    setActiveTeachingParkingPointId(id);
    setSelectedWaypointId(id);
    setSelectedEdgeId(null);
    setTeachingCaptureState({ status: 'idle', message: '' });

    if (!task || !parkingPoint || (poseId && !pose)) {
      setRobotParkingGhost(null);
      return;
    }
    if (parkingPoint.abx?.located === false || pose?.abx?.located === false) {
      setRobotParkingGhost(null);
      notify('该原生记录缺少 map 定位，暂不生成地图虚影', 'warning'); return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      setRobotParkingGhost(null);
      requestSynchronizedFocus('waypoint', id);
      notify('停车点已选择；请加载与任务匹配的地图和机器人后再生成虚影', 'warning');
      return;
    }

    const currentPose = normalizeRobotPose(robotPose);
    const targetPose = normalizeRobotPose(pose?.abx ? pose.mapPose : parkingPoint.mapPose);
    const deltaX = targetPose.position.x - currentPose.position.x;
    const deltaY = targetPose.position.y - currentPose.position.y;
    const deltaZ = targetPose.position.z - currentPose.position.z;
    const planarDistance = Math.hypot(deltaX, deltaY);
    const straightDistance = Math.hypot(deltaX, deltaY, deltaZ);
    const sourceParkingPose = currentParkingPoint
      ? normalizeRobotPose(currentParkingPoint.mapPose)
      : null;
    const sourceParkingDistance = sourceParkingPose
      ? Math.hypot(
          sourceParkingPose.position.x - currentPose.position.x,
          sourceParkingPose.position.y - currentPose.position.y,
          sourceParkingPose.position.z - currentPose.position.z,
        )
      : Number.POSITIVE_INFINITY;

    setRobotParkingGhost({
      revision: createId('robot-parking-ghost'),
      taskId: task.id,
      taskName: task.name,
      parkingPointId: parkingPoint.id,
      parkingPointName: parkingPoint.name,
      poseId: pose?.id || null,
      poseName: pose?.name || '',
      showReadout: options.showReadout !== false,
      sourceParkingPointId: sourceParkingDistance <= 0.15 ? currentParkingPoint?.id || '' : '',
      sourceName: sourceParkingDistance <= 0.15
        ? currentParkingPoint?.name || '当前机器人'
        : '当前机器人',
      targetPose,
      jointValues: { ...normalizeRobotJointValues(pose ? pose.fullBodyJoints?.values : robotJointValues) },
      mapKey: mapData?.sourceHash || mapData?.mapId || mapData?.name || '',
      robotKey: selectedRobot?.id || selectedRobot?.relativePath || '',
      createdAt: new Date().toISOString(),
    });
    setCollapsedPanel((current) => current === '3d' ? null : current);
    requestSynchronizedFocus('robot-ghost', parkingPoint.id);
    notify(
      `${parkingPoint.name}${pose ? ` / ${pose.name}` : ''} 虚影已生成 · XY ${planarDistance.toFixed(2)} m / 直线 ${straightDistance.toFixed(2)} m`,
      'info',
    );
  }, [
    activeTeachingParkingPointId,
    activeTeachingTaskId,
    mapData,
    notify,
    requestSynchronizedFocus,
    robotJointValues,
    robotLoadState.status,
    robotPose,
    selectedRobot,
    teachingContextMatches,
    teachingTasks,
  ]);

  const clearRobotParkingGhost = useCallback(() => {
    setRobotParkingGhost(null);
    setMobileComputation((current) => current ? { ...current, preview: null, followLatest: false } : current);
  }, []);

  const openTeachingPolyline = useCallback((taskId, pathId, action = 'preview') => {
    const task = teachingTasks.find((item) => item.id === taskId);
    const path = task?.polylines?.find((item) => item.id === pathId);
    if (!path) { notify('折线不存在或已经被删除', 'warning'); return; }
    if (polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)
      || teachingCaptureState.status === 'capturing' || robotParkingGhost?.editing) {
      notify('请先结束当前检查、播放或姿态编辑，再打开折线', 'warning'); return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('请先加载该折线所属任务的地图与机器人', 'warning'); return;
    }
    if (!mapData?.faceCount) { notify('折线查看和回放需要带三角面的模型', 'warning'); return; }
    clearRobotParkingGhost();
    setActiveTeachingTaskId(taskId);
    setActiveTeachingParkingPointId(null);
    setCollapsedPanel((current) => current === '3d' ? null : current);
    setPolylineTeachingRequest({ id: createId('polyline-request'), taskId, pathId, action,
      sceneId: mapData.geometry.uuid, robotId: selectedRobot.id || selectedRobot.relativePath,
      path: structuredClone(path) });
    requestInspectorPage({ page: 'teaching' });
    navigateAppPage(APP_PAGE_WORKBENCH);
  }, [teachingTasks, polylineTeachingBusy, teachingPlayback.status, teachingCaptureState.status,
    robotParkingGhost?.editing, robotLoadState.status, teachingContextMatches, mapData, selectedRobot,
    clearRobotParkingGhost, requestInspectorPage, navigateAppPage, notify]);

  const selectNavigationWaypoint = useCallback((id) => {
    selectWaypoint(id);
    if (waypoints.some((point) => point.id === id && point.teachingTaskId)) {
      previewTeachingParkingPoint(id);
    } else {
      setRobotParkingGhost(null);
    }
  }, [previewTeachingParkingPoint, selectWaypoint, waypoints]);

  const selectMapOrigin = useCallback(() => {
    if (polylineTeachingOpen) return;
    setSelectedWaypointId(null);
    setSelectedEdgeId(null);
    setSelectedMapOrigin(true);
    setConnectionSourceId(null);
    setMode('select');
    clearRobotParkingGhost();
    requestInspectorPage({ page: 'navigation' });
  }, [clearRobotParkingGhost, polylineTeachingOpen, requestInspectorPage]);

  const focusWaypointFromInspector = useCallback((id) => {
    setShowWaypoints3D(true);
    selectNavigationWaypoint(id);
    if (!waypoints.some((point) => point.id === id && point.teachingTaskId)) {
      requestSynchronizedFocus('waypoint', id);
    }
  }, [requestSynchronizedFocus, selectNavigationWaypoint, waypoints]);

  const viewTeachingParkingPoint = useCallback((id) => {
    setCollapsedPanel((current) => current === '3d' ? null : current);
    focusWaypointFromInspector(id);
    requestInspectorPage({ page: 'navigation' });
    navigateAppPage(APP_PAGE_WORKBENCH);
  }, [focusWaypointFromInspector, navigateAppPage, requestInspectorPage]);

  const viewTeachingPose = useCallback((parkingPointId, poseId) => {
    setCollapsedPanel((current) => current === '3d' ? null : current);
    previewTeachingParkingPoint(parkingPointId, poseId);
    requestInspectorPage({ page: 'teaching' });
    navigateAppPage(APP_PAGE_WORKBENCH);
  }, [navigateAppPage, previewTeachingParkingPoint, requestInspectorPage]);

  const renameTeachingParkingPoint = useCallback((taskId, parkingPointId, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === taskId
        ? {
            ...task,
            updatedAt,
            parkingPoints: (task.parkingPoints || []).map((parkingPoint) => (
              parkingPoint.id === parkingPointId
                ? { ...parkingPoint, name: nextName, updatedAt }
                : parkingPoint
            )),
          }
        : task
    )));
  }, []);

  const deleteTeachingParkingPoint = useCallback((taskId, parkingPointId) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    if (!task) return;
    if (task.abx) {
      notify('原生任务的停车点与动作顺序需要在机器人端调整后重新导入', 'warning'); return;
    }
    const removed = task.parkingPoints?.find((item) => item.id === parkingPointId);
    setRobotParkingGhost((current) => (
      current?.taskId === taskId && current.parkingPointId === parkingPointId ? null : current
    ));
    const remaining = (task.parkingPoints || [])
      .filter((item) => item.id !== parkingPointId)
      .map((item, index) => ({ ...item, sequence: index + 1 }));
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((item) => (
      item.id === taskId ? { ...item, parkingPoints: remaining, updatedAt } : item
    )));
    if (activeTeachingParkingPointId === parkingPointId) {
      setActiveTeachingParkingPointId(remaining[0]?.id || null);
    }
    notify(`${removed?.name || '停车点'} 已删除`, 'info');
  }, [activeTeachingParkingPointId, notify, teachingTasks]);

  const captureTeachingPoint = useCallback(async (options = {}) => {
    if (polylineTeachingBusy) {
      notify('请先停止折线检查或划线，再记录普通姿态', 'warning');
      return { success: false, message: '折线任务进行中。' };
    }
    const replacePoseId = options?.replacePoseId;
    const createParkingPoint = options?.createParkingPoint === true;
    const task = teachingTasks.find((item) => item.id === (options?.taskId || activeTeachingTaskId));
    if (!task) {
      notify('请先新建或选择一个示教任务', 'warning');
      return { success: false, message: '请先在网页端新建或选择示教任务。' };
    }
    const selectedParkingPoint = task.parkingPoints?.find(
      (item) => item.id === (options?.parkingPointId || activeTeachingParkingPointId),
    );
    if (!selectedParkingPoint && !createParkingPoint) {
      notify('请先新增或选择一个停车点', 'warning');
      return { success: false, message: '请先在网页端新增或选择停车点。' };
    }
    const originalPoint = replacePoseId
      ? selectedParkingPoint?.poses?.find((point) => point.id === replacePoseId)
      : null;
    if (task.abx && (!replacePoseId || originalPoint?.abx?.located === false)) {
      notify('原生任务保留机器人动作顺序；请新建虚拟任务添加步骤，缺少定位的原生姿态请在机器人端编辑', 'warning');
      return { success: false, message: '请先在网页端新建或选择虚拟示教任务。' };
    }
    const edit = robotParkingGhostRef.current;
    if (replacePoseId && (
      !originalPoint
      || !edit?.editing
      || edit.taskId !== task.id
      || edit.parkingPointId !== selectedParkingPoint.id
      || edit.poseId !== replacePoseId
      || createParkingPoint
    )) return;
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('当前地图或机器人与该示教任务不一致，无法记录', 'warning');
      return { success: false, message: '当前地图或机器人与任务不一致，请在网页端选择匹配的任务。' };
    }
    if (teachingCaptureBusyRef.current) return { success: false, message: '正在记录姿态，请稍候。' };
    const pose = normalizeRobotPose(replacePoseId
      ? originalPoint?.abx ? originalPoint.mapPose : selectedParkingPoint.mapPose : robotPose);
    const joints = normalizeRobotJointValues(replacePoseId ? options.jointValues : robotJointValues);
    const timestamp = new Date().toISOString();
    const parkingPoints = task.parkingPoints || [];
    const parkingPoint = createParkingPoint
      ? {
          id: createId('parking-point'),
          name: teachingParkingName(waypoints, pose, `停车点 P${String(parkingPoints.length + 1).padStart(2, '0')}`, selectedWaypointId),
          sequence: parkingPoints.length + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          mapPose: {
            frameId: coordinateFrame,
            position: { ...pose.position },
            rpy: { ...pose.rpy },
          },
          poses: [],
        }
      : selectedParkingPoint;
    const expectsZividCapture = Number(robotLoadState.zividCount) > 0;
    let cameraCapture = null;
    if (expectsZividCapture) {
      const provider = zividCaptureProviderRef.current;
      if (typeof provider !== 'function') {
        const message = '左右 Zivid 画面正在准备，请稍后重试';
        setTeachingCaptureState({ status: 'error', message });
        notify(message, 'warning');
        return { success: false, message };
      }
      teachingCaptureBusyRef.current = true;
      setTeachingCaptureState({
        status: 'capturing',
        message: '正在冻结左右 RGB 与点云快照',
      });
      try {
        const capturePromise = provider(replacePoseId ? { cameraPoses: options.cameraPoses }
          : options.allowBackground ? { allowBackground: true } : undefined);
        if (options.allowBackground) await new Promise((resolve) => window.setTimeout(resolve, 0));
        else await waitForPaint();
        cameraCapture = await capturePromise;
      } catch (error) {
        const message = error?.message || '双目视觉快照采集失败';
        setTeachingCaptureState({ status: 'error', message });
        notify(message, 'error');
        return { success: false, message };
      } finally {
        teachingCaptureBusyRef.current = false;
      }
    }
    if (options.isCurrent && !options.isCurrent()) {
      setTeachingCaptureState({ status: 'idle', message: '' });
      return { success: false, message: '协作连接、任务或停车点已切换，本次未记录，请确认后重试。' };
    }
    // A closed preview, a new selection or Escape invalidates an in-flight edit.
    if (replacePoseId && (
      !robotParkingGhostRef.current?.editing
      || robotParkingGhostRef.current.revision !== edit.revision
    )) {
      setTeachingCaptureState({ status: 'idle', message: '' });
      return;
    }
    const point = {
      ...originalPoint,
      id: originalPoint?.id || createId('teach-pose'),
      name: originalPoint?.name || `A${String(parkingPoint.poses.length + 1).padStart(2, '0')}`,
      sequence: originalPoint?.sequence || parkingPoint.poses.length + 1,
      capturedAt: timestamp,
      mapPose: {
        frameId: coordinateFrame,
        position: { ...pose.position },
        rpy: { ...pose.rpy },
      },
      fullBodyJoints: {
        angularUnit: 'degree',
        linearUnit: 'meter',
        source: 'urdf-movable-joints',
        count: Object.keys(joints).length,
        values: { ...joints },
      },
      cameraCapture,
      ...(replacePoseId && {
        opticalTargets: Object.fromEntries(Object.entries(cameraCapture?.frames || {})
          .map(([side, frame]) => [side, frame.opticalPose])),
      }),
    };
    setTeachingTasks((current) => current.map((item) => (
      item.id === task.id
        ? {
            ...item,
            parkingPoints: createParkingPoint
              ? [
                  ...(item.parkingPoints || []),
                  { ...parkingPoint, poses: [point], updatedAt: timestamp },
                ]
              : item.parkingPoints.map((candidate) => (
                  candidate.id === parkingPoint.id
                    ? {
                        ...candidate,
                        poses: replacePoseId
                          ? candidate.poses.map((entry) => entry.id === replacePoseId
                            ? { ...entry, ...point, name: entry.name }
                            : entry)
                          : [...candidate.poses, point],
                        updatedAt: timestamp,
                      }
                    : candidate
                )),
            updatedAt: timestamp,
          }
        : item
    )));
    if (createParkingPoint) {
      setActiveTeachingParkingPointId(parkingPoint.id);
      setSelectedWaypointId(parkingPoint.id);
      setSelectedEdgeId(null);
    }
    if (replacePoseId) {
      setRobotParkingGhost((current) => current?.revision === edit.revision ? {
        ...current,
        editing: false,
        targetPose: pose,
        jointValues: { ...joints },
        revision: createId('robot-parking-ghost'),
      } : current);
    }
    notify(
      `${parkingPoint.name} / ${point.name} ${replacePoseId ? '已修改' : createParkingPoint ? '已新建并示教' : '已示教'} · ${point.fullBodyJoints.count} 个全身关节${cameraCapture ? ' + 双目 RGB/XYZ' : ''}`,
      'success',
    );
    setTeachingCaptureState({
      status: 'complete',
      message: cameraCapture
        ? '左右 RGB 与点云已随当前姿态保存'
        : '当前姿态与全身关节已保存',
      pointId: point.id,
      parkingPointId: parkingPoint.id,
      frameCount: cameraCapture ? Object.keys(cameraCapture.frames || {}).length : 0,
    });
    return { success: true, message: `已记录 ${parkingPoint.name} / ${point.name}`, pointId: point.id };
  }, [
    activeTeachingParkingPointId,
    activeTeachingTaskId,
    polylineTeachingBusy,
    coordinateFrame,
    notify,
    robotJointValues,
    robotLoadState.status,
    robotLoadState.zividCount,
    robotPose,
    selectedWaypointId,
    teachingContextMatches,
    teachingTasks,
    waypoints,
  ]);

  const screenCaptureParkingPoint = activeTeachingTask?.parkingPoints?.find((point) => point.id === activeTeachingParkingPointId);
  const ipadPoseCaptureState = screenPoseCaptureState(activeTeachingTask, activeTeachingParkingPointId,
    (polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)) ? '请先在网页端结束轨迹播放或折线任务，再记录姿态。'
      : robotParkingGhost?.editing ? '请先在网页端完成或取消姿态编辑，再记录姿态。'
        : teachingCaptureState.status === 'capturing' ? '正在记录姿态，请稍候。'
          : robotLoadState.status !== 'loaded' || !teachingContextMatches(activeTeachingTask) ? '请在网页端加载与当前任务匹配的地图和机器人。'
            : analyzeParkingPointDrift(robotPose, screenCaptureParkingPoint?.poses)?.shouldWarn
              ? '机器人底盘已偏离当前停车点，请先在网页端确认或新增停车点，再记录姿态。' : '');
  const recordPoseFromIPad = async (request, isConnected) => {
    if (ipadPoseCaptureState.reason) return { success: false, message: ipadPoseCaptureState.reason };
    const map = mapData, robotId = selectedRobot?.id;
    const isCurrent = () => {
      const current = latestWorkspaceRef.current;
      return isConnected() && current.mapData === map && current.selectedRobot?.id === robotId
        && current.activeTeachingTaskId === request.taskId && current.activeTeachingParkingPointId === request.parkingPointId
        && current.teachingTasks.some((task) => task.id === request.taskId && task.parkingPoints?.some((point) => point.id === request.parkingPointId));
    };
    if (!isCurrent()) return { success: false, message: '网页端的任务或停车点已切换，请确认后重新记录。' };
    return captureTeachingPoint({ taskId: request.taskId, parkingPointId: request.parkingPointId, isCurrent, allowBackground: true });
  };

  const renameTeachingPoint = useCallback((taskId, parkingPointId, pointId, name) => {
    const nextName = String(name || '').trim();
    if (!nextName) return;
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => (
      task.id === taskId
        ? {
            ...task,
            updatedAt,
            parkingPoints: task.parkingPoints.map((parkingPoint) => (
              parkingPoint.id === parkingPointId
                ? {
                    ...parkingPoint,
                    updatedAt,
                    poses: parkingPoint.poses.map((point) => (
                      point.id === pointId ? { ...point, name: nextName } : point
                    )),
                  }
                : parkingPoint
            )),
          }
        : task
    )));
  }, []);

  const insertTeachingPresetAction = useCallback((taskId, parkingPointId, poseId, presetId, position) => {
    const current = latestWorkspaceRef.current;
    const task = current.teachingTasks.find((item) => item.id === taskId);
    const preset = current.jointPoses.find((item) => item.id === presetId);
    const id = createId('teach-pose');
    const updated = insertTeachingPreset(task, { parkingPointId, poseId, preset, position, id });
    const next = current.teachingTasks.map((item) => item.id === taskId ? updated : item);
    latestWorkspaceRef.current = { ...current, teachingTasks: next };
    setTeachingTasks(next);
    notify(`已在目标姿态${position === 'before' ? '之前' : '之后'}插入 ${preset.name}`, 'success');
    return updated.parkingPoints.find((item) => item.id === parkingPointId).poses.find((item) => item.id === id);
  }, [notify]);

  const moveTeachingPoint = useCallback((taskId, parkingPointId, poseId, direction) => {
    const current = latestWorkspaceRef.current;
    try {
      const task = current.teachingTasks.find((item) => item.id === taskId);
      const updated = moveTeachingPose(task, { parkingPointId, poseId, direction });
      if (updated === task) return;
      const next = current.teachingTasks.map((item) => item.id === taskId ? updated : item);
      latestWorkspaceRef.current = { ...current, teachingTasks: next };
      setTeachingTasks(next);
      notify(`姿态已${direction === 'up' ? '上移' : '下移'}`, 'success');
    } catch (error) {
      notify(error.message || '调整动作顺序失败', 'error');
    }
  }, [notify]);

  const deleteTeachingPoint = useCallback((taskId, parkingPointId, pointId) => {
    if (latestWorkspaceRef.current.teachingTasks.find((task) => task.id === taskId)?.abx) {
      notify('原生任务的动作顺序需要在机器人端调整后重新导入', 'warning'); return;
    }
    setRobotParkingGhost((current) => (
      current?.taskId === taskId && current.parkingPointId === parkingPointId && current.poseId === pointId
        ? null : current
    ));
    const updatedAt = new Date().toISOString();
    setTeachingTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task;
      return {
        ...task,
        updatedAt,
        parkingPoints: task.parkingPoints.map((parkingPoint) => (
          parkingPoint.id === parkingPointId
            ? {
                ...parkingPoint,
                updatedAt,
                poses: parkingPoint.poses
                  .filter((point) => point.id !== pointId)
                  .map((point, index) => ({ ...point, sequence: index + 1 })),
              }
            : parkingPoint
        )),
      };
    }));
    notify('机械臂示教姿态已删除', 'info');
  }, [notify]);

  const applyTeachingPoint = useCallback(
    (taskId, parkingPointId, pointId) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
      const point = parkingPoint?.poses?.find((item) => item.id === pointId);
      if (!task || !point) return;
      if (point.abx?.located === false) {
        notify('该原生姿态没有 map 定位，不能恢复底盘位置', 'warning'); return;
      }
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        notify('当前地图或机器人与该机械臂姿态不一致，无法应用', 'warning');
        return;
      }
      setRobotControlEnabled(false);
      setRobotPose(normalizeRobotPose(point.mapPose));
      setRobotJointValues(
        normalizeRobotJointValues(point.fullBodyJoints?.values),
      );
      notify(`${parkingPoint.name} / ${point.name} 已应用 · 地图定位与全身关节已恢复`, 'success');
    },
    [notify, robotLoadState.status, teachingContextMatches, teachingTasks],
  );

  const handleParkingMergePlannerChange = useCallback((provider) => {
    const normalized = typeof provider === 'function' ? provider : null;
    parkingMergePlannerRef.current = normalized;
    setParkingMergePlannerReady(Boolean(normalized));
  }, []);

  const handleMobileTeachingSolverChange = useCallback((provider) => {
    mobileTeachingSolverRef.current = provider;
    setMobileTeachingSolverReady(typeof provider === 'function');
  }, []);

  const analyzeTeachingParkingPointMerge = useCallback(
    async (taskId, options = {}) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      if (!task) throw new Error('示教任务不存在或已经被删除');
      if (task.abx) throw new Error('原生任务保留完整动作顺序，不能合并停车点');
      if ((task.parkingPoints?.length || 0) < 2) {
        throw new Error('至少需要两个停车点才能执行近邻聚类');
      }
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        throw new Error('请加载该任务绑定的地图与机器人后再分析');
      }
      const planner = parkingMergePlannerRef.current;
      if (typeof planner !== 'function') {
        throw new Error('机器人运动学规划器正在准备，请稍后重新分析');
      }
      return planner({ task, ...options });
    },
    [robotLoadState.status, teachingContextMatches, teachingTasks],
  );

  const mergeTeachingParkingPoints = useCallback(
    (taskId, requestedClusters = [], analysis = {}) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const mergeableClusters = requestedClusters.filter((cluster) => (
        cluster?.feasible
        && cluster.candidate?.mapPose
        && Array.isArray(cluster.memberIds)
        && cluster.memberIds.length >= 2
      ));
      if (!task || !mergeableClusters.length) {
        notify('没有可执行的停车点合并方案', 'warning');
        return { success: false, mergedClusterCount: 0 };
      }
      if (analysis.armJointCouplingEnabled !== robotArmJointCouplingEnabled) {
        notify('关节6–7角度耦合设置已变化，请重新分析停车点合并方案', 'warning');
        return { success: false, mergedClusterCount: 0 };
      }

      const timestamp = new Date().toISOString();
      let parkingPoints = [...(task.parkingPoints || [])];
      let firstRetainedParkingPointId = null;
      let mergedClusterCount = 0;
      let removedParkingPointCount = 0;
      let replannedPoseCount = 0;
      const consumedParkingPointIds = new Set();

      mergeableClusters.forEach((cluster) => {
        const memberIdSet = new Set(
          cluster.memberIds.filter((id) => !consumedParkingPointIds.has(id)),
        );
        const memberParkingPoints = parkingPoints.filter((item) => memberIdSet.has(item.id));
        if (memberParkingPoints.length < 2) return;
        const sourcePoses = memberParkingPoints.flatMap((parkingPoint) => (
          (parkingPoint.poses || []).map((pose) => ({ parkingPoint, pose }))
        ));
        const plannedByPoseId = new Map(
          (cluster.plannedPoses || []).map((plannedPose) => [plannedPose.poseId, plannedPose]),
        );
        if (
          sourcePoses.some(({ pose }) => {
            const plan = plannedByPoseId.get(pose.id);
            return !plan?.feasible || !plan.jointValues;
          })
        ) return;

        const normalizeMapPose = (value) => {
          const pose = normalizeRobotPose(value);
          return {
            frameId: task.coordinateFrame || coordinateFrame,
            position: { ...pose.position },
            rpy: { ...pose.rpy },
          };
        };
        const commonMapPose = normalizeMapPose(cluster.candidate.mapPose);
        const retainedParkingPoint = memberParkingPoints.find(
          (item) => item.id === cluster.candidate.anchorParkingPointId,
        ) || memberParkingPoints[0];
        const mergeId = createId('parking-merge');
        const sourceParkingPoints = memberParkingPoints.map((parkingPoint) => ({
          id: parkingPoint.id,
          name: parkingPoint.name,
          mapPose: normalizeMapPose(parkingPoint.mapPose),
          poseCount: parkingPoint.poses?.length || 0,
        }));
        const mergedPoses = sourcePoses.map(({ parkingPoint, pose }, index) => {
          const plan = plannedByPoseId.get(pose.id);
          const jointValues = normalizeRobotJointValues(plan.jointValues);
          return {
            ...pose,
            sequence: index + 1,
            mapPose: normalizeMapPose(commonMapPose),
            fullBodyJoints: {
              ...pose.fullBodyJoints,
              source: 'parking-point-merge-dls-replan',
              count: Object.keys(jointValues).length,
              values: jointValues,
            },
            replanningHistory: [
              ...(Array.isArray(pose.replanningHistory) ? pose.replanningHistory : []),
              {
                mergeId,
                replannedAt: timestamp,
                method: analysis.method || 'common-base-dual-optical-dls',
                sourceParkingPointId: parkingPoint.id,
                sourceParkingPointName: parkingPoint.name,
                sourceMapPose: normalizeMapPose(pose.mapPose),
                sourceJointValues: normalizeRobotJointValues(
                  pose.fullBodyJoints?.values,
                ),
                commonMapPose: normalizeMapPose(commonMapPose),
                positionTolerance: Number(analysis.positionTolerance) || 0,
                rotationTolerance: Number(analysis.rotationTolerance) || 0,
                positionError: Number(plan.positionError) || 0,
                rotationError: Number(plan.rotationError) || 0,
                sideErrors: plan.sideErrors || {},
              },
            ],
          };
        });
        const originalIndices = memberParkingPoints.map((parkingPoint) => (
          parkingPoints.findIndex((item) => item.id === parkingPoint.id)
        ));
        const insertionIndex = Math.max(0, Math.min(...originalIndices));
        const priorMergeIds = new Set();
        const priorMergeHistory = memberParkingPoints.flatMap((parkingPoint) => (
          Array.isArray(parkingPoint.mergeHistory) ? parkingPoint.mergeHistory : []
        )).filter((history) => {
          const historyId = String(history?.id || '');
          if (historyId && priorMergeIds.has(historyId)) return false;
          if (historyId) priorMergeIds.add(historyId);
          return true;
        });
        const mergedParkingPoint = {
          ...retainedParkingPoint,
          updatedAt: timestamp,
          mapPose: commonMapPose,
          poses: mergedPoses,
          mergeHistory: [
            ...priorMergeHistory,
            {
              id: mergeId,
              mergedAt: timestamp,
              method: analysis.method || 'xy-single-link+common-base-dual-optical-dls',
              candidateSource: cluster.candidate.source,
              distanceThreshold: Number(analysis.distanceThreshold) || 0,
              positionTolerance: Number(analysis.positionTolerance) || 0,
              rotationTolerance: Number(analysis.rotationTolerance) || 0,
              sourceParkingPoints,
              poseCount: mergedPoses.length,
              maximumPositionError: Number(cluster.candidate.maximumPositionError) || 0,
              maximumRotationError: Number(cluster.candidate.maximumRotationError) || 0,
            },
          ],
        };

        parkingPoints = parkingPoints.filter((item) => !memberIdSet.has(item.id));
        parkingPoints.splice(insertionIndex, 0, mergedParkingPoint);
        memberIdSet.forEach((id) => consumedParkingPointIds.add(id));
        firstRetainedParkingPointId ||= retainedParkingPoint.id;
        mergedClusterCount += 1;
        removedParkingPointCount += memberParkingPoints.length - 1;
        replannedPoseCount += mergedPoses.length;
      });

      if (!mergedClusterCount) {
        notify('分析结果已经过期，请重新计算停车点合并方案', 'warning');
        return { success: false, mergedClusterCount: 0 };
      }
      parkingPoints = parkingPoints.map((parkingPoint, index) => ({
        ...parkingPoint,
        sequence: index + 1,
      }));
      setTeachingTasks((current) => current.map((item) => (
        item.id === taskId
          ? { ...item, parkingPoints, updatedAt: timestamp }
          : item
      )));
      setActiveTeachingTaskId(taskId);
      setActiveTeachingParkingPointId(firstRetainedParkingPointId);
      setTeachingCaptureState({ status: 'idle', message: '' });
      notify(
        `${mergedClusterCount} 组停车点已融合 · 减少 ${removedParkingPointCount} 个停车点 / 重规划 ${replannedPoseCount} 组姿态`,
        'success',
      );
      return {
        success: true,
        mergedClusterCount,
        removedParkingPointCount,
        replannedPoseCount,
        retainedParkingPointId: firstRetainedParkingPointId,
      };
    },
    [coordinateFrame, notify, teachingTasks, robotArmJointCouplingEnabled],
  );

  const updateRobotJointValue = useCallback(
    (name, rawValue) => {
      if (robotLoadState.status !== 'loaded' || !name) return;
      const definition = robotLoadState.movableJoints?.find((joint) => joint.name === name);
      const value = clampJointValue(rawValue, definition);
      setRobotControlEnabled(false);
      setRobotJointValues((current) => ({ ...current, [name]: value }));
    },
    [robotLoadState.movableJoints, robotLoadState.status],
  );

  const toggleRobotJointLock = useCallback((name) => {
    const jointName = String(name || '').trim();
    if (!jointName || robotLoadState.status !== 'loaded') return;
    setLockedRobotJointNames((current) => {
      const normalized = normalizeRobotJointLocks(current);
      return normalized.includes(jointName)
        ? normalized.filter((candidate) => candidate !== jointName)
        : [...normalized, jointName];
    });
  }, [robotLoadState.status]);

  const unlockAllRobotJoints = useCallback(() => {
    setLockedRobotJointNames([]);
    notify('已解除全部关节 IK 锁定', 'info');
  }, [notify]);

  const zeroRobotJoints = useCallback(() => {
    if (robotLoadState.status !== 'loaded') {
      notify('机器人尚未完成装配，无法复位姿态', 'warning');
      return;
    }
    const definitions = robotLoadState.movableJoints || [];
    const jointNames = definitions.length
      ? definitions.map((joint) => joint.name)
      : Object.keys(robotJointValues);
    const definitionByName = new Map(definitions.map((joint) => [joint.name, joint]));
    setRobotControlEnabled(false);
    setRobotJointValues(Object.fromEntries(
      jointNames.map((name) => [name, clampJointValue(0, definitionByName.get(name))]),
    ));
    notify(`${jointNames.length} 个可动关节已恢复初始姿态`, 'info');
  }, [notify, robotJointValues, robotLoadState.movableJoints, robotLoadState.status]);

  const captureJointPose = useCallback(
    (requestedName) => {
      if (!selectedRobot || robotLoadState.status !== 'loaded') {
        notify('请先完成机器人模型加载，再记录关节姿态', 'warning');
        return;
      }
      const values = normalizeRobotJointValues(robotJointValues);
      const jointCount = Object.keys(values).length;
      if (!jointCount) {
        notify('当前机器人没有可记录的可动关节', 'warning');
        return;
      }
      const timestamp = new Date().toISOString();
      const name = String(requestedName || '').trim()
        || `关节姿态 ${String(jointPoses.length + 1).padStart(2, '0')}`;
      const pose = {
        id: createId('joint-pose'),
        name,
        sequence: jointPoses.length + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        robot: {
          id: selectedRobot.id || selectedRobot.relativePath,
          name: selectedRobot.name,
          relativePath: selectedRobot.relativePath,
        },
        joints: {
          angularUnit: 'degree',
          linearUnit: 'meter',
          source: 'joint-console',
          count: jointCount,
          values: { ...values },
        },
      };
      setJointPoses((current) => [...current, pose]);
      notify(`${name} 已记录 · ${jointCount} 个关节值`, 'success');
    },
    [jointPoses.length, notify, robotJointValues, robotLoadState.status, selectedRobot],
  );

  const renameJointPose = useCallback((id, requestedName) => {
    const name = String(requestedName || '').trim();
    if (!name) return;
    const updatedAt = new Date().toISOString();
    setJointPoses((current) => current.map((pose) => (
      pose.id === id ? { ...pose, name, updatedAt } : pose
    )));
  }, []);

  const deleteJointPose = useCallback((id) => {
    const pose = jointPoses.find((item) => item.id === id);
    setJointPoses((current) => current
      .filter((item) => item.id !== id)
      .map((item, index) => ({ ...item, sequence: index + 1 })));
    notify(`${pose?.name || '关节姿态'} 已删除`, 'info');
  }, [jointPoses, notify]);

  const applyJointPose = useCallback(
    (id, { announce = true } = {}) => {
      // A newly saved preset may not be in the render that started the save.
      const pose = latestWorkspaceRef.current.jointPoses.find((item) => item.id === id);
      if (!pose || !selectedRobot || robotLoadState.status !== 'loaded') {
        notify('机器人尚未就绪，无法执行关节姿态', 'warning');
        return false;
      }
      const poseRobotKey = pose.robot?.id || pose.robot?.relativePath;
      const currentRobotKey = selectedRobot.id || selectedRobot.relativePath;
      if (!poseRobotKey || poseRobotKey !== currentRobotKey) {
        notify('该关节姿态绑定了不同的机器人模型', 'warning');
        return false;
      }
      const definitionByName = new Map(
        (robotLoadState.movableJoints || []).map((joint) => [joint.name, joint]),
      );
      const values = Object.fromEntries(
        Object.entries(normalizeRobotJointValues(pose.joints?.values)).map(([name, value]) => [
          name,
          clampJointValue(value, definitionByName.get(name)),
        ]),
      );
      setRobotControlEnabled(false);
      setRobotJointValues((current) => ({ ...current, ...values }));
      if (announce) notify(`${pose.name} 已应用到机器人`, 'success');
      return true;
    },
    [notify, robotLoadState.movableJoints, robotLoadState.status, selectedRobot],
  );

  const currentExportPayload = () => buildExport({
    abxRoutes,
    transfer: workspaceTransfer,
    independentTeachingName,
    directoryAutosaveSuspended,
    mapData,
    teachingSpaceMode,
    heightRange,
    waypoints,
    edges,
    view2d: view2dRef.current,
    view3d: view3dRef.current,
    robot: selectedRobot,
    robotPose,
    robotJointValues,
    lockedRobotJointNames,
    ignoredRobotCollisionJointNames,
    robotArmSoftLimitRatio,
    robotArmSoftLimitOverrides,
    robotArmJointCouplingEnabled,
    robotHeightLocked,
    teachingTasks,
    jointPoses,
    meshRenderQuality,
    pointColorMode,
    placedObjectColorMode,
    showPaths3D,
    showParkingPoints3D,
    showWaypoints3D,
    showWaypointNames3D,
    showPathNames3D,
    showHeightLegend3D,
    activeTeachingTaskId,
    activeTeachingParkingPointId,
    collapsedPanel,
    inspectorCollapsed,
  });

  const openAbxTeachingExport = () => {
    if (teachingSpaceMode !== 'map') {
      notify('请先将独立示教转换到地图示教，再导出机器人示教数据', 'warning');
      return;
    }
    setAbxExportSnapshot({ payload: currentExportPayload(), robot: selectedRobot,
      robotPackage: portableRobotPackageRef.current });
  };

  const importAbxFile = async (event, kind) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || abxImportBusyRef.current) return;
    if (teachingSpaceMode !== 'map' || !mapData) {
      notify('请先打开地图示教工程，再导入机器人文件', 'warning'); return;
    }
    const workspaceMap = mapData;
    abxImportBusyRef.current = true;
    setAbxImportBusy(true);
    try {
      let imported;
      if (kind === 'route') {
        if (file.size > 48 * 1024) throw new Error('路网文件不能超过 48 KiB');
        imported = abxRouteToProject(readAbxRoute(await file.text()));
      } else {
        let model = null;
        if (selectedRobot?.format === 'urdf') {
          model = abxRobotModel(await readAbxRobotPackage(selectedRobot, portableRobotPackageRef.current));
        }
        imported = await readAbxTeachingFile(file, { robot: selectedRobot, robotModel: model, map: workspaceMap });
      }
      const current = latestWorkspaceRef.current;
      if (current.mapData !== workspaceMap || current.teachingSpaceMode !== 'map') {
        throw new Error('导入期间工程已切换，请在目标工程重新导入');
      }
      // Imported tasks have fresh IDs and are appended as separate tasks.
      // Normalize only the additions, leaving existing task data untouched.
      const merged = mergeAbxImport(current, {
        ...imported,
        tasks: normalizeTeachingTasks(imported.tasks || []),
      });
      const tasks = merged.tasks;
      const nextTaskId = imported.tasks?.[0]?.id || current.activeTeachingTaskId;
      const nextParkingId = imported.tasks?.length
        ? imported.tasks[0].parkingPoints[0]?.id || null : current.activeTeachingParkingPointId;
      // Persist this committed import immediately. A reload just after the
      // success notification must not race the normal debounced autosave.
      latestWorkspaceRef.current = { ...current, abxRoutes: merged.abxRoutes,
        waypoints: merged.waypoints, edges: merged.edges, teachingTasks: tasks, jointPoses: merged.jointPoses,
        activeTeachingTaskId: nextTaskId, activeTeachingParkingPointId: nextParkingId, validation: initialValidation };
      setAbxRoutes(merged.abxRoutes);
      setWaypoints(merged.waypoints); setEdges(merged.edges);
      setTeachingTasks(tasks); setJointPoses(merged.jointPoses);
      setValidation(initialValidation);
      if (imported.tasks?.length) {
        setActiveTeachingTaskId(nextTaskId);
        setActiveTeachingParkingPointId(nextParkingId);
      }
      await persistWorkspaceNow();
      notify(kind === 'route'
        ? `机器人路径已导入 · ${imported.waypoints.length} 节点 / ${imported.edges.length} 有向边`
        : `机器人示教已导入 · 新增 ${imported.tasks.length} 任务，原有任务已保留。${imported.warnings.join(' ')}`, 'success');
    } catch (error) {
      notify(`机器人${kind === 'route' ? '路径' : '示教'}导入失败：${error.message}`, 'error');
    } finally {
      abxImportBusyRef.current = false;
      setAbxImportBusy(false);
    }
  };

  const exportAbxRoutes = async () => {
    try {
      const { routes } = await buildAbxRouteDocuments(currentExportPayload());
      setAbxRouteExport(routes);
    } catch (error) { notify(`机器人路径导出失败：${error.message}`, 'error'); }
  };

  const exportIndependentTeachingJson = (payload) => {
    const data = buildTeachingDataExport(payload);
    const stamp = data.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(data, `atlas-teaching-independent-${stamp}.json`);
    notify(`示教数据已导出 · ${data.statistics.taskCount} 任务 / ${data.statistics.parkingPointCount} 停车点 / ${data.statistics.poseCount} 机器人姿态 / ${data.statistics.devicePoseCount} 设备姿态`, 'success');
  };

  const exportTeachingData = async () => {
    if (teachingSpaceMode === 'map') {
      openAbxTeachingExport();
      return;
    }
    if (teachingExportBusyRef.current || independentExportDialog) return;
    teachingExportBusyRef.current = true;
    try {
      const snapshot = { payload: currentExportPayload(), map: mapData, sessionId: sessionIdRef.current,
        robot: selectedRobot, robotPackage: portableRobotPackageRef.current };
      if (mapRouteSyncEnabled) {
        const mapConfig = await loadWorkspaceConfig(snapshot.sessionId, 'map');
        if (latestWorkspaceRef.current.mapData !== snapshot.map || latestWorkspaceRef.current.teachingSpaceMode !== 'independent'
          || sessionIdRef.current !== snapshot.sessionId || workspaceSwitchingRef.current) {
          throw new Error('工程已切换，请在目标独立示教中重新导出');
        }
        if (mapRouteSyncStatus(snapshot.map, snapshot.payload.workspace.transfer, mapConfig).available) {
          setIndependentExportDialog({ ...snapshot, mapConfig, busy: false, error: '' });
          return;
        }
      }
      exportIndependentTeachingJson(snapshot.payload);
    } catch (error) {
      notify(`示教数据导出失败：${error.message}`, 'error');
    } finally {
      teachingExportBusyRef.current = false;
    }
  };

  const chooseIndependentTeachingExport = async (format) => {
    if (!independentExportDialog || teachingExportBusyRef.current) return;
    const snapshot = independentExportDialog;
    teachingExportBusyRef.current = true;
    setIndependentExportDialog({ ...snapshot, busy: true, error: '' });
    try {
      if (format === 'json') {
        exportIndependentTeachingJson(snapshot.payload);
      } else {
        // Recheck the authoritative map when ZIP is chosen; another tab may
        // have replaced it while this dialog was open. Never use a stale link.
        const mapConfig = await loadWorkspaceConfig(snapshot.sessionId, 'map');
        if (sessionIdRef.current !== snapshot.sessionId || latestWorkspaceRef.current.mapData !== snapshot.map
          || latestWorkspaceRef.current.teachingSpaceMode !== 'independent' || workspaceSwitchingRef.current) {
          throw new Error('工程已切换，请关闭窗口后重新导出');
        }
        const payload = buildIndependentMapTeachingExport(snapshot.payload, snapshot.map, mapConfig);
        setAbxExportSnapshot({ payload, robot: snapshot.robot, robotPackage: snapshot.robotPackage });
      }
      setIndependentExportDialog(null);
    } catch (error) {
      setIndependentExportDialog({ ...snapshot, busy: false, error: error.message || '示教数据导出失败' });
    } finally {
      teachingExportBusyRef.current = false;
    }
  };

  const copyTeachingNode = async (taskId, parkingPointId, poseId) => {
    const label = poseId ? '姿态' : '停车点';
    try {
      const task = latestWorkspaceRef.current.teachingTasks.find((item) => item.id === taskId);
      const parkingPoint = task?.parkingPoints.find((item) => item.id === parkingPointId);
      if (!parkingPoint) throw new Error('未找到选中的停车点');
      const point = poseId ? parkingPoint.poses.find((item) => item.id === poseId) : null;
      if (poseId && !point) throw new Error('未找到选中的姿态');
      const data = point
        ? buildRobotPresetFile(point.fullBodyJoints)
        : buildTeachingParkingPointCopy(task, parkingPoint);
      await writeClipboardText(`${JSON.stringify(data, null, 2)}\n`);
      notify(`${label}「${(point || parkingPoint).name}」已复制到剪贴板`, 'success');
    } catch (error) {
      notify(`复制${label}失败：${error.message}`, 'error');
    }
  };

  const exportProject = async (downloadName, overwrite = false) => {
    if (!mapData?.geometry) {
      notify('请先加载完整地图；仅有配置元数据时无法生成便携工程包', 'error');
      return;
    }
    if (projectExportBusyRef.current) return;
    if (overwrite && !activeProjectSaveTarget?.handle) return;
    const invalid = edges.find(
      (edge) =>
        edge.limits.minSpeed > edge.limits.maxSpeed ||
        edge.limits.minAcceleration > edge.limits.maxAcceleration,
    );
    if (invalid) {
      selectEdge(invalid.id);
      notify('存在无效的路径约束，请修正后再保存', 'error');
      return;
    }
    projectExportBusyRef.current = true;
    setToast(null);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = typeof downloadName === 'string'
      ? downloadName : `atlas-project-${teachingSpaceMode}-${stamp}.zip`;
    const operation = overwrite ? 'save' : 'saveAs';
    let fileHandle = overwrite ? activeProjectSaveTarget.handle : null;
    try {
      if (overwrite) {
        setProjectExportState({ status: 'selecting', operation, byteLength: 0, phase: '确认文件写入权限' });
        await ensureProjectWritePermission(fileHandle);
      } else if (typeof downloadName !== 'string' && !isVisionWorkbench()) {
        if (typeof window.showSaveFilePicker !== 'function') {
          setProjectExportDialog({ filename });
          return;
        }
        setProjectExportState({ status: 'selecting', operation, byteLength: 0, phase: '选择保存位置' });
        try {
          // Invoke directly from the click, before imports or packing consume user activation.
          fileHandle = await window.showSaveFilePicker({
            id: `atlas-project-export-${teachingSpaceMode}`,
            suggestedName: filename,
            excludeAcceptAllOption: true,
            types: [{ description: '完整示教工程 ZIP', accept: { 'application/zip': ['.zip'] } }],
          });
        } catch (error) {
          if (error?.name === 'AbortError') {
            setProjectExportState(projectExportState);
            return;
          }
          if (['SecurityError', 'NotSupportedError'].includes(error?.name)) {
            setProjectExportState(projectExportState);
            setProjectExportDialog({ filename });
            return;
          }
          throw error;
        }
      }
      setProjectExportDialog(null);
      setProjectExportState({
        status: 'packing', operation, byteLength: 0, phase: '冻结地图资源', detail: mapData.name, progress: 0,
      });
      notify('正在打包地图、机器人、预设姿态、路径与独立示教列表…', 'info');
      const payload = currentExportPayload();
      const { downloadProjectArchive, saveProjectArchive } = await import('./lib/projectArchive.js');
      const mapResource = createGeometryCache(
        mapData.geometry,
        mapData.bounds,
        mapData.byteLength,
        mapData.sourceHash,
        mapData.sourceHashKind,
        {
          fileModifiedAt: mapData.fileModifiedAt,
          mimeType: mapData.mimeType,
          loadedAt: mapData.loadedAt,
          sourceKind: mapData.sourceKind,
          sourceBlob: mapData.sourceBlob,
          teachingSpaceMode,
          teachingGroupId: mapData.teachingGroupId,
        },
      );
      mapResource.mapId = mapData.mapId;
      const reusableRobotPackage = portableRobotPackageRef.current?.relativePath
        === selectedRobot?.relativePath
        ? portableRobotPackageRef.current
        : null;
      const workspaceUI = { mapRouteSyncEnabled, showSlice3D };
      let linkedWorkspace = null;
      if (!sessionIdRef.current) throw new Error('工作会话不可用，无法读取独立示教列表，请刷新后重试');
      await sessionWriteChainRef.current;
      const { companionWorkspace, independentHistory } = await loadProjectCompanions(sessionIdRef.current, teachingSpaceMode);
      if (companionWorkspace) {
        const candidates = {
          [teachingSpaceMode]: { mode: teachingSpaceMode, map: mapResource,
            config: { mapId: mapData.mapId, config: { project: payload } } },
          [companionWorkspace.mode]: companionWorkspace,
        };
        if (linkedWorkspaceRelation(candidates)) {
          linkedWorkspace = companionWorkspace;
        }
      } else if (payload.workspace?.transfer && (teachingSpaceMode === 'independent' || !independentHistory.length)) {
        throw new Error('已绑定的另一侧工程缓存缺失，请恢复对应工程后再保存完整工程');
      }
      const workspaceMapIds = companionWorkspace
        ? { [teachingSpaceMode]: mapData.mapId, [companionWorkspace.mode]: companionWorkspace.map.mapId }
        : null;
      const previousMapIds = activeProjectSaveTarget?.workspaceMapIds || activeProjectSaveTarget?.linkedMapIds;
      if (overwrite && previousMapIds
        && ['map', 'independent'].some((mode) => previousMapIds[mode] !== workspaceMapIds?.[mode])) {
        throw new Error('当前工程工作区已变化，请使用“另存为工程”保存');
      }
      const archive = await (fileHandle ? saveProjectArchive : downloadProjectArchive)(
        payload,
        fileHandle || filename,
        {
          mapResource,
          existingRobotPackage: reusableRobotPackage,
          linkedWorkspace,
          companionWorkspace: linkedWorkspace ? null : companionWorkspace,
          independentHistory,
          workspaceUI,
          onProgress: ({ phase, detail, progress }) => setProjectExportState({
            status: 'packing',
            operation,
            byteLength: 0,
            phase,
            detail,
            progress: Number(progress) || 0,
          }),
        },
      );
      let targetRemembered = true;
      if (!overwrite || companionWorkspace) {
        const target = fileHandle
          ? { mapId: mapData.mapId, teachingSpaceMode, handle: fileHandle, workspaceMapIds } : null;
        const current = latestWorkspaceRef.current;
        if (current.mapData?.mapId === mapData.mapId && current.teachingSpaceMode === teachingSpaceMode) {
          projectSaveTargetRevisionRef.current += 1;
          setProjectSaveTarget(target);
        }
        try {
          if (target) await rememberProjectSaveTarget(target);
          else await clearProjectSaveTarget(mapData.mapId, teachingSpaceMode);
          if (companionWorkspace) {
            if (target) await rememberProjectSaveTarget({ ...target,
              mapId: companionWorkspace.map.mapId, teachingSpaceMode: companionWorkspace.mode });
            else await clearProjectSaveTarget(companionWorkspace.map.mapId, companionWorkspace.mode);
          }
        } catch {
          targetRemembered = false;
        }
      }
      setProjectExportState({
        status: 'ready',
        byteLength: archive.byteLength,
        statistics: archive.manifest.statistics,
      });
      const sizeMb = archive.byteLength / (1024 * 1024);
      const sizeLabel = sizeMb >= 0.1 ? `${sizeMb.toFixed(1)} MB` : `${Math.max(1, Math.round(archive.byteLength / 1024))} KB`;
      notify(
        (fileHandle ? `工程已保存 · ${fileHandle.name} · ${sizeLabel}${targetRemembered ? '' : ' · 无法记住保存位置，刷新后请重新另存为'}`
          : `工程下载已开始 · ${filename} · ${sizeLabel}`)
          + (companionWorkspace ? ' · 已包含地图示教与独立示教' : '')
          + (independentHistory.length ? ` · ${independentHistory.length} 组独立示教缓存` : ''),
        targetRemembered ? 'success' : 'warning',
      );
    } catch (error) {
      setProjectExportState({ status: 'error', byteLength: 0 });
      notify(`工程保存失败：${error.message}`, 'error');
    } finally {
      projectExportBusyRef.current = false;
    }
  };

  const handleProjectionStats = useCallback((stats) => setProjectionStats(stats), []);
  const handleSelectRobot = useCallback(
    (value) => {
      const robot = normalizeRobotDescriptor(value);
      if (!robot) {
        notify('机器人模型描述无效', 'error');
        return;
      }
      const currentRobotKey = selectedRobot?.relativePath || selectedRobot?.id || '';
      const nextRobotKey = robot.relativePath || robot.id || '';
      if (projectDirectoryRef.current && currentRobotKey !== nextRobotKey) {
        detachProjectDirectory('机器人模型已更换；原工程目录已解除关联，避免资源身份不一致');
      }
      releasePortableRobotPackage(portableRobotPackageRef.current?.resourceId);
      portableRobotPackageRef.current = null;
      robotNotificationRef.current = '';
      defaultRobotJointLocksPendingRef.current = true;
      setSelectedRobot(robot);
      setRobotPose(normalizeRobotPose(null));
      setRobotJointValues({});
      setLockedRobotJointNames([]);
      setIgnoredRobotCollisionJointNames([]);
      setRobotArmSoftLimitRatio(ARM_SOFT_LIMIT_RATIO);
      setRobotArmSoftLimitOverrides({});
      setRobotArmJointCouplingEnabled(true);
      setRobotControlEnabled(false);
      setRobotHeightLocked(false);
      setRobotCollisionProtectionEnabled(true);
      setZividCameraPoses({});
      setCameraTeachingCommand(null);
      setCameraTeachingResult({ status: 'idle', revision: 0 });
      zividCaptureProviderRef.current = null;
      teachingCaptureBusyRef.current = false;
      setTeachingCaptureState({ status: 'idle', message: '' });
      setRobotLoadState({
        status: mapData?.geometry ? 'loading' : 'pending',
        robotId: robot.id,
        name: robot.name,
        loaded: 0,
        total: 0,
      });
      notify(
        mapData?.geometry
          ? `${robot.name} 已选择，正在装配到地图原点`
          : `${robot.name} 已选择，加载地图后将在原点显示`,
        'info',
      );
    },
    [detachProjectDirectory, mapData?.geometry, notify, selectedRobot],
  );
  const handleRobotLoadState = useCallback((nextState) => {
    setRobotLoadState(nextState);
    if (nextState.status !== 'loaded') {
      setRobotControlEnabled(false);
      setZividCameraPoses({});
    } else {
      const availableJointNames = new Set(
        (nextState.movableJoints || []).flatMap((joint) => joint?.name ? [joint.name] : []),
      );
      const applyDefaultLocks = defaultRobotJointLocksPendingRef.current;
      defaultRobotJointLocksPendingRef.current = false;
      setLockedRobotJointNames((current) => {
        const retained = normalizeRobotJointLocks(current).filter(
          (name) => availableJointNames.has(name),
        );
        const next = applyDefaultLocks
          ? normalizeRobotJointLocks([
              ...retained,
              ...defaultRobotJointLocks(nextState.movableJoints),
            ])
          : retained;
        return next.length === current.length
          && next.every((name, index) => name === current[index])
          ? current
          : next;
      });
    }
  }, []);
  const handleRobotPoseChange = useCallback((nextPose) => {
    const normalized = normalizeRobotPose(nextPose);
    setRobotPose((current) => {
      const unchanged =
        current.position.x === normalized.position.x
        && current.position.y === normalized.position.y
        && current.position.z === normalized.position.z
        && current.rpy.roll === normalized.rpy.roll
        && current.rpy.pitch === normalized.rpy.pitch
        && current.rpy.yaw === normalized.rpy.yaw;
      return unchanged ? current : normalized;
    });
  }, []);
  const handleRobotCollisionProtectionChange = useCallback(
    (enabled) => {
      const nextEnabled = Boolean(enabled);
      if (
        nextEnabled
        && (!mapData?.geometry || robotLoadState.status !== 'loaded' || !selectedRobot)
      ) {
        notify('请先完成地图与机器人模型加载', 'warning');
        return;
      }
      setRobotCollisionProtectionEnabled(nextEnabled);
      notify(
        nextEnabled
          ? '碰撞保护已开启 · 底盘与轮组已排除'
          : '碰撞保护已关闭 · 检测资源已释放',
        nextEnabled ? 'info' : 'success',
      );
    },
    [mapData?.geometry, notify, robotLoadState.status, selectedRobot],
  );
  const handleRobotJointValuesChange = useCallback((nextValues) => {
    const normalized = normalizeRobotJointValues(nextValues);
    setRobotJointValues((current) => {
      const currentEntries = Object.entries(current);
      const nextEntries = Object.entries(normalized);
      if (
        currentEntries.length === nextEntries.length
        && nextEntries.every(([name, value]) => current[name] === value)
      ) {
        return current;
      }
      return normalized;
    });
  }, []);
  const handleZividCameraPoseChange = useCallback((nextPoses) => {
    setZividCameraPoses(nextPoses && typeof nextPoses === 'object' ? nextPoses : {});
  }, []);
  const handleZividCaptureProviderChange = useCallback((provider) => {
    zividCaptureProviderRef.current = typeof provider === 'function' ? provider : null;
  }, []);
  const requestCameraTeachingMove = useCallback(
    (request) => {
      const side = request?.side === 'right' ? 'right' : 'left';
      if (robotLoadState.status !== 'loaded' || Number(robotLoadState.zividCount) < 1) {
        notify('Zivid 末端相机运动链尚未就绪', 'warning');
        return;
      }
      if (!zividCameraPoses[side]) {
        notify(`${side === 'left' ? '左' : '右'}臂相机坐标系正在同步，请稍后重试`, 'warning');
        return;
      }
      const revision = ++cameraTeachingRevisionRef.current;
      const command = {
        revision,
        side,
        action: String(request?.action || ''),
        linearStep: Number(request?.linearStep) || 0.025,
        angularStep: Number(request?.angularStep) || 3,
        source: request?.source === 'spacemouse' ? 'spacemouse' : 'button',
        inputMagnitude: Math.max(0, Math.min(1, Number(request?.inputMagnitude) || 0)),
      };
      setRobotControlEnabled(false);
      setCameraTeachingResult({
        revision,
        side,
        action: command.action,
        status: 'solving',
      });
      setCameraTeachingCommand(command);
    },
    [notify, robotLoadState.status, robotLoadState.zividCount, zividCameraPoses],
  );
  const handleCameraTeachingResult = useCallback(
    (result) => {
      const normalized = result && typeof result === 'object'
        ? result
        : { status: 'error', message: '相机示教逆解未返回结果' };
      setCameraTeachingResult(normalized);
      if (normalized.status === 'error') {
        notify(normalized.message || '相机示教逆解失败', 'warning');
      }
    },
    [notify],
  );
  const handleShowRobotChange = useCallback((visible) => {
    if (!visible) setRobotControlEnabled(false);
    setShowRobotModel(Boolean(visible));
  }, []);

  const handleRobotControlChange = useCallback(
    (enabled, { announce = true } = {}) => {
      const nextEnabled = Boolean(enabled) && robotLoadState.status === 'loaded';
      if (nextEnabled) setShowRobotModel(true);
      setRobotControlEnabled(nextEnabled);
      if (announce) notify(
        nextEnabled
          ? robotHeightLocked
            ? '机器人控制已启用 · WASD 全向移动 / ←→ 原地旋转 / Z 高度已锁'
            : '机器人控制已启用 · WASD 全向移动 / ←→ 原地旋转 / ↑↓ 调整高度'
          : '机器人控制已关闭 · WASD 与 ←→ 已交还相机',
        'info',
      );
    },
    [notify, robotHeightLocked, robotLoadState.status],
  );

  const handleRobotHeightLockChange = useCallback(
    (locked) => {
      if (!selectedRobot || robotLoadState.status !== 'loaded') return;
      const nextLocked = Boolean(locked);
      setRobotHeightLocked(nextLocked);
      notify(
        nextLocked
          ? `机器人高度已锁定 · Z ${robotPose.position.z.toFixed(3)} m`
          : '机器人高度已解锁 · 可用 ↑/↓ 重新微调',
        nextLocked ? 'success' : 'info',
      );
    },
    [notify, robotLoadState.status, robotPose.position.z, selectedRobot],
  );

  useEffect(() => {
    if (!['loaded', 'error'].includes(robotLoadState.status)) return;
    const signature = `${robotLoadState.status}:${robotLoadState.robotId}:${robotLoadState.message || ''}`;
    if (robotNotificationRef.current === signature) return;
    robotNotificationRef.current = signature;
    if (robotLoadState.status === 'loaded') {
      notify(
        `${robotLoadState.name || '机器人'} 已加载 · X ${robotPose.position.x.toFixed(2)} / Y ${robotPose.position.y.toFixed(2)} / YAW ${robotPose.rpy.yaw.toFixed(1)}°`,
        'success',
      );
    } else {
      notify(`机器人加载失败：${robotLoadState.message || '未知错误'}`, 'error');
    }
  }, [notify, robotLoadState, robotPose]);
  const handleViewChange = useCallback(
    (nextView) => {
      view2dRef.current = nextView;
      queueWorkspaceSave();
    },
    [queueWorkspaceSave],
  );
  const handleView3dChange = useCallback(
    (nextView) => {
      view3dRef.current = nextView;
      queueWorkspaceSave();
    },
    [queueWorkspaceSave],
  );

  const advanceTeachingPlayback = useCallback(function advancePlayback(timestamp) {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime || runtime.status !== 'playing') {
      teachingPlaybackFrameRef.current = null;
      return;
    }

    if (runtime.lastTimestamp === null) {
      runtime.lastTimestamp = timestamp;
    } else {
      const frameDuration = Math.max(0, Math.min(250, timestamp - runtime.lastTimestamp));
      runtime.lastTimestamp = timestamp;
      runtime.segmentElapsedMs += frameDuration * runtime.speed;
    }

    let crossedBoundary = false;
    while (runtime.segmentIndex < runtime.plan.segments.length) {
      const activeSegment = runtime.plan.segments[runtime.segmentIndex];
      if (runtime.segmentElapsedMs < activeSegment.durationMs) break;
      const finalSample = sampleTeachingTrajectorySegment(activeSegment, 1);
      setRobotPose(normalizeRobotPose(finalSample.robotPose));
      setRobotJointValues(normalizeRobotJointValues(finalSample.robotJointValues));
      markTeachingPlaybackPoseReached(runtime, activeSegment);
      runtime.segmentElapsedMs -= activeSegment.durationMs;
      runtime.segmentIndex += 1;
      crossedBoundary = true;

      if (runtime.segmentIndex >= runtime.plan.segments.length) {
        // Each lap starts at the first recording without an extra return path.
        setRobotPose(normalizeRobotPose(runtime.plan.initialRobotPose));
        setRobotJointValues(normalizeRobotJointValues(runtime.plan.initialJointValues));
        runtime.segmentIndex = 0;
        runtime.cycle += 1;
        runtime.reachedPoseIds.clear();
        runtime.activeParkingPointId = null;
      }
    }

    const segment = runtime.plan.segments[runtime.segmentIndex];
    markTeachingPlaybackPoseReached(runtime, segment);
    if (runtime.activeParkingPointId !== segment.target?.parkingPointId) {
      runtime.activeParkingPointId = segment.target?.parkingPointId || null;
      if (!runtime.mobilePreview) setActiveTeachingParkingPointId(runtime.activeParkingPointId);
    }
    const shouldRender = crossedBoundary
      || runtime.lastAppliedTimestamp === null
      || timestamp - runtime.lastAppliedTimestamp >= 30;
    if (shouldRender) {
      const progress = segment.durationMs > 0
        ? runtime.segmentElapsedMs / segment.durationMs
        : 1;
      const sample = sampleTeachingTrajectorySegment(segment, progress);
      if (segment.phase === 'chassis') {
        setRobotPose(normalizeRobotPose(sample.robotPose));
      } else if (segment.phase === 'joints') {
        setRobotJointValues(normalizeRobotJointValues(sample.robotJointValues));
      }
      setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime));
      runtime.lastAppliedTimestamp = timestamp;
    }

    teachingPlaybackFrameRef.current = window.requestAnimationFrame(advancePlayback);
  }, []);

  const startTeachingPlayback = useCallback((task, mobilePreview = null) => {
    if (polylineTeachingBusy) { notify('请先停止折线检查或划线，再播放示教任务', 'warning'); return; }
    if (!task) {
      notify('示教任务不存在或已经被删除', 'warning');
      return;
    }
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('请先加载该任务绑定的地图与机器人，再播放轨迹', 'warning');
      return;
    }

    if (task.polylines?.length && !task.parkingPoints?.some((point) => point.poses?.length)) {
      notify('请在示教数据中心或图谱控制台中选择对应折线并点击回放', 'info'); return;
    }
    const plan = buildTeachingTaskTrajectory({
      task,
      jointDefinitions: robotLoadState.movableJoints || [],
    });
    if (!plan.poseCount || !plan.segments.length) {
      notify('当前任务还没有可播放的机械臂示教姿态', 'warning');
      return;
    }

    if (teachingPlaybackFrameRef.current !== null) {
      window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
    }
    const runtime = {
      plan,
      mobilePreview,
      status: 'playing',
      segmentIndex: 0,
      segmentElapsedMs: 0,
      lastTimestamp: null,
      lastAppliedTimestamp: null,
      activeParkingPointId: plan.segments[0].target.parkingPointId,
      reachedPoseIds: new Set(),
      speed: 1,
      cycle: 1,
      followRobot: false,
      context: {
        mapId: mapData?.mapId || mapData?.sourceHash || mapData?.name || '',
        robotId: selectedRobot?.id || selectedRobot?.relativePath || '',
      },
    };
    teachingPlaybackRuntimeRef.current = runtime;
    setRobotPose(normalizeRobotPose(plan.initialRobotPose));
    setRobotJointValues(normalizeRobotJointValues(plan.initialJointValues));
    markTeachingPlaybackPoseReached(runtime, plan.segments[0]);
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime));
    setRobotParkingGhost(null);
    setMobileComputation((current) => current ? { ...current, preview: null, followLatest: false } : current);
    setMobilePoseSelection(null);
    setShowRobotModel(true);
    setActiveTeachingTaskId(mobilePreview?.taskId || task.id);
    setActiveTeachingParkingPointId(mobilePreview ? null : runtime.activeParkingPointId);
    setRobotControlEnabled(false);
    setHeightRangeCollapsed(true);
    setCollapsedPanel((currentPanel) => currentPanel === '3d' ? null : currentPanel);
    focusRevisionRef.current += 1;
    setSynchronizedFocus({
      type: 'robot',
      id: selectedRobot?.id || selectedRobot?.relativePath || 'active-robot',
      revision: focusRevisionRef.current,
    });
    navigateAppPage(APP_PAGE_WORKBENCH);
    teachingPlaybackFrameRef.current = window.requestAnimationFrame(advanceTeachingPlayback);
    notify(
      `${plan.taskName} 开始循环播放 · ${plan.populatedParkingPointCount} 个停车点 / ${plan.poseCount} 个姿态`,
      'info',
    );
    return true;
  }, [
    advanceTeachingPlayback,
    polylineTeachingBusy,
    mapData,
    navigateAppPage,
    notify,
    robotLoadState,
    selectedRobot,
    teachingContextMatches,
  ]);

  const startTeachingTaskPlayback = useCallback((taskId) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    if (task?.parkingPoints.some((p) => p.abx?.located === false || p.poses.some((pose) => pose.abx?.located === false))) {
      notify('该原生任务包含未定位的停车点或姿态，不能进行地图回放', 'warning'); return;
    }
    startTeachingPlayback(task);
  }, [startTeachingPlayback, teachingTasks, notify]);

  const pauseTeachingTaskPlayback = useCallback(() => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime || runtime.status !== 'playing') return;
    if (teachingPlaybackFrameRef.current !== null) {
      window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
    }
    teachingPlaybackFrameRef.current = null;
    runtime.status = 'paused';
    runtime.lastTimestamp = null;
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime, 'paused'));
  }, []);

  const resumeTeachingTaskPlayback = useCallback(() => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime || runtime.status !== 'paused') return;
    runtime.status = 'playing';
    runtime.lastTimestamp = null;
    setHeightRangeCollapsed(true);
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime, 'playing'));
    teachingPlaybackFrameRef.current = window.requestAnimationFrame(advanceTeachingPlayback);
  }, [advanceTeachingPlayback]);

  const stopTeachingTaskPlayback = useCallback((announce = true) => {
    const runtime = teachingPlaybackRuntimeRef.current;
    const wasRunning = Boolean(runtime && ['playing', 'paused'].includes(runtime.status));
    if (teachingPlaybackFrameRef.current !== null) {
      window.cancelAnimationFrame(teachingPlaybackFrameRef.current);
    }
    teachingPlaybackFrameRef.current = null;
    teachingPlaybackRuntimeRef.current = null;
    setTeachingPlayback(createIdleTeachingPlayback());
    if (announce && wasRunning) notify('示教轨迹播放已停止，机器人保留在当前位置', 'info');
  }, [notify]);

  const openRobotPreset = (presetId = null) => {
    if (!robotPresetReady) return;
    const preset = presetId ? latestWorkspaceRef.current.jointPoses.find((pose) => pose.id === presetId) : null;
    if (presetId && (!isRobotJointPreset(preset) || !presetMatchesRobot(preset, selectedRobot))) {
      throw new Error('预设姿态或机器人已变化，请重新选择');
    }
    const values = preset ? robotPresetValuesForEditing(preset, robotPresetJoints) : { ...robotJointValues };
    robotPresetReturnFocusRef.current = robotPresetManager ? document.activeElement : robotMenuButtonRef.current;
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    setRobotPresetDraft({
      id: preset?.id || createId('joint-pose'),
      mode: preset ? 'edit' : 'new',
      name: preset?.name || '',
      mapId: mapData?.mapId,
      robot: selectedRobot,
      joints: robotPresetJoints,
      values,
    });
  };

  const openRobotPresetManager = () => {
    if (!robotPresetManagerReady) return;
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    setRobotPresetManager({ mapId: mapData.mapId, teachingSpaceMode });
  };

  const openRobotJointLimits = () => {
    if (robotJointLimitsDisabledReason) return;
    setRobotControlEnabled(false);
    setRobotJointLimitDraft({ robot: selectedRobot, mapId: mapData?.mapId, teachingSpaceMode,
      ratio: robotArmSoftLimitRatio, overrides: robotArmSoftLimitOverrides,
      joints: robotLoadState.movableJoints.filter((joint) => joint.softLimitRatio), values: { ...robotJointValues } });
  };
  const applyRobotJointLimits = async ({ ratio, overrides }) => {
    const current = latestWorkspaceRef.current;
    if (robotJointLimitsDisabledReason || !robotJointLimitDraft || current.selectedRobot !== robotJointLimitDraft.robot
      || current.mapData?.mapId !== robotJointLimitDraft.mapId || current.teachingSpaceMode !== robotJointLimitDraft.teachingSpaceMode) {
      throw new Error('当前工程或机器人状态已变化，请重新打开软限位设置。');
    }
    const normalized = normalizeArmSoftLimitOverrides(overrides);
    const normalizedRatio = normalizeArmSoftLimitRatio(ratio);
    latestWorkspaceRef.current = { ...current, robotArmSoftLimitRatio: normalizedRatio, robotArmSoftLimitOverrides: normalized };
    setRobotArmSoftLimitRatio(normalizedRatio);
    setRobotArmSoftLimitOverrides(normalized);
    await persistWorkspaceNow();
    if (!sessionReadyRef.current) throw new Error('设置已应用，尚未持久保存，请将工程另存为备份。');
    setRobotJointLimitDraft(null);
  };

  const persistRobotPresetChanges = async (current, next) => {
    latestWorkspaceRef.current = { ...current, jointPoses: next };
    setJointPoses(next);
    await persistWorkspaceNow();
    if (!sessionReadyRef.current) throw new Error('预设变更尚未持久保存，请先将工程另存为备份');
  };

  const robotPresetManagerContext = (id) => {
    const current = latestWorkspaceRef.current;
    if (!robotPresetManager || !robotPresetManagerReady || !sessionReadyRef.current || workspaceSwitchingRef.current
      || current.mapData?.mapId !== robotPresetManager.mapId
      || current.teachingSpaceMode !== robotPresetManager.teachingSpaceMode) {
      throw new Error('当前工程已变化或尚未就绪，请重新打开预设姿态管理');
    }
    const pose = current.jointPoses.find((item) => item.id === id && isRobotJointPreset(item));
    if (!pose) throw new Error('该预设姿态已不存在，请重新选择');
    return { current, pose };
  };

  const renameRobotPreset = async (id, requestedName) => {
    const { current, pose } = robotPresetManagerContext(id);
    const name = validateRobotPresetName(requestedName, current.jointPoses, pose.robot, id);
    if (name === pose.name) return;
    await persistRobotPresetChanges(current, current.jointPoses.map((item) => item.id === id
      ? { ...item, name, updatedAt: new Date().toISOString() } : item));
  };

  const deleteRobotPreset = async (id) => {
    const { current } = robotPresetManagerContext(id);
    await persistRobotPresetChanges(current, current.jointPoses.filter((pose) => pose.id !== id)
      .map((pose, index) => ({ ...pose, sequence: index + 1 })));
  };

  const saveRobotPreset = async ({ name, values, apply = false }) => {
    const current = latestWorkspaceRef.current;
    if (!robotPresetDraft || !robotPresetReady || !sessionReadyRef.current
      || !presetMatchesRobot(robotPresetDraft, current.selectedRobot)
      || current.mapData?.mapId !== robotPresetDraft.mapId) {
      throw new Error('当前工程或机器人已变化，请重新打开预设姿态窗口');
    }
    const previous = current.jointPoses.find((pose) => pose.id === robotPresetDraft.id);
    if (robotPresetDraft.mode === 'edit' && !isRobotJointPreset(previous)) {
      throw new Error('该预设姿态已不存在，请重新选择');
    }
    const pose = { ...previous, ...createRobotJointPreset({
      id: robotPresetDraft.id,
      name: validateRobotPresetName(name, current.jointPoses, current.selectedRobot, robotPresetDraft.id),
      robot: current.selectedRobot,
      joints: robotPresetDraft.joints, values,
      sequence: previous?.sequence || current.jointPoses.length + 1,
    }) };
    if (previous) pose.createdAt = previous.createdAt;
    const next = previous
      ? current.jointPoses.map((item) => item.id === pose.id ? pose : item)
      : [...current.jointPoses, pose];
    await persistRobotPresetChanges(current, next);
    if (apply) {
      const latest = latestWorkspaceRef.current;
      if (latest.mapData?.mapId !== current.mapData?.mapId || latest.teachingSpaceMode !== current.teachingSpaceMode
        || !applyRobotPreset(pose.id, { announce: false })) {
        throw new Error('姿态已保存，但当前工程或机器人已变化，请从机器人菜单重新应用');
      }
    }
    closeRobotPreset();
    notify(apply ? `${pose.name} 已保存并应用到机器人` : `${pose.name} 已保存，可从机器人菜单直接应用`, 'success');
  };

  const applyRobotPreset = (id, { announce = true } = {}) => {
    const current = latestWorkspaceRef.current;
    if (!robotPresetReady || !sessionReadyRef.current || workspaceSwitchingRef.current
      || !current.jointPoses.some((pose) => pose.id === id && isRobotJointPreset(pose)
        && presetMatchesRobot(pose, current.selectedRobot))) return false;
    stopTeachingTaskPlayback(false);
    setRobotParkingGhost(null);
    setShowRobotModel(true);
    return applyJointPose(id, { announce });
  };

  const applyTeachingParkingPoint = useCallback(
    (taskId, parkingPointId, poseId = null) => {
      const task = teachingTasks.find((item) => item.id === taskId);
      const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
      const pose = poseId ? parkingPoint?.poses?.find((item) => item.id === poseId) : null;
      if (!task || !parkingPoint || (poseId && !pose)) return;
      if (parkingPoint.abx?.located === false || pose?.abx?.located === false) {
        notify('该原生停车点没有 map 定位，不能恢复底盘位置', 'warning'); return;
      }
      if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
        notify('当前地图或机器人与该停车点不一致，无法应用', 'warning');
        return;
      }
      stopTeachingTaskPlayback(false);
      setRobotControlEnabled(false);
      setRobotPose(normalizeRobotPose(pose?.abx ? pose.mapPose : parkingPoint.mapPose));
      if (pose) setRobotJointValues(normalizeRobotJointValues(pose.fullBodyJoints?.values));
      setActiveTeachingTaskId(task.id);
      setActiveTeachingParkingPointId(parkingPoint.id);
      setTeachingCaptureState({ status: 'idle', message: '' });
      setRobotParkingGhost(null);
      requestSynchronizedFocus('robot', selectedRobot?.id || selectedRobot?.relativePath || 'active-robot');
      notify(
        pose
          ? `已移动到 ${parkingPoint.name} 并应用 ${pose.name} · 可继续示教操作并记录姿态`
          : `已移动到 ${parkingPoint.name} · 可继续示教操作并记录姿态`,
        'success',
      );
    },
    [
      notify,
      requestSynchronizedFocus,
      robotLoadState.status,
      selectedRobot,
      stopTeachingTaskPlayback,
      teachingContextMatches,
      teachingTasks,
    ],
  );

  const applyTeachingUpperBodyPose = useCallback((taskId, parkingPointId, poseId) => {
    const task = latestWorkspaceRef.current.teachingTasks.find((item) => item.id === taskId);
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
    const pose = parkingPoint?.poses?.find((item) => item.id === poseId);
    if (!pose) return;
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('当前地图或机器人与该姿态不一致，无法应用', 'warning');
      return;
    }
    if (teachingCaptureBusyRef.current) {
      notify('请等待当前姿态采集完成后再执行上身姿态', 'warning');
      return;
    }
    let values;
    try {
      const savedValues = robotPresetValuesForEditing({ joints: pose.fullBodyJoints }, robotPresetJoints);
      values = Object.fromEntries(robotPresetJoints.flatMap((joint) => (
        Number.isFinite(savedValues[joint.name])
          ? [[joint.name, clampJointValue(savedValues[joint.name], joint)]] : []
      )));
    } catch (error) {
      notify(error.message || '无法读取上身姿态', 'warning');
      return;
    }
    if (!Object.keys(values).length) {
      notify('该姿态没有与当前机器人匹配的上身关节', 'warning');
      return;
    }
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    // Apply the same non-wheel joints as robot presets without changing the base pose.
    setRobotJointValues((current) => ({ ...current, ...values }));
    setShowRobotModel(true);
    setTeachingCaptureState({ status: 'idle', message: '' });
    clearRobotParkingGhost();
    requestSynchronizedFocus('robot', selectedRobot?.id || selectedRobot?.relativePath || 'active-robot');
    notify(`${pose.name} 上身姿态已应用 · 当前位置和底盘朝向保持不变`, 'success');
  }, [clearRobotParkingGhost, notify, requestSynchronizedFocus, robotLoadState.status,
    robotPresetJoints, selectedRobot, stopTeachingTaskPlayback, teachingContextMatches]);

  const moveRobotToNavigationPoint = useCallback((point) => {
    if (!point || !selectedRobot || robotLoadState.status !== 'loaded' || loadState.loading) return;
    if (teachingCaptureBusyRef.current) {
      notify('请等待当前姿态采集完成后再移动机器人', 'warning');
      return;
    }
    const target = waypointRobotPose(point, latestWorkspaceRef.current.robotPose.position.z);
    if (!target) {
      notify('转换矩阵使地图竖直方向平行于当前高度平面，无法保持高度移动到该点，请检查转换矩阵', 'warning');
      return;
    }
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    clearRobotParkingGhost();
    setShowRobotModel(true);
    // Navigation coordinates describe the route, while the base height is
    // calibrated independently for the loaded robot. Respect both frames.
    setRobotPose(normalizeRobotPose(target));
    setRobotWaypointLocation(point.id ? {
      waypointId: point.id,
      sourceWaypointId: point.source === TEMPORARY_MAP_ROUTE_SOURCE ? point.sourceWaypointId : null,
      mapId: latestWorkspaceRef.current.mapData?.mapId,
      teachingSpaceMode: latestWorkspaceRef.current.teachingSpaceMode,
      robotKey: selectedRobot.id || selectedRobot.relativePath,
    } : null);
    requestSynchronizedFocus('robot', selectedRobot.id || selectedRobot.relativePath);
    notify(`已运动到 ${point.name}，底盘朝向已对齐，Z 高度保持不变`, 'success');
  }, [clearRobotParkingGhost, loadState.loading, notify, requestSynchronizedFocus,
    robotLoadState.status, selectedRobot, stopTeachingTaskPlayback]);

  const moveRobotToWaypoint = useCallback((id) => {
    moveRobotToNavigationPoint(latestWorkspaceRef.current.waypoints.find((point) => point.id === id));
  }, [moveRobotToNavigationPoint]);

  const moveRobotToMapOrigin = useCallback(() => {
    const pose = normalizeRobotPose(visibleMapOriginPose);
    // The transformed map Z axis matters when navigating a tilted local frame.
    const up = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(
      ...['roll', 'pitch', 'yaw'].map((axis) => THREE.MathUtils.degToRad(pose.rpy[axis])), 'ZYX',
    ));
    moveRobotToNavigationPoint({ name: '地图原点', pose: parkingWaypointPose(pose),
      source: TEMPORARY_MAP_ROUTE_SOURCE, navigationUp: { x: up.x, y: up.y, z: up.z } });
  }, [moveRobotToNavigationPoint, visibleMapOriginPose]);

  const beginTeachingParkingPointEdit = useCallback((taskId, parkingPointId) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
    if (
      !parkingPoint
      || robotParkingGhost?.taskId !== taskId
      || robotParkingGhost?.parkingPointId !== parkingPointId
      || robotParkingGhost.poseId
    ) return;
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('请加载与该停车点匹配的地图和机器人后再修改位置', 'warning');
      return;
    }
    if (teachingCaptureBusyRef.current) {
      notify('请等待当前姿态采集完成后再修改停车点', 'warning');
      return;
    }
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(true);
    setRobotPose(normalizeRobotPose(parkingPoint.mapPose));
    setActiveTeachingTaskId(taskId);
    setActiveTeachingParkingPointId(parkingPointId);
    setTeachingCaptureState({ status: 'idle', message: '' });
    setRobotParkingGhost((current) => current && { ...current, editing: true });
    requestSynchronizedFocus('robot-ghost', parkingPointId);
    notify('WASD 调整停车位置 · ←/→ 调整朝向 · 点击“录入新位置”保存，Esc 取消', 'info');
  }, [
    notify,
    requestSynchronizedFocus,
    robotLoadState.status,
    robotParkingGhost,
    stopTeachingTaskPlayback,
    teachingContextMatches,
    teachingTasks,
  ]);

  const beginTeachingPoseEdit = useCallback((taskId, parkingPointId, poseId) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
    const pose = parkingPoint?.poses?.find((item) => item.id === poseId);
    if (
      !pose
      || robotParkingGhost?.taskId !== taskId
      || robotParkingGhost?.parkingPointId !== parkingPointId
      || robotParkingGhost?.poseId !== poseId
    ) return;
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('请加载与该姿态匹配的地图和机器人后再调整', 'warning');
      return;
    }
    if (teachingCaptureBusyRef.current) {
      notify('请等待当前姿态采集完成后再调整姿态', 'warning');
      return;
    }
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    const targetPose = normalizeRobotPose(parkingPoint.mapPose);
    const jointValues = normalizeRobotJointValues(pose.fullBodyJoints?.values);
    setRobotPose(targetPose);
    setRobotJointValues(jointValues);
    setActiveTeachingTaskId(taskId);
    setActiveTeachingParkingPointId(parkingPointId);
    setTeachingCaptureState({ status: 'idle', message: '' });
    setRobotParkingGhost((current) => current && {
      ...current,
      editing: true,
      targetPose,
      jointValues: { ...jointValues },
      revision: createId('robot-parking-ghost'),
    });
    requestSynchronizedFocus('robot-ghost', parkingPointId);
    notify(`正在调整 ${parkingPoint.name} / ${pose.name} · 点击“确认修改”保存，Esc 取消`, 'info');
  }, [
    notify,
    requestSynchronizedFocus,
    robotLoadState.status,
    robotParkingGhost,
    stopTeachingTaskPlayback,
    teachingContextMatches,
    teachingTasks,
  ]);

  const cancelTeachingPreviewEdit = useCallback(() => {
    if (!robotParkingGhost?.editing) return;
    setRobotControlEnabled(false);
    setRobotPose(normalizeRobotPose(robotParkingGhost.targetPose));
    if (robotParkingGhost.poseId) {
      setRobotJointValues(normalizeRobotJointValues(robotParkingGhost.jointValues));
    }
    setRobotParkingGhost((current) => current && { ...current, editing: false });
    notify(robotParkingGhost.poseId ? '已取消姿态修改，恢复原关节姿态' : '已取消停车点修改，恢复原停车位置', 'info');
  }, [notify, robotParkingGhost]);

  const recordTeachingParkingPointPosition = useCallback((taskId, parkingPointId, nextPose) => {
    const task = teachingTasks.find((item) => item.id === taskId);
    const parkingPoint = task?.parkingPoints?.find((item) => item.id === parkingPointId);
    if (
      !parkingPoint
      || !robotParkingGhost?.editing
      || robotParkingGhost.taskId !== taskId
      || robotParkingGhost.parkingPointId !== parkingPointId
      || robotParkingGhost.poseId
    ) return;
    if (robotLoadState.status !== 'loaded' || !teachingContextMatches(task)) {
      notify('当前地图或机器人与该停车点不一致，无法录入新位置', 'warning');
      return;
    }
    const targetPose = normalizeRobotPose(nextPose);
    const updatedAt = new Date().toISOString();
    const mapPose = {
      ...parkingPoint.mapPose,
      frameId: parkingPoint.mapPose?.frameId || coordinateFrame,
      position: { ...targetPose.position },
      rpy: { ...targetPose.rpy },
    };
    setTeachingTasks((current) => current.map((item) => item.id !== taskId ? item : {
      ...item,
      updatedAt,
      parkingPoints: item.parkingPoints.map((point) => point.id !== parkingPointId ? point : {
        ...point,
        mapPose,
        updatedAt,
        poses: (point.poses || []).map((pose) => ({
          ...pose,
          updatedAt,
          mapPose: {
            ...pose.mapPose,
            frameId: mapPose.frameId,
            position: { ...targetPose.position },
            rpy: { ...targetPose.rpy },
          },
        })),
      }),
    }));
    setRobotControlEnabled(false);
    setRobotPose(targetPose);
    setRobotParkingGhost((current) => current && {
      ...current,
      editing: false,
      targetPose,
      revision: createId('robot-parking-ghost'),
    });
    notify(`${parkingPoint.name} 新位置已录入 · 所属姿态的基座位置已同步`, 'success');
  }, [
    coordinateFrame,
    notify,
    robotLoadState.status,
    robotParkingGhost,
    teachingContextMatches,
    teachingTasks,
  ]);

  const changeTeachingPlaybackSpeed = useCallback((requestedSpeed) => {
    const speed = [0.5, 1, 1.5, 2, 5].includes(Number(requestedSpeed))
      ? Number(requestedSpeed)
      : 1;
    const runtime = teachingPlaybackRuntimeRef.current;
    if (runtime) runtime.speed = speed;
    setTeachingPlayback((current) => ({ ...current, speed }));
  }, []);

  const changeTeachingPlaybackFollowRobot = useCallback((enabled) => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime) return;
    runtime.followRobot = Boolean(enabled);
    setTeachingPlayback(teachingPlaybackStateFromRuntime(runtime));
  }, []);

  useEffect(() => {
    if (appPage !== APP_PAGE_WORKBENCH) pauseTeachingTaskPlayback();
  }, [appPage, pauseTeachingTaskPlayback]);

  useEffect(() => {
    if (appPage !== APP_PAGE_WORKBENCH) return undefined;
    const onKeyDown = (event) => {
      const isSpace = event.code === 'Space' || event.key === ' ';
      const isEscape = event.code === 'Escape' || event.key === 'Escape';
      const runtime = teachingPlaybackRuntimeRef.current;
      if (
        (!isSpace && !isEscape)
        || !runtime
        || !['playing', 'paused'].includes(runtime.status)
        || event.defaultPrevented
        || event.isComposing
        || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      ) return;

      const target = event.target;
      if (
        target?.isContentEditable
        || target?.closest?.('input, textarea, select, [role="textbox"]')
        || document.querySelector('[aria-modal="true"], dialog[open]')
      ) return;
      // Focused controls keep native Space activation, including pause/resume.
      if (isSpace && target?.closest?.('button, a[href], [role="button"], [role="switch"]')) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (isEscape) stopTeachingTaskPlayback();
      else if (runtime.status === 'playing') pauseTeachingTaskPlayback();
      else resumeTeachingTaskPlayback();
    };
    // Handle playback before the viewer's window listener can dismiss a ghost.
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [appPage, pauseTeachingTaskPlayback, resumeTeachingTaskPlayback, stopTeachingTaskPlayback]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState !== 'visible') pauseTeachingTaskPlayback();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [pauseTeachingTaskPlayback]);

  useEffect(() => {
    const runtime = teachingPlaybackRuntimeRef.current;
    if (!runtime) return;
    const mapId = mapData?.mapId || mapData?.sourceHash || mapData?.name || '';
    const robotId = selectedRobot?.id || selectedRobot?.relativePath || '';
    const preview = runtime.mobilePreview;
    const source = preview && teachingTasks.find((task) => task.id === preview.taskId);
    if (
      robotLoadState.status !== 'loaded'
      || runtime.context.mapId !== mapId
      || runtime.context.robotId !== robotId
      || (preview && (source?.mobileSolve !== preview.report || source?.mobileCapture !== preview.capture
        || JSON.stringify(source?.mobileTransform) !== preview.transform))
    ) {
      stopTeachingTaskPlayback(false);
    }
  }, [
    mapData?.mapId,
    mapData?.name,
    mapData?.sourceHash,
    robotLoadState.status,
    selectedRobot,
    teachingTasks,
    stopTeachingTaskPlayback,
  ]);

  const modeOptions = [
    { id: 'select', label: '选择 / 漫游', icon: MousePointer2 },
    { id: 'box', label: '框选', icon: ScanLine },
    { id: 'add', label: '添加导航点', icon: Plus },
    { id: 'connect', label: '连接路径', icon: GitBranch },
  ];

  const hasWorkspace = Boolean(
    mapData
    || selectedRobot
    || waypoints.length
    || edges.length
    || teachingTasks.length
    || jointPoses.length,
  );
  const liveWorkspaceSummary = hasWorkspace
    ? {
        available: true,
        mode: teachingSpaceMode,
        mapId: mapData?.mapId || null,
        mapName: projectDirectoryState.name || mapData?.name || selectedRobot?.name || '未命名工作现场',
        teachingName: isIndependentTeachingSpace ? independentTeachingName : '',
        pointCount: Number(mapData?.pointCount) || 0,
        faceCount: Number(mapData?.faceCount) || 0,
        waypointCount: waypoints.length,
        edgeCount: edges.length,
        taskCount: teachingTasks.length,
        robotName: selectedRobot?.name || '',
        savedAt: Date.now(),
      }
    : null;
  const workspaceCatalog = {
    map: cachedWorkspaces.map,
    independent: cachedWorkspaces.independent,
    [teachingSpaceMode]: liveWorkspaceSummary,
  };

  useEffect(() => {
    if (sessionState.status !== 'ready' || !liveWorkspaceSummary) return;
    setCachedWorkspaces((current) => {
      const previous = current[teachingSpaceMode];
      if (
        previous?.mapId === liveWorkspaceSummary.mapId
        && previous?.mapName === liveWorkspaceSummary.mapName
        && previous?.teachingName === liveWorkspaceSummary.teachingName
        && previous?.pointCount === liveWorkspaceSummary.pointCount
        && previous?.waypointCount === liveWorkspaceSummary.waypointCount
        && previous?.edgeCount === liveWorkspaceSummary.edgeCount
        && previous?.taskCount === liveWorkspaceSummary.taskCount
        && previous?.robotName === liveWorkspaceSummary.robotName
      ) return current;
      return { ...current, [teachingSpaceMode]: liveWorkspaceSummary };
    });
  }, [
    liveWorkspaceSummary?.edgeCount,
    liveWorkspaceSummary?.mapId,
    liveWorkspaceSummary?.mapName,
    liveWorkspaceSummary?.teachingName,
    liveWorkspaceSummary?.pointCount,
    liveWorkspaceSummary?.robotName,
    liveWorkspaceSummary?.taskCount,
    liveWorkspaceSummary?.waypointCount,
    sessionState.status,
    teachingSpaceMode,
  ]);

  const activateCachedWorkspace = async (requestedMode, destination = APP_PAGE_WORKBENCH, selectedWorkspace = null) => {
    if (loadState.loading || workspaceSwitchingRef.current) return;
    const targetMode = normalizeTeachingSpaceMode(requestedMode);
    const targetWorkspace = selectedWorkspace || workspaceCatalog[targetMode];
    if (!targetWorkspace?.available) {
      navigateAppPage(APP_PAGE_HOME, { teachingSpaceMode: targetMode });
      notify(`尚未打开${teachingModeLabel(targetMode)}工程，请在主页面新建或加载工程`, 'info');
      return;
    }
    if (targetMode === teachingSpaceMode && hasWorkspace) {
      navigateAppPage(destination);
      return;
    }
    if (!sessionReadyRef.current || !sessionIdRef.current) {
      notify('工作会话尚未就绪，请稍候', 'warning');
      return;
    }
    if (sessionSaveTimerRef.current) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    setLoadState({
      loading: true,
      progress: 0.65,
      phase: targetMode === 'independent' ? '切换独立示教缓存' : '切换地图示教缓存',
      detail: targetWorkspace.mapName || '正在恢复工作现场',
    });
    try {
      const saved = persistWorkspaceNow();
      workspaceSwitchingRef.current = true;
      await saved;
      if (!sessionReadyRef.current) throw new Error('当前工程尚未保存成功，请重试');
      await activateWorkspaceMode(sessionIdRef.current, targetMode, selectedWorkspace?.mapId);
      const targetPath = destination === APP_PAGE_TEACHING_DATA
        ? '/teaching-data'
        : '/workbench';
      window.location.assign(targetPath);
    } catch (error) {
      workspaceSwitchingRef.current = false;
      setLoadState({ loading: false, progress: 0, phase: '' });
      const message = error?.message || '工作缓存切换失败';
      setIndependentWorkspaceDialog((current) => current ? { ...current, busy: false, error: message } : null);
      notify(message, 'error');
    }
  };

  const continueWorkspace = async (requestedMode, destination = APP_PAGE_WORKBENCH) => {
    if (loadState.loading || workspaceSwitchingRef.current || independentChoiceLoadingRef.current
      || independentWorkspaceDialog || newIndependentDialog) return;
    const targetMode = normalizeTeachingSpaceMode(requestedMode);
    if (teachingSpaceMode !== 'map' || targetMode !== 'independent' || !sessionReadyRef.current) {
      return activateCachedWorkspace(targetMode, destination);
    }
    independentChoiceLoadingRef.current = true;
    try {
      const entries = await listIndependentWorkspaces(sessionIdRef.current);
      if (entries.length > 1) {
        setIndependentWorkspaceDialog({ entries, destination, busy: false, error: '' });
      } else if (entries[0]?.historyId) {
        if (independentSwitchBlocked) {
          notify('请等待当前操作完成后再切换独立示教', 'info');
          return;
        }
        await restoreIndependentHistory(entries[0].historyId, destination);
      } else if (!entries.length && appPage === APP_PAGE_WORKBENCH && mapData?.geometry) {
        if (independentSwitchBlocked) {
          notify('请等待当前操作完成后再新增独立示教', 'info');
          return;
        }
        await openNewIndependentDialog();
      } else {
        await activateCachedWorkspace(targetMode, destination, entries[0] || null);
      }
    } catch (error) {
      notify(error?.message || '无法读取独立示教列表，请重试', 'error');
    } finally {
      independentChoiceLoadingRef.current = false;
    }
  };

  const chooseIndependentWorkspace = (entry) => {
    if (!independentWorkspaceDialog || independentWorkspaceDialog.busy || independentSwitchBlocked
      || workspaceSwitchingRef.current) return;
    const destination = independentWorkspaceDialog.destination;
    setIndependentWorkspaceDialog((current) => ({
      ...current, busy: true, selectedId: entry.historyId || 'current', error: '',
    }));
    if (entry.historyId) restoreIndependentHistory(entry.historyId, destination);
    else activateCachedWorkspace('independent', destination, entry);
  };

  const closeProjectLoadDialog = useCallback(() => {
    projectLoadDialogRevisionRef.current += 1;
    setProjectLoadDialog((current) => ({ ...current, open: false }));
  }, []);

  useEffect(() => {
    if (!projectLoadDialog.open || projectLoadDialog.mode !== 'independent') return undefined;
    let cancelled = false;
    setIndependentHistory({ status: 'loading', entries: [] });
    listIndependentWorkspaces(sessionIdRef.current).then((entries) => {
      if (!cancelled) setIndependentHistory({ status: 'ready', entries });
    }).catch((error) => {
      if (!cancelled) setIndependentHistory({ status: 'error', entries: [], error: error.message });
    });
    return () => { cancelled = true; };
  }, [projectLoadDialog.open, projectLoadDialog.mode]);

  const openIndependentNameDialog = (entry) => {
    if (independentSwitchBlocked || independentSwitchBusyRef.current || workspaceSwitchingRef.current) return;
    setRobotControlEnabled(false);
    setIndependentNameDialog({ entry, busy: false, error: '' });
  };

  const renameIndependentTeaching = async (name) => {
    if (!independentNameDialog || independentSwitchBlocked || independentSwitchBusyRef.current || workspaceSwitchingRef.current) return;
    const { entry } = independentNameDialog;
    independentSwitchBusyRef.current = true;
    setIndependentNameDialog((current) => ({ ...current, busy: true, error: '' }));
    let savingCurrent = false;
    try {
      const current = latestWorkspaceRef.current;
      savingCurrent = !entry.historyId && current.teachingSpaceMode === 'independent' && current.mapData?.mapId === entry.mapId;
      if (savingCurrent) {
        if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
        const saved = persistWorkspaceNow();
        workspaceSwitchingRef.current = true;
        await saved;
        if (!sessionReadyRef.current) throw new Error('当前工程尚未保存成功，请重试');
      }
      const teachingName = await renameIndependentWorkspace(sessionIdRef.current, {
        historyId: entry.historyId, mapId: entry.mapId, expectedName: entry.teachingName, name,
      });
      if (savingCurrent) {
        latestWorkspaceRef.current = { ...latestWorkspaceRef.current, independentTeachingName: teachingName };
        setIndependentTeachingName(teachingName);
      }
      const updateEntries = (entries) => entries.map((item) => item.mapId === entry.mapId ? { ...item, teachingName } : item);
      setIndependentHistory((current) => ({ ...current, entries: updateEntries(current.entries) }));
      setIndependentWorkspaceDialog((current) => current ? { ...current, entries: updateEntries(current.entries) } : null);
      setCachedWorkspaces((current) => current.independent?.mapId === entry.mapId
        ? { ...current, independent: { ...current.independent, teachingName } } : current);
      setIndependentNameDialog(null);
      notify('独立示教名称已更新', 'success');
    } catch (error) {
      setIndependentNameDialog((current) => current ? { ...current, busy: false, error: error.message || '修改名称失败，请重试' } : null);
    } finally {
      if (savingCurrent) workspaceSwitchingRef.current = false;
      independentSwitchBusyRef.current = false;
    }
  };

  const restoreIndependentHistory = async (historyId, destination = APP_PAGE_WORKBENCH) => {
    if (independentSwitchBlocked || independentSwitchBusyRef.current || workspaceSwitchingRef.current) return;
    independentSwitchBusyRef.current = true;
    setLoadState({ loading: true, progress: 0.5, phase: '恢复独立示教', detail: '先完整缓存当前独立工程，再恢复选中的缓存工程' });
    try {
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      const saved = persistWorkspaceNow();
      workspaceSwitchingRef.current = true;
      await saved;
      if (!sessionReadyRef.current) throw new Error('当前工程尚未保存成功，请重试');
      const archived = await prepareIndependentHistory();
      await switchIndependentWorkspace(sessionIdRef.current, {
        activeMode: latestWorkspaceRef.current.teachingSpaceMode, ...archived, historyId,
      });
      window.location.assign(destination === APP_PAGE_TEACHING_DATA ? '/teaching-data' : '/workbench');
    } catch (error) {
      workspaceSwitchingRef.current = false;
      independentSwitchBusyRef.current = false;
      setLoadState({ loading: false, progress: 0, phase: '' });
      const message = error?.message || '恢复独立示教失败，当前工程已保留';
      setIndependentWorkspaceDialog((current) => current ? { ...current, busy: false, error: message } : null);
      notify(message, 'error');
    }
  };

  const showProjectLoadDialog = useCallback(async (requestedMode = teachingSpaceMode) => {
    if (loadState.loading) return;
    const targetMode = normalizeTeachingSpaceMode(requestedMode);
    const revision = projectLoadDialogRevisionRef.current + 1;
    projectLoadDialogRevisionRef.current = revision;
    setProjectLoadDialog({
      open: true,
      mode: targetMode,
      directory: { status: 'checking' },
    });

    try {
      const activeBinding = projectDirectoryRef.current;
      const activeBindingMode = normalizeTeachingSpaceMode(
        activeBinding?.teachingSpaceMode || teachingSpaceMode,
      );
      const binding = activeBinding?.handle && activeBindingMode === targetMode
        ? activeBinding
        : await loadProjectDirectoryBinding(targetMode);
      if (projectLoadDialogRevisionRef.current !== revision) return;
      if (!binding?.handle) {
        setProjectLoadDialog({
          open: true,
          mode: targetMode,
          directory: { status: 'missing' },
        });
        return;
      }

      let permission = 'prompt';
      let permissionError = '';
      try {
        const { queryProjectDirectoryPermission } = await import('./lib/projectArchive.js');
        permission = await queryProjectDirectoryPermission(binding.handle, false);
      } catch (error) {
        permissionError = error?.message || '目录权限状态暂时不可用';
      }
      if (projectLoadDialogRevisionRef.current !== revision) return;
      setProjectLoadDialog({
        open: true,
        mode: targetMode,
        directory: {
          status: 'available',
          handle: binding.handle,
          name: binding.name || binding.handle.name || '工程目录',
          savedAt: binding.savedAt || binding.manifest?.updatedAt || null,
          permission,
          error: permissionError,
        },
      });
    } catch (error) {
      if (projectLoadDialogRevisionRef.current !== revision) return;
      setProjectLoadDialog({
        open: true,
        mode: targetMode,
        directory: {
          status: 'error',
          error: error?.message || '无法检查默认保存路径',
        },
      });
    }
  }, [loadState.loading, teachingSpaceMode]);

  const loadDefaultProjectDirectory = async () => {
    const targetMode = projectLoadDialog.mode;
    const candidate = projectLoadDialog.directory;
    if (candidate?.status !== 'available' || !candidate.handle) {
      notify('默认保存路径当前不可用，请选择其他工程目录', 'warning');
      return;
    }

    let permission = candidate.permission;
    if (permission !== 'granted') {
      try {
        const permissionRequest = typeof candidate.handle.requestPermission === 'function'
          ? candidate.handle.requestPermission({ mode: 'readwrite' })
          : Promise.resolve('granted');
        permission = await permissionRequest;
      } catch (error) {
        permission = 'denied';
        console.warn('默认工程目录授权失败', error);
      }
    }
    if (permission !== 'granted') {
      setProjectLoadDialog((current) => ({
        ...current,
        directory: { ...current.directory, permission },
      }));
      notify('未获得默认工程目录的读写权限', 'warning');
      return;
    }

    closeProjectLoadDialog();
    await applyImportedProject(async (onProgress) => {
      const { readProjectDirectoryHandle } = await import('./lib/projectArchive.js');
      return readProjectDirectoryHandle(candidate.handle, {
        onProgress,
        requestPermission: false,
      });
    }, candidate.name || '默认工程目录', targetMode);
  };

  const loadAutoSavedProject = () => {
    const targetMode = projectLoadDialog.mode;
    closeProjectLoadDialog();
    // This action already explicitly selects the active auto-save.
    activateCachedWorkspace(targetMode, APP_PAGE_WORKBENCH);
  };

  const loadRecoveryProject = () => {
    const targetMode = projectLoadDialog.mode;
    closeProjectLoadDialog();
    openLastProject(targetMode);
  };

  const chooseProjectDirectory = () => {
    const { mode: targetMode, directory } = projectLoadDialog;
    closeProjectLoadDialog();
    openProjectDirectory(targetMode, directory?.handle);
  };

  const chooseProjectGuideFile = async () => {
    const targetMode = projectLoadDialog.mode;
    closeProjectLoadDialog();
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [handle] = await window.showOpenFilePicker({
          id: `atlas-project-guide-${targetMode}`,
          multiple: false,
          excludeAcceptAllOption: true,
          types: [{
            description: '示教工程（JSON / ZIP）',
            accept: {
              'application/json': ['.json'],
              'application/zip': ['.zip'],
            },
          }],
        });
        if (handle) await loadProjectGuideFile(await handle.getFile(), targetMode);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        if (!['SecurityError', 'NotSupportedError'].includes(error?.name)) {
          setProjectImportError({ sourceName: '工程文件', mode: targetMode,
            message: error?.message || '无法读取所选文件' });
          return;
        }
      }
    }
    projectGuideModeRef.current = targetMode;
    pathInputRef.current?.click();
  };

  const openTeachingTransfer = async () => {
    if (loadState.loading || teachingTransferBusyRef.current || teachingCaptureBusyRef.current) return;
    const operation = teachingSpaceMode === 'map' ? 'extract'
      : workspaceTransfer?.kind === 'extraction' ? 'writeback' : 'place';
    setTeachingTransferDialog({ operation, loading: true, busy: false, error: '' });
    setRobotControlEnabled(false);
    stopTeachingTaskPlayback(false);
    try {
      await waitForPaint();
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      await persistWorkspaceNow();
      if (!sessionReadyRef.current) throw new Error('当前工程尚未保存成功，请重试后再转换');
      const [source, target] = await Promise.all([
        loadWorkspaceSnapshot(sessionIdRef.current, teachingSpaceMode),
        loadWorkspaceSnapshot(sessionIdRef.current, alternateTeachingMode),
      ]);
      if (!(source.map?.positionBuffer instanceof ArrayBuffer) || !source.config?.config?.project) {
        throw new Error('请先打开包含完整点云的工程，再进行示教转换');
      }
      setTeachingTransferDialog((current) => current ? { ...current, loading: false, source, target } : null);
    } catch (error) {
      setTeachingTransferDialog((current) => current ? { ...current, loading: false, error: error.message } : null);
    }
  };

  const switchTeachingSource = (source) => {
    if (source === teachingDevice || teachingCaptureState.status === 'capturing') return;
    const tasks = source === 'desktop' ? desktopTeachingTasks : mobileTasksByDevice[source];
    if (!tasks) return;
    const saved = teachingSourceSelectionsRef.current.get(`${teachingSpaceMode}:${mapData?.mapId}:${source}`);
    const task = tasks.find((item) => item.id === saved?.taskId) || tasks[0];
    stopTeachingTaskPlayback(false);
    selectTeachingTask(task?.id || null, saved?.parkingPointId);
  };

  const openIPadTeaching = (entry) => {
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    setIPadTeachingEntry(entry);
    setIPadTeachingOpen(true);
  };

  const selectMobilePose = (taskId, sampleId) => {
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    setMobileComputation((current) => current ? { ...current, preview: null, followLatest: false } : current);
    selectTeachingTask(taskId);
    setMobilePoseSelection({ taskId, sampleId });
    requestSynchronizedFocus('mobile-pose', sampleId);
  };

  const openMobileRobotPose = (parkingPointId, poseId) => {
    stopTeachingTaskPlayback(false);
    setShowRobotModel(true);
    setMobilePoseSelection(null);
    previewTeachingParkingPoint(parkingPointId, poseId);
    navigateAppPage(APP_PAGE_WORKBENCH);
  };

  const openMobileSource = (taskId) => {
    if (!teachingTasks.some((task) => task.id === taskId && task.mobileCapture)) {
      notify('来源采样任务不在当前工程中；已保存的机器人姿态仍可编辑', 'info');
      return;
    }
    stopTeachingTaskPlayback(false);
    selectTeachingTask(taskId);
  };

  const openMobileTeachingSolve = (taskId, sampleId = null) => {
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    setMobileSolveSampleId(sampleId);
    setMobileSolveTaskId(taskId);
  };

  const mobileSolveContext = (taskId, report = null) => {
    const current = latestWorkspaceRef.current;
    const task = current.teachingTasks.find((item) => item.id === taskId);
    if (!task?.mobileCapture) throw new Error('设备示教任务不存在');
    const sameMap = task.map?.sourceHash && current.mapData?.sourceHash
      ? task.map.sourceHash === current.mapData.sourceHash : task.map?.fileName === current.mapData?.name;
    if (!sameMap || task.coordinateFrame !== teachingCoordinateFrame(current.teachingSpaceMode)) throw new Error('请打开该采样任务对应的工程');
    if (!current.selectedRobot || robotLoadState.status !== 'loaded') throw new Error('请先加载机器人模型');
    if (report && (report.robot?.id !== (current.selectedRobot.id || current.selectedRobot.relativePath)
      || report.captureId !== task.mobileCapture.id || task.mobileSolve?.computedAt !== report.computedAt)) {
      throw new Error('机器人或采样数据已变化，请重新计算');
    }
    if (report && report.armJointCouplingEnabled !== current.robotArmJointCouplingEnabled) {
      throw new Error('关节6–7角度耦合设置与该报告不一致，请重新计算');
    }
    return { current, task };
  };

  const calculateMobileTeaching = (taskId, rawOptions) => {
    const { current, task } = mobileSolveContext(taskId);
    const solver = mobileTeachingSolverRef.current;
    if (!solver) throw new Error('运动学求解器尚未就绪，请稍后重试');
    const options = validateMobileSolveOptions(rawOptions);
    if (options.referencePose.type === 'preset') {
      options.referencePose = mobileReferenceFromPreset(
        current.jointPoses.find((preset) => preset.id === options.referencePose.id), current.selectedRobot,
      );
    }
    const total = task.mobileCapture.samples.filter((sample) => !options.keyframesOnly || sample.kind === 'keyframe').length;
    if (!total) throw new Error('没有可计算的采样点');
    mobileTeachingRunRef.current?.controller.abort();
    const run = { id: createId('mobile-compute'), taskId, taskName: task.name, options,
      controller: new AbortController(), status: 'running', controls: null, previews: [],
      map: current.mapData, robot: current.selectedRobot, workspaceId: sessionIdRef.current,
      armSoftLimitRatio: current.robotArmSoftLimitRatio,
      armSoftLimitOverrides: current.robotArmSoftLimitOverrides,
      armJointCouplingEnabled: current.robotArmJointCouplingEnabled,
      sourceCapture: task.mobileCapture, sourceTransform: JSON.stringify(task.mobileTransform) };
    mobileTeachingRunRef.current = run;
    const isCurrent = () => mobileTeachingRunRef.current === run && !run.controller.signal.aborted;
    const update = (change) => {
      if (isCurrent()) setMobileComputation((value) => value?.id === run.id ? { ...value, ...change } : value);
    };
    setMobileComputation({ id: run.id, taskId, taskName: task.name, options, status: 'running', total, completed: 0,
      rows: [], startedAt: new Date().toISOString(), mapPose: structuredClone(current.robotPose),
      feasibleCount: 0, name: '', side: '', error: '', preview: null, previewCount: 0, previewIndex: -1, followLatest: true });
    setMobileSolveTaskId(null);
    setRobotParkingGhost(null);
    setRobotControlEnabled(false);
    setShowRobotModel(true);
    setCollapsedPanel((value) => value === '3d' ? null : value);
    stopTeachingTaskPlayback(false);
    navigateAppPage(APP_PAGE_WORKBENCH);

    // The run is owned by the workbench, independently of the configuration dialog.
    void (async () => {
      try {
        const result = await solver({ task, options, signal: run.controller.signal,
          onControl: (controls) => { run.controls = controls; },
          onStatus: (status) => { if (isCurrent()) { run.status = status; update({ status }); } },
          onProgress: (progress) => update(progress),
          onSample: ({ row, mapPose }) => {
            if (!isCurrent()) return;
            // Keep all rows for live review, including failures. Only the final
            // report is saved into the task when this run completes.
            setMobileComputation((value) => value?.id === run.id ? { ...value, rows: [...value.rows, row] } : value);
            if (!row.feasible) return;
            const preview = { kind: 'mobile-solve', taskId, taskName: task.name, revision: `${run.id}:${row.sampleId}`,
              parkingPointId: `${run.id}:${row.parkingId || row.sampleId}`, parkingPointName: `计算停车点 ${row.parkingId?.replace('parking-', 'P') || ''}`, poseId: row.sampleId, poseName: row.name,
              side: row.pairedSampleId ? 'both' : row.selectedSide, targetPose: mapPose, sourceName: '计算预览',
              jointValues: row.solutions[row.selectedSide].jointValues };
            run.previews.push(preview);
            const previewCount = run.previews.length;
            setMobileComputation((value) => value?.id === run.id ? { ...value, previewCount,
              ...(value.followLatest ? { preview, previewIndex: previewCount - 1 } : {}) } : value);
            if (previewCount === 1) requestSynchronizedFocus('robot-ghost', run.id);
          },
        });
        if (!isCurrent()) return;
        if (result.version !== MOBILE_SOLVE_VERSION) throw new Error('后台求解器版本已过期，本次未更新报告。请刷新页面后重新计算');
        const latest = latestWorkspaceRef.current;
        if (run.map !== latest.mapData || run.robot !== latest.selectedRobot || run.workspaceId !== sessionIdRef.current
          || latest.teachingTasks.find((item) => item.id === taskId)?.mobileCapture !== run.sourceCapture) return;
        const report = { ...result, robot: { id: run.robot.id || run.robot.relativePath, name: run.robot.name } };
        const next = latest.teachingTasks.map((item) => item.id === taskId ? { ...item, mobileSolve: report, updatedAt: report.computedAt } : item);
        latestWorkspaceRef.current = { ...latest, teachingTasks: next };
        setTeachingTasks(next);
        run.status = 'completed';
        update({ status: 'completed', rows: [], completed: total, feasibleCount: report.feasibleCount, side: '' });
      } catch (error) {
        if (isCurrent()) { run.status = 'error'; update({ status: 'error', rows: [], error: error.message }); }
      }
    })();
  };

  const pauseMobileTeaching = () => {
    const run = mobileTeachingRunRef.current;
    if (run?.status !== 'running') return;
    run.status = 'pausing';
    setMobileComputation((value) => value?.id === run.id ? { ...value, status: 'pausing' } : value);
    run.controls?.pause();
  };

  const resumeMobileTeaching = () => {
    const run = mobileTeachingRunRef.current;
    if (run?.status === 'paused') run.controls?.resume();
  };

  const cancelMobileTeaching = () => {
    const run = mobileTeachingRunRef.current;
    if (!run || !['running', 'pausing', 'paused'].includes(run.status)) return;
    run.controller.abort();
    run.status = 'cancelled';
    run.previews = [];
    setMobileComputation((value) => value?.id === run.id ? { ...value, status: 'cancelled', rows: [], preview: null,
      previewCount: 0, previewIndex: -1, followLatest: false } : value);
  };

  const restartMobileTeaching = () => {
    const run = mobileTeachingRunRef.current;
    if (!run) return;
    try { calculateMobileTeaching(run.taskId, run.options); }
    catch (error) { notify(error.message, 'error'); }
  };

  const dismissMobileTeaching = () => {
    mobileTeachingRunRef.current?.controller.abort();
    mobileTeachingRunRef.current = null;
    setMobileComputation(null);
  };

  const previewMobileTeaching = (index, followLatest = false) => {
    const run = mobileTeachingRunRef.current;
    const preview = run?.previews[index];
    if (!preview) return;
    stopTeachingTaskPlayback(false);
    setShowRobotModel(true);
    setMobileComputation((value) => value?.id === run.id ? { ...value, preview, previewIndex: index, followLatest } : value);
  };

  const playMobileTeachingSolutions = (taskId, report) => {
    if (mobileSaveDisabledReason) throw new Error(mobileSaveDisabledReason);
    const { current, task } = mobileSolveContext(taskId, report);
    if (!report?.feasibleCount) throw new Error('本次计算没有可达姿态，无法动态预览');
    // Use the same ordered parking points, joints and trajectory player as a
    // saved task. The preview remains transient until the user chooses Save.
    const preview = normalizeTeachingTasks([buildMobileSolvedTask(task, report, current.selectedRobot, createId('mobile-preview'))])[0];
    preview.name = `${task.name} · 动态预览`;
    if (startTeachingPlayback(preview, { taskId, report, capture: task.mobileCapture, transform: JSON.stringify(task.mobileTransform) })) {
      setMobileSolveTaskId(null);
    }
  };

  const playMobileTeachingTask = (taskId) => {
    try {
      const report = latestWorkspaceRef.current.teachingTasks.find((task) => task.id === taskId)?.mobileSolve;
      if (!report) throw new Error('请先完成机器人姿态计算');
      playMobileTeachingSolutions(taskId, report);
    } catch (error) { notify(error.message, 'error'); }
  };

  const applyMobileTeachingSolution = (taskId, report, sampleId, side) => {
    mobileSolveContext(taskId, report);
    const row = report.rows.find((item) => item.sampleId === sampleId), solution = row?.solutions[side];
    if (!row?.feasible || !solution?.feasible) throw new Error('该姿态未满足当前计算约束');
    dismissMobileTeaching();
    stopTeachingTaskPlayback(false);
    setRobotControlEnabled(false);
    setRobotParkingGhost(null);
    setRobotPose(mobileSolutionMapPose(report, row, side));
    setRobotJointValues(normalizeRobotJointValues(solution.jointValues));
    setShowRobotModel(true);
    setMobileSolveTaskId(null);
    navigateAppPage(APP_PAGE_WORKBENCH);
    notify(`${row.name} · ${row.pairedSampleId ? '双臂同步' : side === 'left' ? '左臂' : '右臂'}解已应用到虚拟机器人`, 'success');
  };

  const saveMobileTeachingSolutions = (taskId, report) => {
    if (mobileSaveDisabledReason) throw new Error(mobileSaveDisabledReason);
    const { current, task } = mobileSolveContext(taskId, report);
    const existing = current.teachingTasks.find((item) => item.id === report.savedTaskId);
    const solved = existing || normalizeTeachingTasks([buildMobileSolvedTask(task, report, current.selectedRobot, createId('mobile-solved'))])[0];
    stopTeachingTaskPlayback(false);
    dismissMobileTeaching();
    if (!existing) {
      const next = [...current.teachingTasks.map((item) => item.id === taskId ? { ...item, mobileSolve: { ...report, savedTaskId: solved.id } } : item), solved];
      latestWorkspaceRef.current = { ...current, teachingTasks: next };
      setTeachingTasks(next);
    }
    setActiveTeachingTaskId(solved.id);
    setActiveTeachingParkingPointId(solved.parkingPoints[0]?.id || null);
    setMobileSolveTaskId(null);
    navigateAppPage(APP_PAGE_WORKBENCH);
    notify(existing ? '已打开已保存的机器人示教任务' : `已保存 ${report.feasibleCount} 个拍摄目标、${solved.parkingPoints.reduce((count, parking) => count + parking.poses.length, 0)} 组动作、${solved.parkingPoints.length} 个停车点，可在“示教数据”中查看`, 'success');
  };

  const saveMobileTeachingTask = (taskId) => {
    try {
      const report = latestWorkspaceRef.current.teachingTasks.find((task) => task.id === taskId)?.mobileSolve;
      if (!report) throw new Error('请先完成机器人姿态计算');
      saveMobileTeachingSolutions(taskId, report);
    } catch (error) { notify(error.message, 'error'); }
  };

  const importIPadTeaching = async (result, ticket) => {
    const current = latestWorkspaceRef.current;
    const workspaceId = sessionIdRef.current;
    if (current.teachingSpaceMode !== 'independent' || !sessionReadyRef.current) throw new Error('请先打开对应的独立示教工程');
    const task = await ipadResultTask(result, ticket, current.mapData);
    const latest = latestWorkspaceRef.current;
    if (latest.mapData !== current.mapData || latest.teachingSpaceMode !== 'independent'
      || sessionIdRef.current !== workspaceId || workspaceSwitchingRef.current) {
      throw new IPadModelMismatchError(latest.mapData, ticket.manifest, mobileDeviceLabel(result),
        '校验期间独立示教地图已切换，已停止接收。请打开对应地图后重新接收。');
    }
    if (!sessionReadyRef.current) throw new Error('当前独立示教工程尚未就绪，请重新接收');
    // Preserve desktop poses edited while the model hash was being calculated.
    const next = latest.teachingTasks.some((item) => item.mobileCapture?.id === result.id)
      ? latest.teachingTasks : [...latest.teachingTasks, task];
    latestWorkspaceRef.current = { ...latest, teachingTasks: next, activeTeachingTaskId: task.id, activeTeachingParkingPointId: null };
    setTeachingTasks(next); setActiveTeachingTaskId(task.id); setActiveTeachingParkingPointId(null);
    await persistWorkspaceNow();
    if (!sessionReadyRef.current) throw new Error('接收结果尚未保存成功，请重试；请保留设备端结果或原始结果文件');
    notify(`已接收 ${mobileDeviceLabel(result)} 示教：${task.mobileCapture.samples.length} 个 Pose`, 'success');
    return task;
  };

  const applyTeachingTransfer = async (options) => {
    if (teachingTransferBusyRef.current || !teachingTransferDialog?.source) return;
    teachingTransferBusyRef.current = true;
    setTeachingTransferDialog((current) => ({ ...current, busy: true, error: '' }));
    try {
      if (sessionSaveTimerRef.current) window.clearTimeout(sessionSaveTimerRef.current);
      await persistWorkspaceNow();
      if (!sessionReadyRef.current) throw new Error('当前工程尚未保存成功，请重试后再转换');
      workspaceSwitchingRef.current = true;
      const source = await loadWorkspaceSnapshot(sessionIdRef.current, teachingSpaceMode);
      const target = teachingTransferDialog.target;
      const result = options.operation === 'extract'
        ? await extractTeachingWorkspace(source, options)
        : options.operation === 'writeback'
          ? await writeBackTeachingWorkspace(source, target)
          : await placeTeachingWorkspace(source, target, options);
      await commitWorkspaceTransfer(sessionIdRef.current, source, target, result);
      window.location.assign('/workbench');
    } catch (error) {
      workspaceSwitchingRef.current = false;
      teachingTransferBusyRef.current = false;
      setTeachingTransferDialog((current) => current ? { ...current, busy: false, error: error.message || '示教转换失败' } : null);
    }
  };

  const beginNewProject = (requestedMode) => {
    if (loadState.loading || sessionState.status !== 'ready') return;
    if (normalizeTeachingSpaceMode(requestedMode) === 'independent') {
      independentCloudInputRef.current?.click();
    } else {
      mapInputRef.current?.click();
    }
  };

  const loadingProgress = projectImportProgress?.progress ?? loadState.progress;
  const progressLabel = projectImportProgress || loadingProgress < 1
    ? `${Math.round(loadingProgress * 100)}%`
    : 'PROCESS';

  const syncIdentity = () => {
    const current = latestWorkspaceRef.current;
    return JSON.stringify([current.teachingSpaceMode, current.mapData?.mapId,
      current.mapData?.sourceHash, current.selectedRobot?.relativePath || '']);
  };
  const syncPayload = () => {
    const current = latestWorkspaceRef.current;
    return buildExport({ ...current, robot: current.selectedRobot, transfer: current.workspaceTransfer,
      view2d: view2dRef.current, view3d: view3dRef.current });
  };
  const workSync = useWorkSync({
    deviceName: isVisionWorkbench() ? 'Vision Pro 工作台' : /Mac/.test(navigator.platform) ? 'Mac 浏览器' : /Win/.test(navigator.platform) ? 'Windows 浏览器' : '浏览器设备',
    ready: () => sessionReadyRef.current && !workspaceSwitchingRef.current && !loadState.loading
      && teachingCaptureState.status !== 'capturing',
    identity: syncIdentity,
    project: () => {
      const current = latestWorkspaceRef.current;
      if (!sessionReadyRef.current || !current.mapData?.geometry) return null;
      return { key: syncIdentity(), mode: current.teachingSpaceMode,
        name: current.independentTeachingName || current.mapData.name || '当前工程' };
    },
    readDocument: () => syncDocument(normalizeProject(syncPayload())),
    applyDocument: (document) => {
      const current = latestWorkspaceRef.current;
      const next = Object.fromEntries(Object.entries(document)
        .map(([key, value]) => [key, retainSyncReferences(current[key], value)]));
      const temporaryPoints = current.waypoints.filter((point) => point.source === TEMPORARY_MAP_ROUTE_SOURCE);
      if (temporaryPoints.length) {
        const temporaryIds = new Set(temporaryPoints.map((point) => point.id));
        next.waypoints = [...next.waypoints, ...temporaryPoints];
        const ids = new Set(next.waypoints.map((point) => point.id));
        next.edges = [...next.edges, ...current.edges.filter((edge) =>
          (edge.source === TEMPORARY_MAP_ROUTE_SOURCE || temporaryIds.has(edge.from) || temporaryIds.has(edge.to))
          && ids.has(edge.from) && ids.has(edge.to))];
      }
      latestWorkspaceRef.current = { ...current, ...next };
      setWaypoints(next.waypoints); setEdges(next.edges); setAbxRoutes(next.abxRoutes);
      setTeachingTasks(next.teachingTasks); setJointPoses(next.jointPoses);
      setIndependentTeachingName(next.independentTeachingName);
      // Each operator keeps their own selection, unless that entity was deleted.
      setSelectedWaypointId((id) => next.waypoints.some((point) => point.id === id) ? id : null);
      setSelectedEdgeId((id) => next.edges.some((edge) => edge.id === id) ? id : null);
      setActiveTeachingTaskId((id) => next.teachingTasks.some((task) => task.id === id) ? id : null);
      setActiveTeachingParkingPointId((id) => next.teachingTasks.some((task) => task.parkingPoints.some((point) => point.id === id)) ? id : null);
      queueWorkspaceSave();
    },
    buildInitial: async (onProgress) => {
      const current = latestWorkspaceRef.current;
      if (!current.mapData?.geometry || workspaceSwitchingRef.current || loadState.loading) throw new Error('请先完成当前工程加载');
      const localIdentity = syncIdentity();
      const payload = syncPayload();
      // Only the active workspace is shared. A binding to the host's other
      // local workspace would otherwise leave the peer unable to save its ZIP.
      payload.workspace.transfer = null;
      const document = syncDocument(normalizeProject(payload));
      const map = current.mapData;
      const mapResource = createGeometryCache(map.geometry, map.bounds, map.byteLength, map.sourceHash, map.sourceHashKind, {
        fileModifiedAt: map.fileModifiedAt, mimeType: map.mimeType, loadedAt: map.loadedAt,
        sourceKind: map.sourceKind, sourceBlob: map.sourceBlob, teachingSpaceMode: current.teachingSpaceMode,
        teachingGroupId: map.teachingGroupId,
      });
      mapResource.mapId = map.mapId;
      const existingRobotPackage = portableRobotPackageRef.current?.relativePath === current.selectedRobot?.relativePath
        ? portableRobotPackageRef.current : null;
      const { buildProjectArchive } = await import('./lib/projectArchive.js');
      const archive = await buildProjectArchive(payload, { mapResource, existingRobotPackage, onProgress });
      return { bytes: archive.bytes, document, localIdentity };
    },
    installInitial: async (bytes, project, isActive) => {
      const { readProjectArchive } = await import('./lib/projectArchive.js');
      const imported = await readProjectArchive(bytes);
      if (!isActive()) return;
      await applyImportedProject(async () => imported, `同步：${project.name}`, project.mode, { throwOnError: true, fromWorkSync: true });
      await waitForPaint();
    },
    persist: persistWorkspaceNow,
    loadCheckpoint: loadWorkSyncCheckpoint,
    saveCheckpoint: saveWorkSyncCheckpoint,
  }, JSON.stringify([sessionState.status, teachingSpaceMode, mapData?.mapId,
    mapData?.sourceHash, mapData?.name, selectedRobot?.relativePath, independentTeachingName]));

  const openCacheAction = (kind, entry = null) => {
    if (independentSwitchBlocked || independentSwitchBusyRef.current || workspaceSwitchingRef.current) return;
    setRobotControlEnabled(false);
    setCacheActionDialog({ kind, entry, busy: false, error: '' });
  };
  const confirmCacheAction = async () => {
    if (!cacheActionDialog || independentSwitchBlocked || independentSwitchBusyRef.current || workspaceSwitchingRef.current
      || projectExportBusyRef.current || projectExportDialog) return;
    const { kind, entry } = cacheActionDialog;
    const reset = kind === 'reset';
    const current = latestWorkspaceRef.current;
    const deletingLive = !reset && !entry.historyId && current.teachingSpaceMode === 'independent'
      && current.mapData?.mapId === entry.mapId;
    independentSwitchBusyRef.current = true;
    setCacheActionDialog((value) => ({ ...value, busy: true, error: '' }));
    let committed = false;
    try {
      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      // Drain existing writes before deletion, and prevent pagehide/autosave or
      // an in-flight synchronization from recreating the removed workspace.
      const saved = !reset && !deletingLive ? persistWorkspaceNow() : Promise.resolve();
      workspaceSwitchingRef.current = true;
      if (reset || deletingLive) await workSync.disconnect(reset ? '全局重置，同步已断开' : '当前缓存已删除，同步已断开');
      await saved;
      await Promise.allSettled([sessionWriteChainRef.current, projectDirectoryWriteChainRef.current]);
      if (reset) {
        await clearProjectDirectoryBinding();
        await clearAllProjectSaveTargets();
        await clearAllWorkspaceCaches(sessionIdRef.current);
        committed = true;
        // A clean page also releases both model editors' geometry, undo stacks
        // and workers, which intentionally live only in memory.
        window.location.replace('/');
        return;
      }
      if (!entry.historyId) {
        await clearProjectDirectoryBinding('independent');
        await clearProjectSaveTarget(entry.mapId, 'independent');
      }
      await deleteIndependentWorkspace(sessionIdRef.current, { historyId: entry.historyId, mapId: entry.mapId });
      committed = true;
      if (deletingLive) {
        window.location.replace('/');
        return;
      }
      const remaining = (entries) => entries.filter((item) => item.mapId !== entry.mapId);
      setIndependentHistory((value) => ({ ...value, entries: remaining(value.entries) }));
      setIndependentWorkspaceDialog((value) => value ? { ...value, entries: remaining(value.entries) } : null);
      if (!entry.historyId) setCachedWorkspaces((value) => ({ ...value, independent: null }));
      setLastProjectRecovery((value) => value?.teachingSpaceMode === 'independent' && value.mapId === entry.mapId ? null : value);
      setCacheActionDialog(null);
      workspaceSwitchingRef.current = false;
      independentSwitchBusyRef.current = false;
      notify('独立示教缓存已删除', 'success');
    } catch (error) {
      if (!committed) {
        workspaceSwitchingRef.current = false;
        independentSwitchBusyRef.current = false;
      }
      setCacheActionDialog((value) => value ? { ...value, busy: false,
        error: committed ? '缓存已清理，请刷新页面。' : error.message || '清理缓存失败，请重试' } : null);
    }
  };
  return (
    <RobotJointLimitContext.Provider value={robotArmSoftLimitRatio}>
    <RobotJointSoftRangesContext.Provider value={robotArmSoftLimitOverrides}>
    <RobotJointCouplingContext.Provider value={robotArmJointCouplingEnabled}>
    <input ref={mapInputRef} className="visually-hidden" type="file" accept=".ply" onChange={handleMapFile} />
    <input ref={abxTeachingInputRef} className="visually-hidden" type="file"
      accept=".zip,.abxteach.ndjson,.ndjson" aria-label="机器人示教文件"
      onChange={(event) => importAbxFile(event, 'teaching')} />
    <input ref={abxRouteInputRef} className="visually-hidden" type="file"
      accept=".route.json,.json,application/json" aria-label="机器人路径文件"
      onChange={(event) => importAbxFile(event, 'route')} />
    <input
      ref={independentCloudInputRef}
      className="visually-hidden"
      type="file"
      accept=".ply,application/octet-stream"
      data-independent-teaching-input="true"
      onChange={handleIndependentCloudFile}
    />
    <VisionWorkbenchBridge ready={sessionState.status === 'ready'} name={independentTeachingName || mapData?.name}
      sceneReady={Boolean(mapData?.geometry && !loadState.loading && robotLoadState.status !== 'pending' && !workspaceSwitchingRef.current)}
      sync={workSync} persist={persistWorkspaceNow} save={() => exportProject()}
      importFile={async (file) => {
        const { readProjectFile } = await import('./lib/projectArchive.js');
        const imported = await readProjectFile(file);
        const mode = imported.workspaceCollection?.activeMode || (imported.linkedWorkspaces ? teachingSpaceMode
          : normalizeProject(imported.payload).workspace?.teachingSpaceMode) || 'map';
        await applyImportedProject(async () => imported, file.name, mode, { throwOnError: true });
      }}
      scene={{ mapData, robot: selectedRobot, robotPose, robotJointValues, tasks: teachingTasks, waypoints, edges,
        mode: teachingSpaceMode, softLimitRatio: robotArmSoftLimitRatio, softLimitOverrides: robotArmSoftLimitOverrides,
        jointCoupling: robotArmJointCouplingEnabled }} />
    <input
      ref={pathInputRef}
      className="visually-hidden"
      type="file"
      accept={PROJECT_GUIDE_FILE_ACCEPT}
      data-project-guide-input="true"
      onChange={handlePathFile}
    />
    <input
      ref={projectDirectoryInputRef}
      className="visually-hidden"
      type="file"
      webkitdirectory=""
      multiple
      onChange={handleProjectDirectoryFiles}
    />
    <div
      className={`app-shell ${appPage === APP_PAGE_HOME ? 'is-home-background' : appPage !== APP_PAGE_WORKBENCH ? 'is-route-background' : ''} ${isIndependentTeachingSpace ? 'is-independent-teaching-space' : ''}`}
      data-app-page="workbench"
      data-teaching-space-mode={teachingSpaceMode}
      data-teaching-source={teachingSource}
      data-coordinate-frame={coordinateFrame}
      aria-hidden={appPage !== APP_PAGE_WORKBENCH || robotSettingsModalOpen}
      inert={robotSettingsModalOpen ? '' : undefined}
    >
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Route size={20} strokeWidth={1.8} /></div>
          <div>
            <span>{isVisionWorkbench() ? 'ATLAS / VISION PRO' : 'ATLAS / ROUTE'}</span>
            <strong>{isVisionWorkbench() ? '空间工程工作台' : '虚拟示教平台'}</strong>
          </div>
        </div>

        <button
          type="button"
          className="workbench-menu-trigger home-page-action"
          aria-label="返回主页面"
          title="返回模式与工程入口；当前工作现场不会被清空"
          onClick={() => navigateAppPage(APP_PAGE_HOME)}
          disabled={loadState.loading}
        >
          <House size={15} /> <span>{isVisionWorkbench() ? '工程管理' : '主页面'}</span>
        </button>

        <div className="map-identity" data-space-mode={teachingSpaceMode}>
          <span className={`map-state-dot ${mapData?.geometry ? 'online' : ''}`} />
          <div>
            <small>{isIndependentTeachingSpace ? '独立示教 · ORIGIN 0' : '地图示教 · MAP'}</small>
            <strong title={mapData?.name}>{(isIndependentTeachingSpace && independentTeachingName) || mapData?.name || (isIndependentTeachingSpace ? 'NO SPACE LOADED' : 'NO MAP LOADED')}</strong>
          </div>
          {mapData?.pointCount > 0 && (
            <em>
              {(mapData.pointCount / 1_000_000).toFixed(2)}M PTS
              {mapData.faceCount > 0 ? ` · ${(mapData.faceCount / 1_000_000).toFixed(2)}M TRI` : ''}
            </em>
          )}
        </div>

        <WorkbenchToolbar
          isActive={appPage === APP_PAGE_WORKBENCH && !robotSettingsModalOpen && !teachingTransferDialog && !ipadTeachingOpen && !visionSceneOpen && !mobileSolveTaskId}
          sections={[
            {
              id: 'project', label: '工程', icon: FolderOpen, triggerRef: mapDetailsButtonRef,
              busy: ['packing', 'selecting'].includes(projectExportState.status),
              content: <>
                <section className="workbench-menu-section">
                  <p>当前工程</p>
                  <button
                    type="button"
                    className="action-button"
                    aria-label="查看地图与工程配置"
                    disabled={!mapData?.bounds}
                    onClick={() => setMapDetailsOpen(true)}
                    title={mapData?.bounds ? '查看地图文件、空间范围与工程配置' : '请先加载地图'}
                  >
                    <FileSearch size={15} />
                    <span>地图与工程配置</span>
                  </button>
                  <ProjectExportButton
                    label="另存为工程"
                    mapData={mapData}
                    exportState={projectExportState}
                    disabled={loadState.loading || teachingCaptureState.status === 'capturing'}
                    onExport={exportProject}
                  />
                  <ProjectExportButton
                    overwrite
                    mapData={mapData}
                    exportState={projectExportState}
                    saveTarget={activeProjectSaveTarget?.handle}
                    disabled={loadState.loading || teachingCaptureState.status === 'capturing'}
                    onExport={() => exportProject(undefined, true)}
                  />
                </section>
              </>,
            },
            {
              id: 'teaching', label: '示教', icon: Route,
              content: <>
                <section className="workbench-menu-section">
                  <p>当前：{teachingModeLabel(teachingSpaceMode)}</p>
                  <button
                    type="button"
                    className={`action-button teaching-mode-action ${isIndependentTeachingSpace ? '' : 'independent-teaching-action'}`}
                    aria-label={`切换到${teachingModeLabel(alternateTeachingMode)}`}
                    data-teaching-mode-target={alternateTeachingMode}
                    title={isIndependentTeachingSpace
                      ? '切换到地图示教；尚未打开地图时返回主页面'
                      : '切换到独立示教；已加载地图且没有独立示教缓存时可直接新增'}
                    onClick={() => continueWorkspace(alternateTeachingMode)}
                    disabled={loadState.loading || sessionState.status !== 'ready'}
                  >
                    {isIndependentTeachingSpace ? <MapIcon size={15} /> : <ScanLine size={15} />}
                    <span>{teachingModeLabel(alternateTeachingMode)}</span>
                  </button>
                  {isIndependentTeachingSpace && <>
                    <button
                      type="button"
                      className="action-button independent-teaching-action"
                      onClick={openNewIndependentDialog}
                      disabled={independentSwitchBlocked || !mapData?.geometry}
                      title="选择独立模型，可选加载与当前地图的转换矩阵；当前独立工程将保存到缓存列表"
                    >
                      <Plus size={15} /><span>新增独立示教</span>
                    </button>
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => showProjectLoadDialog('independent')}
                      disabled={independentSwitchBlocked}
                    >
                      <History size={15} /><span>独立示教缓存</span>
                    </button>
                  </>}
                </section>
                <section className="workbench-menu-section">
                  <p>数据与转换</p>
                  <button
                    type="button"
                    className="action-button teaching-data-page-link"
                    aria-label="打开示教数据管理页"
                    onClick={() => navigateAppPage(APP_PAGE_TEACHING_DATA)}
                    disabled={teachingCaptureState.status === 'capturing'}
                    title={teachingCaptureState.status === 'capturing'
                      ? '请等待当前机器人姿态与相机快照完成记录'
                      : '管理示教任务、点位与视觉快照'}
                  >
                    <Database size={15} /><span>示教数据</span><b>{teachingTasks.length}</b>
                  </button>
                  <button
                    type="button"
                    className="action-button teaching-transfer-action"
                    aria-label="打开示教转换"
                    title={isIndependentTeachingSpace ? '整体放入地图或回写精调结果' : '提取地图局部到独立示教'}
                    disabled={!mapData?.geometry || loadState.loading || sessionState.status !== 'ready' || teachingCaptureState.status === 'capturing'}
                    onClick={openTeachingTransfer}
                  >
                    <ArrowLeftRight size={15} /><span>示教转换</span>
                  </button>
                </section>
              </>,
            },
            {
              id: 'robot', label: '机器人', icon: Bot, triggerRef: robotMenuButtonRef,
              content: <>
                <section className="workbench-menu-section">
                  <p>机器人</p>
                  <RobotPicker
                    menuAnchorRef={robotMenuButtonRef}
                    menuLabel="机器人模型"
                    isActive={appPage === APP_PAGE_WORKBENCH && !robotSettingsModalOpen}
                    selectedRobot={selectedRobot}
                    loadState={robotLoadState}
                    onSelect={handleSelectRobot}
                    showRobot={showRobotModel}
                    visibilityDisabled={teachingCaptureState.status === 'capturing'}
                    onShowRobotChange={handleShowRobotChange}
                  />
                  <button type="button" className="action-button" disabled={!robotPresetReady}
                    title={robotPresetReady ? '输入双臂、躯干和头部关节值并保存' : '请先加载具有可动关节的机器人模型'}
                    onClick={() => openRobotPreset()}><Plus size={15} /><span>新建预设姿态</span></button>
                  <button type="button" className="action-button" disabled={!robotPresetManagerReady}
                    onClick={openRobotPresetManager}><List size={15} /><span>管理预设姿态</span></button>
                </section>
                <RobotJointLimitSettings ratio={robotArmSoftLimitRatio} onChange={setRobotArmSoftLimitRatio}
                  customCount={Object.keys(robotArmSoftLimitOverrides).length} onOpenDetails={openRobotJointLimits}
                  onReset={() => { setRobotArmSoftLimitRatio(ARM_SOFT_LIMIT_RATIO); setRobotArmSoftLimitOverrides({}); }}
                  disabledReason={robotJointLimitsDisabledReason} />
                <RobotJointCouplingSettings enabled={robotArmJointCouplingEnabled} onChange={setRobotArmJointCouplingEnabled}
                  disabledReason={robotLoadState.status !== 'loaded' ? '加载机器人后可调整关节6–7角度耦合约束。'
                    : !['left', 'right'].some((side) => [6, 7].every((index) => robotLoadState.movableJoints?.some(
                      (joint) => new RegExp(`^${side}[_-]J${index}$`, 'i').test(joint.name)
                        && ['revolute', 'continuous'].includes(joint.type)))) ? '当前模型没有成对的 J6、J7 旋转关节。'
                      : teachingCaptureState.status === 'capturing' ? '采集完成后可调整耦合约束。'
                        : (polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)) ? '停止轨迹播放或折线任务后可调整耦合约束。'
                          : mobileComputation ? '结束示教计算后可调整耦合约束。' : ''} />
                <section className="workbench-menu-section robot-presets-list">
                  <p>预设姿态{robotPresets.length > 0 ? ` · ${robotPresets.length}` : ''}</p>
                  {robotPresets.map((pose) => <button key={pose.id} type="button" className="action-button"
                    aria-label={`应用预设姿态 ${pose.name}`} title={pose.name}
                    disabled={!robotPresetReady} onClick={() => applyRobotPreset(pose.id)}>
                    <Play size={15} /><span>{pose.name}</span><b>{pose.joints.count} 关节</b>
                  </button>)}
                  {!robotPresets.length && <p className="robot-presets-empty">
                    {selectedRobot ? '暂无预设姿态，点击上方新建。' : '加载机器人后可创建预设姿态。'}
                  </p>}
                </section>
              </>,
            },
            {
              id: 'devices', label: '设备', icon: Usb, triggerRef: devicesMenuButtonRef,
              content: <>
                <section className="workbench-menu-section">
                  <p>输入控制器</p>
                  <SpaceMouseControl
                    menuAnchorRef={devicesMenuButtonRef}
                    inputRef={spaceMouseInputRef}
                    onNotify={notify}
                    isActive={appPage === APP_PAGE_WORKBENCH && !robotSettingsModalOpen && !teachingTransferDialog && !ipadTeachingOpen && !visionSceneOpen && !mobileSolveTaskId}
                  />
                </section>
                <section className="workbench-menu-section">
                  <p>移动示教设备</p>
                  {['ipad', 'vision'].map((device) => <IPadTeachingMenu key={device} device={device} menuAnchorRef={devicesMenuButtonRef} mapData={mapData} source={teachingDevice}
                    desktopCount={desktopTeachingTasks.length} deviceCount={mobileTasksByDevice[device].length}
                    disabled={!mapData?.geometry || loadState.loading || sessionState.status !== 'ready' || teachingCaptureState.status === 'capturing'}
                    isActive={appPage === APP_PAGE_WORKBENCH && !robotSettingsModalOpen && !teachingTransferDialog && !ipadTeachingOpen && !visionSceneOpen && !mobileSolveTaskId}
                    onSourceChange={switchTeachingSource} onOpenSync={openIPadTeaching} allowTeaching={isIndependentTeachingSpace}
                    onOpenScene={() => setVisionSceneOpen(true)}
                    onOpenScreen={() => setIPadScreenOpen(true)} />)}
                </section>
              </>,
            },
          ]}
        >
          <div className="service-pill" title="局域网服务默认端口">
            <Server size={13} />
            <span>{isVisionWorkbench() ? 'VISION' : 'LAN'}</span>
            <strong>{isVisionWorkbench() ? '本机工作台' : ':21990'}</strong>
          </div>
          <WorkSyncControl sync={workSync} />
        </WorkbenchToolbar>
      </header>

      <main
        className={`workspace ${inspectorCollapsed ? 'is-inspector-collapsed' : ''}`}
        data-inspector-collapsed={inspectorCollapsed ? 'true' : 'false'}
      >
        <div
          className={`visual-workspace ${isIndependentTeachingSpace ? 'is-spatial-only' : ''} ${activeCollapsedPanel ? `is-${activeCollapsedPanel}-collapsed` : ''}`}
          data-workspace-layout={isIndependentTeachingSpace ? 'spatial-only' : 'spatial-and-map'}
          data-collapsed-panel={activeCollapsedPanel || 'none'}
        >
          <section
            className={`viewport-panel panel-3d ${!isIndependentTeachingSpace && mobileTeachingTasks.length ? 'has-teaching-source-switch' : ''} ${activeCollapsedPanel === '3d' ? 'is-collapsed' : ''}`}
            data-collapsed={activeCollapsedPanel === '3d' ? 'true' : 'false'}
          >
            <div className="panel-heading">
              <div className="panel-heading__title">
                <span className="panel-index">01</span>
                <div>
                  <small>{isIndependentTeachingSpace ? 'VIRTUAL_ORIGIN / LOCAL SPACE' : 'SPATIAL SOURCE'}</small>
                  <strong>
                    {isIndependentTeachingSpace
                      ? mapData?.faceCount > 0 ? '独立示教空间 / 网格' : '独立示教空间'
                      : mapData?.faceCount > 0 ? '三维点云 / 网格' : '三维点云'}
                  </strong>
                </div>
              </div>
              <div
                className="panel-stats robot-position-readout"
                role="group"
                aria-label="机器人实时坐标"
                title={selectedRobot && robotLoadState.status === 'loaded'
                  ? `机器人在 ${coordinateFrame.toUpperCase()} 坐标系中的实时位置，单位：米`
                  : '加载机器人后显示实时 XYZ 坐标'}
              >
                <span className="robot-position-readout__label"><Bot size={12} /> 机器人定位</span>
                {['x', 'y', 'z'].map((axis) => (
                  <span key={axis} data-axis={axis}>
                    <i className={`axis ${axis}`}>{axis.toUpperCase()}</i>
                    <b>{selectedRobot && robotLoadState.status === 'loaded'
                      ? (Math.round(robotPose.position[axis] * 1000) / 1000).toFixed(3)
                      : '—'}</b>
                  </span>
                ))}
                <small>m</small>
              </div>
              <div
                className="panel-heading__display-settings"
                ref={setDisplaySettingsContainer}
              />
              <HeightRange
                bounds={mapData?.bounds}
                value={heightRange}
                onChange={setHeightRange}
                visible={showSlice3D}
                onVisibleChange={setShowSlice3D}
                disabled={!mapData?.geometry}
                collapsed={heightRangeCollapsed}
                onCollapsedChange={setHeightRangeCollapsed}
                isActive={appPage === APP_PAGE_WORKBENCH && !robotSettingsModalOpen && !teachingTransferDialog && !ipadTeachingOpen && !visionSceneOpen && !mobileSolveTaskId}
              />
              {!isIndependentTeachingSpace && (
                <button
                  type="button"
                  className="panel-collapse-button"
                  aria-label={activeCollapsedPanel === '3d' ? '展开3D窗口' : '折叠3D窗口'}
                  aria-expanded={activeCollapsedPanel !== '3d'}
                  aria-controls="panel-body-3d"
                  onClick={() => toggleCollapsedPanel('3d')}
                >
                  {activeCollapsedPanel === '3d' ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  <span>{activeCollapsedPanel === '3d' ? '展开' : '折叠'}</span>
                </button>
              )}
            </div>
            {!isIndependentTeachingSpace && mobileTeachingTasks.length > 0 && (
              <div className="teaching-source-bar" role="group" aria-label="示教来源">
                <span>示教来源</span>
                <div className="teaching-source-switch">
                  <button type="button" aria-pressed={teachingSource === 'desktop'}
                    aria-label={`查看${isIndependentTeachingSpace ? '独立' : '电脑'}示教`}
                    disabled={loadState.loading || sessionState.status !== 'ready' || teachingCaptureState.status === 'capturing'}
                    onClick={() => switchTeachingSource('desktop')}>
                    <Bot size={13} />{isIndependentTeachingSpace ? '独立示教' : '电脑示教'}
                  </button>
                  {['ipad', 'vision'].filter((device) => mobileTasksByDevice[device].length).map((device) => <button key={device} type="button" aria-pressed={teachingDevice === device}
                    aria-label={`查看 ${device === 'vision' ? 'Vision Pro' : 'iPad / iPhone'} 示教`}
                    disabled={loadState.loading || sessionState.status !== 'ready' || teachingCaptureState.status === 'capturing'}
                    onClick={() => switchTeachingSource(device)}>
                    {device === 'vision' ? <Glasses size={13} /> : <Tablet size={13} />}{device === 'vision' ? 'Vision Pro' : 'iPad / iPhone'} 示教
                  </button>)}
                </div>
              </div>
            )}
            <div
              id="panel-body-3d"
              className="panel-body"
              aria-hidden={activeCollapsedPanel === '3d'}
            >
              <PointCloudViewer
                mapData={mapData}
                mapOriginPose={visibleMapOriginPose}
                selectedMapOrigin={selectedMapOrigin}
                onSelectMapOrigin={selectMapOrigin}
                displaySettingsContainer={displaySettingsContainer}
                heightRange={heightRange}
                showSlice={showSlice3D}
                waypoints={waypoints}
                edges={edges}
                selectedWaypointId={selectedWaypointId}
                selectedEdgeId={selectedEdgeId}
                colorMode={pointColorMode}
                onColorModeChange={setPointColorMode}
                placedObjectColorMode={placedObjectColorMode}
                onPlacedObjectColorModeChange={setPlacedObjectColorMode}
                workspaceTransfer={workspaceTransfer}
                meshRenderQuality={meshRenderQuality}
                onMeshRenderQualityChange={setMeshRenderQuality}
                showPaths={showPaths3D}
                onShowPathsChange={setShowPaths3D}
                showParkingPoints={showParkingPoints3D}
                onShowParkingPointsChange={setShowParkingPoints3D}
                showWaypoints={showWaypoints3D}
                onShowWaypointsChange={setShowWaypoints3D}
                showWaypointNames={showWaypointNames3D}
                onShowWaypointNamesChange={setShowWaypointNames3D}
                showPathNames={showPathNames3D}
                onShowPathNamesChange={setShowPathNames3D}
                showHeightLegend={showHeightLegend3D}
                onShowHeightLegendChange={setShowHeightLegend3D}
                onSelectWaypoint={selectNavigationWaypoint}
                onInspectorPageRequest={requestInspectorPage}
                onSelectEdge={selectEdge}
                onClearSelection={clearSelection}
                focusRequest={synchronizedFocus}
                initialView={restoredView3d}
                onViewChange={handleView3dChange}
                robotDescriptor={selectedRobot}
                showRobot={showRobotModel}
                onShowRobotChange={handleShowRobotChange}
                robotLoadState={robotLoadState}
                robotPose={robotPose}
                robotJointValues={robotJointValues}
                lockedRobotJointNames={lockedRobotJointNames}
                robotControlEnabled={robotControlEnabled}
                robotHeightLocked={robotHeightLocked}
                robotTrajectoryActive={['playing', 'paused'].includes(teachingPlayback.status)}
                teachingPlayback={teachingPlayback}
                robotParkingGhost={mobileComputation?.preview || robotParkingGhost}
                teachingCaptureBusy={teachingCaptureState.status === 'capturing'}
                teachingSpaceMode={teachingSpaceMode}
                teachingDevice={teachingDevice}
                teachingTasks={workbenchTeachingTasks}
                onSavePolyline={saveTeachingPolyline}
                onDeletePolyline={deleteTeachingPolyline}
                onPolylineBusyChange={setPolylineTeachingBusy}
                polylineBusy={polylineTeachingBusy}
                polylineOpen={polylineTeachingOpen}
                onPolylineOpenChange={setPolylineTeachingOpen}
                polylineContainer={polylineTeachingContainer}
                polylineRequest={polylineTeachingRequest}
                onPolylineRequestHandled={finishPolylineTeachingRequest}
                selectedMobilePose={selectedMobilePose}
                spaceMouseInputRef={spaceMouseInputRef}
                viewportCanvasRef={main3DCanvasRef}
                collaborationViewportRef={collaborationViewportRef}
                cameraTeachingCommand={cameraTeachingCommand}
                collisionProtectionEnabled={robotCollisionProtectionEnabled}
                ignoredCollisionJointNames={ignoredRobotCollisionJointNames}
                onIgnoredCollisionJointNamesChange={setIgnoredRobotCollisionJointNames}
                onRobotLoadState={handleRobotLoadState}
                onRobotPoseChange={handleRobotPoseChange}
                onRobotJointValuesChange={handleRobotJointValuesChange}
                onResetRobotJointPose={zeroRobotJoints}
                onRobotControlChange={handleRobotControlChange}
                onRobotHeightLockChange={handleRobotHeightLockChange}
                onZividCameraPoseChange={handleZividCameraPoseChange}
                onCameraTeachingResult={handleCameraTeachingResult}
                onParkingMergePlannerChange={handleParkingMergePlannerChange}
                onMobileTeachingSolverChange={handleMobileTeachingSolverChange}
                onCollisionProtectionChange={handleRobotCollisionProtectionChange}
                onClearRobotParkingGhost={clearRobotParkingGhost}
                onMoveToParkingPoint={applyTeachingParkingPoint}
                onEditParkingPoint={beginTeachingParkingPointEdit}
                onCancelTeachingPreviewEdit={cancelTeachingPreviewEdit}
                onRecordParkingPointPosition={recordTeachingParkingPointPosition}
                onEditTeachingPose={beginTeachingPoseEdit}
                onConfirmTeachingPose={captureTeachingPoint}
                isActive={appPage === APP_PAGE_WORKBENCH && !robotSettingsModalOpen && !teachingTransferDialog && !ipadTeachingOpen && !visionSceneOpen && !mobileSolveTaskId}
              />
              <TeachingPlaybackDock
                key={teachingPlayback.taskId}
                playback={teachingPlayback}
                onPause={pauseTeachingTaskPlayback}
                onResume={resumeTeachingTaskPlayback}
                onStop={() => stopTeachingTaskPlayback()}
                onSpeedChange={changeTeachingPlaybackSpeed}
                onFollowRobotChange={changeTeachingPlaybackFollowRobot}
              />
              {!mapData && (
                <button type="button" className="placeholder-load" onClick={() => navigateAppPage(APP_PAGE_HOME)}>
                  <House size={15} /> 前往欢迎页新建工程
                </button>
              )}
            </div>
          </section>

          {!isIndependentTeachingSpace && (
            <section
              className={`viewport-panel panel-2d ${collapsedPanel === '2d' ? 'is-collapsed' : ''}`}
              data-collapsed={collapsedPanel === '2d' ? 'true' : 'false'}
            >
              <div className="panel-heading map-heading">
                <div className="panel-heading__title">
                  <span className="panel-index">02</span>
                  <div>
                    <small>LIVE VECTOR SLICE</small>
                    <strong>二维路径图</strong>
                  </div>
                </div>
                <div className="mode-switcher" role="toolbar" aria-label="二维地图工具">
                  {modeOptions.map((option) => {
                    const Icon = option.icon;
                    const robotWaypointReady = option.id === 'add'
                      && Boolean(selectedRobot)
                      && robotLoadState.status === 'loaded';
                    return (
                      <button
                        type="button"
                        key={option.id}
                        className={mode === option.id ? 'is-active' : ''}
                        aria-label={option.label}
                        aria-pressed={mode === option.id}
                        data-robot-waypoint-ready={robotWaypointReady ? 'true' : undefined}
                        title={option.id === 'add'
                          ? robotWaypointReady
                            ? `记录机器人当前 ${coordinateFrameLabel} 位姿，并保持二维地图点选添加模式`
                            : '进入二维地图点选添加模式；加载机器人后可直接记录当前位置'
                          : undefined}
                        onClick={() => {
                          if (option.id === 'add') addWaypointFromToolbar();
                          else setActiveMode(option.id);
                        }}
                        disabled={!mapData?.bounds}
                      >
                        <Icon size={14} /> {option.label}
                      </button>
                    );
                  })}
                </div>
                <div className="slice-badge">
                  <Layers2 size={13} />
                  <span>Z {heightRange[0].toFixed(2)} — {heightRange[1].toFixed(2)} m</span>
                  <strong>{projectionStats.selectedCount.toLocaleString('zh-CN')}</strong>
                </div>
                <button
                  type="button"
                  className="panel-collapse-button"
                  aria-label={collapsedPanel === '2d' ? '展开2D窗口' : '折叠2D窗口'}
                  aria-expanded={collapsedPanel !== '2d'}
                  aria-controls="panel-body-2d"
                  onClick={() => toggleCollapsedPanel('2d')}
                >
                  {collapsedPanel === '2d' ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  <span>{collapsedPanel === '2d' ? '展开' : '折叠'}</span>
                </button>
              </div>
              <div
                id="panel-body-2d"
                className="panel-body"
                aria-hidden={collapsedPanel === '2d'}
              >
                <Map2DView
                  mapData={mapData}
                  selectedMapOrigin={selectedMapOrigin}
                  onSelectMapOrigin={selectMapOrigin}
                  initialView={restoredView2d}
                  heightRange={heightRange}
                  waypoints={waypoints}
                  edges={edges}
                  mode={mode}
                  connectionSourceId={connectionSourceId}
                  selectedWaypointId={selectedWaypointId}
                  selectedEdgeId={selectedEdgeId}
                  colorMode={pointColorMode}
                  onAddWaypoint={addWaypoint}
                  onSelectWaypoint={selectNavigationWaypoint}
                  onSelectEdge={selectEdge}
                  onConnectTarget={connectTarget}
                  onClearSelection={clearSelection}
                  onDeleteSelection={deleteMapSelection}
                  onProjectionStats={handleProjectionStats}
                  onViewChange={handleViewChange}
                  focusRequest={synchronizedFocus}
                />
              </div>
            </section>
          )}
        </div>

        <Inspector
          mapData={mapData}
          pageRequest={inspectorPageRequest}
          polylineOpen={polylineTeachingOpen}
          onPolylineContainer={setPolylineTeachingContainer}
          teachingSpaceMode={teachingSpaceMode}
          waypoints={waypoints}
          edges={edges}
          selectedWaypointId={selectedWaypointId}
          arrivedWaypointId={arrivedWaypointId}
          selectedEdgeId={selectedEdgeId}
          validation={validation}
          robot={selectedRobot}
          robotLoadState={robotLoadState}
          robotPose={robotPose}
          robotJointValues={robotJointValues}
          lockedRobotJointNames={lockedRobotJointNames}
          meshRenderQuality={meshRenderQuality}
          onMeshRenderQualityChange={setMeshRenderQuality}
          spaceMouseInputRef={spaceMouseInputRef}
          main3DCanvasRef={main3DCanvasRef}
          teachingTasks={workbenchTeachingTasks}
          teachingDevice={teachingDevice}
          teachingSources={isIndependentTeachingSpace ? teachingSources : []}
          onTeachingSourceChange={switchTeachingSource}
          robotTasks={desktopTeachingTasks}
          mobilePoseSelection={selectedMobilePose ? mobilePoseSelection : null}
          onSelectMobilePose={selectMobilePose}
          onOpenMobileRobotPose={openMobileRobotPose}
          onOpenMobileSource={openMobileSource}
          activeTeachingTaskId={activeTeachingTaskId}
          activeTeachingParkingPointId={activeTeachingParkingPointId}
          robotParkingGhostId={robotParkingGhost?.parkingPointId || null}
          robotParkingGhostPoseId={robotParkingGhost?.poseId || null}
          editingTeachingPoseId={robotParkingGhost?.editing ? robotParkingGhost.poseId : null}
          jointPoses={jointPoses}
          zividCameraPoses={zividCameraPoses}
          cameraTeachingResult={cameraTeachingResult}
          teachingCaptureState={teachingCaptureState}
          collapsed={inspectorCollapsed}
          onCollapsedChange={setInspectorCollapsed}
          onRunConnectivity={runConnectivity}
          onImportRoute={() => abxRouteInputRef.current?.click()}
          onExportRoute={exportAbxRoutes}
          routeImportDisabled={!mapData || abxImportBusy || loadState.loading}
          routeImportBusy={abxImportBusy}
          routeExportDisabled={(!waypoints.length && !abxRoutes.length) || abxImportBusy}
          onSyncMapRoute={syncMapRoute}
          mapRouteSync={mapRouteSync}
          mapRouteSyncBusy={mapRouteSyncBusy}
          mapRouteSyncDisabled={loadState.loading || sessionState.status !== 'ready'}
          onSelectWaypoint={focusWaypointFromInspector}
          onSearchWaypoint={focusWaypointFromInspector}
          onMoveToWaypoint={moveRobotToWaypoint}
          selectedMapOrigin={selectedMapOrigin}
          onMoveToMapOrigin={moveRobotToMapOrigin}
          waypointMoveDisabled={loadState.loading || teachingCaptureState.status === 'capturing'}
          onSelectEdge={focusEdgeFromInspector}
          onClearSelection={clearSelection}
          onUpdateWaypoint={updateWaypoint}
          onUpdateEdge={updateEdge}
          onDeleteWaypoint={deleteWaypoint}
          onDeleteEdge={deleteEdge}
          onCreateTeachingTask={createTeachingTask}
          onSelectTeachingTask={selectTeachingTask}
          onCreateTeachingParkingPoint={createTeachingParkingPoint}
          onSelectTeachingParkingPoint={(id, poseId) => previewTeachingParkingPoint(id, poseId, {
            showReadout: false,
          })}
          onCaptureTeachingPoint={captureTeachingPoint}
          onDeleteTeachingTask={deleteTeachingTask}
          onDeleteTeachingParkingPoint={deleteTeachingParkingPoint}
          onDeleteTeachingPoint={deleteTeachingPoint}
          onOpenTeachingPolyline={openTeachingPolyline}
          onDeleteTeachingPolyline={deleteTeachingPolyline}
          polylineActionsDisabled={polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)
            || loadState.loading || sessionState.status !== 'ready'}
          onApplyTeachingPoint={applyTeachingParkingPoint}
          onApplyTeachingUpperBodyPose={applyTeachingUpperBodyPose}
          onSolveMobileTask={openMobileTeachingSolve}
          onSaveMobileTask={saveMobileTeachingTask}
          mobileSaveDisabledReason={mobileSaveDisabledReason}
          onUpdateRobotJointValue={updateRobotJointValue}
          onToggleRobotJointLock={toggleRobotJointLock}
          onUnlockAllRobotJoints={unlockAllRobotJoints}
          onZeroRobotJoints={zeroRobotJoints}
          onCaptureJointPose={captureJointPose}
          onRenameJointPose={renameJointPose}
          onDeleteJointPose={deleteJointPose}
          onApplyJointPose={applyJointPose}
          onCameraTeachingMove={requestCameraTeachingMove}
          onZividCaptureProviderChange={handleZividCaptureProviderChange}
          isWorkbenchActive={appPage === APP_PAGE_WORKBENCH}
        />
      </main>

      <footer className="statusbar">
        <span><CircleDot size={10} /> FRAME / {coordinateFrame.toUpperCase()} · XY + Z-UP</span>
        <span><Zap size={10} /> GPU POINT RENDER</span>
        <span
          className={`session-guard is-${sessionState.status}`}
          data-session-state={sessionState.status}
          data-session-restored={sessionState.restored ? 'true' : 'false'}
          data-recovery-available={lastProjectRecovery?.available ? 'true' : 'false'}
          title={
            sessionState.status === 'error'
              ? '自动保护不可用，请使用“工程 → 另存为工程”保存备份'
              : '刷新页面自动恢复当前工作现场；服务或计算机重启后可前往示教数据页恢复工程'
          }
        >
          {sessionState.status === 'error' ? <ShieldAlert size={10} /> : <ShieldCheck size={10} />}
          {sessionState.status === 'checking'
            ? 'SESSION CHECK'
            : sessionState.status === 'error'
              ? 'SESSION UNPROTECTED'
              : lastProjectRecovery?.available
                ? 'RECOVERY READY'
                : 'SESSION AUTO-SAVE'}
        </span>
        {projectDirectoryState.status !== 'detached' && (
          <span
            className={`project-directory-guard is-${projectDirectoryState.status}`}
            title={projectDirectoryState.status === 'synced'
              ? `${projectDirectoryState.name} · 工程配置与新增示教资源已同步`
              : projectDirectoryState.status === 'saving'
                ? `${projectDirectoryState.name} · 正在增量写入`
                : projectDirectoryState.status === 'readonly'
                  ? `${projectDirectoryState.name} · 浏览器未提供目录写权限`
                  : projectDirectoryState.error || '需要重新授权工程目录'}
          >
            <FolderOpen size={10} />
            {projectDirectoryState.status === 'saving'
              ? 'PROJECT SAVING'
              : projectDirectoryState.status === 'synced'
                ? 'PROJECT SYNCED'
                : projectDirectoryState.status === 'readonly'
                  ? 'PROJECT READ ONLY'
                  : 'PROJECT ATTENTION'}
          </span>
        )}
        <span className="statusbar__hint">
          {mode === 'connect' && connectionSourceId
            ? '起点已锁定 · 请选择终点'
            : mode === 'add'
              ? selectedRobot && robotLoadState.status === 'loaded'
                ? '再次点击“添加导航点”记录机器人 · 或点击二维截面继续添加'
                : '点击二维截面添加导航点'
              : mode === 'box'
                ? '二维图左键拉框 · Delete 删除所选'
                : '拖动二维地图平移 · 滚轮缩放'}
        </span>
        <span>SCHEMA 1.3</span>
      </footer>

      {appPage === APP_PAGE_WORKBENCH && toast && (
        <div className={`toast-message ${toast.kind}`} role="status">
          <span>{toast.kind === 'error' ? <X size={14} /> : <Check size={14} />}</span>
          {toast.message}
        </div>
      )}
      {appPage === APP_PAGE_WORKBENCH && mapDetailsOpen && mapData?.bounds && (
        <MapDetailsDialog
          mapData={mapData}
          teachingSpaceMode={teachingSpaceMode}
          heightRange={heightRange}
          robot={selectedRobot}
          robotLoadState={robotLoadState}
          robotPose={robotPose}
          robotControlEnabled={robotControlEnabled}
          robotHeightLocked={robotHeightLocked}
          meshRenderQuality={meshRenderQuality}
          onClose={closeMapDetails}
          returnFocusRef={mapDetailsButtonRef}
        />
      )}
      {appPage === APP_PAGE_WORKBENCH && robotJointLimitDraft && (
        <RobotJointLimitDialog snapshot={robotJointLimitDraft} onApply={applyRobotJointLimits}
          onClose={closeRobotJointLimits} returnFocusRef={robotMenuButtonRef} />
      )}
      {appPage === APP_PAGE_WORKBENCH && robotPresetManager && (
        <RobotPresetManagerDialog poses={projectRobotPresets} robot={selectedRobot} canEdit={robotPresetReady}
          hidden={Boolean(robotPresetDraft)} onNew={() => openRobotPreset()} onEdit={openRobotPreset}
          onRename={renameRobotPreset} onDelete={deleteRobotPreset}
          onClose={closeRobotPresetManager} returnFocusRef={robotMenuButtonRef} />
      )}
      {appPage === APP_PAGE_WORKBENCH && robotPresetDraft && (
        <RobotPresetDialog key={robotPresetDraft.id} snapshot={robotPresetDraft} onSave={saveRobotPreset}
          currentJointValues={robotJointValues}
          onClose={closeRobotPreset} returnFocusRef={robotPresetReturnFocusRef} />
      )}
    </div>
    {appPage === APP_PAGE_HOME && (
      <>
        <StartPage
          initialMode={startPageMode ?? teachingSpaceMode}
          workspaces={workspaceCatalog}
          sessionState={sessionState}
          projectDirectoryState={projectDirectoryState}
          busy={loadState.loading || Boolean(cacheActionDialog?.busy)}
          syncControl={<WorkSyncControl sync={workSync} />}
          onGlobalReset={() => openCacheAction('reset')}
          resetDisabled={independentSwitchBlocked}
          onNewProject={beginNewProject}
          onLoadProject={showProjectLoadDialog}
          onContinue={(modeId) => continueWorkspace(modeId, APP_PAGE_WORKBENCH)}
          onOpenTeachingData={(modeId) => continueWorkspace(modeId, APP_PAGE_TEACHING_DATA)}
          onOpenModelEditor={() => navigateAppPage(APP_PAGE_MODEL_EDITOR)}
        />
        {toast && (
          <div className={`toast-message ${toast.kind}`} role="status">
            <span>{toast.kind === 'error' ? <X size={14} /> : <Check size={14} />}</span>
            {toast.message}
          </div>
        )}
      </>
    )}
    <ModelEditorPage active={appPage === APP_PAGE_MODEL_EDITOR} onHome={() => navigateAppPage(APP_PAGE_HOME)} onOpenPair={() => navigateAppPage(APP_PAGE_MODEL_PAIR_EDITOR)} />
    <WorkSyncAuthorization sync={workSync} />
    <ModelPairEditorPage active={appPage === APP_PAGE_MODEL_PAIR_EDITOR} onBack={() => navigateAppPage(APP_PAGE_MODEL_EDITOR)} />
    {appPage === APP_PAGE_TEACHING_DATA && (
      <div className="app-shell is-teaching-data-page" data-app-page="teaching-data">
        <TeachingDataPage
          tasks={teachingTasks}
          jointPoses={jointPoses}
          teachingSpaceMode={teachingSpaceMode}
          activeTaskId={activeTeachingTaskId}
          activeParkingPointId={activeTeachingParkingPointId}
          mapData={mapData}
          heightRange={heightRange}
          pointColorMode={pointColorMode}
          robot={selectedRobot}
          robotLoadState={robotLoadState}
          robotJointValues={robotJointValues}
          captureState={teachingCaptureState}
          parkingMergePlannerReady={parkingMergePlannerReady}
          projectExportState={projectExportState}
          sessionState={sessionState}
          recovery={lastProjectRecovery}
          onBack={() => navigateAppPage(APP_PAGE_WORKBENCH)}
          onHome={() => navigateAppPage(APP_PAGE_HOME)}
          onOpenLastProject={() => openLastProject()}
          onSelectTask={selectTeachingTask}
          onRenameTask={renameTeachingTask}
          onDeleteTask={deleteTeachingTask}
          onSelectParkingPoint={selectTeachingParkingPoint}
          onViewParkingPoint={viewTeachingParkingPoint}
          onRenameParkingPoint={renameTeachingParkingPoint}
          onDeleteParkingPoint={deleteTeachingParkingPoint}
          onApplyParkingPoint={applyTeachingParkingPoint}
          onRenamePoint={renameTeachingPoint}
          onDeletePoint={deleteTeachingPoint}
          onApplyPoint={applyTeachingPoint}
          onViewPose={viewTeachingPose}
          onInsertPreset={insertTeachingPresetAction}
          onMovePoint={moveTeachingPoint}
          onPlayTask={startTeachingTaskPlayback}
          onOpenPolyline={openTeachingPolyline}
          playbackDisabled={polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)
            || teachingCaptureState.status === 'capturing' || Boolean(robotParkingGhost?.editing)
            || loadState.loading || sessionState.status !== 'ready'}
          onAnalyzeParkingPointMerge={analyzeTeachingParkingPointMerge}
          onMergeParkingPoints={mergeTeachingParkingPoints}
          onExportProject={exportProject}
          onExportTeachingData={exportTeachingData}
          onCopyTeachingNode={copyTeachingNode}
          onImportTeachingData={teachingSpaceMode === 'map' ? () => abxTeachingInputRef.current?.click() : null}
          teachingImportDisabled={!mapData || abxImportBusy || loadState.loading || teachingCaptureState.status === 'capturing'}
          canExportTeachingData={Boolean(mapData || selectedRobot || teachingTasks.length || jointPoses.length || waypoints.length)}
          onSolveMobileTask={openMobileTeachingSolve}
          onSaveMobileTask={saveMobileTeachingTask}
          mobileSaveDisabledReason={mobileSaveDisabledReason}
        />

        {toast && (
          <div className={`toast-message ${toast.kind}`} role="status">
            <span>{toast.kind === 'error' ? <X size={14} /> : <Check size={14} />}</span>
            {toast.message}
          </div>
        )}
      </div>
    )}
    {[APP_PAGE_WORKBENCH, APP_PAGE_TEACHING_DATA].includes(appPage) && (loadState.loading || projectImportProgress) && (
      <div className="loading-curtain" role="status" aria-live="polite">
        <div className={`loading-module ${projectImportProgress ? 'is-project-import' : ''}`}>
          <div className="loading-module__top">
            <MapIcon size={18} />
            <span>{projectImportProgress ? '加载工程' : loadState.phase}</span>
            <strong>{progressLabel}</strong>
          </div>
          <div className="loading-track" role="progressbar" aria-label={projectImportProgress ? '工程加载总进度' : loadState.phase}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(loadingProgress * 100)}>
            <span style={{ width: `${Math.max(loadingProgress * 100, projectImportProgress ? 0 : 4)}%` }} />
          </div>
          {projectImportProgress ? <>
            <small className="loading-module__source" title={projectImportProgress.sourceName}>{projectImportProgress.sourceName}</small>
            <small className="loading-module__stage">{projectImportProgress.stage}</small>
          </> : <small>{loadState.detail || '正在准备工作现场，请保持页面开启'}</small>}
        </div>
      </div>
    )}
    {projectExportDialog && <ProjectExportDialog
      filename={projectExportDialog.filename}
      onSave={exportProject}
      onClose={() => setProjectExportDialog(null)}
    />}
    {abxExportSnapshot && <AbxTeachingExportDialog snapshot={abxExportSnapshot} onClose={() => setAbxExportSnapshot(null)} />}
    {independentExportDialog && <IndependentTeachingExportDialog state={independentExportDialog}
      onMapExport={() => chooseIndependentTeachingExport('zip')}
      onJsonExport={() => chooseIndependentTeachingExport('json')}
      onClose={() => { if (!teachingExportBusyRef.current) setIndependentExportDialog(null); }} />}
    {abxRouteExport && <AbxRouteExportDialog routes={abxRouteExport} onClose={() => setAbxRouteExport(null)} />}
    <MobileTeachingComputeDock computation={mobileComputation} inWorkbench={appPage === APP_PAGE_WORKBENCH}
      onSave={saveMobileTeachingTask} onPlay={playMobileTeachingTask} saveDisabledReason={mobileSaveDisabledReason}
      onPause={pauseMobileTeaching} onResume={resumeMobileTeaching} onCancel={cancelMobileTeaching}
      onRestart={restartMobileTeaching} onDismiss={dismissMobileTeaching}
      onConfigure={() => openMobileTeachingSolve(mobileComputation.taskId)} onPreview={previewMobileTeaching}
      onFollowLatest={(follow) => follow ? previewMobileTeaching(mobileTeachingRunRef.current.previews.length - 1, true)
        : setMobileComputation((value) => ({ ...value, followLatest: false }))}
      onFocusPreview={() => requestSynchronizedFocus('robot-ghost', mobileComputation.preview?.parkingPointId)} />
    {mobileSolveTaskId && teachingTasks.find((task) => task.id === mobileSolveTaskId)?.mobileCapture && <MobileTeachingSolveDialog
      initialSampleId={mobileSolveSampleId}
      key={mobileSolveTaskId} task={teachingTasks.find((task) => task.id === mobileSolveTaskId)} robot={selectedRobot} robotPose={robotPose}
      robotPresets={robotPresets}
      computation={mobileComputation?.taskId === mobileSolveTaskId ? mobileComputation : null}
      ready={!mobileSolveDisabledReason} readinessMessage={mobileSolveDisabledReason} robotLoadState={robotLoadState}
      robotSelectionDisabled={sessionState.status !== 'ready' || ['running', 'pausing', 'paused'].includes(mobileComputation?.status)}
      onSelectRobot={(value) => { dismissMobileTeaching(); handleSelectRobot(value); setShowRobotModel(true); }}
      onClose={() => setMobileSolveTaskId(null)} onCalculate={calculateMobileTeaching}
      onApply={applyMobileTeachingSolution} onSave={saveMobileTeachingSolutions} onPlay={playMobileTeachingSolutions} />}
    {appPage === APP_PAGE_WORKBENCH && <IPadScreenCollaboration open={ipadScreenOpen} onClose={() => setIPadScreenOpen(false)}
      mapData={mapData} robot={selectedRobot} robotLoadState={robotLoadState} cameraPoses={zividCameraPoses} meshRenderQuality={meshRenderQuality}
      jointValues={robotJointValues} onChangeJoint={updateRobotJointValue} viewportCaptureRef={collaborationViewportRef}
      poseCaptureState={ipadPoseCaptureState} onRecordPose={recordPoseFromIPad}
      controlBlockedReason={(polylineTeachingBusy || ['playing', 'paused'].includes(teachingPlayback.status)) ? '请先在网页端结束轨迹播放或折线任务，再调整关节。'
        : teachingCaptureState.status === 'capturing' ? '正在记录 Pose，请稍候。' : ''} />}
    {visionSceneOpen && <VisionSceneShareDialog mapData={mapData} robot={selectedRobot} robotPose={robotPose} robotJointValues={robotJointValues}
      tasks={teachingTasks} waypoints={waypoints} edges={edges} mode={teachingSpaceMode} softLimitRatio={robotArmSoftLimitRatio}
      softLimitOverrides={robotArmSoftLimitOverrides} jointCoupling={robotArmJointCouplingEnabled} onClose={() => setVisionSceneOpen(false)} />}
    {ipadTeachingOpen && <IPadTeachingDialog device={ipadTeachingEntry.device} mapData={mapData} teachingTasks={teachingTasks} waypoints={waypoints} edges={edges} initialAction={ipadTeachingEntry.action} initialTicketId={ipadTeachingEntry.ticketId}
      onClose={() => setIPadTeachingOpen(false)} onImport={importIPadTeaching} />}
    {teachingTransferDialog && <TeachingTransferDialog
      state={teachingTransferDialog}
      onClose={() => { if (!teachingTransferBusyRef.current) setTeachingTransferDialog(null); }}
      onApply={applyTeachingTransfer}
      onLoadMap={() => {
        setTeachingTransferDialog(null);
        navigateAppPage(APP_PAGE_HOME, { teachingSpaceMode: 'map' });
      }}
    />}
    {newIndependentDialog && <NewIndependentTeachingDialog
      state={newIndependentDialog}
      progress={loadState}
      onLoadRoute={loadNewIndependentRoute}
      onCreate={createIndependentTeaching}
      onClose={closeNewIndependentDialog}
    />}
    {independentWorkspaceDialog && <IndependentWorkspaceDialog
      state={independentWorkspaceDialog}
      disabled={independentSwitchBlocked}
      onSelect={chooseIndependentWorkspace}
      onCreate={appPage === APP_PAGE_WORKBENCH && mapData?.geometry
        ? () => openNewIndependentDialog({ fromPicker: true }) : undefined}
      onClose={() => {
        if (!independentWorkspaceDialog.busy) setIndependentWorkspaceDialog(null);
      }}
    />}
    {projectImportError && <ProjectImportErrorDialog error={projectImportError}
      onClose={() => setProjectImportError(null)}
      onChooseProject={() => {
        const mode = projectImportError.mode;
        setProjectImportError(null);
        showProjectLoadDialog(mode);
      }} />}
    <ProjectLoadDialog
      open={projectLoadDialog.open}
      teachingSpaceMode={projectLoadDialog.mode}
      directory={projectLoadDialog.directory}
      workspace={workspaceCatalog[projectLoadDialog.mode]}
      recovery={lastProjectRecovery}
      independentHistory={independentHistory}
      historyDisabled={independentSwitchBlocked}
      busy={loadState.loading || Boolean(independentNameDialog) || Boolean(cacheActionDialog)}
      onClose={closeProjectLoadDialog}
      onLoadDefaultDirectory={loadDefaultProjectDirectory}
      onLoadWorkspace={loadAutoSavedProject}
      onLoadRecovery={loadRecoveryProject}
      onLoadHistory={restoreIndependentHistory}
      onRenameIndependent={openIndependentNameDialog}
      onDeleteIndependent={(entry) => openCacheAction('independent', entry)}
      onChooseDirectory={chooseProjectDirectory}
      onChooseGuideFile={chooseProjectGuideFile}
    />
    {independentNameDialog && <IndependentTeachingNameDialog
      state={independentNameDialog}
      onSave={renameIndependentTeaching}
      onClose={() => { if (!independentSwitchBusyRef.current) setIndependentNameDialog(null); }}
    />}
    {cacheActionDialog && <WorkspaceCacheDialog state={cacheActionDialog} onConfirm={confirmCacheAction}
      mapData={mapData} exportState={projectExportState} exportNotice={toast} onExport={exportProject}
      exportDialogOpen={Boolean(projectExportDialog)} exportDisabled={independentSwitchBlocked}
      onClose={() => { if (!independentSwitchBusyRef.current) setCacheActionDialog(null); }} />}
    </RobotJointCouplingContext.Provider>
    </RobotJointSoftRangesContext.Provider>
    </RobotJointLimitContext.Provider>
  );
}

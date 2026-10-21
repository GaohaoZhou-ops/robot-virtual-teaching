import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Download,
  FolderOpen,
  MoveHorizontal,
  Navigation,
  PanelRightClose,
  PanelRightOpen,
  Route,
  RefreshCw,
  Ruler,
  ScanLine,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { calculatePathDistances } from '../lib/pathMetrics.js';
import { TEMPORARY_MAP_ROUTE_SOURCE } from '../lib/teachingNavigation.js';
import { abxNodeLabel } from '../lib/abxRoute.js';
import { connectivityCopy } from '../lib/graph.js';
import ConnectivityResults from './ConnectivityResults.jsx';
import FloatingRobotJointPanel from './FloatingRobotJointPanel.jsx';
import VirtualTeachingPanel from './VirtualTeachingPanel.jsx';
import ZividCameraPanel from './ZividCameraPanel.jsx';

function NumericField({ label, value, unit, step = '0.01', onCommit }) {
  const [draft, setDraft] = useState(String(Number(value).toFixed(2)));

  useEffect(() => {
    setDraft(String(Number(value).toFixed(2)));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(Number(value).toFixed(2)));
  };

  return (
    <label className="numeric-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}

function WaypointNameField({ name, onCommit }) {
  const [draft, setDraft] = useState(name);
  const nextName = draft.trim();
  const canCommit = Boolean(nextName && nextName !== name);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  return (
    <form
      className="waypoint-name-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCommit) return;
        onCommit(nextName);
        setDraft(nextName);
      }}
    >
      <label className="text-field">
        <span>导航点名称</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) {
              event.preventDefault();
            }
          }}
        />
      </label>
      <button type="submit" className="action-button primary" disabled={!canCommit}>
        修改
      </button>
    </form>
  );
}

const statusMeta = {
  connected: { label: '可互达', className: 'connected' },
  unreachable: { label: '未互达', className: 'unreachable' },
  unchecked: { label: '待检测', className: 'unchecked' },
};

export default function Inspector({
  mapData,
  pageRequest = null,
  teachingSpaceMode = 'map',
  waypoints,
  edges,
  selectedWaypointId,
  arrivedWaypointId = null,
  selectedEdgeId,
  validation,
  robot,
  robotLoadState,
  robotPose,
  robotJointValues,
  lockedRobotJointNames = [],
  meshRenderQuality = 'auto',
  onMeshRenderQualityChange,
  spaceMouseInputRef,
  main3DCanvasRef,
  teachingTasks = [],
  teachingDevice,
  teachingSources,
  onTeachingSourceChange,
  robotTasks,
  mobilePoseSelection,
  onSelectMobilePose,
  onOpenMobileRobotPose,
  onOpenMobileSource,
  onEditTeachingPose,
  activeTeachingTaskId,
  activeTeachingParkingPointId,
  robotParkingGhostId,
  robotParkingGhostPoseId,
  editingTeachingPoseId,
  jointPoses = [],
  zividCameraPoses,
  cameraTeachingResult,
  teachingCaptureState,
  onRunConnectivity,
  onImportRoute,
  onExportRoute,
  routeImportDisabled = false,
  routeImportBusy = false,
  routeExportDisabled = false,
  onSyncMapRoute,
  mapRouteSync,
  mapRouteSyncBusy = false,
  mapRouteSyncDisabled = false,
  onSelectWaypoint,
  onSearchWaypoint,
  onMoveToWaypoint,
  waypointMoveDisabled = false,
  onSelectEdge,
  onClearSelection,
  onUpdateWaypoint,
  onUpdateEdge,
  onDeleteWaypoint,
  onDeleteEdge,
  onCreateTeachingTask,
  onSelectTeachingTask,
  onCreateTeachingParkingPoint,
  onSelectTeachingParkingPoint,
  onCaptureTeachingPoint,
  onDeleteTeachingTask,
  onDeleteTeachingParkingPoint,
  onDeleteTeachingPoint,
  onSolveMobileTask,
  onSaveMobileTask,
  mobileSaveDisabledReason,
  onUpdateRobotJointValue,
  onToggleRobotJointLock,
  onUnlockAllRobotJoints,
  onZeroRobotJoints,
  onCaptureJointPose,
  onRenameJointPose,
  onDeleteJointPose,
  onApplyJointPose,
  onCameraTeachingMove,
  onZividCaptureProviderChange,
  collapsed = false,
  onCollapsedChange,
  isWorkbenchActive = true,
}) {
  const [activePage, setActivePage] = useState('teaching');
  const [routeIndexCollapsed, setRouteIndexCollapsed] = useState(false);
  const [waypointIndexCollapsed, setWaypointIndexCollapsed] = useState(false);
  const navigationListsId = useId();
  const [activeTeachingCameraSide, setActiveTeachingCameraSide] = useState('left');
  const [expandedCameraSide, setExpandedCameraSide] = useState(null);
  const [jointWindowOpen, setJointWindowOpen] = useState(false);
  const [connectivityResultsOpen, setConnectivityResultsOpen] = useState(false);
  const pathTestRef = useRef(null);
  const closeConnectivityResults = useCallback(() => setConnectivityResultsOpen(false), []);
  const scrollRef = useRef(null);
  const workbenchActivityRef = useRef(isWorkbenchActive);
  const selectedWaypoint = waypoints.find((point) => point.id === selectedWaypointId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const isIndependentTeachingSpace = teachingSpaceMode === 'independent';
  const coordinateFrameLabel = isIndependentTeachingSpace ? 'VIRTUAL_ORIGIN' : 'MAP';
  const hasTemporaryMapRoute = waypoints.some((point) => point.source === TEMPORARY_MAP_ROUTE_SOURCE);
  const pointById = useMemo(() => new Map(waypoints.map((point) => [point.id, point])), [waypoints]);
  const activeTeachingTask = teachingTasks.find((task) => task.id === activeTeachingTaskId)
    || teachingTasks[0]
    || null;
  const taskRobotKey = activeTeachingTask?.robot?.id
    || activeTeachingTask?.robot?.relativePath;
  const currentRobotKey = robot?.id || robot?.relativePath;
  const sameTeachingRobot = Boolean(
    taskRobotKey && currentRobotKey && taskRobotKey === currentRobotKey,
  );
  const sameTeachingMap = activeTeachingTask?.map?.sourceHash && mapData?.sourceHash
    ? activeTeachingTask.map.sourceHash === mapData.sourceHash
    : Boolean(
        activeTeachingTask?.map?.fileName
        && activeTeachingTask.map.fileName === mapData?.name,
      );
  const cameraTeachingEnabled = Boolean(
    activeTeachingTask
    && sameTeachingRobot
    && sameTeachingMap
    && robotLoadState?.status === 'loaded'
    && Number(robotLoadState?.zividCount) > 0
    && zividCameraPoses?.[activeTeachingCameraSide],
  );
  const selectedPathMetrics = useMemo(
    () =>
      selectedEdge
        ? calculatePathDistances(
            pointById.get(selectedEdge.from)?.pose,
            pointById.get(selectedEdge.to)?.pose,
          )
        : null,
    [pointById, selectedEdge],
  );

  useEffect(() => {
    setJointWindowOpen(Boolean(editingTeachingPoseId));
  }, [editingTeachingPoseId]);

  useEffect(() => {
    const resumed = isWorkbenchActive && !workbenchActivityRef.current;
    workbenchActivityRef.current = isWorkbenchActive;
    if (resumed) {
      setActivePage('teaching');
    }
  }, [isWorkbenchActive]);

  const validationCopy = connectivityCopy(validation);
  const ValidationIcon = validation.status === 'connected' ? CheckCircle2
    : validation.status === 'partial' ? TriangleAlert : ScanSearch;

  useEffect(() => {
    setConnectivityResultsOpen(false);
  }, [activePage, collapsed, isWorkbenchActive, teachingSpaceMode, selectedWaypointId, selectedEdgeId]);

  useEffect(() => {
    if (validation.status !== 'partial') setConnectivityResultsOpen(false);
  }, [validation.status]);

  const updatePose = (key, value) => {
    onUpdateWaypoint(selectedWaypoint.id, {
      pose: { ...selectedWaypoint.pose, [key]: value },
    });
  };

  const updateLimit = (key, value) => {
    onUpdateEdge(selectedEdge.id, {
      limits: { ...selectedEdge.limits, [key]: value },
    });
  };

  const updateMotion = (patch) => {
    onUpdateEdge(selectedEdge.id, {
      motion: {
        direction: selectedEdge.motion?.direction === 'reverse' ? 'reverse' : 'forward',
        enable3DObstacleAvoidance: selectedEdge.motion?.enable3DObstacleAvoidance !== false,
        ...patch,
      },
    });
  };

  const invalidLimits = selectedEdge
    ? selectedEdge.limits.minSpeed > selectedEdge.limits.maxSpeed ||
      selectedEdge.limits.minAcceleration > selectedEdge.limits.maxAcceleration
    : false;
  const inspectorPages = [
    {
      id: 'navigation',
      index: '01',
      label: '路径与导航',
      compactLabel: '路径 / 导航',
      summary: `${waypoints.length}P · ${edges.length}E`,
      icon: Route,
    },
    {
      id: 'teaching',
      index: '02',
      label: '示教',
      compactLabel: '示教',
      summary: `${teachingTasks.length} TASKS`,
      icon: Bot,
    },
    {
      id: 'camera',
      index: '03',
      label: '相机',
      compactLabel: '相机',
      summary: `${robotLoadState?.zividCount || 0} CAMERAS`,
      icon: Camera,
    },
  ];
  const activePageMeta = inspectorPages.find((page) => page.id === activePage)
    || inspectorPages[0];

  useEffect(() => {
    if (selectedEdgeId || (selectedWaypoint && !selectedWaypoint.teachingTaskId)) {
      setActivePage('navigation');
    }
  }, [selectedEdgeId, selectedWaypointId, selectedWaypoint?.id, selectedWaypoint?.teachingTaskId]);

  useEffect(() => {
    if (!pageRequest) return;
    setActivePage(pageRequest.page);
    if (pageRequest.cameraSide === 'left' || pageRequest.cameraSide === 'right') {
      setActiveTeachingCameraSide(pageRequest.cameraSide);
    }
  }, [pageRequest]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activePage]);

  const handleZividExpandedChange = useCallback((isExpanded, side) => {
    if (isExpanded) {
      setExpandedCameraSide(side);
      setActiveTeachingCameraSide(side);
      setJointWindowOpen(false);
    } else {
      setExpandedCameraSide((current) => current === side ? null : current);
    }
  }, []);

  const activateInspectorPage = (pageId) => {
    setActivePage(pageId);
  };

  const handleTabKeyDown = (event, pageIndex) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? inspectorPages.length - 1
        : (pageIndex + (event.key === 'ArrowRight' ? 1 : -1) + inspectorPages.length)
          % inspectorPages.length;
    const nextPage = inspectorPages[nextIndex];
    activateInspectorPage(nextPage.id);
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${nextPage.id}`)?.focus());
  };

  return (
    <>
      <aside
        className={`inspector-panel ${collapsed ? 'is-collapsed' : ''}`}
        data-active-page={activePage}
        data-collapsed={collapsed ? 'true' : 'false'}
        aria-label="图谱控制台"
      >
      <div
        id="inspector-panel-content"
        className="inspector-panel__content"
        aria-hidden={collapsed ? 'true' : 'false'}
        inert={collapsed ? '' : undefined}
      >
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">CONTROL DECK / {activePageMeta.index}</span>
          <h2>图谱控制台</h2>
        </div>
        <div className="inspector-heading__tools">
          <button
            type="button"
            className={`joint-float-toggle ${jointWindowOpen ? 'is-active' : ''}`}
            aria-label={jointWindowOpen ? '隐藏全关节浮动窗口' : '打开全关节浮动窗口'}
            aria-pressed={jointWindowOpen}
            title="浮动显示全部机器人关节，不遮断地图与相机操作"
            onClick={() => setJointWindowOpen((current) => !current)}
          >
            <SlidersHorizontal size={12} />
            <span>关节</span>
          </button>
        </div>
      </div>

      <nav className="inspector-pagination" role="tablist" aria-label="控制台子页">
        {inspectorPages.map((page, pageIndex) => {
          const PageIcon = page.icon;
          const selected = activePage === page.id;
          return (
            <button
              type="button"
              role="tab"
              id={`inspector-tab-${page.id}`}
              key={page.id}
              className={selected ? 'is-active' : ''}
              aria-label={page.label}
              aria-selected={selected}
              aria-controls={`inspector-page-${page.id}`}
              tabIndex={selected ? 0 : -1}
              data-page={page.id}
              onClick={() => activateInspectorPage(page.id)}
              onKeyDown={(event) => handleTabKeyDown(event, pageIndex)}
            >
              <i>{page.index}</i>
              <span><PageIcon size={12} />{page.compactLabel}</span>
              <small>{page.summary}</small>
            </button>
          );
        })}
      </nav>

      <div className="inspector-scroll" data-page-scroll={activePage} ref={scrollRef}>
        {activePage === 'navigation' && (
          <div
            className="inspector-page inspector-page--navigation"
            role="tabpanel"
            id="inspector-page-navigation"
            aria-labelledby="inspector-tab-navigation"
          >
            {!isIndependentTeachingSpace && (
              <div className="inspector-route-actions" role="group" aria-label="路径导入导出">
                <button
                  type="button"
                  className="inspector-route-import"
                  aria-label="导入路径"
                  title="导入机器人路网 JSON，保留已有路径和示教任务"
                  disabled={routeImportDisabled || routeImportBusy || !onImportRoute}
                  onClick={() => {
                    onClearSelection();
                    onImportRoute();
                  }}
                >
                  <FolderOpen size={13} />
                  <span>{routeImportBusy ? '导入中…' : '导入路径'}</span>
                </button>
                <button
                  type="button"
                  className="inspector-route-import"
                  aria-label="导出路径"
                  title="导出机器人路网 JSON，保留节点编号和有向连接"
                  disabled={routeExportDisabled || routeImportBusy || !onExportRoute}
                  onClick={onExportRoute}
                >
                  <Download size={13} />
                  <span>导出路径</span>
                </button>
              </div>
            )}
            <div className="inspector-navigation-actions" role="group" aria-label="路径操作">
              {isIndependentTeachingSpace && (
                <button
                  type="button"
                  className={`inspector-route-import map-route-sync-button ${hasTemporaryMapRoute ? 'is-synced' : ''}`}
                  aria-busy={mapRouteSyncBusy}
                  disabled={!mapRouteSync?.available || mapRouteSyncDisabled || mapRouteSyncBusy || !onSyncMapRoute}
                  onClick={onSyncMapRoute}
                  title={mapRouteSync?.available
                    ? '按已建立的转换关系同步到独立模型坐标系；重新同步会替换临时副本，不修改地图路径'
                    : mapRouteSync?.reason}
                >
                  <RefreshCw size={13} />
                  <span>{mapRouteSyncBusy ? '同步中…' : hasTemporaryMapRoute ? '重新同步' : '同步路径'}</span>
                </button>
              )}
              <button
                type="button"
                className={`inspector-route-import path-test-button is-${validation.status}`}
                ref={pathTestRef}
                aria-haspopup="dialog"
                aria-expanded={connectivityResultsOpen}
                onClick={() => {
                  const result = onRunConnectivity();
                  setConnectivityResultsOpen(result?.status === 'partial');
                }}
                disabled={!edges.length}
                title={['运行有向图强连通检测', validationCopy.title, validationCopy.detail].filter(Boolean).join(' · ')}
              >
                <ValidationIcon size={13} />
                <span>路径测试</span>
              </button>
            </div>

            <section className="waypoint-search" aria-label="导航点搜索">
              <div className="waypoint-search__copy">
                <Search size={14} />
                <div>
                  <strong>定位导航点</strong>
                  <span>仅显示当前地图已配置点位</span>
                </div>
              </div>
              <label>
                <span className="visually-hidden">搜索导航点</span>
                <select
                  aria-label="搜索导航点"
                  value={selectedWaypointId || ''}
                  disabled={!waypoints.length}
                  onChange={(event) => {
                    if (event.target.value) onSearchWaypoint(event.target.value);
                    else onClearSelection();
                  }}
                >
                  <option value="">{waypoints.length ? '选择导航点…' : '暂无导航点'}</option>
                  {waypoints.map((point) => (
                    <option key={point.id} value={point.id}>
                      {point.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>

        {(selectedWaypoint || selectedEdge) && (
          <button type="button" className="back-link" onClick={onClearSelection}>
            <ArrowLeft size={13} /> 返回路径与导航
          </button>
        )}

        {selectedWaypoint && (
          <section className="property-editor">
            <div className="property-editor__title">
              <div className="point-glyph"><span /></div>
              <div className="waypoint-title">
                <span className="eyebrow">{selectedWaypoint.teachingTaskId ? 'TEACHING / PARKING POINT' : 'WAYPOINT / 3D POSE'}</span>
                <div className="waypoint-title__row">
                  <h3 title={selectedWaypoint.name}>{selectedWaypoint.name}</h3>
                  <button
                    type="button"
                    className="inspector-route-import waypoint-move-button"
                    disabled={!robot || robotLoadState?.status !== 'loaded' || waypointMoveDisabled || !onMoveToWaypoint}
                    title={!robot || robotLoadState?.status !== 'loaded'
                      ? '请先加载机器人模型'
                      : waypointMoveDisabled ? '请等待当前加载或采集完成'
                        : '移动到该导航点的 X/Y 并对齐底盘朝向，保持当前 Z 高度'}
                    onClick={() => onMoveToWaypoint(selectedWaypoint.id)}
                  >
                    <Navigation size={12} />运动到该点
                  </button>
                </div>
              </div>
            </div>

            <WaypointNameField
              key={selectedWaypoint.id}
              name={selectedWaypoint.name}
              onCommit={(name) => onUpdateWaypoint(selectedWaypoint.id, { name })}
            />

            <div className="field-section-heading">
              {selectedWaypoint.source !== TEMPORARY_MAP_ROUTE_SOURCE && <span>原始三维坐标</span>}
              <small>XYZ · meter</small>
            </div>
            <div className="field-grid three">
              <NumericField label="X" value={selectedWaypoint.pose.x} unit="m" onCommit={(value) => updatePose('x', value)} />
              <NumericField label="Y" value={selectedWaypoint.pose.y} unit="m" onCommit={(value) => updatePose('y', value)} />
              <NumericField label="Z" value={selectedWaypoint.pose.z} unit="m" onCommit={(value) => updatePose('z', value)} />
            </div>

            <div className="field-section-heading">
              <span>姿态角</span>
              <small>RPY · degree</small>
            </div>
            <div className="field-grid three">
              <NumericField label="ROLL" value={selectedWaypoint.pose.roll} unit="°" onCommit={(value) => updatePose('roll', value)} />
              <NumericField label="PITCH" value={selectedWaypoint.pose.pitch} unit="°" onCommit={(value) => updatePose('pitch', value)} />
              <NumericField label="YAW" value={selectedWaypoint.pose.yaw} unit="°" onCommit={(value) => updatePose('yaw', value)} />
            </div>

            {selectedWaypoint.source !== TEMPORARY_MAP_ROUTE_SOURCE && <div className="capture-note">
              <CrosshairMark />
              {selectedWaypoint.teachingTaskId ? (
                <span>关联示教任务「{selectedWaypoint.teachingTaskName}」。名称和位置与停车点同步，位置修改也会同步到所属姿态。</span>
              ) : selectedWaypoint.source === 'robot-current-pose' ? (
                <span>XYZ 与 RPY 取自机器人当前 {coordinateFrameLabel} 位姿；导出时同时写入 <code>pose</code>、<code>xzy</code> 与 <code>rpy</code>。</span>
              ) : (
                <span>Z 值取自点击位置附近的原始点云；导出时同时写入 <code>pose</code>、<code>xzy</code> 与 <code>rpy</code>。</span>
              )}
            </div>}

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (selectedWaypoint.teachingTaskId || window.confirm(`删除 ${selectedWaypoint.name} 及其关联路径？`)) {
                  onDeleteWaypoint(selectedWaypoint.id);
                }
              }}
            >
              <Trash2 size={14} /> 删除导航点
            </button>
          </section>
        )}

        {selectedEdge && (
          <section className="property-editor">
            <div className="property-editor__title">
              <div className="route-glyph"><Route size={17} /></div>
              <div>
                <span className="eyebrow">DIRECTED PATH</span>
                <h3>路径参数</h3>
              </div>
            </div>

            <div className="direction-card">
              <div>
                <small>FROM</small>
                <strong>{pointById.get(selectedEdge.from)?.name || selectedEdge.from}</strong>
              </div>
              <div className="direction-arrow"><ArrowRight size={18} /></div>
              <div>
                <small>TO</small>
                <strong>{pointById.get(selectedEdge.to)?.name || selectedEdge.to}</strong>
              </div>
            </div>

            {selectedPathMetrics && (
              <div
                className="path-distance-card"
                aria-label="路径距离"
                data-straight-distance={selectedPathMetrics.straight3D}
                data-xy-distance={selectedPathMetrics.planarXY}
                data-vertical-delta={selectedPathMetrics.verticalDelta}
              >
                <div className="path-distance-card__heading">
                  <Ruler size={13} />
                  <span>几何距离</span>
                  <small>LIVE CALC</small>
                </div>
                <div className="path-distance-card__metrics">
                  <div>
                    <Ruler size={14} />
                    <span>3D 直线距离</span>
                    <strong>{selectedPathMetrics.straight3D.toFixed(3)} <em>m</em></strong>
                  </div>
                  <div>
                    <MoveHorizontal size={14} />
                    <span>XY 平面距离</span>
                    <strong>{selectedPathMetrics.planarXY.toFixed(3)} <em>m</em></strong>
                  </div>
                </div>
                <p>
                  XY 距离已排除定位高度误差
                  <span>ΔZ {selectedPathMetrics.verticalDelta.toFixed(3)} m</span>
                </p>
              </div>
            )}

            <div className="field-section-heading">
              <span>执行策略</span>
              <small>motion behavior</small>
            </div>
            <div className="motion-config">
              <div className="motion-config__row">
                <div>
                  <strong>车体行驶方式</strong>
                  <span>不改变 FROM → TO 的有向关系</span>
                </div>
                <div className="motion-direction-toggle" role="group" aria-label="行驶方向">
                  <button
                    type="button"
                    aria-pressed={selectedEdge.motion?.direction !== 'reverse'}
                    className={selectedEdge.motion?.direction !== 'reverse' ? 'is-active' : ''}
                    onClick={() => updateMotion({ direction: 'forward' })}
                  >
                    正走
                  </button>
                  <button
                    type="button"
                    aria-pressed={selectedEdge.motion?.direction === 'reverse'}
                    className={selectedEdge.motion?.direction === 'reverse' ? 'is-active' : ''}
                    onClick={() => updateMotion({ direction: 'reverse' })}
                  >
                    倒车
                  </button>
                </div>
              </div>
              <div className="motion-config__row">
                <div className="motion-config__perception">
                  <ScanLine size={15} />
                  <div>
                    <strong>3D 感知避障</strong>
                    <span>行进过程中启用空间障碍物检测</span>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="3D感知避障"
                  aria-checked={selectedEdge.motion?.enable3DObstacleAvoidance !== false}
                  className={`perception-switch ${selectedEdge.motion?.enable3DObstacleAvoidance !== false ? 'is-on' : ''}`}
                  title={
                    selectedEdge.motion?.enable3DObstacleAvoidance !== false
                      ? '点击关闭行进中的 3D 感知避障'
                      : '点击启用行进中的 3D 感知避障'
                  }
                  onClick={() =>
                    updateMotion({
                      enable3DObstacleAvoidance:
                        selectedEdge.motion?.enable3DObstacleAvoidance === false,
                    })
                  }
                >
                  <span><i /></span>
                  <em>
                    {selectedEdge.motion?.enable3DObstacleAvoidance !== false ? '已启用' : '已关闭'}
                  </em>
                </button>
              </div>
            </div>

            <div className="field-section-heading">
              <span>速度约束</span>
              <small>meter / second</small>
            </div>
            <div className="field-grid two">
              <NumericField label="最小速度" value={selectedEdge.limits.minSpeed} unit="m/s" onCommit={(value) => updateLimit('minSpeed', value)} />
              <NumericField label="最大速度" value={selectedEdge.limits.maxSpeed} unit="m/s" onCommit={(value) => updateLimit('maxSpeed', value)} />
            </div>

            <div className="field-section-heading">
              <span>加速度约束</span>
              <small>meter / second²</small>
            </div>
            <div className="field-grid two">
              <NumericField label="最小加速度" value={selectedEdge.limits.minAcceleration} unit="m/s²" onCommit={(value) => updateLimit('minAcceleration', value)} />
              <NumericField label="最大加速度" value={selectedEdge.limits.maxAcceleration} unit="m/s²" onCommit={(value) => updateLimit('maxAcceleration', value)} />
            </div>

            {invalidLimits && (
              <div className="inline-warning"><TriangleAlert size={14} /> 最小值不能大于最大值</div>
            )}

            <div className={`path-status ${selectedEdge.status}`}>
              <span />
              {statusMeta[selectedEdge.status]?.label || '待检测'}
              <small>有向 {pointById.get(selectedEdge.from)?.name} → {pointById.get(selectedEdge.to)?.name}</small>
            </div>

            <button
              type="button"
              className="danger-button"
              onClick={() => {
                if (window.confirm('删除这条有向路径？')) onDeleteEdge(selectedEdge.id);
              }}
            >
              <Trash2 size={14} /> 删除路径
            </button>
          </section>
        )}

        {!selectedWaypoint && !selectedEdge && (
          <>
            <section className="route-index">
              <div className="section-title navigation-index-heading">
                <Route size={14} />
                <span>有向路径</span>
                <small>{edges.length}</small>
                <button
                  type="button"
                  className="navigation-index-toggle"
                  aria-label={routeIndexCollapsed ? '展开有向路径' : '折叠有向路径'}
                  title={routeIndexCollapsed ? '展开有向路径' : '折叠有向路径'}
                  aria-expanded={!routeIndexCollapsed}
                  aria-controls={`${navigationListsId}-routes`}
                  onClick={() => setRouteIndexCollapsed((value) => !value)}
                >
                  <span className="navigation-index-toggle__triangle" aria-hidden="true" />
                </button>
              </div>
              <div id={`${navigationListsId}-routes`} className="navigation-index-content" hidden={routeIndexCollapsed}>
                {!edges.length && (
                  <div className="empty-list">
                    <CircleGauge size={24} strokeWidth={1.3} />
                    <span>切换到“连接路径”，依次选择起点与终点</span>
                  </div>
                )}
                {edges.map((edge, index) => {
                  const meta = statusMeta[edge.status] || statusMeta.unchecked;
                  return (
                    <button type="button" className="route-index__item" key={edge.id} onClick={() => onSelectEdge(edge.id)}>
                      <span className={`status-dot ${meta.className}`} />
                      <span className="route-index__number">E{String(index + 1).padStart(2, '0')}</span>
                      <strong>{pointById.get(edge.from)?.name || '?'} <ArrowRight size={12} /> {pointById.get(edge.to)?.name || '?'}</strong>
                      <small>{edge.limits.maxSpeed.toFixed(1)} m/s</small>
                      <ChevronRight size={14} />
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="waypoint-index">
              <div className="section-title navigation-index-heading">
                <span>导航点</span>
                <small>{waypoints.length}</small>
                <button
                  type="button"
                  className="navigation-index-toggle"
                  aria-label={waypointIndexCollapsed ? '展开导航点' : '折叠导航点'}
                  title={waypointIndexCollapsed ? '展开导航点' : '折叠导航点'}
                  aria-expanded={!waypointIndexCollapsed}
                  aria-controls={`${navigationListsId}-waypoints`}
                  onClick={() => setWaypointIndexCollapsed((value) => !value)}
                >
                  <span className="navigation-index-toggle__triangle" aria-hidden="true" />
                </button>
              </div>
              <div id={`${navigationListsId}-waypoints`} className="waypoint-chips navigation-index-content" hidden={waypointIndexCollapsed}>
                {waypoints.map((point, index) => (
                  <button
                    type="button"
                    key={point.id}
                    data-waypoint-id={point.id}
                    className={point.id === arrivedWaypointId ? 'is-arrived' : undefined}
                    aria-current={point.id === arrivedWaypointId ? 'location' : undefined}
                    title={`${point.id === arrivedWaypointId ? '机器人当前停车点 · ' : ''}${point.teachingTaskId ? `示教停车点 · ${point.teachingTaskName}` : point.name}`}
                    onClick={() => onSelectWaypoint(point.id)}
                  >
                    <i className={point.abx ? 'waypoint-node-id' : undefined}>{point.abx ? `N${point.abx.nodeId}` : point.source === TEMPORARY_MAP_ROUTE_SOURCE ? '↔' : String(index + 1).padStart(2, '0')}</i>
                    {point.abx ? abxNodeLabel(point.abx.nodeId, point.name) : point.name}
                  </button>
                ))}
                {!waypoints.length && <span className="muted-copy">暂无导航点</span>}
              </div>
            </section>
          </>
        )}
          </div>
        )}

        {isWorkbenchActive && activePage === 'teaching' && (
          <div
            className="inspector-page inspector-page--teaching"
            role="tabpanel"
            id="inspector-page-teaching"
            aria-labelledby="inspector-tab-teaching"
          >
            <VirtualTeachingPanel
              teachingDevice={teachingDevice}
              teachingSources={teachingSources}
              onTeachingSourceChange={onTeachingSourceChange}
              robotTasks={robotTasks}
              mobilePoseSelection={mobilePoseSelection}
              onSelectMobilePose={onSelectMobilePose}
              onOpenMobileRobotPose={onOpenMobileRobotPose}
              onOpenMobileSource={onOpenMobileSource}
              onEditPose={onEditTeachingPose}
              editingPoseId={editingTeachingPoseId}
              teachingSpaceMode={teachingSpaceMode}
              tasks={teachingTasks}
              activeTaskId={activeTeachingTaskId}
              activeParkingPointId={activeTeachingParkingPointId}
              previewParkingPointId={robotParkingGhostId}
              previewPoseId={robotParkingGhostPoseId}
              mapData={mapData}
              robot={robot}
              robotLoadState={robotLoadState}
              robotPose={robotPose}
              robotJointValues={robotJointValues}
              view="capture"
              captureState={teachingCaptureState}
              onCreateTask={onCreateTeachingTask}
              onSelectTask={onSelectTeachingTask}
              onCreateParkingPoint={onCreateTeachingParkingPoint}
              onSelectParkingPoint={onSelectTeachingParkingPoint}
              onCapturePoint={onCaptureTeachingPoint}
              onDeleteTask={onDeleteTeachingTask}
              onDeleteParkingPoint={onDeleteTeachingParkingPoint}
              onDeletePoint={onDeleteTeachingPoint}
              onSolveMobileTask={onSolveMobileTask}
              onSaveMobileTask={onSaveMobileTask}
              mobileSaveDisabledReason={mobileSaveDisabledReason}
            />
          </div>
        )}

        {isWorkbenchActive && (
          <div
            className="inspector-page inspector-page--camera"
            role="tabpanel"
            id="inspector-page-camera"
            aria-labelledby="inspector-tab-camera"
            hidden={activePage !== 'camera'}
          >
            <div
              className="camera-teaching-workspace is-active"
              data-camera-controls-location="adjacent-to-viewport"
              data-camera-inverse-activation="automatic"
              data-camera-layout="vertical-stereo"
            >
              {['left', 'right'].map((side) => (
                <ZividCameraPanel
                  key={side}
                  side={side}
                  active={activePage === 'camera' && !collapsed && (!expandedCameraSide || expandedCameraSide === side)}
                  mapData={mapData}
                  robot={robot}
                  robotLoadState={robotLoadState}
                  cameraPoses={zividCameraPoses}
                  activeSide={expandedCameraSide === side ? activeTeachingCameraSide : side}
                  onActiveSideChange={setActiveTeachingCameraSide}
                  cameraTeachingEnabled={cameraTeachingEnabled}
                  cameraTeachingResult={cameraTeachingResult}
                  meshRenderQuality={meshRenderQuality}
                  onMeshRenderQualityChange={onMeshRenderQualityChange}
                  spaceMouseInputRef={spaceMouseInputRef}
                  mainViewportCanvasRef={main3DCanvasRef}
                  jointControlOpen={jointWindowOpen}
                  onExpandedChange={handleZividExpandedChange}
                  onOpenJointControl={() => setJointWindowOpen(true)}
                  onCameraTeachingMove={onCameraTeachingMove}
                  onCaptureProviderChange={side === 'left' ? onZividCaptureProviderChange : undefined}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      </div>
      <button
        type="button"
        className="inspector-collapse-toggle"
        aria-label={collapsed ? '展开图谱控制台' : '折叠图谱控制台'}
        aria-expanded={!collapsed}
        aria-controls="inspector-panel-content"
        title={collapsed ? '向左展开图谱控制台' : '向右收起图谱控制台'}
        onClick={() => onCollapsedChange?.(!collapsed)}
      >
        {collapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={13} />}
        <span>{collapsed ? '展开控制台' : '折叠'}</span>
      </button>
      </aside>

      {connectivityResultsOpen && validation.status === 'partial' && activePage === 'navigation' && !collapsed && isWorkbenchActive && (
        <ConnectivityResults anchorRef={pathTestRef} validation={validation} waypoints={waypoints} edges={edges}
          onClose={closeConnectivityResults} onLocateWaypoint={onSearchWaypoint} onLocateEdge={onSelectEdge} />
      )}

      <FloatingRobotJointPanel
        open={jointWindowOpen}
        teachingPoseEditing={Boolean(editingTeachingPoseId)}
        onClose={() => setJointWindowOpen(false)}
        robot={robot}
        robotLoadState={robotLoadState}
        jointValues={robotJointValues}
        lockedJointNames={lockedRobotJointNames}
        poses={jointPoses}
        onChangeJoint={onUpdateRobotJointValue}
        onToggleJointLock={onToggleRobotJointLock}
        onUnlockAllJoints={onUnlockAllRobotJoints}
        onZeroJoints={onZeroRobotJoints}
        onCapturePose={onCaptureJointPose}
        onRenamePose={onRenameJointPose}
        onDeletePose={onDeleteJointPose}
        onApplyPose={onApplyJointPose}
      />
    </>
  );
}

function CrosshairMark() {
  return (
    <span className="crosshair-mark" aria-hidden="true">
      <i /><i />
    </span>
  );
}

import { isRobotBodyJoint } from './robotJointLocks.js';

export const SCREEN_CONTROL_LIMIT = 64 * 1024;
export const SCREEN_COMMAND_MAX_AGE = 3000;
const groups = [
  ['底盘轮组', (name) => /wheel/i.test(name)],
  ['躯干与升降', isRobotBodyJoint],
  ['头部', (name) => /head/i.test(name)],
  ['左机械臂', (name) => /^left[_-]/i.test(name)],
  ['右机械臂', (name) => /^right[_-]/i.test(name)],
];
const finiteLimit = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const textWithin = (value, length = 256) => typeof value === 'string' && value.length <= length;
const requestId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);

export function screenPoseCaptureState(task, parkingPointId, blockedReason = '') {
  const parking = task?.parkingPoints?.find((point) => point.id === parkingPointId);
  const reason = !task ? '请先在网页端新建或选择示教任务，再新增或选择停车点。'
    : task.mobileCapture || task.abx ? '请先在网页端新建或选择虚拟示教任务及停车点，再记录姿态。'
      : !parking ? '请先在网页端为当前任务新增或选择停车点，再记录姿态。' : blockedReason;
  return { taskId: task?.id || '', parkingPointId: parking?.id || '',
    taskName: String(task?.name || '').slice(0, 256), parkingPointName: String(parking?.name || '').slice(0, 256), reason };
}

export function validScreenCaptureState(value) {
  return value && ['taskId', 'parkingPointId', 'taskName', 'parkingPointName', 'reason'].every((key) => textWithin(value[key]));
}

export function validScreenCaptureResult(value) {
  return value && requestId(value.id) && ['recording', 'complete', 'error'].includes(value.status) && textWithin(value.message, 512);
}

export function screenPoseCaptureCommand(command, state, now = Date.now()) {
  if (!command || !state?.capture || !requestId(command.id) || command.robotId !== state.robotId
    || !textWithin(command.taskId) || !textWithin(command.parkingPointId)
    || !Number.isFinite(command.ageMs) || command.ageMs < 0 || !Number.isFinite(command.receivedAt)
    || now - command.receivedAt + command.ageMs > SCREEN_COMMAND_MAX_AGE || command.receivedAt - now > 1000) return null;
  return { id: command.id, robotId: command.robotId, taskId: command.taskId, parkingPointId: command.parkingPointId,
    ageMs: command.ageMs, receivedAt: command.receivedAt };
}

export function validScreenViewportControl(value) {
  return value && typeof value.enabled === 'boolean' && Number.isFinite(value.aspect) && value.aspect >= 0.01 && value.aspect <= 100
    && Number.isSafeInteger(value.ack) && value.ack >= 0;
}

export function screenViewportCommand(command, state, lastSequence = 0, now = Date.now()) {
  if (!state?.viewportControl?.enabled || !command || command.robotId !== state.robotId
    || !Number.isSafeInteger(command.sequence) || command.sequence <= lastSequence
    || !['rotate', 'pan', 'zoom'].includes(command.kind)
    || ![command.dx, command.dy, command.zoom].every((value) => Number.isFinite(value) && Math.abs(value) <= 4)
    || (command.kind === 'zoom' ? command.dx !== 0 || command.dy !== 0 : command.zoom !== 0)
    || !Number.isFinite(command.ageMs) || command.ageMs < 0 || !Number.isFinite(command.receivedAt)
    || now - command.receivedAt + command.ageMs > SCREEN_COMMAND_MAX_AGE || command.receivedAt - now > 1000) return null;
  return { sequence: command.sequence, robotId: command.robotId, kind: command.kind, dx: command.dx, dy: command.dy, zoom: command.zoom,
    ageMs: command.ageMs, receivedAt: command.receivedAt };
}

export function screenJointState(robot, definitions = [], values = {}, blockedReason = '', ack = 0) {
  const seen = new Set();
  const joints = definitions.flatMap((joint) => {
    if (!joint?.name || seen.has(joint.name) || !['revolute', 'continuous', 'prismatic'].includes(joint.type)) return [];
    seen.add(joint.name);
    const linear = joint.type === 'prismatic';
    const lower = finiteLimit(joint.lower, linear ? -1 : -180);
    const upper = finiteLimit(joint.upper, linear ? 1 : 180);
    return [{ name: joint.name, group: groups.find(([, test]) => test(joint.name))?.[0] || '其他关节',
      lower, upper, step: linear ? 0.001 : 0.1, unit: linear ? 'm' : '°',
      value: finiteLimit(values[joint.name], 0) }];
  });
  return { robotId: String(robot?.id || robot?.relativePath || ''), robotName: String(robot?.name || '机器人'),
    editable: !blockedReason && joints.length > 0, reason: blockedReason || (joints.length ? '' : '当前模型没有可动关节'), ack, joints };
}

export function validScreenJointState(value) {
  return value && typeof value.robotId === 'string' && value.robotId.length > 0 && value.robotId.length <= 256
    && typeof value.robotName === 'string' && value.robotName.length <= 256
    && typeof value.editable === 'boolean' && typeof value.reason === 'string' && value.reason.length <= 256
    && Number.isSafeInteger(value.ack) && value.ack >= 0
    && (value.capture == null || validScreenCaptureState(value.capture))
    && (value.captureResult == null || validScreenCaptureResult(value.captureResult))
    && (value.viewportControl == null || validScreenViewportControl(value.viewportControl))
    && Array.isArray(value.joints) && value.joints.length <= 128
    && new Set(value.joints.map((joint) => joint?.name)).size === value.joints.length
    && value.joints.every((joint) => joint && typeof joint.name === 'string' && joint.name.length > 0 && joint.name.length <= 128
      && typeof joint.group === 'string' && joint.group.length <= 64 && ['m', '°'].includes(joint.unit)
      && [joint.lower, joint.upper, joint.step, joint.value].every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e7)
      && joint.lower <= joint.upper && joint.step > 0);
}

// Commands are absolute joint values, coalesced on the iPad. Expired gestures
// must never move the robot later when a suspended workbench resumes.
export function screenJointCommand(command, state, lastSequence = 0, now = Date.now()) {
  if (!state?.editable || !command || command.robotId !== state.robotId
    || !Number.isSafeInteger(command.sequence) || command.sequence <= lastSequence
    || typeof command.ageMs !== 'number' || !Number.isFinite(command.ageMs) || command.ageMs < 0
    || typeof command.receivedAt !== 'number' || !Number.isFinite(command.receivedAt)
    || now - command.receivedAt + command.ageMs > SCREEN_COMMAND_MAX_AGE || command.receivedAt - now > 1000
    || typeof command.value !== 'number' || !Number.isFinite(command.value)) return null;
  const joint = state.joints.find((entry) => entry.name === command.name);
  if (!joint) return null;
  return { ...command, value: Math.max(joint.lower, Math.min(joint.upper, command.value)) };
}

// Keep displayed checks and IK acceptance on the same per-axis thresholds.
export const MOBILE_CHEST_TILT_LIMIT = 0.25;
export const mobileChestTiltTolerance = (options) => options?.chestTiltTolerance ?? MOBILE_CHEST_TILT_LIMIT;
export const mobileChestWithinTolerance = (tilt, options) => Number.isFinite(tilt) && tilt >= 0
  && tilt <= mobileChestTiltTolerance(options) + 1e-7;
export const MOBILE_TOLERANCE_GROUPS = [
  ['positionTolerance', ['x', 'y', 'z'], '位置容差', 'cm', 100],
  ['rotationTolerance', ['roll', 'pitch', 'yaw'], '角度容差', '°', 1],
];

export function mobileAxisWithinTolerance(value, tolerance, key) {
  const epsilon = key === 'positionTolerance' ? 1e-9 : 1e-7;
  return Number.isFinite(value) && Number.isFinite(tolerance)
    && Math.abs(value) <= tolerance + epsilon;
}

export function mobileTargetWithinTolerance(solution, options) {
  return MOBILE_TOLERANCE_GROUPS.every(([key, axes]) => axes.every((axis) => mobileAxisWithinTolerance(
    solution?.[key === 'positionTolerance' ? 'positionError' : 'rotationError']?.[axis], options[key]?.[axis], key,
  )));
}

// A rounded value must not look equal to its limit when the raw value differs.
export function formatMobileConstraintValue(value, limit, scale = 1) {
  if (!Number.isFinite(value)) return '—';
  let digits = 2;
  while (Number.isFinite(limit) && Math.abs(value) !== limit && digits < 8
    && (Math.abs(value) * scale).toFixed(digits) === (limit * scale).toFixed(digits)) digits += 1;
  return (value * scale).toFixed(digits);
}

export function mobileSolutionFailureReasons(solution, options) {
  if (!solution || solution.feasible || solution.skipped) return [];
  const reasons = [];
  for (const [key, axes, label, unit, scale] of MOBILE_TOLERANCE_GROUPS) {
    const errors = solution[key === 'positionTolerance' ? 'positionError' : 'rotationError'];
    const exceeded = axes.filter((axis) => Number.isFinite(errors?.[axis]) && Number.isFinite(options[key]?.[axis])
      && !mobileAxisWithinTolerance(errors[axis], options[key][axis], key));
    if (exceeded.length) reasons.push(`${label}超限：${exceeded.map((axis) => {
      const value = Math.abs(errors[axis]), limit = options[key][axis];
      return `|${axis.toUpperCase()} 误差| ${formatMobileConstraintValue(value, limit, scale)} ${unit} > ${formatMobileConstraintValue(limit, value, scale)} ${unit}`;
    }).join('；')}`);
  }
  if (options.lockChestVertical && Number.isFinite(solution.chestTilt) && !mobileChestWithinTolerance(solution.chestTilt, options)) {
    const limit = mobileChestTiltTolerance(options);
    const explanation = Number.isFinite(solution.chestTiltLowerBound) && !mobileChestWithinTolerance(solution.chestTiltLowerBound, options)
      ? `底盘侧倾使前胸倾角至少为 ${formatMobileConstraintValue(solution.chestTiltLowerBound, limit)}°，踝、膝、腰俯仰关节无法消除这部分侧倾。请调整底盘姿态，或在允许时增大“前胸垂直容差”；放宽相机 XYZ / RPY 容差对此无效`
      : options.allowTorsoHeight ? '请检查底盘倾斜或躯干行程；前胸垂直容差独立于相机 XYZ / RPY 容差'
        : '可开启自动调节胸部高度或检查关节锁定；前胸垂直容差独立于相机 XYZ / RPY 容差';
    reasons.push(`前胸未满足垂直约束：倾角 ${formatMobileConstraintValue(solution.chestTilt, limit)}° > ${limit}°。${explanation}`);
  }
  const collision = solution.collision;
  if (options.checkCollisions && collision?.checked && !collision.clear) {
    const collisionReasons = [];
    if (collision.selfPairs?.length) collisionReasons.push(`机器人自身干涉：${collision.selfPairs.map((pair) => pair.join(' ↔ ')).join('；')}`);
    if (collision.environmentLinks?.length) collisionReasons.push(`机器人与工件干涉：${collision.environmentLinks.join('、')}`);
    if (collision.groundLinks?.length) collisionReasons.push(`机器人低于支撑平面：${collision.groundLinks.join('、')}`);
    const clearance = collision.armBodyClearance;
    if (options.armBodyClearance > 0 && clearance?.checked && !clearance.clear) {
      const limit = options.armBodyClearance;
      collisionReasons.push(`机械臂与躯干间距不足：保守下界 ${formatMobileConstraintValue(clearance.minimum, limit, 100)} cm，要求 ≥ ${formatMobileConstraintValue(limit, clearance.minimum, 100)} cm${clearance.limitingPair?.length
        ? `（${clearance.limitingPair.join(' ↔ ')}）` : ''}。可调整停车点或关节锁定`);
    }
    reasons.push(...(collisionReasons.length ? collisionReasons : ['碰撞筛选未通过，报告未记录受限部件']));
  }
  // Old reports may only contain a reason string or omit diagnostic fields.
  // Preserve that evidence without inventing a collision or a joint-limit hit.
  if (!reasons.length) reasons.push(solution.reason || '报告未记录具体失败原因，请重新计算以获取完整检查结果。');
  return reasons;
}

export function mobileSolutionFailureSummary(solution, options) {
  const reasons = mobileSolutionFailureReasons(solution, options);
  if (!reasons.length) return '';
  return `${mobileTargetWithinTolerance(solution, options) ? 'XYZ / RPY 均在容差内，但仍未通过：' : ''}${reasons.join('；')}`;
}

export function mobileRowFailureReason(row, options) {
  if (!row || row.feasible) return '';
  const reasons = Object.entries(row.solutions || {}).map(([side, solution]) => {
    const reason = mobileSolutionFailureSummary(solution, options);
    return reason ? `${side === 'left' ? '左臂' : '右臂'}：${reason}` : '';
  }).filter(Boolean);
  return reasons.join('\n') || row.reason || '报告未记录具体失败原因，请重新计算以获取完整检查结果。';
}

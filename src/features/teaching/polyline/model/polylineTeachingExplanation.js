import { normalizePolyline } from "./polylineTeaching.js";

const mm = (value) => (value * 1000).toFixed(1);
const seconds = (value) => (Math.max(0, value || 0) / 1000).toFixed(1);

const constraintsFor = (path, waistAvailable) => [
  ['执行臂', path.side === 'right' ? '右臂' : '左臂'],
  ['底盘', path.base.sync ? '移动' : path.base.search ? '自搜索' : '静止 · 位置和姿态固定'],
  ['腰部协同', waistAvailable ? path.base.waistAssist ? '已开启' : '未开启' : '当前执行链无可协同腰部'],
  ['末端距线段', `${mm(Math.abs(path.tcpOffset[2]))} mm · 工具 ${path.toolAxisDirection === 1 ? '+Z' : '−Z'}`],
  ['工具 XYZ 偏移', `${path.tcpOffset.map(mm).join(' / ')} mm`],
  ['位置 / 朝向容差', `${mm(path.settings.tolerance)} mm / ${path.settings.rotationTolerance.toFixed(2)}°`],
  ['工具朝向', path.settings.perpendicularTool ? '垂直法向量 · 工具轴垂直于路线方向，随线转动' : '采用检查时的朝向，并沿线保持'],
  ['最大保障', path.base.allowPartial ? '已开启' : '未开启'],
];

function explainStartTool(plan, path, waistAvailable) {
  const check = plan.startToolCheck, collision = check.collision, suggestions = [];
  const alternative = check.oppositeDirection;
  if (alternative) suggestions.push({ title: `检查“从末端指向线段”：工具 ${alternative.direction === 1 ? '+Z' : '−Z'}`,
    text: `保留 ${mm(Math.abs(alternative.tcpOffset[2]))} mm 距离、反转工具 Z 方向后，P0 的固定安装部件通过了工件碰撞检查。这仅是起点工具检查，尚未验证整机逆解和整条路线；请核对实际工具安装后手动切换，再点击“检查路径”。` });
  suggestions.push({ title: '核对工具偏移与安装方向',
    text: '“从末端指向线段”表示虚拟笔尖相对于工具坐标系原点的方向。不同机械臂、不同工具的坐标轴可能不同；请核对方向、末端距线段及高级 XYZ 偏移。' },
  { title: '调整工具朝向或起点位置',
    text: `可在折线示教中双击末端调整朝向，或调整 P0。${path.settings.perpendicularTool
      ? '重新检查时会从当前姿态重新选择与起始路线垂直的朝向。' : '重新检查时会采用当前工具朝向。'}仅改变肘部、腰部或底盘位置，同时保持 P0 的工具朝向和偏移不变，无法消除这一固定安装部件的干涉。` });
  const physical = collision.environmentIntersectingLinks || [], clearance = collision.environmentClearanceLinks || [];
  const details = [];
  if (physical.length) details.push(`${physical.join('、')} 与工件存在碰撞体重叠；本次并非只触及预留区。`);
  if (clearance.length) details.push(`${clearance.join('、')} 的 ${mm(collision.environmentMargin)} mm 碰撞预留区与工件相交；这不等于真实外壳已接触。`);
  details.push(`检查已计入 ${mm(path.settings.tolerance)} mm 位置容差和 ${path.settings.rotationTolerance.toFixed(2)}° 朝向容差；即使利用这些容差，固定安装部件仍不能避开工件。`,
    '固定安装部件在 P0 的位置由点位、工具偏移和工具朝向共同决定。因此需要先调整这些配置，再搜索到起点的路线。');
  const original = check.originalIssue;
  return { summary: 'P0 处的固定安装部件与工件干涉，当前工具配置未通过起点检查。',
    scope: '这是当前点位、工具偏移与朝向下的几何干涉结论，不表示调整配置后仍不可达。',
    location: '起点 P0 · 固定安装部件', message: plan.issue.message, details,
    stop: '已停止接近绕行搜索。增加候选数量或延长搜索时间无法消除 P0 处的这一干涉。',
    stats: [['工具碰撞体', `${check.rigidLinkCount} 个`], ['绕行搜索', '已跳过'], ['检查耗时', `${seconds(check.elapsedMs)} s`]],
    countNote: '只检查与工具末端刚性连接的部件。通过这项检查后，仍需验证整机逆解、碰撞和完整运动过程。',
    original: original ? `原直线${Number.isFinite(original.distanceFromStart) ? `在约 ${mm(original.distanceFromStart)} mm 处` : ''}失败：${original.message}。本次进一步检查发现 P0 本身也受工具干涉限制。` : null,
    partialNote: path.base.allowPartial ? '最大保障需先到达 P0；当前尚不能开始划线。' : null,
    constraints: constraintsFor(path, waistAvailable), suggestions,
    nearby: '相近点位也可能让固定工具组件进入工件或碰撞预留区。比较两条折线时，需同时比较执行臂、工具方向、XYZ 偏移和检查时的工具朝向。' };
}

// Explain recorded evidence, not a new feasibility verdict. In particular,
// approachSearch.originalIssue describes ONE straight trial, not every detour.
export function explainPolylineSearch(plan, value, { waistAvailable = false } = {}) {
  const path = normalizePolyline(value), search = plan?.approachSearch, issue = plan?.issue;
  if (path && issue && plan?.startToolCheck?.blocked) return explainStartTool(plan, path, waistAvailable);
  if (!path || !search || !issue) return null;
  const drawing = issue.phase === 'drawing', collision = issue.collision;
  const physical = collision?.environmentIntersectingLinks || [];
  const clearance = collision?.environmentClearanceLinks || [];
  const self = collision?.selfPairs || [], ground = collision?.groundLinks || [];
  const environment = collision?.environmentLinks || [];
  const margin = Number.isFinite(collision?.environmentMargin) ? `${mm(collision.environmentMargin)} mm` : '设定的';
  const location = drawing
    ? `划线 P${issue.segmentIndex} → P${(issue.segmentIndex + 1) % path.points.length} · 该段约 ${(Math.max(0, Math.min(1, issue.progress || 0)) * 100).toFixed(1)}%`
    : `到起点 P0 的移动${Number.isFinite(issue.distanceFromStart) ? ` · 原直线约 ${mm(issue.distanceFromStart)} mm 处` : ''}`;
  const details = [];
  if (physical.length) details.push(`碰撞模型中的 ${physical.join('、')} 与工件模型发生重叠。这里检查的是机器人碰撞几何；显示模型透明或隐藏都不会取消这项检查。`);
  if (clearance.length) details.push(`${clearance.join('、')} 的碰撞体本身未检出与工件重叠，但外扩的 ${margin} 预留区与工件相交，因此路线未通过。预留区相交不等于真实外壳已经接触，也不是精确间距测量。`);
  if (self.length) details.push(`机器人自身碰撞涉及 ${self.map((pair) => pair.join(' ↔ ')).join('；')}。即使笔尖能到达目标，沿途仍需让这些部件保持分离。`);
  if (ground.length) details.push(`${ground.join('、')} 低于当前支撑平面，需要调整沿途姿态或高度。`);
  if (collision && !physical.length && !clearance.length && !self.length && !ground.length) {
    details.push('该采样姿态未通过整机碰撞或间距检查；当前记录没有更细的碰撞分类，不能据此认定某个部件已经实际接触。');
  }
  if (issue.code === 'continuous-ik') {
    details.push(`该采样位置未找到同时满足位置精度与固定工具朝向的连续关节解。${Number.isFinite(issue.positionError)
      ? `位置误差 ${mm(issue.positionError)} mm；` : ''}${Number.isFinite(issue.rotationError) ? `朝向误差 ${issue.rotationError.toFixed(2)}°；` : ''}本次容差为 ${mm(path.settings.tolerance)} mm / ${path.settings.rotationTolerance.toFixed(2)}°。`);
  }
  if (!drawing) details.push('上方保留的是初次直线接近的失败记录。后续绕行可能在其他位置、因其他原因失败，不能把这个位置理解为所有方案共同的阻塞点。');

  const stop = search.stopReason === 'time-budget'
    ? `深入搜索达到约 ${seconds(search.deepBudgetMs)} s 的时间预算后停止，尚未完成检查的方案不用于执行；未验证剩余可能路线。`
    : search.stopReason === 'candidate-limit'
      ? `深入搜索达到${Number.isFinite(search.deepCandidateLimit) ? ` ${search.deepCandidateLimit} 个` : ''}候选方案数量上限后停止，搜索范围之外仍可能存在其他路线。`
      : search.stopReason === 'exhausted'
        ? '本轮生成并去重后的候选方案已检查完，仍未找到可执行路线；这不是对所有可能姿态与路线的穷尽证明。'
        : '本轮接近搜索已经结束，未找到满足当前约束的可执行路线。';
  const suggestions = [];
  if (physical.length || clearance.length || environment.length) suggestions.push({
    title: drawing ? '调整出问题的划线位置或工具配置' : '先检查 P0 与接近路线的空间余量',
    text: `结合提示中的部件，检查其与工件的相对位置。可在工艺允许时小幅调整${drawing ? '该段点位' : 'P0'}、末端距线段或工具轴方向，再重新检查；距离应与实际探针或工具安装一致。`,
  });
  if (self.length || issue.code === 'continuous-ik' || !drawing) suggestions.push({
    title: '调整机械臂的起始姿态或工具朝向',
    text: path.settings.perpendicularTool
      ? '可在折线示教中双击末端调整姿态，尽量让手臂避开躯干和工件。再次检查会从调整后的姿态选择最接近的垂直方向，并随路线转动；也可调整点位以缓和方向变化。手动拖动成功仍需重新验证整条路线。'
      : '可在折线示教中双击末端调整姿态，尽量让手臂避开躯干和工件。再次检查会采用调整后的当前工具朝向，并沿线保持；手动拖动成功仍需重新验证整条路线。',
  });
  if (ground.length) suggestions.push({ title: '调整接近高度', text: '检查命中部件与支撑平面的关系，抬高或调整起始姿态后重新检查，避免接近时向下绕行。' });
  if (waistAvailable && !path.base.waistAssist) suggestions.push({
    title: '尝试开启“腰部：协同”',
    text: '当前腰部未参与本次固定底盘规划。开启后可增加姿态调整空间，底盘仍保持原位，另一臂的关节角保持不变，整机继续参与碰撞检查。',
  });
  if (drawing && !path.base.allowPartial) suggestions.push({
    title: '允许只划一部分时，尝试“最大保障”',
    text: '已有接近路线通过 P0 检查。开启后会重新检查并尝试保留从 P0 开始连续可执行的划线部分，不跳过中间失败位置。',
  });
  if (!path.base.sync && !path.base.search) suggestions.push({
    title: '停车位置允许改变时，尝试底盘自搜索或移动',
    text: '这会改变当前“底盘静止”的约束，需要重新规划；只在作业允许底盘改变位置或姿态时使用。',
  });
  if (!suggestions.length) suggestions.push({ title: '根据失败位置调整路线', text: '检查上述失败记录及当前参数，调整对应点位或机器人起始姿态后重新检查。' });

  return {
    summary: drawing || search.reachedStart
      ? '已有接近路线验证到达 P0，但后续划线未通过，本次没有可执行轨迹。'
      : '尚未找到从当前姿态到 P0 的可执行接近路线，划线尚未开始。',
    scope: '有限搜索失败不代表全局不可达。以下解释和建议只依据本次记录，调整后仍需重新检查。',
    location, message: issue.message, details, stop,
    stats: [
      ['快速搜索', `${search.quickAttempts ?? 0} 种`],
      ['深入搜索', `${search.deepAttempts ?? 0} 种`],
      ['总耗时', `${seconds(search.elapsedMs)} s`],
    ],
    countNote: `数量为已开始尝试的接近方案，不含最初的直线检查${search.stopReason === 'time-budget' ? '，可能包含被时限中断的方案' : ''}。${search.guideAttempts ? `其中 ${search.guideAttempts} 种参考了已保存折线。` : ''}${search.memoryAttempts ? `其中 ${search.memoryAttempts} 种参考了最近成功轨迹及其关节姿态。` : ''}${search.environmentBuilds === 1 ? `工件碰撞索引建立一次后共用，准备耗时 ${seconds(search.environmentBuildMs)} s。` : ''}`,
    original: drawing && search.originalIssue ? `原直线在约 ${mm(search.originalIssue.distanceFromStart || 0)} mm 处失败：${search.originalIssue.message}。替代接近路线随后已验证到达 P0，所以当前报告的是划线阶段的问题。` : null,
    partialNote: path.base.allowPartial
      ? drawing || search.reachedStart ? '已开启最大保障，但本次仍未得到从 P0 开始、可完整验证并安全停止的连续划线部分。'
        : '最大保障需先到达 P0，前往 P0 的移动不算已划线，不能作为可执行的划线部分。'
      : null,
    constraints: constraintsFor(path, waistAvailable),
    suggestions,
    nearby: '相近折线仍可能要求不同的接近路线和关节姿态，微小位移也可能跨过碰撞预留区或关节可达边界。比较时应使用相同起始姿态、执行臂、工具偏移和规划约束；已保存折线只提供几何参考，新路线仍会独立检查。',
  };
}

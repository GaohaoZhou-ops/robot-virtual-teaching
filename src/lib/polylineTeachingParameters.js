// Stored values use metres/degrees/seconds. The same definitions drive input
// limits, archive validation, defaults and help, so their units cannot drift.
export const POLYLINE_ALGORITHM_GROUPS = [
  { key: 'motion', label: '精度与运动', fields: [
    { key: 'tolerance', label: '位置容差', unit: 'mm', scale: 1000, min: .0002, max: .003, default: .001, step: .1,
      description: '笔尖相对目标路线允许的最大位置误差，包含逆解和回放插值误差。折线模式还包含圆角过渡误差；空间曲线以预览曲线为基准，不要求贴近点间直线。调小更精确，但更难求解；不放宽碰撞检查。' },
    { key: 'rotationTolerance', label: '朝向容差', unit: '°', min: .1, max: 1, default: .5, step: .1,
      description: '工具相对目标姿态允许的最大角度误差。默认目标为检查时的固定朝向；开启“垂直法向量”后，目标姿态随路线方向变化，并要求工具轴与路线成 90°。调小更严格，也可能降低求解成功率。' },
    { key: 'step', label: '采样间距', unit: 'mm', scale: 1000, min: .0005, max: .01, default: .004, step: .5,
      description: '沿路线求解的基础采样间距。调小会增加采样和耗时，有助于跟踪变化较快的姿态；调大减少基础采样。曲线弯曲处、折线圆角和回放插值仍会按需细分，不能通过调大间距跳过碰撞检查。' },
    { key: 'acceleration', label: '末端加速度', unit: 'mm/s²', scale: 1000, min: .01, max: .5, default: .2, step: 10,
      description: '末端速度变化的上限，用于起停、转弯和轨迹调速。调小起停更平缓、执行时间更长；调大仍受关节与底盘运动能力限制，不保证达到设定速度上限。' },
  ] },
  { key: 'search', label: '接近搜索与姿态重试', fixedBaseOnly: true, fields: [
    { key: 'deepSearchSeconds', label: '深入搜索时限', unit: 's', min: 0, max: 60, default: 15, step: 1, integer: true,
      description: '快速搜索未找到完整路线后，深入搜索可额外使用的时间，不是整次检查的总时限。0 表示关闭深入搜索。增加时间可能探索更多路线，但不保证有解；可随时停止计算。' },
    { key: 'deepSearchCandidates', label: '深入候选上限', unit: '个', min: 1, max: 128, default: 128, step: 8, integer: true,
      description: '深入阶段最多尝试的接近方案数量。达到时限或数量上限任一条件即停止；去重、提前成功或候选用尽也会提前结束。它不改变快速搜索的方案数，调大不保证成功。' },
    { key: 'postureRetries', label: '姿态重试上限', unit: '次', min: 0, max: 32, default: 12, step: 1, integer: true,
      description: '每个路线候选内，遇到可恢复的逆解、关节跳变或碰撞问题时，局部回退并尝试另一姿态策略的次数上限；接近与划线共用此预算。0 表示关闭局部姿态重试，接近路线搜索仍可进行。' },
    { key: 'postureSamples', label: '重试采样预算', unit: '次', min: 8, max: 512, default: 96, step: 8, integer: true,
      description: '每个路线候选内，所有局部姿态重试共用的采样点求解预算。它与姿态重试上限共同限制计算量；调大可尝试更长的回退路段，耗时也可能增加。替换路段与整条回放插值仍须通过检查。' },
  ] },
];

export const POLYLINE_ALGORITHM_FIELDS = POLYLINE_ALGORITHM_GROUPS.flatMap((group) => group.fields);
export const POLYLINE_ALGORITHM_DEFAULTS = Object.freeze(Object.fromEntries(POLYLINE_ALGORITHM_FIELDS.map((field) => [field.key, field.default])));
export const polylineParameterNumber = (value) => String(Number(value.toFixed(6)));
export const polylineParameterValue = (field, value) => polylineParameterNumber(value * (field.scale || 1));

export const POLYLINE_CONSTRAINT_HELP = [
  ['底盘：静止', '底盘严格保持检查时的位置和姿态，与移动、自搜索互斥。可以启用最大保障与腰部协同。'],
  ['底盘：移动', '从当前位置开始，让麦轮底盘的水平平移、转向与机械臂联合规划；保持底盘高度和倾斜。与自搜索可以同时勾选。'],
  ['底盘：自搜索', '先搜索合适的起始底盘位置并预定位；单独启用时，划线期间底盘保持静止。与移动同时启用时，先找初始位置，再同步沿线规划。检查通过后，可点击“到达搜索位置”直接采用底盘位置与对应的机械臂起始姿态，末端就位 P0 后从起点执行已检查的轨迹。预定位不计入划线进度。'],
  ['完成度：最大保障', '仅底盘静止时生效。无法完整划线时，保留从 P0 开始连续通过检查的部分，并在可达终点平滑停止；必须先安全到达 P0，不能跳过失败位置，也不放宽碰撞、精度或关节限位。'],
  ['完成度：匀速划线', '默认开启。划线保持统一巡航速度，起终点平滑加减速；受关节或转弯限制时降低整体速度，接近原路折返时停车换向。折线在位置容差内平滑过弯，关闭后严格经过顶点并在拐角减速到停。空间曲线始终保留曲线形状，关闭后允许沿曲线调整速度，不会在普通经过点停车。'],
  ['完成度：垂直法向量', '默认关闭。开启后，“从末端指向线段”所选的工具 ±Z 轴始终与路线当前的前进方向（切线）成 90°，角度误差受朝向容差约束。以检查时的工具姿态选择最接近的垂直方向，随路线连续调整，并尽量减少工具自身的旋转。接近 P0 时平滑调整到起始姿态；严格折线的硬拐角会停稳后原地转向，再走下一段。笔尖仍沿原路线运动，工具偏移、关节限位及整机碰撞检查继续生效。这是垂直于路线方向，不代表沿工件表面法线，也不会自动贴合表面。关闭后保持检查时的固定工具朝向。'],
  ['腰部：协同', '仅底盘静止且执行链包含可协同腰部时可用。本次折线规划临时允许腰部参与，不修改全局关节锁定；退出模式后仍保持原锁定状态。另一臂保持关节角并随腰部移动，整机继续参与碰撞检查。'],
  ['水平范围 · m', '仅启用“移动”或“自搜索”时生效。以本次点击“检查路径”时的底盘位置为圆心，限制底盘在水平面内的最大直线位移，即允许区域的半径，而非累计行驶距离。默认 2 m，可设 0.05–10 m。调大允许搜索更远的位置及更大的底盘移动范围，仍须满足碰撞与机械臂可达性约束。'],
  ['转向范围 · ±°', '仅启用“移动”或“自搜索”时生效。以本次点击“检查路径”时的底盘朝向为基准，限制绕竖直轴向两侧转动的最大角度。例如输入 60，允许相对初始朝向在 −60° 至 +60° 内转向。默认 ±180°，输入值可设 0–180°；设为 0 时禁止底盘转向，仍允许在水平范围内平移。'],
  ['底盘运动限制', '底盘保持检查时的高度和倾斜；平移上限 100 mm/s，转向上限 15°/s。范围参数限制本次底盘搜索与运动，并不提供底盘绕障导航。'],
];

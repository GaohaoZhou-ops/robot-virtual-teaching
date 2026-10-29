const moving = (node) => ['revolute', 'continuous', 'prismatic'].includes(node.userData?.jointType);
const rigidRoot = (node) => {
  for (let parent = node; parent; parent = parent.parent) if (moving(parent)) return parent;
  return null;
};

export function nearestPolylineReference(samples, target, maximumDistance = .2) {
  let closest = null, distance = maximumDistance ** 2;
  for (const sample of samples || []) {
    if (!Array.isArray(sample.position) || sample.position.length !== 3 || !sample.position.every(Number.isFinite) || !sample.joints) continue;
    const value = sample.position.reduce((sum, coordinate, i) => sum + (coordinate - target.getComponent(i)) ** 2, 0);
    if (value < distance) { distance = value; closest = sample; }
  }
  return closest;
}

// A tool rigidly attached to the controlled frame has a fixed pose for a
// fixed TCP target/orientation. Repeated elbow seeds cannot resolve that hit;
// let the outer Cartesian approach search change the transit instead.
export function canRecoverPolylinePosture(controller, problem) {
  if (['continuous-ik', 'joint-jump'].includes(problem?.code)) return true;
  const collision = problem?.collision;
  if (!collision) return false;
  if (collision.selfPairs?.length) return true;
  const links = new Set([...(collision.environmentLinks || []), ...(collision.groundLinks || [])]);
  const toolRoot = rigidRoot(controller.frame);
  let recoverable = false;
  controller.robot.traverse((node) => {
    if (links.has(node.userData.mobileCollision?.linkName) && rigidRoot(node) !== toolRoot) recoverable = true;
  });
  return recoverable;
}

export function polylineRecoveryPolicies(controller, movable, problem, reference, target, referenceSamples = []) {
  const policies = [], names = new Set(movable.map((joint) => joint.name));
  const known = nearestPolylineReference(referenceSamples, target);
  if (known) policies.push({ reference: known.joints, seedReference: known.joints, source: 'successful-plan' });
  const links = new Set([...(problem.collision?.selfPairs || []).flat(), ...(problem.collision?.environmentLinks || []),
    ...(problem.collision?.groundLinks || [])]);
  const implicated = [];
  controller.robot.traverse((node) => {
    const proxy = node.userData.mobileCollision;
    if (!proxy || !links.has(proxy.linkName)) return;
    for (const name of proxy.chain.filter((name) => names.has(name)).slice(-2).reverse()) {
      if (!implicated.includes(name)) implicated.push(name);
    }
  });
  if (movable.length > 1) for (const name of implicated.slice(0, 2)) {
    policies.push({ reference, heldJoints: [name], source: 'hold-joint' });
  }
  policies.push({ reference, source: 'regularized' });
  const candidates = implicated.length ? implicated : movable
    .filter((joint) => /waist|torso|chest|[_-]J[123]$/i.test(joint.name)).map((joint) => joint.name);
  for (const name of candidates.slice(0, 2)) {
    const joint = movable.find((joint) => joint.name === name);
    for (const sign of [-1, 1]) policies.push({ source: 'posture-bias', reference: { ...reference,
      [name]: reference[name] + sign * (joint.userData.jointType === 'prismatic' ? .04 : 20) } });
  }
  return policies.slice(0, 7);
}

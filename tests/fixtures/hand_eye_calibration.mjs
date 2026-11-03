// Synthetic calibration and robot; no colleague/private calibration data.
export function handEyeReport(side = 'left') {
  const rotation = side === 'left' ? [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]
    : [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
  const translation_m = [.06, -.002, side === 'left' ? -.15 : .15];
  const inverse = rotation[0].map((_, i) => rotation.map((row) => row[i]));
  return { format: 'botx_handeye_real_report_v1', recommended_method: 'Park',
    generated_at_utc: '2026-11-01T00:00:00Z', source: { plan_revision: 'synthetic-test' },
    methods: { Park: { camera_to_tool: { rotation, translation_m },
      tool_to_camera: { rotation: inverse, translation_m: inverse.map((row) => -row.reduce((sum, x, i) => sum + x * translation_m[i], 0)) } } },
    intrinsics: { width: 1944, height: 1200, K: [[side === 'left' ? 1600 : 1500, 0, 1000], [0, 1700, 550], [0, 0, 1]],
      distortion: [-.08, .1, -.001, .001, -.06] } };
}

export function calibrationRobotPackage(files = {}) {
  const encode = (text) => new TextEncoder().encode(text);
  const urdf = `<robot name="zivid_m70_calibration_fixture">
    <link name="base_link"><visual><geometry><box size="0.4 0.3 0.2"/></geometry></visual></link>
    ${['left', 'right'].map((side) => `<link name="tool_${side}"/>
      <joint name="arm_${side}" type="revolute"><parent link="base_link"/><child link="tool_${side}"/>
        <origin xyz="0 ${side === 'left' ? .3 : -.3} .6" rpy=".1 .2 .3"/><axis xyz="0 0 1"/><limit lower="-2" upper="2" effort="10" velocity="1"/></joint>
      <link name="zivid_${side}_link"><visual><geometry><mesh filename="zivid.stl"/></geometry></visual></link>
      <joint name="zivid_${side}_mount" type="fixed"><parent link="tool_${side}"/><child link="zivid_${side}_link"/><origin xyz="0 0 .1" rpy=".2 .1 0"/></joint>
      <link name="zivid_${side}_optical_frame"/>
      <joint name="zivid_${side}_optical_joint" type="fixed"><parent link="zivid_${side}_link"/><child link="zivid_${side}_optical_frame"/><origin xyz=".01 .02 .03" rpy="0 .2 .1"/></joint>`).join('')}
  </robot>`;
  return { schemaVersion: 1, packageName: 'calibration_fixture', packagePath: 'calibration_fixture',
    relativePath: 'calibration_fixture/robot.urdf', format: 'urdf', files: [
      { path: 'calibration_fixture/robot.urdf', mimeType: 'application/xml', bytes: encode(urdf) },
      { path: 'calibration_fixture/zivid.stl', bytes: encode('solid camera\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex .1 0 0\nvertex 0 .1 0\nendloop\nendfacet\nendsolid camera') },
      ...Object.entries(files).map(([side, report]) => ({ path: `calibration_fixture/calib/handeye_${side}_real_report.json`,
        mimeType: 'application/json', bytes: encode(typeof report === 'string' ? report : JSON.stringify(report)) })),
    ] };
}

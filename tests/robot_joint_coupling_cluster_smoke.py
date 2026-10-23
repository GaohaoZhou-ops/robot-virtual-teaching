"""Offline IK must obey the same strict wrist constraint as browser planning."""
import importlib.util
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compute_parking_merge', ROOT / 'src/cluster/compute_parking_merge.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

with TemporaryDirectory() as directory:
    urdf = Path(directory) / 'wrist.urdf'
    urdf.write_text('''<robot name="wrist">
      <link name="base"/><link name="wrist"/><link name="tool_left"/>
      <joint name="left_J6" type="revolute"><parent link="base"/><child link="wrist"/>
        <axis xyz="0 0 1"/><limit lower="-2" upper="2"/></joint>
      <joint name="left_J7" type="revolute"><parent link="wrist"/><child link="tool_left"/>
        <axis xyz="0 0 1"/><limit lower="-2" upper="2"/></joint></robot>''')
    for enabled in [True, False, None]:
        model = module.RobotModel(urdf, Path(directory), arm_joint_coupling_enabled=enabled)
        for sign in [-1, 1]:
            seed = {'left_J6': sign * 0.8, 'left_J7': sign * 1.0}
            assert model.coupling_satisfied(seed) == (enabled is False), 'strict boundary'
            cancelled = {'left_J6': sign * 0.8, 'left_J7': -sign * 1.2}
            assert model.coupling_satisfied(cancelled), 'algebraic sum'
            model.project_coupling(seed, [model.movable['left_J7']])
            assert seed['left_J6'] == sign * 0.8
            assert model.coupling_satisfied(seed)
            known = {'left_J6': sign * 1.05, 'left_J7': sign * 1.05}
            transform = model.forward({}, known)['tool_left']
            target = module.target_from_transform('left', 'tool_left', transform, 'test')
            result = module.solve_ik(model, {}, known, target, {})
            assert model.coupling_satisfied(result)
            total = abs(result['left_J6'] + result['left_J7'])
            assert total < 1.8 if enabled is not False else math.isclose(total, 2.1)
            for name, value in result.items():
                assert model.movable[name].lower <= value <= model.movable[name].upper

urdf = ROOT / 'robots/botx_abx_zivid_m70/urdf/botx_abx_zivid_m70.urdf'
with patch.object(module.RobotModel, '_read_collision_proxies', return_value=[]):
    model = module.RobotModel(urdf, ROOT)
assert len(model.coupling_pairs) == 2
for sign in [-1, 1]:
    values = {joint.name: joint.clamp(sign * 999) for pair in model.coupling_pairs for joint in pair}
    locked = {pair[0].name: values[pair[0].name] for pair in model.coupling_pairs}
    model.project_coupling(values, [pair[1] for pair in model.coupling_pairs])
    assert model.coupling_satisfied(values)
    assert all(values[name] == value for name, value in locked.items())
    degrees = model.internal_to_serialized(values)
    for side in ['left', 'right']:
        assert abs(math.radians(degrees[f'{side}_J6'] + degrees[f'{side}_J7'])) < 1.8
print('PASS offline coupling: strict boundaries, disabled/default settings, constrained IK, locked joints and both BOTX arms')

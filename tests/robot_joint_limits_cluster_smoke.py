"""Keep the independently packaged offline solver's arm limits aligned with the workbench."""
import importlib.util
import math
from pathlib import Path
import sys
from unittest.mock import patch
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compute_parking_merge', ROOT / 'src/cluster/compute_parking_merge.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
urdf = ROOT / 'robots/botx_abx_zivid_m70/urdf/botx_abx_zivid_m70.urdf'
with patch.object(module.RobotModel, '_read_collision_proxies', return_value=[]):
    robot = module.RobotModel(urdf, ROOT)
count = 0
for node in ET.parse(urdf).findall('joint'):
    name = node.get('name')
    if name not in robot.movable or node.find('limit') is None:
        continue
    lower, upper = [float(node.find('limit').get(key)) for key in ['lower', 'upper']]
    if name.startswith(('left_J', 'right_J')):
        margin = (upper - lower) * 0.025
        lower, upper = lower + margin, upper - margin
        count += 1
    joint = robot.movable[name]
    assert math.isclose(joint.lower, lower, abs_tol=1e-10), name
    assert math.isclose(joint.upper, upper, abs_tol=1e-10), name
    assert math.isclose(joint.clamp(-999), lower, abs_tol=1e-10), name
    assert math.isclose(joint.clamp(999), upper, abs_tol=1e-10), name
assert count == 14
for ratio in [0.8, 0.5, 1.0, 0.01, None, float('nan'), -1, 2]:
    with patch.object(module.RobotModel, '_read_collision_proxies', return_value=[]):
        configured = module.RobotModel(urdf, ROOT, arm_soft_limit_ratio=ratio)
    expected_ratio = 0.95 if ratio is None or not math.isfinite(ratio) else max(0.01, min(1, ratio))
    for node in ET.parse(urdf).findall('joint'):
        name = node.get('name')
        if name not in configured.movable or node.find('limit') is None:
            continue
        lower, upper = [float(node.find('limit').get(key)) for key in ['lower', 'upper']]
        if name.startswith(('left_J', 'right_J')):
            margin = (upper - lower) * (1 - expected_ratio) / 2
            lower, upper = lower + margin, upper - margin
        joint = configured.movable[name]
        assert math.isclose(joint.lower, lower, abs_tol=1e-10), (ratio, name)
        assert math.isclose(joint.upper, upper, abs_tol=1e-10), (ratio, name)
assert module.ALGORITHM_VERSION == '1.1.0'
print('PASS offline URDF parser: default/custom ratios and invalid settings; 14 arm limits; body/head unchanged')

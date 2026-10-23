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
assert module.ALGORITHM_VERSION == '1.1.0'
print('PASS offline URDF parser and solver clamps: 14 arm soft limits; body/head unchanged')

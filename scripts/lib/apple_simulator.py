#!/usr/bin/env python3
"""Shared singleton launcher for the Atlas iPhone, iPad and visionOS applications."""

import argparse
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys


REPO = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Simulator:
    key: str
    name: str
    runtime_pattern: str
    runtime_name: str
    device_type_prefix: str
    scheme: str
    bundle_id: str
    sdk: str
    app_name: str
    instructions: str
    project_directory: str = ''


VISION = Simulator(
    'vision', 'Vision Pro', r'(?:xrOS|visionOS)', 'visionOS', '',
    'AtlasVisionTeaching', 'com.atlasroute.teaching.vision', 'xrsimulator', 'Atlas 空间示教',
    '在应用中点击「打开本地演练」开始调试。\n演练流程：进入空间示教 → 放到前方 → 确认校准 → 记录 Pose。',
)
IPAD = Simulator(
    'ipad', 'iPad Pro', r'iOS', 'iOS', 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-',
    'AtlasTeaching', 'com.atlasroute.teaching', 'iphonesimulator', 'Atlas 示教',
    '可调试配对、模型预览与已有数据；AR / LiDAR 空间示教需在真机验证。',
)
IPHONE = Simulator(
    'iphone', 'iPhone', r'iOS', 'iOS', 'com.apple.CoreSimulator.SimDeviceType.iPhone-',
    'AtlasTeaching', 'com.atlasroute.teaching', 'iphonesimulator', 'Atlas 示教',
    '可调试手机界面、配对、模型预览与已有数据；AR / LiDAR 空间示教需在真机验证。',
    project_directory='ipad',
)


def run(*args, **kwargs):
    return subprocess.run(args, cwd=REPO, text=True, check=True, **kwargs)


def select_device(config, devices, requested):
    candidates = []
    for runtime, entries in devices.items():
        version = re.search(rf'\.{config.runtime_pattern}-(\d+(?:-\d+)*)$', runtime)
        if version:
            for entry in entries:
                device_type = entry.get('deviceTypeIdentifier', '')
                matches = not config.device_type_prefix or device_type.startswith(config.device_type_prefix)
                if not device_type and config.device_type_prefix:
                    matches = entry.get('name', '').startswith(config.name)
                if entry.get('isAvailable') and matches:
                    candidates.append((tuple(map(int, version[1].split('-'))), entry))
    if not candidates:
        raise RuntimeError(f'请先在 Xcode Settings → Components 中安装 {config.runtime_name} Simulator，'
                           f'并在 Window → Devices and Simulators 中添加 {config.name} 设备。')
    selected = next((entry for _, entry in candidates if entry['udid'] == requested), None)
    if requested and not selected:
        raise RuntimeError(f'指定设备不是可用的 {config.name} 模拟器：{requested}')
    active = [entry for _, entry in candidates if entry['state'] in ('Booted', 'Booting')]
    if len(active) > 1:
        raise RuntimeError(f'已有多个 {config.name} 模拟器运行，请在 Simulator 中关闭多余设备后重试。')
    if active:
        if requested and requested != active[0]['udid']:
            raise RuntimeError(f"{config.name} 模拟器 {active[0]['udid']} 已运行；请先关闭它再切换设备。")
        return active[0]
    return selected or max(candidates, key=lambda item: (
        item[0], item[1].get('deviceTypeIdentifier', ''), item[1]['udid'],
    ))[1]


def launch(config, rebuild):
    devices = json.loads(run('xcrun', 'simctl', 'list', 'devices', 'available', '-j', capture_output=True).stdout)['devices']
    device = select_device(config, devices, os.environ.get(f'{config.key.upper()}_SIMULATOR_ID', ''))
    udid = device['udid']
    print(f"{'复用' if device['state'] in ('Booted', 'Booting') else '启动'} {config.name} 模拟器：{udid}", flush=True)
    if device['state'] != 'Booted':
        run('xcrun', 'simctl', 'bootstatus', udid, '-b')
    developer = os.environ.get('DEVELOPER_DIR') or run('xcode-select', '-p', capture_output=True).stdout.strip()
    # open -a reuses the Simulator application; never pass -n (new instance).
    run('open', '-a', str(Path(developer) / 'Applications/Simulator.app'), '--args', '-CurrentDeviceUDID', udid)
    if not rebuild:
        installed = subprocess.run(
            ['xcrun', 'simctl', 'get_app_container', udid, config.bundle_id, 'app'],
            cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0
        if installed:
            # Without --terminate-running-process, simctl preserves the running app.
            run('xcrun', 'simctl', 'launch', udid, config.bundle_id)
            print('已打开现有应用，不重复编译或重启。更新代码请使用 --rebuild。')
            return 0

    artifacts = Path(os.environ.get(f'{config.key.upper()}_ARTIFACTS') or f'{config.key}/test-artifacts/simulator-dev')
    if not artifacts.is_absolute():
        artifacts = REPO / artifacts
    artifacts.mkdir(parents=True, exist_ok=True)
    build_log = artifacts / 'build.log'
    app = artifacts / f'DerivedData/Build/Products/Debug-{config.sdk}' / f'{config.scheme}.app'
    print(f'编译 {config.app_name}…\n日志：{build_log}', flush=True)
    with build_log.open('w') as output:
        result = subprocess.run([
            'xcodebuild', '-project', str(REPO / (config.project_directory or config.key) / f'{config.scheme}.xcodeproj'),
            '-scheme', config.scheme, '-configuration', 'Debug',
            '-destination', f'platform={config.runtime_name} Simulator,id={udid}',
            '-derivedDataPath', str(artifacts / 'DerivedData'),
            'CODE_SIGNING_ALLOWED=NO', 'ONLY_ACTIVE_ARCH=YES', 'build',
        ], cwd=REPO, stdout=output, stderr=subprocess.STDOUT)
    log_text = build_log.read_text(errors='replace')
    resource_error = re.search(r'Command .* emitted errors but did not return a nonzero exit code', log_text)
    if result.returncode or resource_error or not (app / 'Info.plist').is_file() or not (app / config.scheme).is_file():
        print('\n'.join(log_text.splitlines()[-60:]), file=sys.stderr)
        print(f'编译或产物检查失败，日志：{build_log}', file=sys.stderr)
        return result.returncode or 1
    run('xcrun', 'simctl', 'install', udid, str(app))
    run('xcrun', 'simctl', 'launch', '--terminate-running-process', udid, config.bundle_id)
    print(f'已启动。{config.instructions}')
    print(f'编译日志：{build_log}')
    return 0


def main(config):
    # Let subprocess.run clean up a current child and release the lock on TERM.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    prefix = config.key.upper()
    parser = argparse.ArgumentParser(
        prog=f'./scripts/start_{config.key}_simulator.command',
        description=f'单例启动 {config.name} 模拟器与 {config.app_name}。',
        epilog=f'可选环境变量：{prefix}_SIMULATOR_ID=<UDID>，{prefix}_ARTIFACTS=<产物目录>。',
    )
    parser.add_argument('--rebuild', action='store_true', help='重新编译、安装并重启应用；默认复用已安装的应用。')
    options = parser.parse_args()
    try:
        # One stable inode per Mac user and device family, across all checkouts.
        # Never unlink it: kernel locks release on exit, including failed launches.
        lock_path = Path('/tmp') / f'atlas-{config.key}-simulator-{os.getuid()}.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(f'已有 {config.name} 启动任务正在执行，本次不会重复启动。')
                return 0
            return launch(config, options.rebuild)
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr.strip(), file=sys.stderr)
        print(f'启动失败：{error.cmd[0]} 返回 {error.returncode}。请检查 Xcode 和模拟器状态。', file=sys.stderr)
        return error.returncode or 1
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f'启动失败：{error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('已取消启动。', file=sys.stderr)
        return 130

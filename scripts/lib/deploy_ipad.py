#!/usr/bin/env python3
"""Sign, update and launch Atlas on a USB-connected iPad without uninstalling it."""

import argparse
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import sys
import tempfile
import time


REPO = Path(__file__).resolve().parents[2]
BUNDLE_ID = 'com.atlasroute.teaching'
SCHEME = 'AtlasTeaching'
SIGNING_HINT = '请在 Xcode → Settings → Accounts 登录开发者账号，检查团队资格和证书后重试。'
DEVICE_HINT = '请用数据线连接 iPad、解锁并信任此电脑，保持连接；首次使用需开启“设置 → 隐私与安全性 → 开发者模式”。'


def run(args, log=None, hint='', timeout=60):
    """Keep tool output in per-run logs; never parse devicectl's display tables."""
    try:
        if log:
            with log.open('w') as output:
                result = subprocess.run(args, cwd=REPO, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            text = log.read_text(errors='replace')
        else:
            result = subprocess.run(args, cwd=REPO, capture_output=True, text=True, timeout=timeout)
            text = result.stdout
        if result.returncode:
            detail = text if log else result.stdout + result.stderr
            raise RuntimeError(f'{args[0]} 执行失败（{result.returncode}）。\n'
                               + '\n'.join(detail.splitlines()[-30:]) + '\n' + hint)
        return text
    except FileNotFoundError as error:
        raise RuntimeError(f'找不到工具 {args[0]}，请安装并选择完整 Xcode。') from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f'{args[0]} 等待超时。{hint}') from error


def device_command(logs, name, *args, timeout=60):
    output = logs / f'{name}.json'
    run(['xcrun', 'devicectl', *args, '--timeout', str(timeout), '--quiet', '--json-output', str(output)],
        log=logs / f'{name}.log', hint=DEVICE_HINT, timeout=timeout + 10)
    payload = json.loads(output.read_text())
    if payload['info']['outcome'] != 'success':
        raise RuntimeError(f'设备操作失败，请查看 {output}。{DEVICE_HINT}')
    return payload['result']


def select_device(devices, requested):
    candidates = []
    for device in devices:
        hardware = device.get('hardwareProperties', {})
        connection = device.get('connectionProperties', {})
        if (hardware.get('deviceType') == 'iPad' and hardware.get('reality') == 'physical'
                and connection.get('transportType') == 'wired'
                and connection.get('pairingState') == 'paired'
                and connection.get('tunnelState') != 'unavailable'):
            candidates.append(device)
    if requested:
        candidates = [d for d in candidates if requested in (
            d['identifier'], d['hardwareProperties'].get('udid'), d['deviceProperties'].get('name'))]
    if not candidates:
        raise RuntimeError('未找到符合条件的有线 iPad。' + DEVICE_HINT)
    if len(candidates) != 1:
        choices = '\n'.join(f"  {d['deviceProperties']['name']}: {d['hardwareProperties']['udid']}" for d in candidates)
        raise RuntimeError('检测到多台 iPad，请用 --device <UDID> 指定一台：\n' + choices)
    return candidates[0]


def signing_team(requested):
    if requested:
        if not re.fullmatch(r'[A-Z0-9]{10}', requested):
            raise RuntimeError('--team / IPAD_DEVELOPMENT_TEAM 必须是 10 位大写字母或数字的 Team ID。')
        return requested
    # Prefer the team already used for this app, including expired profiles.
    # Never infer the Team ID from the person identifier in a certificate's CN.
    teams = set()
    for directory in ('Library/Developer/Xcode/UserData/Provisioning Profiles',
                      'Library/MobileDevice/Provisioning Profiles'):
        for path in (Path.home() / directory).glob('*.mobileprovision'):
            try:
                profile = plistlib.loads(run(['security', 'cms', '-D', '-i', str(path)]).encode())
            except (RuntimeError, ValueError, plistlib.InvalidFileException):
                continue
            if profile.get('Entitlements', {}).get('application-identifier', '').endswith('.' + BUNDLE_ID):
                teams.update(profile.get('TeamIdentifier', []))
    if not teams:
        identities = run(['security', 'find-identity', '-v', '-p', 'codesigning'])
        fingerprints = {f.upper() for f in re.findall(r'([A-Fa-f0-9]{40}) "(?:Apple Development|iPhone Developer):', identities)}
        certificates = run(['security', 'find-certificate', '-a', '-p'])
        for certificate in re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', certificates, re.S):
            der = base64.b64decode(''.join(certificate.splitlines()[1:-1]))
            if hashlib.sha1(der).hexdigest().upper() not in fingerprints:
                continue
            result = subprocess.run(['openssl', 'x509', '-noout', '-subject', '-nameopt', 'RFC2253'],
                                    input=certificate, capture_output=True, text=True, check=True)
            subject = re.sub(r'^subject=\s*', '', result.stdout.strip())
            match = re.search(r'(?:^|,)OU=([A-Z0-9]{10})(?:,|$)', subject)
            if match:
                teams.add(match[1])
    if len(teams) != 1:
        available = '、'.join(sorted(teams)) or '未检测到'
        raise RuntimeError(f'无法唯一确定签名团队（{available}）。请用 --team <TEAM_ID> 指定。{SIGNING_HINT}')
    return teams.pop()


def validate_app(app, team, udid, logs):
    if not (app / SCHEME).is_file():
        raise RuntimeError(f'构建未生成可执行文件：{app / SCHEME}')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise RuntimeError('构建产物的 Bundle ID 不匹配，已停止安装。')
    run(['codesign', '--verify', '--deep', '--strict', str(app)], log=logs / 'codesign.log', hint=SIGNING_HINT)
    profile = plistlib.loads(run(['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]).encode())
    expiry = profile['ExpirationDate'].replace(tzinfo=timezone.utc)
    if (expiry <= datetime.now(timezone.utc) or team not in profile.get('TeamIdentifier', [])
            or udid not in profile.get('ProvisionedDevices', [])
            or profile.get('Entitlements', {}).get('application-identifier') != f'{team}.{BUNDLE_ID}'):
        raise RuntimeError('新 App 的描述文件已过期，或团队、应用、设备不匹配，已停止安装。' + SIGNING_HINT)
    local_expiry = expiry.astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')
    (logs / 'signing-info.json').write_text(json.dumps({
        'team': team, 'bundleIdentifier': BUNDLE_ID, 'profileUUID': profile['UUID'],
        'expiresAt': expiry.isoformat(), 'expiresAtLocal': local_expiry,
    }, ensure_ascii=False, indent=2))
    print(f'签名有效至：{local_expiry}', flush=True)
    print('有效期由 Apple 签发；仍有效的描述文件可能被 Xcode 复用。', flush=True)


def deploy(options, output, logs):
    run(['xcodebuild', '-version'], hint='请先安装并选择完整 Xcode。')
    run(['xcrun', '--sdk', 'iphoneos', '--show-sdk-path'], hint='请在 Xcode Settings → Components 安装 iOS SDK。')
    print('检测通过数据线连接的 iPad…', flush=True)
    devices = device_command(logs, 'devices', 'list', 'devices')['devices']
    device = select_device(devices, options.device)
    identifier = device['identifier']
    udid = device['hardwareProperties']['udid']
    if device['deviceProperties'].get('developerModeStatus') != 'enabled':
        raise RuntimeError('iPad 尚未开启开发者模式。' + DEVICE_HINT)
    state = device_command(logs, 'lock-state', 'device', 'info', 'lockState', '--device', identifier)
    if state.get('passcodeRequired') or not state.get('unlockedSinceBoot'):
        raise RuntimeError('请先解锁 iPad，再执行部署。')
    team = signing_team(options.team)
    print(f"设备：{device['deviceProperties']['name']}（{udid}）\n签名团队：{team}", flush=True)

    derived = output / 'DerivedData'
    app = derived / f'Build/Products/{options.configuration}-iphoneos/{SCHEME}.app'
    print(f'更新签名并构建 {options.configuration} 版本…\n构建日志：{logs / "build.log"}', flush=True)
    build_log = run([
        'xcodebuild', '-project', str(REPO / 'ipad' / f'{SCHEME}.xcodeproj'), '-scheme', SCHEME,
        '-configuration', options.configuration, '-sdk', 'iphoneos', '-destination', f'platform=iOS,id={udid}',
        '-derivedDataPath', str(derived), '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration',
        f'DEVELOPMENT_TEAM={team}', 'CODE_SIGN_STYLE=Automatic', 'CODE_SIGNING_ALLOWED=YES', 'build',
    ], log=logs / 'build.log', hint=SIGNING_HINT, timeout=1800)
    if re.search(r'Command .* emitted errors but did not return a nonzero exit code', build_log):
        raise RuntimeError(f'资源编译失败，已停止安装；请查看 {logs / "build.log"}。')
    validate_app(app, team, udid, logs)

    # Update the same bundle in place. Never uninstall or replace its data container.
    print('覆盖安装，保留原有模型和示教数据…', flush=True)
    device_command(logs, 'install', 'device', 'install', 'app', '--device', identifier, str(app), timeout=180)
    print('启动 App 并检查运行状态…', flush=True)
    launched = device_command(logs, 'launch', 'device', 'process', 'launch', '--device', identifier,
                              BUNDLE_ID, '--terminate-existing')
    pid = launched['process']['processIdentifier']
    time.sleep(5)
    processes = device_command(logs, 'processes', 'device', 'info', 'processes', '--device', identifier)
    if not any(p.get('processIdentifier') == pid for p in processes['runningProcesses']):
        raise RuntimeError('App 已安装，但启动后退出，请查看 iPad 提示或在 Xcode 检查设备崩溃日志。')
    print(f'部署成功，Atlas 示教已启动（PID {pid}）。\nApp：{app}\n日志：{logs}', flush=True)


def main():
    parser = argparse.ArgumentParser(
        prog='./scripts/deploy_ipad.sh', description='自动签名、覆盖安装并启动通过数据线连接的 iPad 上的 Atlas 示教。',
        epilog='首次需在 Xcode 登录 Apple 账号，iPad 解锁、信任电脑并开启开发者模式。免费签名仍受 7 天限制。')
    parser.add_argument('--device', default=os.environ.get('IPAD_DEVICE_ID'), help='指定 iPad 的 UDID、CoreDevice ID 或名称；默认识别唯一有线 iPad。')
    parser.add_argument('--team', default=os.environ.get('IPAD_DEVELOPMENT_TEAM'), help='Apple Team ID；默认从本 App 的描述文件或有效开发证书识别。')
    parser.add_argument('--configuration', choices=('Debug', 'Release'), default='Release', help='构建配置，默认 Release。')
    options = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    logs = None
    try:
        # Match the simulator launchers: one stable lock per Mac user, across checkouts.
        lock_path = Path('/tmp') / f'atlas-ipad-deploy-{os.getuid()}.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError('已有 iPad 部署任务运行，请等待其结束。') from error
            output = REPO / 'ipad/build/deploy-device'
            output.mkdir(parents=True, exist_ok=True)
            logs = Path(tempfile.mkdtemp(prefix=datetime.now().strftime('run-%Y%m%d-%H%M%S-'), dir=output))
            deploy(options, output, logs)
        return 0
    except KeyboardInterrupt:
        print('\n已取消部署。', file=sys.stderr)
        return 130
    except (RuntimeError, OSError, ValueError, KeyError, TypeError, plistlib.InvalidFileException,
            subprocess.CalledProcessError) as error:
        print(f'部署失败：{error}', file=sys.stderr)
        if logs:
            print(f'本次日志：{logs}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

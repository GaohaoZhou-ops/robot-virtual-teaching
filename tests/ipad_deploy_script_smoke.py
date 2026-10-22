#!/usr/bin/env python3
"""Exercise the deployment CLI with fake Apple tools; never touch a real device."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('deploy_ipad', REPO / 'scripts/lib/deploy_ipad.py')
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)
TEAM = 'ABCDE12345'

FAKE_TOOL = r'''#!/usr/bin/env python3
from datetime import datetime, timedelta
import json, os
from pathlib import Path
import plistlib, sys

command, args = Path(sys.argv[0]).name, sys.argv[1:]
case = os.environ.get('ATLAS_DEPLOY_TEST_CASE', '')
with open(os.environ['ATLAS_DEPLOY_TEST_CALLS'], 'a') as log:
    log.write(json.dumps({'command': command, 'args': args, 'cwd': os.getcwd()}) + '\n')
def arg(key): return args[args.index(key) + 1]
def fail(code=1): print('fixture failure'); sys.exit(code)
if command == 'xcodebuild':
    if '-version' in args: print('Xcode fixture'); sys.exit(0)
    if case == 'build-failure': fail(65)
    if case == 'false-success':
        print('Command CompileAssetCatalog emitted errors but did not return a nonzero exit code')
        sys.exit(0)
    app = Path(arg('-derivedDataPath')) / ('Build/Products/' + arg('-configuration') + '-iphoneos/AtlasTeaching.app')
    app.mkdir(parents=True, exist_ok=True)
    team = next(a.split('=', 1)[1] for a in args if a.startswith('DEVELOPMENT_TEAM='))
    bundle = 'wrong.bundle' if case == 'wrong-bundle' else 'com.atlasroute.teaching'
    (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': bundle}))
    if case != 'no-executable': (app / 'AtlasTeaching').write_text('executable fixture')
    profile = {'UUID': 'profile-fixture', 'TeamIdentifier': ['OTHER12345' if case == 'wrong-team' else team],
               'ProvisionedDevices': ['other-ipad' if case == 'wrong-device' else 'ipad-udid'],
               'ExpirationDate': datetime.utcnow() + timedelta(days=-1 if case == 'expired' else 7),
               'Entitlements': {'application-identifier': team + '.com.atlasroute.teaching'}}
    (app / 'embedded.mobileprovision').write_bytes(plistlib.dumps(profile))
    print('** BUILD SUCCEEDED **')
elif command == 'security':
    if args[0] != 'cms': fail()
    sys.stdout.buffer.write(Path(arg('-i')).read_bytes())
elif command == 'codesign':
    if case == 'invalid-signature': fail()
elif command == 'xcrun':
    if '--sdk' in args: print('/fixture/iPhoneOS.sdk'); sys.exit(0)
    operation = args[1:4]
    ipad = {'identifier': 'ipad-core-id',
            'hardwareProperties': {'deviceType': 'iPad', 'reality': 'physical', 'udid': 'ipad-udid'},
            'connectionProperties': {'transportType': 'wired', 'pairingState': 'paired', 'tunnelState': 'disconnected'},
            'deviceProperties': {'name': 'Test iPad', 'developerModeStatus': 'enabled'}}
    if args[1:3] == ['list', 'devices']:
        phone = {**ipad, 'identifier': 'phone-id', 'hardwareProperties': {'deviceType': 'iPhone', 'reality': 'physical'}}
        devices = [phone, ipad]
        if case == 'no-ipad': devices = [phone]
        if case == 'wireless': ipad['connectionProperties']['transportType'] = 'localNetwork'
        if case == 'unavailable': ipad['connectionProperties']['tunnelState'] = 'unavailable'
        if case == 'no-developer-mode': ipad['deviceProperties']['developerModeStatus'] = 'disabled'
        if case == 'multiple':
            devices.append({**ipad, 'identifier': 'second-id', 'hardwareProperties': {**ipad['hardwareProperties'], 'udid': 'other-udid'},
                            'deviceProperties': {**ipad['deviceProperties'], 'name': 'Second iPad'}})
        result = {'devices': devices}
    elif operation == ['device', 'info', 'lockState']:
        result = {'passcodeRequired': case == 'locked', 'unlockedSinceBoot': True}
    elif operation == ['device', 'install', 'app']:
        if case == 'install-failure': fail()
        result = {'installedApps': [{'bundleID': 'com.atlasroute.teaching'}]}
    elif operation == ['device', 'process', 'launch']:
        if case == 'launch-failure': fail()
        result = {'process': {'processIdentifier': 42}}
    elif operation == ['device', 'info', 'processes']:
        result = {'runningProcesses': [] if case == 'crash' else [{'processIdentifier': 42}]}
    else: fail()
    Path(arg('--json-output')).write_text(json.dumps({'info': {'outcome': 'success'}, 'result': result}))
else: fail()
'''


class DeploymentCLI(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='atlas-ipad-deploy-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / 'project with spaces'
        for name in ('deploy_ipad.sh', 'lib/deploy_ipad.py'):
            target = self.repo / 'scripts' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / 'scripts' / name, target)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('xcodebuild', 'xcrun', 'security', 'codesign'):
            tool = self.bin / name
            tool.write_text(FAKE_TOOL)
            tool.chmod(0o755)
        self.calls_file = self.root / 'calls.jsonl'

    def run_cli(self, args=(), case='', team=True):
        environment = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                       'ATLAS_DEPLOY_TEST_CALLS': str(self.calls_file), 'ATLAS_DEPLOY_TEST_CASE': case}
        environment.pop('IPAD_DEVICE_ID', None)
        environment.pop('IPAD_DEVELOPMENT_TEAM', None)
        return subprocess.run(['bash', str(self.repo / 'scripts/deploy_ipad.sh'),
                               *(['--team', TEAM] if team else []), *args],
                              cwd=self.root, env=environment, capture_output=True, text=True, timeout=30)

    def calls(self):
        return [json.loads(line) for line in self.calls_file.read_text().splitlines()] if self.calls_file.exists() else []

    def test_help_and_bad_arguments_have_no_side_effects(self):
        self.assertEqual(self.run_cli(['--help']).returncode, 0)
        for args in (['--unknown'], ['--configuration', 'Fast'], ['--device']):
            self.assertEqual(self.run_cli(args).returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_device_and_lock_failures_never_build_or_install(self):
        for case in ('no-ipad', 'wireless', 'unavailable', 'multiple', 'locked', 'no-developer-mode'):
            with self.subTest(case=case):
                result = self.run_cli(case=case)
                self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(any(c['command'] == 'xcodebuild' and '-version' not in c['args'] for c in self.calls()))
        self.assertFalse(any('install' in c['args'] for c in self.calls()))

    def test_failed_or_invalid_build_never_installs(self):
        for case in ('build-failure', 'false-success', 'no-executable', 'wrong-bundle',
                     'invalid-signature', 'expired', 'wrong-team', 'wrong-device'):
            with self.subTest(case=case):
                shutil.rmtree(self.repo / 'ipad', ignore_errors=True)
                result = self.run_cli(case=case)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn('部署成功', result.stdout)
        self.assertFalse(any('install' in c['args'] for c in self.calls()))

    def test_success_uses_selected_device_signed_build_and_update(self):
        result = self.run_cli(['--device', 'ipad-udid', '--configuration', 'Debug'], case='multiple')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('签名有效至', result.stdout)
        self.assertIn('部署成功', result.stdout)
        calls = self.calls()
        build = next(c for c in calls if c['command'] == 'xcodebuild' and 'build' in c['args'])
        for flag in ('-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'CODE_SIGNING_ALLOWED=YES',
                     'CODE_SIGN_STYLE=Automatic', 'DEVELOPMENT_TEAM=' + TEAM, 'platform=iOS,id=ipad-udid', 'Debug'):
            self.assertIn(flag, build['args'])
        install = next(c for c in calls if 'install' in c['args'])
        self.assertIn('ipad-core-id', install['args'])
        self.assertTrue(any('Debug-iphoneos/AtlasTeaching.app' in a for a in install['args']))
        self.assertLess(calls.index(build), calls.index(install))
        self.assertFalse(any('uninstall' in c['args'] for c in calls))
        self.assertTrue(all(c['cwd'] == str(self.repo) for c in calls))

    def test_install_and_launch_failure_never_report_success(self):
        for case in ('install-failure', 'launch-failure', 'crash'):
            with self.subTest(case=case):
                self.calls_file.write_text('')
                result = self.run_cli(case=case)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertNotIn('部署成功', result.stdout)
                if case == 'install-failure':
                    self.assertFalse(any('launch' in c['args'] for c in self.calls()))


class SigningTeam(unittest.TestCase):
    def test_existing_profile_and_ambiguity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profiles = root / 'Library/Developer/Xcode/UserData/Provisioning Profiles'
            profiles.mkdir(parents=True)
            (profiles / 'one.mobileprovision').touch()
            def profile(team):
                return plistlib.dumps({'Entitlements': {'application-identifier': team + '.' + DEPLOY.BUNDLE_ID},
                                       'TeamIdentifier': [team]}).decode()
            with patch.object(DEPLOY.Path, 'home', return_value=root), patch.object(DEPLOY, 'run', return_value=profile(TEAM)):
                self.assertEqual(DEPLOY.signing_team(None), TEAM)
            (profiles / 'two.mobileprovision').touch()
            with patch.object(DEPLOY.Path, 'home', return_value=root), patch.object(DEPLOY, 'run', side_effect=[profile(TEAM), profile('OTHER12345')]):
                with self.assertRaisesRegex(RuntimeError, '--team'):
                    DEPLOY.signing_team(None)

    def test_certificate_uses_team_ou_instead_of_person_cn(self):
        with tempfile.TemporaryDirectory() as temporary:
            cert = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----'
            identity = '1) ' + hashlib.sha1(b'abc').hexdigest().upper() + ' "Apple Development: Person (PERSON1234)"'
            subject = subprocess.CompletedProcess([], 0, 'subject=OU=' + TEAM + ',CN=Apple Development: Person (PERSON1234)', '')
            with patch.object(DEPLOY.Path, 'home', return_value=Path(temporary)), \
                 patch.object(DEPLOY, 'run', side_effect=[identity, cert]), \
                 patch.object(DEPLOY.subprocess, 'run', return_value=subject):
                self.assertEqual(DEPLOY.signing_team(None), TEAM)


if __name__ == '__main__':
    unittest.main(verbosity=2)

// Requires an unmodified Electron runtime, never the sealed release executable.
// Uses a disposable profile and a short-lived build; does not change system time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { prepareDesktopPayload, buildDesktopMain } from '../../scripts/lib/build_macos.mjs';
import { teachingTransferFixture } from '../teaching_transfer_helpers.mjs';
import { buildProjectArchive } from '../../src/features/workspace/model/projectArchive.js';

const executablePath = process.env.ATLAS_TEST_ELECTRON;
assert.ok(executablePath, 'Set ATLAS_TEST_ELECTRON to the official Electron executable.');
const outputRoot = path.resolve('build/macos/validation');
await mkdir(outputRoot, { recursive: true });
const directory = await mkdtemp(path.join(outputRoot, 'smoke-'));
console.log(`Desktop UI evidence: ${directory}`);
const payload = path.join(directory, 'payload'), userData = path.join(directory, 'user-data');
const release = { version: '1.0.0', buildId: 'desktop-smoke', builtAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 90000).toISOString(), timeZone: 'Asia/Shanghai', warnBeforeDays: 7 };
await prepareDesktopPayload(payload, release);
const fixture = teachingTransferFixture('map');
fixture.config.config.project.virtualTeaching.tasks.forEach(task => task.parkingPoints.forEach(parking =>
  parking.poses.forEach(pose => { pose.cameraCapture = null; })));
const archive = await buildProjectArchive(fixture.config.config.project, {
  mapResource: fixture.map, existingRobotPackage: fixture.map.portableRobotPackage,
});
const fixtureFile = path.join(directory, 'fixture.zip');
await writeFile(fixtureFile, archive.bytes);
let application, page, originalOrigin;
const errors = [];
async function launch() {
  application = await electron.launch({ executablePath, args: [payload],
    env: { ...process.env, ATLAS_DESKTOP_TEST_USER_DATA: userData }, timeout: 40000 });
  application.process().stderr.on('data', data => process.stderr.write(data));
  application.process().once('exit', (code, signal) => console.log(`Desktop test process exited: ${signal || code}`));
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-session-state="ready"]:visible').first().waitFor();
  await page.waitForFunction(() => typeof window.AtlasDesktop?.getRelease === 'function');
}
async function downloadBackup(filename) {
  const destination = path.join(directory, filename);
  await application.evaluate(({ session }, destination) => {
    globalThis.__desktopDownload = new Promise((resolve) => session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(destination);
      item.once('done', (_event, state) => resolve({ state, filename: item.getFilename() }));
    }));
  }, destination);
  await page.getByRole('button', { name: '导出当前工程备份', exact: true }).click();
  const result = await application.evaluate(() => globalThis.__desktopDownload);
  assert.equal(result.state, 'completed');
  const entries = unzipSync(await readFile(destination));
  const project = JSON.parse(strFromU8(entries['config/project.json']));
  assert.equal(project.virtualTeaching.tasks[0].id, 'map-task');
  assert.ok(entries['environment/positions.f32le']);
  assert.ok(entries['robot/files/transfer/robot.urdf']);
  return destination;
}
async function assertExpiredStartup(profile, name) {
  const receipt = path.join(directory, `${name}.json`), bootstrap = path.join(directory, `${name}.cjs`);
  // Replace only the native prompt so this regression can acknowledge it
  // unattended; execute the actual compiled startup and quit paths.
  await writeFile(bootstrap, `
    const { app, dialog, BrowserWindow } = require('electron');
    const fs = require('node:fs'), { Server } = require('node:http');
    let serviceStarts = 0;
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) { serviceStarts++; return listen.apply(this, args); };
    dialog.showMessageBox = async options => {
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ options, serviceStarts,
        windows: BrowserWindow.getAllWindows().length, userData: app.getPath('userData') }));
      return { response: 0 };
    };
    dialog.showErrorBox = (title, content) => { console.error(title, content); app.exit(1); };
    require(${JSON.stringify(path.join(payload, 'main.cjs'))});
  `);
  const result = spawnSync(executablePath, [bootstrap], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ATLAS_DESKTOP_TEST_USER_DATA: profile } });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const value = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(value.options.type, 'warning');
  assert.match(value.options.message, /此版本已到期/);
  assert.match(value.options.detail, /请联系发布者获取新版安装包/);
  assert.deepEqual(value.options.buttons, ['退出']);
  assert.equal(value.windows, 0, 'expired launches must not create a workbench');
  assert.equal(value.serviceStarts, 0, 'expired launches must not start local services');
  assert.equal(value.userData, profile);
}
try {
  await launch();
  originalOrigin = new URL(page.url()).origin;
  assert.equal((await page.evaluate(() => window.AtlasDesktop.getRelease())).status, 'warning');
  assert.equal(await page.locator('.desktop-workbench').evaluate(e => e.inert), false);
  assert.equal(await page.getByText('版本已到期，请更新软件。', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => typeof window.showSaveFilePicker), 'function');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()), false);
  await page.evaluate(() => {
    window.__desktopReleaseUpdates = [];
    window.AtlasDesktop.onRelease(value => window.__desktopReleaseUpdates.push({ at: performance.now(), status: value.status }));
  });
  await page.screenshot({ path: path.join(directory, '01-start.png') });
  await page.evaluate(() => { window.showOpenFilePicker = undefined; });
  await page.getByRole('button', { name: '加载工程', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '加载工程引导文件', exact: true }).click();
  await (await chooser).setFiles(fixtureFile);
  await page.waitForURL('**/workbench');
  await page.waitForFunction(() => document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded');
  await page.locator('.loading-curtain').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(directory, '02-workbench.png') });
  // Exercise expiry while the Mac app is in the background, without keeping
  // the disposable test window in front of the publisher's workspace.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  console.log('Desktop launch, isolated preload, real project import and 3D robot rendering passed. Waiting for live expiry…');
  await page.getByRole('dialog', { name: '此版本已到期' }).waitFor({ timeout: 160000 });
  const updates = await page.evaluate(() => window.__desktopReleaseUpdates);
  assert.ok(updates.length >= 2, 'observe periodic checks before and after expiry');
  assert.equal(updates[0].status, 'warning');
  assert.equal(updates.at(-1).status, 'expired');
  for (let i = 1; i < updates.length; i++) {
    assert.ok(updates[i].at - updates[i - 1].at >= 55000, 'periodic checks must not wake the renderer every second');
  }
  console.log(`Release notifications: ${updates.map(update => update.status).join(' → ')}; interval ${(updates[1].at - updates[0].at).toFixed(0)} ms.`);
  assert.equal(await page.locator('.desktop-workbench').evaluate(e => e.inert), true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+r');
  assert.ok(await page.getByRole('dialog', { name: '此版本已到期' }).isVisible());
  assert.equal(await page.evaluate(() => fetch('/__atlas/work-sync/status').then(r => r.status)), 403);
  await downloadBackup('expired-backup.zip');
  await page.screenshot({ path: path.join(directory, '03-expired-backup.png') });
  console.log('Live expiry, keyboard lock, service cutoff and complete backup passed.');
  await application.close(); application = null;

  await assertExpiredStartup(userData, 'expired-restart');
  await assertExpiredStartup(path.join(directory, 'expired-first-run'), 'expired-first-run');
  console.log('Expired restart and first launch: native expiry prompt, no workbench or local services, clean exit.');

  await buildDesktopMain(payload, { ...release, version: '1.0.1', buildId: 'desktop-smoke-update',
    builtAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  await launch();
  assert.equal(new URL(page.url()).origin, originalOrigin);
  await page.locator('.desktop-release__notice').waitFor();
  assert.equal(await page.locator('.desktop-workbench').evaluate(e => e.inert), false);
  assert.equal((await page.evaluate(() => window.AtlasDesktop.getRelease())).version, '1.0.1');
  assert.equal(await page.locator('[data-map-workspace="cached"]').count(), 1);
  await page.getByRole('button', { name: '继续工作', exact: true }).first().click();
  await page.waitForURL('**/workbench');
  await page.waitForFunction(() => document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded');
  await page.screenshot({ path: path.join(directory, '04-updated.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: installing a newer release unlocks the same saved project; no renderer errors.');
} finally {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'last-state.png') }).catch(() => {});
  await application?.close();
}

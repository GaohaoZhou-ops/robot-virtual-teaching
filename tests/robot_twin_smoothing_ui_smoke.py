"""Continuous twin motion and flicker-free camera frames, using only loopback fixtures."""
import json
import os
import statistics
import subprocess
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect
from teaching_transfer_ui_smoke import seed, CHROME

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-artifacts' / 'robot-twin-smoothing'
ARTIFACTS.mkdir(parents=True, exist_ok=True)
fixture = subprocess.Popen(['node', '--input-type=module', '-e', r'''
import {createFakeRobotServer} from './scripts/lib/fake_robot_server.mjs';
const start = performance.now();
const server = createFakeRobotServer({clock: () => 19000 + performance.now() - start});
const handler = server.listeners('request')[0]; server.removeAllListeners('request');
let tick = 0;
server.on('request', (req, res) => {
  if (req.url === '/api/v1/slam') {
    const end = res.end.bind(res), writeHead = res.writeHead.bind(res);
    let code, headers;
    res.writeHead = (status, values) => { code = status; headers = values; return res; };
    res.end = (bytes, ...args) => {
      const data = JSON.parse(bytes);
      if (data.sample?.pose) data.sample.pose = {x_m: 10 + (performance.now() - start) * .0003, y_m:20, yaw_rad:0};
      bytes = Buffer.from(JSON.stringify(data));
      writeHead(code, {...headers, 'Content-Length':bytes.length}); return end(bytes, ...args);
    };
    setTimeout(() => void handler(req,res), [0,30,10,50][tick++ % 4]);
  } else void handler(req,res);
});
await new Promise(done => server.listen(0,'127.0.0.1',done));
console.log(`http://127.0.0.1:${server.address().port}`);
'''], cwd=ROOT, stdout=subprocess.PIPE, text=True)
address = fixture.stdout.readline().strip()
assert address.startswith('http://127.0.0.1:')
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(25000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        profiles = {'version': 1, 'profiles': [{'id': 'smooth', 'name': '平滑测试机器人', 'address': address}], 'selectedIds': ['smooth']}
        page.add_init_script('localStorage.setItem("atlas-route-studio:robot-twin-profiles-v1",' + json.dumps(json.dumps(profiles)) + ')')
        page.add_init_script('''window.twinReadings = [];
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            const result = await originalFetch(...args);
            if (String(args[0]).endsWith('/robot-twin/snapshot')) result.clone().json().then(s => {
              if (s.pose) window.twinReadings.push({time:performance.now(), x:s.pose.x});
            });
            return result;
          };
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = async function() {
            await decode.call(this);
            if (window.delayTwinDecode) await new Promise(done => setTimeout(done, 180));
          };''')
        def safe_connect(route):
            assert route.request.post_data_json['address'] == address
            route.continue_()
        page.route('**/__atlas/robot-twin/sessions', safe_connect)
        held, pause = [], False
        def camera_frame(route):
            if pause:
                held.append(route)
            else:
                route.continue_()
        page.route('**/__atlas/robot-twin/camera/frame', camera_frame)
        try:
            seed(page, ['map'], 'map')
            canvas = page.locator('.three-canvas')
            offline = canvas.get_attribute('data-robot-origin')
            page.get_by_role('button', name='同步作业', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='真机孪生').click()
            dialog = page.get_by_role('dialog', name='真机孪生', exact=True)
            dialog.get_by_label('管理员密码', exact=True).fill('admin')
            dialog.get_by_role('button', name='连接并同步', exact=True).click()
            expect(dialog).not_to_be_visible(timeout=10000)
            page.get_by_role('button', name='机器人后上方跟随视角', exact=True).click()
            # Non-followed robots no longer carry an active presentation buffer.
            # Let this newly enabled follower collect its first pair of samples.
            page.wait_for_timeout(650)
            frames = page.evaluate('''() => new Promise(done => {
              const frames = [], start = performance.now();
              const read = () => {
                const now=performance.now(), d=document.querySelector('.three-canvas').dataset;
                const raw=window.twinReadings.at(-1);
                frames.push({t:now,x:Number(d.robotX),camera:Number(d.cameraX),
                  fleet:JSON.parse(d.twinRobots)[0]?.x,
                  lag:raw ? (raw.x+(now-raw.time)*.0003-Number(d.robotX))/.0003 : null});
                if(now-start<3500) requestAnimationFrame(read); else done(frames);
              }; requestAnimationFrame(read);
            })''')
            assert len(frames) > 50, len(frames)
            (ARTIFACTS / 'motion.json').write_text(json.dumps({'frames': frames,
                'readings': page.evaluate('window.twinReadings')}))
            moving = sum(b['x'] > a['x'] for a, b in zip(frames, frames[1:])) / (len(frames) - 1)
            assert moving > .95, moving
            offsets = [f['camera'] - f['x'] for f in frames]
            assert max(offsets) - min(offsets) < .001, 'camera and robot share the same presentation frame'
            assert all(abs(f['fleet'] - f['x']) < .00001 for f in frames)
            lag = [f['lag'] for f in frames if f['lag'] is not None]
            assert 550 < statistics.median(lag) < 630, statistics.median(lag)
            monitor = page.get_by_role('complementary', name='任务监控台', exact=True)
            camera = monitor.get_by_role('region', name='本体相机', exact=True)
            page.evaluate('window.delayTwinDecode=true')
            camera.get_by_role('switch', name='本体相机实时画面').click()
            expect(camera).to_have_attribute('data-camera-phase', 'live')
            images = page.evaluate('''() => new Promise(done => {
              const frames=[],start=performance.now();
              const read=()=>{
                const panel=document.querySelector('.task-monitor-camera'),image=panel.querySelector('img');
                frames.push({height:panel.getBoundingClientRect().height,stage:panel.querySelector('.task-monitor-camera__stage').getBoundingClientRect().height,
                  src:image?.src,ready:image?.complete&&image.naturalWidth>0});
                if(performance.now()-start<2500)requestAnimationFrame(read);else done(frames);
              }; requestAnimationFrame(read);
            })''')
            assert len({f['src'] for f in images}) >= 5, len({f['src'] for f in images})
            assert all(f['src'] and f['ready'] for f in images), 'never replace a frame with an undecoded image'
            assert max(f['stage'] for f in images) - min(f['stage'] for f in images) < .5
            assert max(f['height'] for f in images) - min(f['height'] for f in images) < .5
            pause = True
            page.wait_for_timeout(500)
            assert held
            previous = camera.locator('img').get_attribute('src')
            height = camera.bounding_box()['height']
            expect(camera).to_have_attribute('data-camera-phase', 'stale')
            expect(camera.locator('img')).to_have_attribute('src', previous)
            assert abs(camera.bounding_box()['height'] - height) < .5
            camera.get_by_role('button', name='放大本体相机画面').click()
            expanded = page.get_by_role('dialog', name='头部左目 · 实时画面', exact=True)
            expect(expanded.locator('img')).to_have_attribute('src', previous)
            expect(expanded.get_by_role('status')).to_contain_text('保留最后一帧')
            page.screenshot(path=str(ARTIFACTS / 'retained-frame.png'))
            pause = False
            for route in held:
                route.continue_()
            held.clear()
            expect(camera).to_have_attribute('data-camera-phase', 'live')
            expect(expanded.locator('img')).not_to_have_attribute('src', previous)
            expanded.get_by_role('button', name='关闭放大画面').click()
            canvas.press('ArrowRight')
            expect(canvas).to_have_attribute('data-twin-follow-enabled', 'false')
            page.get_by_role('button', name='停止同步', exact=True).click()
            expect(canvas).to_have_attribute('data-robot-origin', offline)
            assert not errors, errors
            with urlopen(address + '/__fake_robot/status', timeout=3) as response:
                requests = json.load(response)['requests']
            assert all(key.startswith('GET ') or key in ['POST /api/v1/access/login', 'POST /api/v1/body-cameras/preview', 'POST /api/v1/body-cameras/frame'] for key in requests if '/api/' in key)
            print(f'Twin smoothing: {len(frames)} frames, {moving:.1%} moving, median display delay {statistics.median(lag):.0f} ms. Camera background decode, fixed layout, retained stale frame and recovery passed.')
        except Exception:
            page.screenshot(path=str(ARTIFACTS / 'failure.png'))
            print('Page errors:', errors)
            raise
        finally:
            browser.close()
finally:
    fixture.terminate()
    fixture.wait(timeout=5)

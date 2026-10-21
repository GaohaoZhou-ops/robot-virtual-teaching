"""ZIP worker memory regression and persistent import failures.

BASE_URL=http://127.0.0.1:21991 python tests/project_import_ui_smoke.py
Optionally set PROJECT_IMPORT_ZIP to exercise a real workspace collection ZIP.
"""
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from project_load_modes_smoke import (
    BASE_URL, CHROME, assert_mode, choose_file, make_fixtures, open_loader,
    wait_ready, workspaces,
)
from teaching_transfer_ui_smoke import ready


PROGRESS_OBSERVER = """
  addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => {
      const samples = JSON.parse(sessionStorage.getItem('__importProgressSamples') || '[]');
      const bars = document.querySelectorAll('.loading-curtain [role="progressbar"]');
      const bar = bars[0];
      if (!bar || (!samples.length && bar.getAttribute('aria-label') !== '工程加载总进度')) return;
      const module = bar.closest('.loading-module');
      const sample = { count: bars.length, value: Number(bar.getAttribute('aria-valuenow')),
        title: module.querySelector('.loading-module__top span').textContent,
        source: module.querySelector('.loading-module__source')?.textContent,
        stage: module.querySelector('.loading-module__stage')?.textContent };
      if (JSON.stringify(samples.at(-1)) !== JSON.stringify(sample)) {
        samples.push(sample);
        sessionStorage.setItem('__importProgressSamples', JSON.stringify(samples));
      }
    }).observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true});
  });
"""


def reset_progress(page):
    page.evaluate("sessionStorage.removeItem('__importProgressSamples')")


def assert_overall_progress(page, filename, complete=True):
    samples = page.evaluate("JSON.parse(sessionStorage.getItem('__importProgressSamples') || '[]')")
    assert samples, "No overall import progress was displayed"
    assert all(item["count"] == 1 and item["title"] == "加载工程" and item["source"] == filename for item in samples), samples
    values = [item["value"] for item in samples]
    assert values == sorted(values), values
    assert all(0 <= value <= 100 for value in values), values
    if complete:
        assert values[-1] == 100, values
    else:
        assert values[-1] < 100, values
    return samples


def compressed_members():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps({
            "format": "atlas-route-studio-project", "archiveVersion": 1,
            "projectFile": "config/project.json",
        }))
        archive.writestr("config/project.json", json.dumps({"schemaVersion": "1.3"}))
        # Every entry crosses fflate's async worker threshold (512 KiB).
        for index in range(32):
            archive.writestr(f"meshes/{index}.bin", bytes([index]) * 1024 * 1024)
    return buffer.getvalue()


def collection_summary(page):
    return page.evaluate("""async () => {
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const current = await store.loadWorkspaceSnapshot(sessionId, 'independent');
      const { companionWorkspace, independentHistory } = await store.loadProjectCompanions(sessionId, 'independent');
      return [current, companionWorkspace, ...independentHistory].filter(Boolean).map(({ map, config }) => ({
        name: map.name, pointCount: map.pointCount,
        robotFiles: map.portableRobotPackage?.files.length || 0,
        tasks: (config.config.project.virtualTeaching?.tasks || []).map(task => ({
          id: task.id, parking: task.parkingPoints.map(point => ({ id: point.id,
            poses: point.poses.map(pose => ({ id: pose.id,
              frames: Object.entries(pose.cameraCapture?.frames || {}).map(([side, frame]) => ({
                side, captured: Boolean(frame.rgb?.dataUrl), byteLength: frame.rgb?.byteLength,
              })),
            })),
          })),
        })),
      }));
    }""")


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-import-") as directory, sync_playwright() as playwright:
        root = Path(directory)
        make_fixtures(root)
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(60_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("crash", lambda: errors.append("page crashed"))
            page.add_init_script(PROGRESS_OBSERVER)
            page.add_init_script("""
              window.showOpenFilePicker = undefined;
              window.__zipWorkers = [];
              const NativeWorker = window.Worker;
              window.Worker = class extends NativeWorker {
                constructor(url, options) {
                  super(url, options);
                  this.record = { url: String(url), inputs: [], terminated: false };
                  window.__zipWorkers.push(this.record);
                }
                postMessage(value, ...args) {
                  this.record.inputs.push(value instanceof Blob ? 'blob' : 'bytes');
                  return super.postMessage(value, ...args);
                }
                terminate() { this.record.terminated = true; super.terminate(); }
              };
            """)
            page.route("**/__test__/members.zip", lambda route: route.fulfill(body=compressed_members()))
            page.goto(BASE_URL, wait_until="networkidle")
            wait_ready(page)
            result = page.evaluate("""async () => {
              const { readProjectArchive, readProjectFile } = await import('/src/lib/projectArchive.js');
              const bytes = new Uint8Array(await (await fetch('/__test__/members.zip')).arrayBuffer());
              const length = bytes.length;
              window.__zipWorkers = [];
              const raw = await readProjectArchive(bytes);
              const file = await readProjectFile(new File([bytes], 'members.zip'));
              return { workers: window.__zipWorkers, count: raw.archiveFileCount,
                fileCount: file.archiveFileCount, inputRetained: bytes.length === length && bytes[0] === 80 };
            }""")
            assert result["count"] == result["fileCount"] == 34
            assert result["inputRetained"]
            assert len(result["workers"]) == 2, result
            assert [worker["inputs"] for worker in result["workers"]] == [["bytes"], ["blob"]]
            assert all(worker["terminated"] for worker in result["workers"])
            print("large_compressed_members_one_worker_per_archive_and_input_retained=ok", flush=True)

            open_loader(page, "map")
            choose_file(page, root / "map.zip")
            assert_mode(page, "map")
            assert_overall_progress(page, 'map.zip')
            before = workspaces(page)
            bad = root / "damaged.zip"
            bad.write_bytes(b"PK\x03\x04truncated")
            open_loader(page, "map")
            reset_progress(page)
            choose_file(page, bad)
            error = page.get_by_role("alertdialog", name="工程加载失败")
            expect(error).to_be_visible()
            expect(error).to_contain_text("damaged.zip")
            expect(error).to_contain_text("解压失败")
            page.wait_for_timeout(4000)  # Previous toast disappeared at 3200 ms.
            expect(error).to_be_visible()
            assert workspaces(page) == before
            assert_overall_progress(page, 'damaged.zip', complete=False)
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path="/tmp/atlas-import-error-mobile.png")
            assert error.evaluate("el => el.getBoundingClientRect().right <= innerWidth")
            page.set_viewport_size({"width": 1440, "height": 1000})
            error.get_by_role("button", name="重新选择工程", exact=True).click()
            reset_progress(page)
            choose_file(page, root / "map.zip")
            assert_mode(page, "map")
            expect(error).to_have_count(0)
            assert workspaces(page) == before
            assert_overall_progress(page, 'map.zip')
            print("persistent_failure_previous_results_preserved_and_retry=ok", flush=True)

            # A worker startup/network failure must also settle the import and
            # clean up, rather than leaving a permanent loading curtain.
            page.route("**/projectArchive.worker.js*", lambda route: route.abort())
            open_loader(page, "map")
            reset_progress(page)
            choose_file(page, root / "map.zip")
            expect(error).to_be_visible()
            assert_overall_progress(page, 'map.zip', complete=False)
            assert page.evaluate("window.__zipWorkers.at(-1).terminated")
            page.keyboard.press("Escape")
            expect(error).to_have_count(0)
            assert workspaces(page) == before
            page.unroute("**/projectArchive.worker.js*")
            print("worker_startup_failure_recovery_and_keyboard_dismiss=ok", flush=True)

            real_zip = os.environ.get("PROJECT_IMPORT_ZIP")
            if real_zip:
                # Use a clean device so the expected historical groups are exact.
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                target = context.new_page()
                target.set_default_timeout(120_000)
                target.on("pageerror", lambda error: errors.append(str(error)))
                target.on("crash", lambda: errors.append("real ZIP page crashed"))
                target.add_init_script("window.showOpenFilePicker = undefined")
                target.add_init_script(PROGRESS_OBSERVER)
                target.goto(BASE_URL, wait_until="networkidle")
                wait_ready(target)
                open_loader(target, "independent")
                choose_file(target, Path(real_zip).resolve())
                ready(target, "independent")
                samples = assert_overall_progress(target, Path(real_zip).name)
                assert any(sample['value'] == 90 for sample in samples), samples
                print('overall_progress_across_history_validation_and_reload=ok', flush=True)
                summary = collection_summary(target)
                with zipfile.ZipFile(real_zip) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    descriptors = [manifest["workspaces"]["independent"],
                                   manifest["workspaces"]["map"], *manifest["independentHistory"]]
                    assert len(summary) == len(descriptors)
                    for actual, descriptor in zip(summary, descriptors):
                        prefix = descriptor["prefix"]
                        project = json.loads(archive.read(prefix + "config/project.json"))
                        assert actual["name"] == project["map"]["fileName"]
                        assert actual["pointCount"] == project["map"]["pointCount"]
                        robot = json.loads(archive.read(prefix + "robot/robot.json"))
                        assert actual["robotFiles"] == len(robot["files"])
                        tasks = project["virtualTeaching"]["tasks"]
                        assert [task["id"] for task in actual["tasks"]] == [task["id"] for task in tasks]
                        for task, saved in zip(actual["tasks"], tasks):
                            assert [point["id"] for point in task["parking"]] == [point["id"] for point in saved["parkingPoints"]]
                            for point, saved_point in zip(task["parking"], saved["parkingPoints"]):
                                assert [pose["id"] for pose in point["poses"]] == [pose["id"] for pose in saved_point["poses"]]
                                for pose, saved_pose in zip(point["poses"], saved_point["poses"]):
                                    saved_frames = saved_pose.get("cameraCapture", {}).get("frames", {})
                                    assert {frame["side"] for frame in pose["frames"]} == set(saved_frames)
                                    assert all(frame["captured"] for frame in pose["frames"])
                target.reload(wait_until="networkidle")
                ready(target, "independent")
                assert collection_summary(target) == summary
                target.screenshot(path="/tmp/atlas-import-real-zip.png")
                context.close()
                print("real_zip_models_robots_history_teaching_photos_and_refresh=ok", flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == "__main__":
    run()

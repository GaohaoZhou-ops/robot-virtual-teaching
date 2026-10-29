import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download, logical_archive_files
from export_separation_ui_smoke import load_project
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready
from topbar_tools_helpers import topbar_action


def state(page):
    return page.evaluate("""async () => {
      const store = await import('/src/features/workspace/model/sessionStore.js');
      const { normalizeProject } = await import('/src/features/workspace/model/io.js');
      const { linkedWorkspaceRelation } = await import('/src/features/workspace/model/linkedProject.js');
      const { sessionId } = await store.fetchServiceSession();
      const map = await store.loadWorkspaceSnapshot(sessionId, 'map');
      const { companionWorkspace, independentHistory } = await store.loadProjectCompanions(sessionId, 'map');
      const snapshots = [map, companionWorkspace, ...independentHistory];
      const states = {};
      for (const snapshot of snapshots) {
        const project = normalizeProject(snapshot.config.config.project);
        // The scene converts rotary joints to radians and back on first load.
        project.robot.joints = Object.fromEntries(Object.entries(project.robot.joints)
          .map(([name, value]) => [name, Number(value.toFixed(10))]));
        const relation = snapshot.mode === 'independent'
          ? linkedWorkspaceRelation({ map, independent: snapshot }) : null;
        states[snapshot.map.teachingGroupId || 'map'] = {
          name: snapshot.map.name, tasks: project.teachingTasks, jointPoses: project.jointPoses,
          robot: project.robot, positions: [...new Float32Array(snapshot.map.positionBuffer)],
          colors: [...new Uint8Array(snapshot.map.colorBuffer)], indices: [...new Uint8Array(snapshot.map.indexBuffer)],
          waypoints: project.waypoints.filter(point => point.source === 'point-cloud-slice'),
          // Activating a group materializes task-derived nodes and invalidates
          // the computed connectivity status; the saved route stays intact.
          edges: project.edges.map(({ status, ...edge }) => edge),
          matrix: relation?.localToMap || null, matrixImports: relation?.matrixImports || [],
          files: snapshot.map.portableRobotPackage.files.map(file => ({path: file.path, bytes: [...new Uint8Array(file.bytes)]})),
        };
      }
      return { states, historyCount: independentHistory.length,
        currentGroup: companionWorkspace.map.teachingGroupId };
    }""")


def validate_zip(path):
    with zipfile.ZipFile(path) as archive:
        files = logical_archive_files(archive)
        manifest = json.loads(files["manifest.json"])
        assert manifest["format"] == "atlas-route-studio-workspace-project"
        assert manifest["statistics"]["independentHistoryCount"] == 2
        assert manifest["statistics"]["independentWorkspaceCount"] == 3
        for record in manifest["files"]:
            data = files[record["path"]]
            assert hashlib.sha256(data).hexdigest() == record["sha256"]
        for descriptor in [*manifest["workspaces"].values(), *manifest["independentHistory"]]:
            assert descriptor["prefix"] + "robot/files/transfer/meshes/body.stl" in files


def restore_group(page, group):
    topbar_action(page, "独立示教缓存", exact=True).click()
    row = page.locator(".project-load-history li").filter(has_text=f"独立组 {group}")
    with page.expect_navigation(wait_until="networkidle"):
        row.get_by_role("button", name="恢复独立示教 same-model.ply", exact=True).click()
    ready(page, "independent")


def run():
    errors = []
    resource_requests = []
    with tempfile.TemporaryDirectory(prefix="atlas-project-collection-") as temporary, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            source = context.new_page()
            source.set_default_timeout(30_000)
            source.on("pageerror", lambda error: errors.append(str(error)))
            source.goto(BASE_URL, wait_until="networkidle")
            source.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            source.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { projectCollectionFixture } = await import('/tests/project_collection_helpers.mjs');
              const { sessionId } = await store.fetchServiceSession();
              await store.restoreWorkspaceCollection(sessionId, await projectCollectionFixture());
            }""")
            source.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
            ready(source, "map")
            assert topbar_action(source, "另存为工程", exact=True).is_enabled()
            with source.expect_download() as download:
                start_project_download(source, "complete-history")
            path = Path(temporary) / "complete.zip"
            download.value.save_as(path)
            validate_zip(path)
            expected = state(source)
            assert expected["historyCount"] == 2
            assert expected["currentGroup"] == "group-C"
            assert expected["states"]["group-C"]["matrix"] is None

            # A fresh browser profile models a different device. Block the
            # source robot endpoint, so only actual bundled files can load.
            imported = browser.new_context(viewport={"width": 1440, "height": 1000})
            imported.route("**/__atlas/robot-files/**", lambda route: (resource_requests.append(route.request.url), route.abort()))
            page = imported.new_page()
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            load_project(page, "map", path)
            ready(page, "map")
            assert state(page) == expected
            page.reload(wait_until="networkidle")
            ready(page, "map")
            assert state(page) == expected

            # Same filename, three distinct list entries with independent bindings.
            topbar_action(page, "切换到独立示教", exact=True).click()
            picker = page.get_by_role("dialog", name="选择独立示教", exact=True)
            expect(picker.locator('[data-workspace-kind="history"]')).to_have_count(2)
            with page.expect_navigation(wait_until="networkidle"):
                picker.locator('[data-workspace-kind="current"]').get_by_role("button").click()
            ready(page, "independent")
            for group in ("A", "B", "C"):
                restore_group(page, group)
                current = state(page)
                assert current["currentGroup"] == f"group-{group}"
                assert current["historyCount"] == 2
                for key, value in expected["states"][f"group-{group}"].items():
                    assert current["states"][f"group-{group}"][key] == value, (group, key,
                        current["states"][f"group-{group}"][key], value)
                assert current["states"]["map"] == expected["states"]["map"]
            page.screenshot(path="/tmp/atlas-project-collection-restored.png", full_page=True, animations="disabled")
            with page.expect_download() as download:
                start_project_download(page, "complete-reexport")
            reexport = Path(temporary) / "reexport.zip"
            download.value.save_as(reexport)
            validate_zip(reexport)

            # A missing historical mesh leaves all existing workspaces intact.
            bad = Path(temporary) / "missing-history.zip"
            with zipfile.ZipFile(path) as archive, zipfile.ZipFile(bad, "w") as target:
                files = logical_archive_files(archive)
                for name in files:
                    if name != "independent-history/2/robot/files/transfer/meshes/body.stl":
                        target.writestr(name, files[name])
            before = state(page)
            page.locator("input[data-project-guide-input]").set_input_files(str(bad))
            error = page.get_by_role("alertdialog", name="工程加载失败")
            error.get_by_text("工程包缺少", exact=False).wait_for()
            assert state(page) == before
            error.get_by_role("button", name="关闭", exact=True).click()

            # Storage failure after writes were queued must roll back both the
            # active slots and the full history list, without losing local data.
            assert page.evaluate("""async () => {
              const store = await import('/src/features/workspace/model/sessionStore.js');
              const { projectCollectionFixture } = await import('/tests/project_collection_helpers.mjs');
              const { prepareWorkspaceCollectionImport } = await import('/src/features/workspace/model/projectWorkspaceCollection.js');
              const { sessionId } = await store.fetchServiceSession();
              const collection = prepareWorkspaceCollectionImport(await projectCollectionFixture());
              const put = IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put = function(record, ...args) {
                if (record.key === 'independent-history') throw new DOMException('quota test', 'QuotaExceededError');
                return put.call(this, record, ...args);
              };
              try { await store.restoreWorkspaceCollection(sessionId, collection); }
              catch (error) { return error.name === 'QuotaExceededError'; }
              finally { IDBObjectStore.prototype.put = put; }
              return false;
            }""")
            assert state(page) == before
            # Reimporting the same groups updates them instead of duplicating history.
            with page.expect_navigation(wait_until="networkidle"):
                page.locator("input[data-project-guide-input]").set_input_files(str(path))
            ready(page, "independent")
            assert state(page)["historyCount"] == 2
            assert not errors, errors
            assert not resource_requests, resource_requests
            print("complete_history_fresh_device_mesh_presets_routes_media_and_bindings=ok")
            print("same_name_group_switch_reload_reexport_and_deduplication=ok")
            print("corrupt_history_and_atomic_quota_rollback=ok")
            imported.close()
            context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    run()

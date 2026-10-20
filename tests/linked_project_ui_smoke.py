import base64
import io
import json
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import start_project_download
from dual_teaching_workspace_smoke import set_color_mode
from export_separation_ui_smoke import load_project
from map_route_sync_ui_smoke import navigation, temporary_options
from project_export_save_ui_smoke import SAVE_PICKER
from project_save_target_ui_smoke import save, save_as, switch_mode
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready
from topbar_tools_helpers import topbar_action


def seed_linked(page, active):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async active => {
      const { linkedProjectFixture } = await import('/tests/linked_project_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const pair = await linkedProjectFixture();
      await store.restoreLinkedWorkspaces(sessionId, pair, active);
    }""", active)
    page.goto(f"{BASE_URL}/workbench", wait_until="networkidle")
    ready(page, active)
    # Let the UI materialize its task-derived navigation points on both sides.
    switch_mode(page, "independent" if active == "map" else "map")
    switch_mode(page, active)


def state(page):
    return page.evaluate("""async () => {
      const store = await import('/src/lib/sessionStore.js');
      const { linkedWorkspaceRelation } = await import('/src/lib/linkedProject.js');
      const { normalizeProject } = await import('/src/lib/io.js');
      const { sessionId } = await store.fetchServiceSession();
      const pair = Object.fromEntries(await Promise.all(['map', 'independent'].map(async mode =>
        [mode, await store.loadWorkspaceSnapshot(sessionId, mode)])));
      const states = {};
      for (const mode of ['map', 'independent']) {
        const workspace = pair[mode];
        const project = normalizeProject(workspace.config.config.project);
        states[mode] = { tasks: project.teachingTasks, waypoints: project.waypoints,
          edges: project.edges, jointPoses: project.jointPoses, robot: project.robot,
          positions: Array.from(new Float32Array(workspace.map.positionBuffer)),
          colors: Array.from(new Uint8Array(workspace.map.colorBuffer)),
          indices: Array.from(new Uint8Array(workspace.map.indexBuffer)),
          sourceHash: workspace.map.sourceHash,
          robotFiles: workspace.map.portableRobotPackage.files.map(file =>
            ({ path: file.path, bytes: Array.from(new Uint8Array(file.bytes)) })) };
      }
      const relation = linkedWorkspaceRelation(pair);
      return { states, transform: relation?.localToMap, matrixImports: relation?.matrixImports,
        synced: pair.independent.config.config.ui.mapRouteSyncEnabled };
    }""")


def saved_bytes(page, name):
    return base64.b64decode(page.evaluate("""async name => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('chosen-export-folder');
      const file = await (await folder.getFileHandle(name)).getFile();
      return btoa(Array.from(new Uint8Array(await file.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
    }""", name))


def assert_pair(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "atlas-route-studio-linked-project"
        assert manifest["statistics"]["workspaceCount"] == 2
        projects = {}
        for mode in ("map", "independent"):
            prefix = f"workspaces/{mode}/"
            projects[mode] = json.loads(archive.read(prefix + "config/project.json"))
            assert prefix + "environment/positions.f32le" in archive.namelist()
            assert prefix + "robot/files/transfer/robot.urdf" in archive.namelist()
            assert any(name.startswith(prefix + "teaching-data/") and name.endswith(".png")
                       for name in archive.namelist())
            assert not any(point.get("source") == "temporary-map-route" for point in projects[mode]["waypoints"])
        return projects


def check_synced(page):
    actions = navigation(page)
    expect(actions.get_by_role("button", name="重新同步", exact=True)).to_be_enabled()
    expect(temporary_options(page)).to_have_count(len(state(page)["states"]["map"]["waypoints"]))


def check_shared_save_target(browser, errors):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script(f"({SAVE_PICKER})()")
    page = context.new_page()
    page.set_default_timeout(30_000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    seed_linked(page, "map")
    save_as(page, "linked.zip")
    initial = assert_pair(saved_bytes(page, "linked.zip"))
    switch_mode(page, "independent")
    expect(topbar_action(page, "保存工程", exact=True)).to_be_enabled()
    page.keyboard.press("Escape")
    set_color_mode(page, "white")
    save(page, "linked.zip")
    updated = assert_pair(saved_bytes(page, "linked.zip"))
    assert updated["independent"]["workspace"]["pointColorMode"] == "white"
    assert updated["map"]["waypoints"] == initial["map"]["waypoints"]
    assert updated["map"]["virtualTeaching"] == initial["map"]["virtualTeaching"]
    switch_mode(page, "map")
    save(page, "linked.zip")
    assert assert_pair(saved_bytes(page, "linked.zip"))["independent"]["workspace"]["pointColorMode"] == "white"
    committed = saved_bytes(page, "linked.zip")
    page.evaluate("""async () => {
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      // Replace just the other side with an unrelated model.
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const next = teachingTransferFixture('independent');
      next.map.mapId = 'unrelated-model'; next.map.sourceHash = 'unrelated-hash';
      next.config.config.project.map.sourceHash = 'unrelated-hash';
      await store.saveWorkspaceMap(sessionId, next.map.mapId, next.map.name, next.map, 'independent');
      await store.saveWorkspaceConfig(sessionId, next.map.mapId, next.config.config, 'independent');
      await store.activateWorkspaceMode(sessionId, 'map');
    }""")
    topbar_action(page, "保存工程", exact=True).click()
    page.get_by_text("工程保存失败：当前双边绑定关系已变化", exact=False).wait_for()
    assert saved_bytes(page, "linked.zip") == committed
    context.close()
    print("shared_save_target_latest_data_and_replaced_binding_protection=ok", flush=True)


def run():
    errors = []
    with tempfile.TemporaryDirectory(prefix="atlas-linked-project-") as temporary, sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for save_mode in ("map", "independent"):
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                page = context.new_page()
                page.set_default_timeout(30_000)
                page.on("pageerror", lambda error: errors.append(str(error)))
                seed_linked(page, save_mode)
                if save_mode == "independent":
                    check_synced(page)
                with page.expect_download() as download:
                    start_project_download(page, f"linked-{save_mode}")
                path = Path(temporary) / f"{save_mode}.zip"
                download.value.save_as(path)
                assert_pair(path.read_bytes())
                expected = state(page)
                for load_mode in ("map", "independent"):
                    imported = browser.new_context(viewport={"width": 1440, "height": 1000})
                    target = imported.new_page()
                    target.set_default_timeout(30_000)
                    target.on("pageerror", lambda error: errors.append(str(error)))
                    # Import into an empty profile; no map, robot or task cache is available.
                    load_project(target, load_mode, path)
                    ready(target, load_mode)
                    assert state(target) == expected
                    if load_mode == "map":
                        switch_mode(target, "independent")
                    check_synced(target)
                    switch_mode(target, "map")
                    assert state(target) == expected
                    target.reload(wait_until="networkidle")
                    ready(target, "map")
                    assert state(target) == expected
                    imported.close()
                    print(f"save_{save_mode}_load_{load_mode}_both_workspaces_switch_refresh_and_route_sync=ok", flush=True)

                # A malformed companion must leave both existing workspaces intact.
                bad = Path(temporary) / "missing-companion.zip"
                with zipfile.ZipFile(path) as source, zipfile.ZipFile(bad, "w") as dest:
                    for name in source.namelist():
                        if name != "workspaces/independent/environment/positions.f32le":
                            dest.writestr(name, source.read(name))
                page.locator("input[data-project-guide-input]").set_input_files(str(bad))
                page.get_by_text("工程文件无效：工程包缺少", exact=False).wait_for()
                assert state(page) == expected

                # Force a serialization failure after the first workspace has
                # been written in the transaction, and verify complete rollback.
                assert page.evaluate("""async () => {
                  const store = await import('/src/lib/sessionStore.js');
                  const { linkedProjectFixture } = await import('/tests/linked_project_helpers.mjs');
                  const { sessionId } = await store.fetchServiceSession();
                  const pair = await linkedProjectFixture();
                  pair.independent.config.config.unsupported = () => {};
                  try { await store.restoreLinkedWorkspaces(sessionId, pair, 'independent'); }
                  catch (error) { return error.name === 'DataCloneError'; }
                  return false;
                }""")
                assert state(page) == expected
                print(f"{save_mode}_corrupt_import_and_atomic_storage_rollback=ok", flush=True)
                context.close()

            # Native Save As and Save share one destination across the bound pair.
            check_shared_save_target(browser, errors)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == "__main__":
    run()

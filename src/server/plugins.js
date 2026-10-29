import { atlasPhysicsPlugin } from './physics/physicsService.js';
import { atlasWorkspacePlugin } from './workspace/workspaceService.js';
import { ipadTeachingPlugin } from "./devices/ipadTeachingService.js";
import { ipadScreenPlugin } from "./devices/ipadScreenService.js";
import { workSyncPlugin } from "./collaboration/workSyncService.js";
import { robotTwinPlugin } from "./robots/robotTwinService.js";
import { visionScenePlugin } from "./vision/visionSceneService.js";

// Keep service construction in one place. Both development and preview install
// the same routes; the frontend build configuration contains no route handlers.
export function createAtlasServicePlugins() {
  return [atlasPhysicsPlugin(), atlasWorkspacePlugin(), ipadTeachingPlugin(),
    ipadScreenPlugin(), workSyncPlugin(), robotTwinPlugin(), visionScenePlugin()];
}

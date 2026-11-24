import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function sameDirectory(path, directory) {
  try { return realpathSync(path) === directory; } catch { return false; }
}

export function savedDesktopProject(directory, file = join(homedir(), '.codex', '.codex-global-state.json')) {
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const matches = Object.values(state?.['local-projects'] ?? {}).filter(project =>
    typeof project?.id === 'string' && Array.isArray(project.rootPaths) && project.rootPaths.length === 1 && sameDirectory(project.rootPaths[0], directory));
  if (matches.length !== 1) return null;
  const projectId = matches[0].id;
  const mappings = Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] ?? {});
  const candidates = new Set(mappings.map(map => map?.[projectId]).filter(id => typeof id === 'string' && id.length > 0));
  return { projectId, nativeProjectId: candidates.size === 1 ? [...candidates][0] : null };
}

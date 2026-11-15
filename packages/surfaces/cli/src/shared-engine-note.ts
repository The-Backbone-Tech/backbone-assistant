// The shared service refuses a colleague's message when the engine brings its own tools. Tell the owner while they set sharing up.
import { engineBringsOwnTools } from '@backbone-next/platform/composition/engine-settings';

export const SHARED_ENGINE_NOTE = 'Colleagues can join and read what is shared with them, but their messages are refused until you configure a model for shared work. With the background service, stop the background service, run backbone model shared local --endpoint <loopback-url> --model <id>, then start it again. In the app, choose Settings › AI and models › Shared work. Your own engine stays selected.';

/** The one line to print, or nothing when colleagues can be answered (or the engine cannot be read, which the service itself reports). */
export function sharedEngineNote(home: string, brings: () => boolean = () => engineBringsOwnTools(home), loadError?: string | null): string | undefined {
  try { return loadError ? `${loadError} ${SHARED_ENGINE_NOTE}` : brings() ? SHARED_ENGINE_NOTE : undefined; } catch { return undefined; }
}

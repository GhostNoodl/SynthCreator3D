/**
 * Auto-updater: checks GitHub releases (via tauri-plugin-updater) for a newer
 * version, downloads + installs it with progress, then relaunches.
 *
 * Only runs inside the Tauri shell (never in the vite dev browser).
 * Update artifacts are minisign-verified against the pubkey in tauri.conf.json.
 */
import { check } from '@tauri-apps/plugin-updater';
import type { Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export interface UpdateInfo {
  version: string;
  notes: string;
  update: Update;
}

/** Returns update details when a newer release exists, else null. Never throws. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? '',
      update,
    };
  } catch (err) {
    // offline / rate-limited / bad feed: stay silent, the app keeps working
    console.warn('[updater] check failed:', err);
    return null;
  }
}

/** Download and install the update, reporting byte progress, then relaunch. */
export async function installUpdate(
  info: UpdateInfo,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await info.update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null;
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      onProgress(downloaded, total);
    }
  });
  await relaunch();
}

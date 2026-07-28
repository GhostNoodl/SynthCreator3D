import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { parseManifest } from './manifest/validate.ts';
import type { Manifest } from './manifest/types.ts';
import { usePresetStore } from './state/preset.ts';
import { Viewer } from './viewer/Viewer.ts';
import { loadPack } from './viewer/pack.ts';
import type { PackRuntime } from './viewer/pack.ts';
import { LeftPanel } from './ui/LeftPanel.tsx';
import { RightPanel } from './ui/RightPanel.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import type { PackEntry } from './ui/Toolbar.tsx';
import type { ImportedPackInfo } from './ui/ImportWizard.tsx';
import { UpdatePrompt } from './ui/UpdatePrompt.tsx';
import { checkForUpdate } from './updater.ts';
import type { UpdateInfo } from './updater.ts';

/** Pack directory listing, served from public/. The first pack loads by default. */
const PACK_INDEX_URL = 'packs/index.json';

/** localStorage key remembering the 18+ confirmation for an NSFW pack id. */
const nsfwOkKey = (packId: string) => `synthcreator3d:nsfw-ok:${packId}`;

type LoadStatus = 'loading' | 'ready' | 'error';

/** Parse packs/index.json into normalized entries (trailing-slash paths). */
function parsePackIndex(data: unknown): PackEntry[] {
  const packs = (data as { packs?: unknown } | null)?.packs;
  if (!Array.isArray(packs)) throw new Error('pack index: expected { "packs": [...] }');
  const entries = packs.map((raw): PackEntry => {
    const { id, path } = (raw ?? {}) as { id?: unknown; path?: unknown };
    if (typeof id !== 'string' || id === '' || typeof path !== 'string' || path === '') {
      throw new Error('pack index: every entry needs non-empty "id" and "path" strings');
    }
    return { id, path: path.endsWith('/') ? path : `${path}/` };
  });
  if (entries.length === 0) throw new Error('pack index: no packs listed');
  return entries;
}

/** Turn an imported pack (app-data dir) into a PackEntry the loader can use. */
function importedEntry(pack: ImportedPackInfo): PackEntry {
  return {
    id: pack.id,
    // Textures/model load through tauri's asset protocol (scoped to $APPDATA).
    path: `${convertFileSrc(pack.path)}/`,
    imported: true,
    nativePath: pack.path,
  };
}

/** Imported packs registered in the app-data dir; empty outside tauri. */
async function loadImportedEntries(): Promise<PackEntry[]> {
  if (!isTauri()) return [];
  try {
    const imported = await invoke<ImportedPackInfo[]>('list_imported_packs');
    return imported.map(importedEntry);
  } catch (err) {
    console.warn('[app] failed to list imported packs:', err);
    return [];
  }
}

interface PackTarget {
  entry: PackEntry;
  manifest: Manifest;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs (not state): the export toolbar reads the live viewer/runtime on
  // demand without re-rendering the app on every pack load.
  const viewerRef = useRef<Viewer | null>(null);
  const runtimeRef = useRef<PackRuntime | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [packs, setPacks] = useState<PackEntry[]>([]);
  /** Id of the pack that is loaded/loading — the dropdown's value. */
  const [activePackId, setActivePackId] = useState('');
  /** The pack actually being loaded; changing it remounts the whole runtime. */
  const [loadTarget, setLoadTarget] = useState<PackTarget | null>(null);
  /** NSFW pack waiting on the 18+ confirmation (nothing loads while set). */
  const [nsfwGate, setNsfwGate] = useState<PackTarget | null>(null);
  /** Available app update (tauri only), shown once at startup. */
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const manifest = usePresetStore((s) => s.manifest);

  // One silent update check a few seconds after startup (tauri shell only).
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkForUpdate().then((info) => {
        if (!cancelled && info) setUpdateInfo(info);
      });
    }, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  /**
   * Fetch + validate a pack's manifest, then either load it or — for NSFW
   * packs without a stored confirmation — open the 18+ gate first.
   * Imported packs live outside the web root: their manifest comes through
   * the read_text_file command, their assets through the asset protocol.
   */
  async function requestPack(entry: PackEntry) {
    try {
      let data: unknown;
      if (entry.imported && entry.nativePath) {
        const text = await invoke<string>('read_text_file', {
          path: `${entry.nativePath}/manifest.json`,
        });
        data = JSON.parse(text);
      } else {
        const response = await fetch(`${entry.path}manifest.json`);
        if (!response.ok) throw new Error(`manifest fetch failed: HTTP ${response.status}`);
        data = await response.json();
      }
      const parsed = parseManifest(data); // logs warnings, null if fatal
      if (!parsed) throw new Error('manifest is invalid (see warnings above)');
      if (parsed.nsfw && !localStorage.getItem(nsfwOkKey(parsed.id))) {
        setNsfwGate({ entry, manifest: parsed });
        return;
      }
      setActivePackId(entry.id);
      setStatus('loading');
      setLoadTarget({ entry, manifest: parsed });
    } catch (err) {
      console.error('[app] failed to load pack:', err);
      setStatus('error');
    }
  }

  /** Register a just-imported pack in the dropdown and load it. */
  const handlePackImported = (pack: ImportedPackInfo) => {
    const entry = importedEntry(pack);
    setPacks((prev) => (prev.some((p) => p.id === entry.id) ? prev : [...prev, entry]));
    void requestPack(entry);
  };

  const confirmNsfw = () => {
    if (!nsfwGate) return;
    localStorage.setItem(nsfwOkKey(nsfwGate.manifest.id), '1');
    setActivePackId(nsfwGate.entry.id);
    setStatus('loading');
    setLoadTarget(nsfwGate);
    setNsfwGate(null);
  };

  // Cancel = stay on the current pack: activePackId never changed, so the
  // dropdown reverts to it on its own.
  const cancelNsfw = () => setNsfwGate(null);

  // Viewer lifecycle: created once, survives pack switches.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewer = new Viewer(canvas);
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
      viewer.dispose();
    };
  }, []);

  // Pack index, then the first pack by default. Imported packs (app-data
  // dir) are merged in after the embedded ones.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(PACK_INDEX_URL);
        if (!response.ok) throw new Error(`pack index fetch failed: HTTP ${response.status}`);
        const embedded = parsePackIndex(await response.json());
        const imported = await loadImportedEntries();
        const entries = [
          ...embedded,
          ...imported.filter((p) => !embedded.some((e) => e.id === p.id)),
        ];
        if (cancelled) return;
        setPacks(entries);
        const first = entries[0];
        if (first) await requestPack(first);
      } catch (err) {
        console.error('[app] failed to load pack index:', err);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; requestPack is stable enough for startup
  }, []);

  // Pack runtime lifecycle: a new loadTarget = full reload (manifest, GLB,
  // state — nothing is preserved). Cleanup cancels in-flight loads.
  useEffect(() => {
    if (!loadTarget) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    let runtime: PackRuntime | null = null;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        usePresetStore.getState().initFromManifest(loadTarget.manifest);
        const loaded = await loadPack(loadTarget.entry.path, loadTarget.manifest);
        if (cancelled) {
          loaded.dispose();
          return;
        }
        runtime = loaded;
        runtimeRef.current = runtime;
        viewer.setModel(runtime.root);
        // State is the single source of truth: apply once, then on every change.
        runtime.apply(usePresetStore.getState().preset);
        unsubscribe = usePresetStore.subscribe((s) => runtime?.apply(s.preset));
        setStatus('ready');
      } catch (err) {
        console.error('[app] failed to load pack:', err);
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      runtimeRef.current = null;
      viewer.setModel(null);
      runtime?.dispose();
    };
  }, [loadTarget]);

  return (
    <div className="app-shell">
      <Toolbar
        ready={status === 'ready'}
        getViewer={() => viewerRef.current}
        getRuntime={() => runtimeRef.current}
        packs={packs}
        activePackId={activePackId}
        onSelectPack={(id) => {
          if (id === activePackId) return;
          const entry = packs.find((p) => p.id === id);
          if (entry) void requestPack(entry);
        }}
        onPackImported={handlePackImported}
      />
      <div className="layout">
        <aside className="panel left">
          <h1 className="app-title">SynthCreator3D</h1>
          {manifest ? <LeftPanel /> : <p className="dim">Loading manifest…</p>}
        </aside>
        <main className="viewport">
          <canvas ref={canvasRef} className="gl" />
          {status !== 'ready' && (
            <div className="overlay">
              {status === 'loading' ? 'Loading pack…' : 'Failed to load pack — see console'}
            </div>
          )}
        </main>
        <aside className="panel right">{manifest ? <RightPanel /> : null}</aside>
      </div>

      {nsfwGate && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Adults-only content</h2>
            <p>This pack contains adults-only content. Confirm you are 18 or older.</p>
            <div className="modal-actions">
              <button onClick={confirmNsfw}>Confirm</button>
              <button onClick={cancelNsfw}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {updateInfo && !nsfwGate && (
        <UpdatePrompt info={updateInfo} onDismiss={() => setUpdateInfo(null)} />
      )}
    </div>
  );
}

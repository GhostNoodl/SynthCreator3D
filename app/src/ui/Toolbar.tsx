import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { usePresetStore } from '../state/preset.ts';
import type { PackRuntime } from '../viewer/pack.ts';
import type { Viewer } from '../viewer/Viewer.ts';
import { downloadBlob } from '../export/download.ts';
import {
  buildPresetFile,
  parsePresetFile,
  sanitizeFileName,
  serializePresetFile,
} from '../export/presetFile.ts';
import { decodeShareCode, encodeShareCode } from '../export/shareCode.ts';
import { buildVrcConfig, renderVrcConfigMarkdown } from '../export/vrcConfig.ts';
import { bakeTexturePngs, exportBakedGlb, recordTurntable } from '../viewer/exportRuntime.ts';
import { ImportWizard } from './ImportWizard.tsx';
import type { ImportedPackInfo } from './ImportWizard.tsx';

/** One entry of public/packs/index.json or of the imported-pack list — a loadable model pack. */
export interface PackEntry {
  id: string;
  /** Pack base URL (asset-protocol URL for imported packs), normalized with a trailing slash. */
  path: string;
  /** true for packs imported into the app-data dir (manifest read via read_text_file). */
  imported?: boolean;
  /** Native absolute pack directory (imported packs only). */
  nativePath?: string;
}

interface ToolbarProps {
  /** false until the pack (and thus viewer/runtime) is loaded. */
  ready: boolean;
  getViewer: () => Viewer | null;
  getRuntime: () => PackRuntime | null;
  /** Packs from the pack index; empty while the index is still loading. */
  packs: PackEntry[];
  /** Id of the pack that is loaded/loading (the dropdown's value). */
  activePackId: string;
  /** Request a pack switch (may open the 18+ gate instead of loading). */
  onSelectPack: (id: string) => void;
  /** Register + select a pack the import wizard just created. */
  onPackImported: (pack: ImportedPackInfo) => void;
}

interface Notice {
  kind: 'ok' | 'err';
  text: string;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Top toolbar: every export & sharing action, always operating on the CURRENT
 * preset state read straight from the store. Browser-only paths (canvas
 * capture, MediaRecorder, downloads, clipboard) report failures in-line.
 */
export function Toolbar({ ready, getViewer, getRuntime, packs, activePackId, onSelectPack, onPackImported }: ToolbarProps) {
  const manifest = usePresetStore((s) => s.manifest);
  const [name, setName] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareCode, setShareCode] = useState('');
  const [pasteValue, setPasteValue] = useState('');
  const [shareError, setShareError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const effectiveName = name ?? manifest?.name ?? 'preset';
  const fileBase = sanitizeFileName(effectiveName);

  const requireReady = () => {
    const viewer = getViewer();
    const runtime = getRuntime();
    if (!manifest || !viewer || !runtime) throw new Error('pack is not loaded yet');
    return { manifest, viewer, runtime };
  };

  /** Run an async export action with shared busy/error handling. */
  const runExport = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setNotice({ kind: 'ok', text: await action() });
    } catch (err) {
      setNotice({ kind: 'err', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  // 1. Save preset — .synthpreset.json with an optional viewport thumbnail.
  const onSavePreset = () => {
    try {
      const { manifest: m, viewer } = requireReady();
      const preset = usePresetStore.getState().preset;
      // Thumbnail is best-effort: canvas capture is browser territory.
      let thumbnail: string | undefined;
      try {
        thumbnail = viewer.captureThumbnailDataUrl(256);
      } catch (err) {
        console.warn('[toolbar] thumbnail capture failed, saving without one:', err);
      }
      const file = buildPresetFile(m.id, preset, new Date().toISOString(), thumbnail);
      downloadBlob(
        `${fileBase}.synthpreset.json`,
        new Blob([serializePresetFile(file)], { type: 'application/json' }),
      );
      setNotice({ kind: 'ok', text: `Saved ${fileBase}.synthpreset.json` });
    } catch (err) {
      setNotice({ kind: 'err', text: errMsg(err) });
    }
  };

  // 2. Load preset — validate envelope + preset body, reject wrong packId.
  const onFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow picking the same file again
    if (!file || !manifest) return;
    try {
      const parsed = parsePresetFile(await file.text(), manifest.id);
      usePresetStore.getState().loadPresetJson(parsed.preset);
      setNotice({
        kind: 'ok',
        text: parsed.packId
          ? `Loaded preset from ${file.name}`
          : `Loaded legacy preset ${file.name} (no packId — applied without a pack check)`,
      });
    } catch (err) {
      setNotice({ kind: 'err', text: errMsg(err) });
    }
  };

  // 3. Share code — show/copy the current code; paste to load.
  const openShare = () => {
    try {
      setShareCode(encodeShareCode(usePresetStore.getState().preset));
      setPasteValue('');
      setShareError('');
      setShareOpen(true);
    } catch (err) {
      setNotice({ kind: 'err', text: errMsg(err) });
    }
  };

  const copyShareCode = async () => {
    try {
      await navigator.clipboard.writeText(shareCode);
      setShareError('');
      setNotice({ kind: 'ok', text: 'Share code copied to clipboard' });
    } catch {
      setShareError('Clipboard unavailable — select the code above and copy it manually.');
    }
  };

  const loadShareCode = () => {
    try {
      usePresetStore.getState().loadPresetJson(decodeShareCode(pasteValue));
      setShareOpen(false);
      setNotice({ kind: 'ok', text: 'Share code loaded' });
    } catch (err) {
      setShareError(errMsg(err));
    }
  };

  // 4. Screenshot — full-res PNG of the viewport.
  const onScreenshot = () =>
    runExport(async () => {
      const { viewer } = requireReady();
      downloadBlob(`${fileBase}.png`, await viewer.capturePngBlob());
      return `Saved ${fileBase}.png`;
    });

  // 5. Turntable — 4s 360° WebM; button reflects recording state.
  const onTurntable = async () => {
    setRecording(true);
    try {
      const { viewer, runtime } = requireReady();
      const blob = await recordTurntable(viewer.canvas, runtime.root, 4000);
      downloadBlob(`${fileBase}-turntable.webm`, blob);
      setNotice({ kind: 'ok', text: `Saved ${fileBase}-turntable.webm` });
    } catch (err) {
      setNotice({ kind: 'err', text: errMsg(err) });
    } finally {
      setRecording(false);
    }
  };

  // 6. Export GLB — visible nodes only, morphs + baked albedo embedded.
  const onExportGlb = () =>
    runExport(async () => {
      const { manifest: m, runtime } = requireReady();
      const blob = await exportBakedGlb(runtime, m, usePresetStore.getState().preset);
      downloadBlob(`${fileBase}.glb`, blob);
      return `Saved ${fileBase}.glb`;
    });

  // 7. Export textures — baked albedo + emissive PNG per material.
  const onExportTextures = () =>
    runExport(async () => {
      const { manifest: m, runtime } = requireReady();
      const files = await bakeTexturePngs(runtime, m, usePresetStore.getState().preset);
      for (const f of files) downloadBlob(f.name, f.blob);
      return `Exported ${files.length} texture PNG${files.length === 1 ? '' : 's'}`;
    });

  // 8. Export VRChat config — human .md + machine .json.
  const onExportVrc = () => {
    try {
      const { manifest: m } = requireReady();
      const config = buildVrcConfig(m, usePresetStore.getState().preset);
      downloadBlob(
        `${fileBase}.vrchat.md`,
        new Blob([renderVrcConfigMarkdown(config)], { type: 'text/markdown' }),
      );
      downloadBlob(
        `${fileBase}.vrchat.json`,
        new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
      );
      setNotice({ kind: 'ok', text: `Saved ${fileBase}.vrchat.md + .json` });
    } catch (err) {
      setNotice({ kind: 'err', text: errMsg(err) });
    }
  };

  return (
    <div className="toolbar">
      {packs.length > 0 && (
        <select
          className="pack-select"
          value={activePackId}
          onChange={(e) => onSelectPack(e.target.value)}
          title="Model pack"
        >
          {packs.map((pack) => (
            <option value={pack.id} key={pack.id}>
              {pack.id}
            </option>
          ))}
        </select>
      )}
      {isTauri() && (
        <button
          onClick={() => setImportOpen(true)}
          title="Import a purchased Synth model (FBX + PSDs) into a pack"
        >
          Import model
        </button>
      )}
      <input
        className="preset-name"
        type="text"
        value={effectiveName}
        onChange={(e) => setName(e.target.value)}
        title="Preset name — used as the base file name for downloads"
        disabled={!ready}
      />
      <button onClick={onSavePreset} disabled={!ready} title="Download the current preset as JSON">
        Save preset
      </button>
      <button onClick={() => fileRef.current?.click()} disabled={!ready} title="Load a preset JSON file">
        Load preset
      </button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFilePicked} />
      <button onClick={openShare} disabled={!ready} title="Copy/paste a share code">
        Share code
      </button>
      <span className="toolbar-sep" />
      <button onClick={onScreenshot} disabled={!ready || busy} title="Download a PNG of the viewport">
        Screenshot
      </button>
      <button
        onClick={onTurntable}
        disabled={!ready || busy || recording}
        className={recording ? 'recording' : ''}
        title="Record a 4s 360° turntable video (WebM)"
      >
        {recording ? '● Recording…' : 'Turntable'}
      </button>
      <button onClick={onExportGlb} disabled={!ready || busy} title="Export a .glb with the current state baked in">
        Export GLB
      </button>
      <button onClick={onExportTextures} disabled={!ready || busy} title="Download baked albedo/emissive PNGs">
        Export textures
      </button>
      <button onClick={onExportVrc} disabled={!ready} title="Download a VRChat/Unity recreation config (.md + .json)">
        VRChat config
      </button>
      <span className="spacer" />
      {notice && <span className={`notice ${notice.kind}`}>{notice.text}</span>}

      {shareOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShareOpen(false);
          }}
        >
          <div className="modal">
            <h2>Share code</h2>
            <p className="dim">Copy this code to share the current preset:</p>
            <textarea
              className="share-code"
              readOnly
              rows={4}
              value={shareCode}
              onFocus={(e) => e.target.select()}
            />
            <div className="modal-actions">
              <button onClick={copyShareCode}>Copy</button>
            </div>
            <p className="dim">…or paste a code here to load it:</p>
            <textarea
              className="share-code"
              rows={4}
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder="SYNTH1.…"
            />
            {shareError && <p className="notice err">{shareError}</p>}
            <div className="modal-actions">
              <button onClick={loadShareCode} disabled={!pasteValue.trim()}>
                Load code
              </button>
              <button onClick={() => setShareOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {importOpen && (
        <ImportWizard onClose={() => setImportOpen(false)} onPackImported={onPackImported} />
      )}
    </div>
  );
}

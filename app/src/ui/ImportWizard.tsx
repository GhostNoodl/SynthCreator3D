import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

/** One imported pack, as returned by the `list_imported_packs` command. */
export interface ImportedPackInfo {
  id: string;
  name: string;
  /** Absolute native path of the pack directory (contains manifest.json). */
  path: string;
}

/** Mirrors ScanResult in src-tauri/src/import.rs (serde keeps snake_case). */
interface ScanResult {
  fbx: string | null;
  main_psd: string | null;
  clothing_psd: string | null;
  fbx_candidates: string[];
  psd_candidates: string[];
}

/** Mirrors ProgressEvent in src-tauri/src/import.rs. */
interface ProgressEvent {
  step: string;
  label: string;
  status: 'running' | 'done';
  /** 1-based position within the step list (for "Step X of N"). */
  index: number;
  total: number;
}

type Variant = 'sfw' | 'nsfw';
type Phase = 'variant' | 'files' | 'running' | 'done' | 'error';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Pipeline errors can be a wall of script stderr (warnings + layer dumps).
 * Surface the most useful line: the last script ERROR line if present, else
 * the first non-empty line of the message.
 */
function summarizeImportError(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter((l) => l.includes('ERROR:'));
  if (errorLines.length > 0) {
    const last = errorLines[errorLines.length - 1];
    // strip the "[script] ERROR:" prefix for readability
    return last.replace(/^\[[^\]]*\]\s*ERROR:\s*/, '');
  }
  return lines[0] ?? message;
}

/** Shorten a long path for display (full path stays in the title tooltip). */
function shorten(path: string): string {
  const norm = path.replace(/\\/g, '/');
  if (norm.length <= 64) return norm;
  return `${norm.slice(0, 24)}…${norm.slice(-36)}`;
}

interface FileRowProps {
  label: string;
  value: string;
  candidates: string[];
  onChange: (path: string) => void;
  onBrowse: () => void;
}

/** One resolved file: current pick, candidate dropdown, manual override. */
function FileRow({ label, value, candidates, onChange, onBrowse }: FileRowProps) {
  // A browsed file may live outside the scanned candidates — keep it selectable.
  const options = value !== '' && !candidates.includes(value) ? [value, ...candidates] : candidates;
  return (
    <div className="file-row">
      <span className="file-label">{label}</span>
      {value ? (
        <span className="file-value" title={value}>
          {shorten(value)}
        </span>
      ) : (
        <span className="file-value missing">not found — pick manually</span>
      )}
      {options.length > 1 && (
        <select value={value} onChange={(e) => onChange(e.target.value)} title="Candidates found in the folder">
          {value === '' && <option value="">—</option>}
          {options.map((c) => (
            <option value={c} key={c}>
              {c.split(/[\\/]/).pop()}
            </option>
          ))}
        </select>
      )}
      <button onClick={onBrowse}>Browse…</button>
    </div>
  );
}

interface ImportWizardProps {
  onClose: () => void;
  /** Fired once the new pack is registered in the app-data dir. */
  onPackImported: (pack: ImportedPackInfo) => void;
}

/**
 * Import wizard: convert the user's locally purchased Synth files (FBX +
 * PSDs) into a model pack in the app-data dir. Steps: variant → files
 * (auto-found inside the picked folder, manually overridable) → progress →
 * done/error. The heavy lifting happens in Rust (run_import); this component
 * only collects inputs and renders `import-progress` events.
 */
export function ImportWizard({ onClose, onPackImported }: ImportWizardProps) {
  const [phase, setPhase] = useState<Phase>('variant');
  const [variant, setVariant] = useState<Variant>('sfw');
  const [folder, setFolder] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [fbx, setFbx] = useState('');
  const [mainPsd, setMainPsd] = useState('');
  const [clothingPsd, setClothingPsd] = useState('');
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addedName, setAddedName] = useState<string | null>(null);
  /** Last `${variant}|${folder}` pair scanned, so variant switches re-scan. */
  const scannedKey = useRef('');

  const runScan = async (dir: string, v: Variant) => {
    scannedKey.current = `${v}|${dir}`;
    setScan(null);
    setScanError(null);
    try {
      const result = await invoke<ScanResult>('scan_model_folder', { folder: dir, variant: v });
      // A newer scan (folder/variant changed meanwhile) wins.
      if (scannedKey.current !== `${v}|${dir}`) return;
      setScan(result);
      setFbx(result.fbx ?? '');
      setMainPsd(result.main_psd ?? '');
      setClothingPsd(result.clothing_psd ?? '');
    } catch (err) {
      if (scannedKey.current === `${v}|${dir}`) setScanError(errMsg(err));
    }
  };

  // Entering the files phase with a stale (folder, variant) pair re-scans.
  useEffect(() => {
    if (phase === 'files' && folder && scannedKey.current !== `${variant}|${folder}`) {
      void runScan(folder, variant);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runScan is stable; keyed by phase/folder/variant
  }, [phase, folder, variant]);

  // Subscribe to pipeline progress while the import runs.
  useEffect(() => {
    if (phase !== 'running') return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<ProgressEvent>('import-progress', (event) => {
      setProgress((prev) => {
        const index = prev.findIndex((p) => p.step === event.payload.step);
        if (index === -1) return [...prev, event.payload];
        const next = [...prev];
        next[index] = event.payload;
        return next;
      });
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch((err) => console.warn('[import] progress listener failed:', err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [phase]);

  const pickFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select the purchased Synth model folder',
      });
      if (typeof selected === 'string') {
        setFolder(selected);
        void runScan(selected, variant);
      }
    } catch (err) {
      setScanError(errMsg(err));
    }
  };

  const browseFile = async (kind: 'fbx' | 'main' | 'clothing') => {
    const filters =
      kind === 'fbx'
        ? [{ name: 'FBX model', extensions: ['fbx'] }]
        : [{ name: 'PSD texture', extensions: ['psd'] }];
    try {
      const selected = await open({ multiple: false, filters, defaultPath: folder ?? undefined });
      if (typeof selected !== 'string') return;
      if (kind === 'fbx') setFbx(selected);
      else if (kind === 'main') setMainPsd(selected);
      else setClothingPsd(selected);
    } catch (err) {
      setScanError(errMsg(err));
    }
  };

  const startImport = async () => {
    setProgress([]);
    setError(null);
    setPhase('running');
    try {
      await invoke('run_import', {
        variant,
        fbxPath: fbx,
        mainPsdPath: mainPsd,
        clothingPsdPath: clothingPsd,
      });
      const packs = await invoke<ImportedPackInfo[]>('list_imported_packs');
      const added = packs.find((p) => p.id === `zairiza-synth-${variant}`) ?? null;
      setAddedName(added?.name ?? null);
      if (added) onPackImported(added);
      setPhase('done');
    } catch (err) {
      setError(errMsg(err));
      setPhase('error');
    }
  };

  const running = phase === 'running';
  const close = () => {
    if (!running) onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal import-wizard">
        <h2>Import model</h2>

        {phase === 'variant' && (
          <>
            <p className="dim">
              Convert your locally purchased Synth model (Zairiza) into a pack. The model files are
              not bundled with this app — pick the variant you own.
            </p>
            <label className="row">
              <input type="radio" checked={variant === 'sfw'} onChange={() => setVariant('sfw')} />
              SFW — Synth.fbx + main/clothing PSDs
            </label>
            <label className="row">
              <input type="radio" checked={variant === 'nsfw'} onChange={() => setVariant('nsfw')} />
              NSFW (18+) — Synth NSFW ALL.fbx + main/clothing PSDs
            </label>
            <div className="modal-actions">
              <button onClick={() => setPhase('files')}>Next</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {phase === 'files' && (
          <>
            <p className="dim">
              Point at the folder you unpacked the purchased model into. The FBX and both PSDs are
              located automatically; override any file that was not found.
            </p>
            <div className="file-row">
              <span className="file-label">Model folder</span>
              {folder ? (
                <span className="file-value" title={folder}>
                  {shorten(folder)}
                </span>
              ) : (
                <span className="file-value missing">no folder chosen</span>
              )}
              <button onClick={pickFolder}>{folder ? 'Change…' : 'Choose…'}</button>
            </div>
            {folder && !scan && !scanError && <p className="dim">Scanning folder…</p>}
            {scanError && <p className="notice err">{scanError}</p>}
            <FileRow
              label="Model (FBX)"
              value={fbx}
              candidates={scan?.fbx_candidates ?? []}
              onChange={setFbx}
              onBrowse={() => void browseFile('fbx')}
            />
            <FileRow
              label="Main PSD"
              value={mainPsd}
              candidates={scan?.psd_candidates ?? []}
              onChange={setMainPsd}
              onBrowse={() => void browseFile('main')}
            />
            <FileRow
              label="Clothing PSD"
              value={clothingPsd}
              candidates={scan?.psd_candidates ?? []}
              onChange={setClothingPsd}
              onBrowse={() => void browseFile('clothing')}
            />
            <div className="modal-actions">
              <button
                onClick={() => void startImport()}
                disabled={!(fbx && mainPsd && clothingPsd)}
                title={fbx && mainPsd && clothingPsd ? 'Convert into a pack' : 'All three files are required'}
              >
                Start import
              </button>
              <button onClick={() => setPhase('variant')}>Back</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {(phase === 'running' || phase === 'error' || phase === 'done') && (
          <>
            <ImportProgress progress={progress} phase={phase} />
            {phase === 'running' && <p className="dim">Importing — keep this window open.</p>}
            {phase === 'error' && error && (
              <>
                <p className="notice err">{summarizeImportError(error)}</p>
                <details className="import-error-details">
                  <summary>Full error log</summary>
                  <pre>{error}</pre>
                </details>
                <div className="modal-actions">
                  <button onClick={() => setPhase('files')}>Back</button>
                  <button onClick={onClose}>Close</button>
                </div>
              </>
            )}
            {phase === 'done' && (
              <>
                <p className="notice ok">
                  Pack added{addedName ? `: ${addedName}` : ''}. It is now selected in the pack dropdown.
                </p>
                <div className="modal-actions">
                  <button onClick={onClose}>Close</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Determinate import progress: a fill bar with "Step X of N" and the current
 * step emphasized, plus the per-step checklist underneath for detail.
 */
function ImportProgress({ progress, phase }: { progress: ProgressEvent[]; phase: Phase }) {  const total = progress.reduce((max, p) => Math.max(max, p.total), 0);
  const done = progress.filter((p) => p.status === 'done').length;
  const current = progress.find((p) => p.status === 'running');
  const percent = phase === 'done' ? 100 : total > 0 ? Math.round((done / total) * 100) : 0;
  const headline =
    phase === 'done'
      ? 'Import complete'
      : phase === 'error'
        ? 'Import failed'
        : current
          ? `Step ${current.index} of ${total}: ${current.label}`
          : 'Starting…';

  return (
    <div className="import-progress">
      <div className="import-progress-headline">{headline}</div>
      <div className="import-progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="import-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="import-progress-count dim">
        {done} of {total} steps
      </div>
      <ul className="progress-list">
        {progress.map((p) => (
          <li key={p.step} className={p.status}>
            {p.status === 'done' ? '✓' : '…'} {p.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

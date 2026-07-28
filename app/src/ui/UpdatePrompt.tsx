import { useState } from 'react';
import type { UpdateInfo } from '../updater.ts';
import { installUpdate } from '../updater.ts';

type Phase = 'prompt' | 'installing' | 'error';

/** Modal "update available" prompt with download progress; relaunches on finish. */
export function UpdatePrompt({ info, onDismiss }: { info: UpdateInfo; onDismiss: () => void }) {
  const [phase, setPhase] = useState<Phase>('prompt');
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startInstall = async () => {
    setPhase('installing');
    try {
      await installUpdate(info, (d, t) => {
        setDownloaded(d);
        setTotal(t);
      });
      // relaunch() follows a successful install; this line is never reached
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const mb = (n: number) => (n / 1e6).toFixed(1);

  return (
    <div className="modal-backdrop">
      <div className="modal update-prompt">
        <h2>Update available — v{info.version}</h2>
        {phase === 'prompt' && (
          <>
            {info.notes && <pre className="update-notes">{info.notes}</pre>}
            <div className="modal-actions">
              <button onClick={() => void startInstall()}>Update now</button>
              <button onClick={onDismiss}>Later</button>
            </div>
          </>
        )}
        {phase === 'installing' && (
          <>
            <div className="import-progress-bar">
              <div className="import-progress-fill" style={{ width: `${percent ?? 5}%` }} />
            </div>
            <p className="dim">
              {percent !== null
                ? `Downloading… ${percent}% (${mb(downloaded)} / ${mb(total ?? 0)} MB)`
                : 'Downloading…'}
            </p>
          </>
        )}
        {phase === 'error' && (
          <>
            <p className="notice err">Update failed: {error}</p>
            <div className="modal-actions">
              <button onClick={onDismiss}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

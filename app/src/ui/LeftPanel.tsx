import { usePresetStore } from '../state/preset.ts';
import { POSES } from '../viewer/poses.ts';

/** Left panel: toggle groups (radios / checkboxes) + pose, texture set & palette selectors. */
export function LeftPanel() {
  const manifest = usePresetStore((s) => s.manifest);
  const toggles = usePresetStore((s) => s.preset.toggles);
  const textureSet = usePresetStore((s) => s.preset.textureSet);
  const pose = usePresetStore((s) => s.preset.pose);
  const setExclusiveToggle = usePresetStore((s) => s.setExclusiveToggle);
  const setIndependentOption = usePresetStore((s) => s.setIndependentOption);
  const setTextureSet = usePresetStore((s) => s.setTextureSet);
  const setPose = usePresetStore((s) => s.setPose);
  const applyPalette = usePresetStore((s) => s.applyPalette);
  if (!manifest) return null;

  const palettes = manifest.palettes ?? [];

  return (
    <>
      <section className="group">
        <h2>Pose</h2>
        <select value={pose} onChange={(e) => setPose(e.target.value)}>
          {POSES.map((p) => (
            <option value={p.id} key={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </section>

      {manifest.toggleGroups.map((group) => {
        const selection = toggles[group.id];
        return (
          <section className="group" key={group.id}>
            <h2>{group.label}</h2>
            {group.options.map((option) =>
              group.mode === 'exclusive' ? (
                <label className="row" key={option.id}>
                  <input
                    type="radio"
                    name={group.id}
                    checked={selection === option.id}
                    onChange={() => setExclusiveToggle(group.id, option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ) : (
                <label className="row" key={option.id}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(selection) && selection.includes(option.id)}
                    onChange={(e) => setIndependentOption(group.id, option.id, e.target.checked)}
                  />
                  <span>{option.label}</span>
                </label>
              ),
            )}
          </section>
        );
      })}

      {manifest.textureSets.length > 0 && (
        <section className="group">
          <h2>Texture Set</h2>
          <select value={textureSet} onChange={(e) => setTextureSet(e.target.value)}>
            {manifest.textureSets.map((set) => (
              <option value={set.id} key={set.id}>
                {set.label}
              </option>
            ))}
          </select>
        </section>
      )}

      {palettes.length > 0 && (
        <section className="group">
          <h2>Palettes</h2>
          {/* action menu, not state: palettes only recolor, they are not stored in the preset */}
          <select
            value=""
            onChange={(e) => {
              const palette = palettes.find((p) => p.id === e.target.value);
              if (palette) applyPalette(palette);
            }}
          >
            <option value="" disabled>
              Apply palette…
            </option>
            {palettes.map((palette) => (
              <option value={palette.id} key={palette.id}>
                {palette.label}
              </option>
            ))}
          </select>
        </section>
      )}
    </>
  );
}

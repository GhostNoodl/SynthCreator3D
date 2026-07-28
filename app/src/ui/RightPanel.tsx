import { usePresetStore } from '../state/preset.ts';
import type { ColorRegion, SliderDef } from '../manifest/types.ts';
import { materialIdList } from '../manifest/types.ts';

/** Clothing = every material the region lists is `clothing`; anything else is Body. */
function isClothingRegion(region: ColorRegion): boolean {
  return materialIdList(region.material).every((id) => id === 'clothing');
}

/** Right panel: morph sliders (grouped, collapsible), color regions (Body / Clothing), emissive regions. */
export function RightPanel() {
  const manifest = usePresetStore((s) => s.manifest);
  const preset = usePresetStore((s) => s.preset);
  const setSlider = usePresetStore((s) => s.setSlider);
  const setColor = usePresetStore((s) => s.setColor);
  const setEmissive = usePresetStore((s) => s.setEmissive);
  if (!manifest) return null;

  // group sliders by their `group` header, preserving manifest order
  const sliderGroups: { name: string; sliders: SliderDef[] }[] = [];
  for (const slider of manifest.sliders) {
    let g = sliderGroups.find((x) => x.name === slider.group);
    if (!g) {
      g = { name: slider.group, sliders: [] };
      sliderGroups.push(g);
    }
    g.sliders.push(slider);
  }

  const bodyRegions = manifest.colorRegions.filter((r) => !isClothingRegion(r));
  const clothingRegions = manifest.colorRegions.filter(isClothingRegion);

  const colorRows = (regions: ColorRegion[]) =>
    regions.map((region) => (
      <label className="row" key={region.id}>
        <input
          type="color"
          value={preset.colors[region.id] ?? region.defaultColor}
          onChange={(e) => setColor(region.id, e.target.value)}
        />
        <span>{region.label}</span>
      </label>
    ));

  return (
    <>
      {sliderGroups.map((g, index) => (
        <details className="group" key={g.name} open={index === 0}>
          <summary>{g.name}</summary>
          {g.sliders.map((slider) => {
            const value = preset.sliders[slider.id] ?? slider.default;
            return (
              <div className="slider-row" key={slider.id}>
                <div className="slider-labels">
                  <span>{slider.label}</span>
                  <span className="dim">{value.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step={(slider.max - slider.min) / 100}
                  value={value}
                  onChange={(e) => setSlider(slider.id, Number(e.target.value))}
                />
              </div>
            );
          })}
        </details>
      ))}

      {bodyRegions.length > 0 && (
        <details className="group" open>
          <summary>Body Colors</summary>
          {colorRows(bodyRegions)}
        </details>
      )}

      {clothingRegions.length > 0 && (
        <details className="group" open>
          <summary>Clothing Colors</summary>
          {colorRows(clothingRegions)}
        </details>
      )}

      {manifest.emissiveRegions.length > 0 && (
        <section className="group">
          <h2>Glow</h2>
          {manifest.emissiveRegions.map((region) => (
            <label className="row" key={region.id}>
              <input
                type="color"
                value={preset.emissive[region.id] ?? region.defaultColor}
                onChange={(e) => setEmissive(region.id, e.target.value)}
              />
              <span>{region.label}</span>
            </label>
          ))}
        </section>
      )}
    </>
  );
}

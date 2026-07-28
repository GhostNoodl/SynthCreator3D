/**
 * Trigger a browser download for a Blob. Shared by every toolbar export
 * (preset file, screenshot, turntable video, GLB, textures, VRChat config).
 * Browser-only by nature; the module itself is side-effect free.
 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke only after the download has had a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

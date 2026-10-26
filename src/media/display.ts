/**
 * 按原图比例缩到最大 200x200（可配置）
 * 不放大；没有尺寸就返回空字符串，让客户端自己决定
 */
export function markdownImageSize(
  width: number | null,
  height: number | null,
  maxWidth = 200,
  maxHeight = 200,
): string {
  if (!width || !height || width <= 0 || height <= 0) return "";

  const scale = Math.min(maxWidth / width, maxHeight / height, 1);

  const displayWidth = Math.max(1, Math.round(width * scale));
  const displayHeight = Math.max(1, Math.round(height * scale));
  return ` #${displayWidth}px #${displayHeight}px`;
}

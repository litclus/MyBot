import sharp from "sharp";
import { logger } from "../app/logger.js";
import { config } from "../config.js";

export type CompressedImage = {
  data: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
  changed: boolean;
};

/**
 * 图片压缩：最长边 512，优先输出 webp
 * 动图保持动画；压不到目标大小再降尺寸/质量，最后退回首帧
 */
export async function compressImage(input: Buffer, mime: string): Promise<CompressedImage> {
  if (!config.IMAGE_COMPRESS) {
    return { data: input, mime, width: null, height: null, changed: false };
  }

  // GIF 不压缩，压缩后容易掉帧/不动
  if (mime === "image/gif") {
    return { data: input, mime, width: null, height: null, changed: false };
  }

  const animated = mime === "image/gif" || mime === "image/webp";

  try {
    let output = await sharp(input, { animated })
      .resize({
        width: config.IMAGE_MAX_DIMENSION,
        height: config.IMAGE_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();

    if (output.length > config.IMAGE_MAX_BYTES) {
      output = await sharp(input, { animated })
        .resize({
          width: Math.min(384, config.IMAGE_MAX_DIMENSION),
          height: Math.min(384, config.IMAGE_MAX_DIMENSION),
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 65, effort: 5 })
        .toBuffer();
    }

    if (output.length > config.IMAGE_MAX_BYTES && animated) {
      output = await sharp(input)
        .resize({
          width: Math.min(384, config.IMAGE_MAX_DIMENSION),
          height: Math.min(384, config.IMAGE_MAX_DIMENSION),
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 70 })
        .toBuffer();
    }

    if (output.length >= input.length && input.length <= config.IMAGE_MAX_BYTES) {
      return {
        data: input,
        mime,
        width: null,
        height: null,
        changed: false,
      };
    }

    const meta = await sharp(output, { animated }).metadata();
    return {
      data: output,
      mime: "image/webp",
      width: meta.width ?? null,
      height: meta.pageHeight ?? meta.height ?? null,
      changed: true,
    };
  } catch (error) {
    logger.warn("image compress failed", error);
    return { data: input, mime, width: null, height: null, changed: false };
  }
}

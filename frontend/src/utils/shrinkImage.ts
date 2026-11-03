export const IMAGE_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface ShrinkImageOptions {
  // The longest side, in pixels. Smaller images are left at their own size.
  size: number;
  // Crop to the centre square first, for a photo shown in a circle.
  square?: boolean;
  // PNG keeps a logo's transparency; JPEG keeps a photo small.
  format?: 'image/png' | 'image/jpeg';
}

/**
 * Shrinks a picked image in the browser, so what's saved is always small enough to
 * keep with the account, and is re-encoded here rather than stored as uploaded.
 */
export function shrinkImage(file: File, { size, square = false, format = 'image/png' }: ShrinkImageOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const sourceWidth = square ? Math.min(image.width, image.height) : image.width;
      const sourceHeight = square ? sourceWidth : image.height;
      const scale = Math.min(size / sourceWidth, size / sourceHeight, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('This browser couldn’t read that image.'));
        return;
      }
      if (format === 'image/jpeg') {
        // JPEG has no transparency: without this, see-through areas turn black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, (image.width - sourceWidth) / 2, (image.height - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL(format, 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file couldn’t be read as an image.'));
    };
    image.src = url;
  });
}

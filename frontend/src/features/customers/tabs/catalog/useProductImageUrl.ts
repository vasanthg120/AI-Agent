import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { productsService } from '@/services/productsService';

// Product images live behind JwtAuthGuard (GET /crm/products/:id/image), so
// a plain <img src> can't authenticate — fetched as a blob and turned into
// an object URL, same pattern as CloudPreviewModal.tsx's inline preview.
export function useProductImageUrl(id: string, imageFileId: string | undefined): string | undefined {
  const { data: blob } = useQuery({
    queryKey: ['product-image', id],
    queryFn: () => productsService.getImageBlob(id),
    enabled: !!imageFileId,
    staleTime: 5 * 60_000,
  });
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return url;
}

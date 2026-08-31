import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { billingService } from '@/services/billingService';
import { useUiStore } from '@/stores/uiStore';

export interface BillingThemeResult {
  style: CSSProperties;
  logoUrl?: string;
}

// Fetches the admin-configured BillingTheme once and returns it as a scoped
// inline style object to spread onto the pricing page's wrapping element —
// deliberately NEVER written to document.documentElement/:root (see
// frontend/src/styles/variables.css's own token set), so a misconfigured or
// never-touched theme can only ever affect the billing/pricing surface, not
// the rest of the app. Any key the admin hasn't set is simply absent from
// the returned style object, which means the page's CSS module fallback
// values (referencing the same --billing-* custom property names with a
// var(..., fallback) or a plain static value) apply automatically — no
// explicit "is this configured?" branching needed at the call site.
export function useBillingTheme(): BillingThemeResult {
  const themeMode = useUiStore((state) => state.theme);
  const [style, setStyle] = useState<CSSProperties>({});
  const [logoUrl, setLogoUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    billingService
      .getTheme()
      .then((theme) => {
        if (cancelled) return;
        const tokens = themeMode === 'dark' ? { ...theme.tokens, ...theme.darkTokens } : theme.tokens;
        setStyle(tokens as CSSProperties);
        setLogoUrl(theme.logoUrl);
      })
      .catch(() => {
        // Fail silently — the pricing page's own CSS already defines
        // sensible fallback values for every token it references, so a
        // failed/unconfigured theme fetch just means "use those."
      });
    return () => {
      cancelled = true;
    };
  }, [themeMode]);

  return { style, logoUrl };
}

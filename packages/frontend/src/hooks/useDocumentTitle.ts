import { useEffect } from 'react';

const DEFAULT_TITLE = 'Spill | Free therapy';

/** "Sign up | Spill"; the site default when no page title is given. */
export function formatDocumentTitle(title?: string | null): string {
  const t = title?.trim();
  return t ? `${t} | Spill` : DEFAULT_TITLE;
}

const ROBOTS_META_ID = 'route-robots-meta';

/**
 * Per-route document title (every route used to share one), and an
 * optional `noindex` robots meta for pages that must never be indexed
 * (/admin, /feedback). Both are undone when the page unmounts.
 */
export function useDocumentTitle(title?: string | null, options: { noindex?: boolean } = {}): void {
  const { noindex = false } = options;

  useEffect(() => {
    const previous = document.title;
    document.title = formatDocumentTitle(title);
    return () => {
      document.title = previous;
    };
  }, [title]);

  useEffect(() => {
    if (!noindex) return;
    let meta = document.getElementById(ROBOTS_META_ID) as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.id = ROBOTS_META_ID;
      meta.name = 'robots';
      document.head.appendChild(meta);
    }
    meta.content = 'noindex, nofollow';
    return () => {
      meta?.remove();
    };
  }, [noindex]);
}

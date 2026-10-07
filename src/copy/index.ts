import type { MarketingLocale } from '@utils/locale';
import { en } from './en';

/**
 * Copy module: single typed table of UI strings.
 * `Copy` is the shape of the English table.
 * Components read the current table from `Astro.locals.copy`.
 */
export type Copy = typeof en;

const tables: Record<MarketingLocale, Copy> = { en };

export function getCopy(locale: MarketingLocale): Copy {
  return tables[locale];
}

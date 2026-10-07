export const LANGS = ['zh', 'en'] as const
export type Lang = (typeof LANGS)[number]

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value)
}

/** The language a visitor switches to from `lang`. */
export function otherLang(lang: Lang): Lang {
  return lang === 'zh' ? 'en' : 'zh'
}

/** Pages that exist in both languages. */
export type PageId = 'home' | 'work'

/**
 * Public URL of a page in a language. Chinese is the default and lives at
 * the root; English lives under the `/en` prefix.
 */
export function pagePath(lang: Lang, page: PageId): string {
  if (page === 'work') return lang === 'zh' ? '/work' : '/en/work'
  return lang === 'zh' ? '/' : '/en/'
}

import { TIMELINE_ZH, TIMELINE_EN, STUDY_ZH, STUDY_EN, LINKS } from '@/lib/constants'
import { CONTENT } from './content'
import type { Lang } from './routes'

export { LANGS, isLang, otherLang, pagePath } from './routes'
export type { Lang, PageId } from './routes'

/** All UI strings for a language. Content lives in `./content.ts`. */
export function t(lang: Lang) {
  return CONTENT[lang]
}

/** Timeline entries per language (same shape, translated content). */
export const experienceByLang = { zh: TIMELINE_ZH, en: TIMELINE_EN } as const

/** Currently-learning entries per language. */
export const studiesByLang = { zh: STUDY_ZH, en: STUDY_EN } as const

export type ProjectLink = { label: string; href: string; live?: boolean }

/** Project links shown in the "Projects" section — identical across languages. */
export const PROJECT_LINKS: ProjectLink[] = [
  {
    label: 'muse-playbook',
    href: 'https://github.com/styrigx/muse-playbook',
  },
  {
    label: 'textbook-playbook',
    href: 'https://github.com/styrigx/textbook-playbook',
  },
  {
    label: 'muse-invite-board',
    href: 'https://github.com/styrigx/muse-invite-board',
    live: true,
  },
]

export { LINKS }

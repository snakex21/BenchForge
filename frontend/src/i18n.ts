import { useMemo, useEffect, useState, useCallback } from 'react'
import { useUIStore } from '@/store/uiStore'
import pl from './i18n/locales/pl.json'
import en from './i18n/locales/en.json'

export type Language = 'pl' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'uk' | 'cs' | 'nl' | 'tr' | 'ja' | 'ru' | 'zh' | 'zh-TW' | 'ko' | 'id' | 'vi' | 'th' | 'hi' | 'ar' | 'he' | 'el' | 'sv' | 'no' | 'da' | 'fi' | 'hu' | 'ro' | 'bg' | 'hr' | 'sk' | 'sl' | 'lt' | 'lv' | 'et' | 'sr' | 'fa' | 'ur' | 'ms' | 'fil' | 'bn'

export const LANGUAGE_OPTIONS: Array<{ id: Language; label: string; nativeLabel: string; flag: string; locale: string }> = [
  { id: 'pl', label: 'Polish', nativeLabel: 'Polski', flag: '🇵🇱', locale: 'pl-PL' },
  { id: 'en', label: 'English', nativeLabel: 'English', flag: '🇬🇧', locale: 'en-US' },
  { id: 'de', label: 'German', nativeLabel: 'Deutsch', flag: '🇩🇪', locale: 'de-DE' },
  { id: 'es', label: 'Spanish', nativeLabel: 'Español', flag: '🇪🇸', locale: 'es-ES' },
  { id: 'fr', label: 'French', nativeLabel: 'Français', flag: '🇫🇷', locale: 'fr-FR' },
  { id: 'it', label: 'Italian', nativeLabel: 'Italiano', flag: '🇮🇹', locale: 'it-IT' },
  { id: 'pt', label: 'Portuguese', nativeLabel: 'Português', flag: '🇵🇹', locale: 'pt-PT' },
  { id: 'uk', label: 'Ukrainian', nativeLabel: 'Українська', flag: '🇺🇦', locale: 'uk-UA' },
  { id: 'cs', label: 'Czech', nativeLabel: 'Čeština', flag: '🇨🇿', locale: 'cs-CZ' },
  { id: 'nl', label: 'Dutch', nativeLabel: 'Nederlands', flag: '🇳🇱', locale: 'nl-NL' },
  { id: 'tr', label: 'Turkish', nativeLabel: 'Türkçe', flag: '🇹🇷', locale: 'tr-TR' },
  { id: 'ja', label: 'Japanese', nativeLabel: '日本語', flag: '🇯🇵', locale: 'ja-JP' },
  { id: 'ru', label: 'Russian', nativeLabel: 'Русский', flag: '🇷🇺', locale: 'ru-RU' },
  { id: 'zh', label: 'Chinese Simplified', nativeLabel: '简体中文', flag: '🇨🇳', locale: 'zh-CN' },
  { id: 'zh-TW', label: 'Chinese Traditional', nativeLabel: '繁體中文', flag: '🇹🇼', locale: 'zh-TW' },
  { id: 'ko', label: 'Korean', nativeLabel: '한국어', flag: '🇰🇷', locale: 'ko-KR' },
  { id: 'id', label: 'Indonesian', nativeLabel: 'Bahasa Indonesia', flag: '🇮🇩', locale: 'id-ID' },
  { id: 'vi', label: 'Vietnamese', nativeLabel: 'Tiếng Việt', flag: '🇻🇳', locale: 'vi-VN' },
  { id: 'th', label: 'Thai', nativeLabel: 'ไทย', flag: '🇹🇭', locale: 'th-TH' },
  { id: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी', flag: '🇮🇳', locale: 'hi-IN' },
  { id: 'ar', label: 'Arabic', nativeLabel: 'العربية', flag: '🇸🇦', locale: 'ar-SA' },
  { id: 'he', label: 'Hebrew', nativeLabel: 'עברית', flag: '🇮🇱', locale: 'he-IL' },
  { id: 'el', label: 'Greek', nativeLabel: 'Ελληνικά', flag: '🇬🇷', locale: 'el-GR' },
  { id: 'sv', label: 'Swedish', nativeLabel: 'Svenska', flag: '🇸🇪', locale: 'sv-SE' },
  { id: 'no', label: 'Norwegian', nativeLabel: 'Norsk', flag: '🇳🇴', locale: 'nb-NO' },
  { id: 'da', label: 'Danish', nativeLabel: 'Dansk', flag: '🇩🇰', locale: 'da-DK' },
  { id: 'fi', label: 'Finnish', nativeLabel: 'Suomi', flag: '🇫🇮', locale: 'fi-FI' },
  { id: 'hu', label: 'Hungarian', nativeLabel: 'Magyar', flag: '🇭🇺', locale: 'hu-HU' },
  { id: 'ro', label: 'Romanian', nativeLabel: 'Română', flag: '🇷🇴', locale: 'ro-RO' },
  { id: 'bg', label: 'Bulgarian', nativeLabel: 'Български', flag: '🇧🇬', locale: 'bg-BG' },
  { id: 'hr', label: 'Croatian', nativeLabel: 'Hrvatski', flag: '🇭🇷', locale: 'hr-HR' },
  { id: 'sk', label: 'Slovak', nativeLabel: 'Slovenčina', flag: '🇸🇰', locale: 'sk-SK' },
  { id: 'sl', label: 'Slovenian', nativeLabel: 'Slovenščina', flag: '🇸🇮', locale: 'sl-SI' },
  { id: 'lt', label: 'Lithuanian', nativeLabel: 'Lietuvių', flag: '🇱🇹', locale: 'lt-LT' },
  { id: 'lv', label: 'Latvian', nativeLabel: 'Latviešu', flag: '🇱🇻', locale: 'lv-LV' },
  { id: 'et', label: 'Estonian', nativeLabel: 'Eesti', flag: '🇪🇪', locale: 'et-EE' },
  { id: 'sr', label: 'Serbian', nativeLabel: 'Српски', flag: '🇷🇸', locale: 'sr-RS' },
  { id: 'fa', label: 'Persian', nativeLabel: 'فارسی', flag: '🇮🇷', locale: 'fa-IR' },
  { id: 'ur', label: 'Urdu', nativeLabel: 'اردو', flag: '🇵🇰', locale: 'ur-PK' },
  { id: 'ms', label: 'Malay', nativeLabel: 'Bahasa Melayu', flag: '🇲🇾', locale: 'ms-MY' },
  { id: 'fil', label: 'Filipino', nativeLabel: 'Filipino', flag: '🇵🇭', locale: 'fil-PH' },
  { id: 'bn', label: 'Bengali', nativeLabel: 'বাংলা', flag: '🇧🇩', locale: 'bn-BD' },
]

export const getLocale = (language: Language) => LANGUAGE_OPTIONS.find((item) => item.id === language)?.locale || 'pl-PL'

type BaseDictionary = typeof pl
export type TranslationKey = keyof BaseDictionary
type Dictionary = Record<TranslationKey, string>
type PartialDictionary = Partial<Dictionary>
type TranslationParams = Record<string, string | number | null | undefined>

// PL and EN are always loaded (base + fallback)
const plDictionary = pl as Dictionary
const enDictionary = en as PartialDictionary

// Lazy loaders for other languages
const localeLoaders: Record<string, () => Promise<{ default: PartialDictionary }>> = {
  de: () => import('./i18n/locales/de.json'),
  es: () => import('./i18n/locales/es.json'),
  fr: () => import('./i18n/locales/fr.json'),
  it: () => import('./i18n/locales/it.json'),
  pt: () => import('./i18n/locales/pt.json'),
  uk: () => import('./i18n/locales/uk.json'),
  cs: () => import('./i18n/locales/cs.json'),
  nl: () => import('./i18n/locales/nl.json'),
  tr: () => import('./i18n/locales/tr.json'),
  ja: () => import('./i18n/locales/ja.json'),
  ru: () => import('./i18n/locales/ru.json'),
  zh: () => import('./i18n/locales/zh.json'),
  'zh-TW': () => import('./i18n/locales/zh-TW.json'),
  ko: () => import('./i18n/locales/ko.json'),
  id: () => import('./i18n/locales/id.json'),
  vi: () => import('./i18n/locales/vi.json'),
  th: () => import('./i18n/locales/th.json'),
  hi: () => import('./i18n/locales/hi.json'),
  ar: () => import('./i18n/locales/ar.json'),
  he: () => import('./i18n/locales/he.json'),
  el: () => import('./i18n/locales/el.json'),
  sv: () => import('./i18n/locales/sv.json'),
  no: () => import('./i18n/locales/no.json'),
  da: () => import('./i18n/locales/da.json'),
  fi: () => import('./i18n/locales/fi.json'),
  hu: () => import('./i18n/locales/hu.json'),
  ro: () => import('./i18n/locales/ro.json'),
  bg: () => import('./i18n/locales/bg.json'),
  hr: () => import('./i18n/locales/hr.json'),
  sk: () => import('./i18n/locales/sk.json'),
  sl: () => import('./i18n/locales/sl.json'),
  lt: () => import('./i18n/locales/lt.json'),
  lv: () => import('./i18n/locales/lv.json'),
  et: () => import('./i18n/locales/et.json'),
  sr: () => import('./i18n/locales/sr.json'),
  fa: () => import('./i18n/locales/fa.json'),
  ur: () => import('./i18n/locales/ur.json'),
  ms: () => import('./i18n/locales/ms.json'),
  fil: () => import('./i18n/locales/fil.json'),
  bn: () => import('./i18n/locales/bn.json'),
}

// Cache for loaded dictionaries
const loadedDictionaries = new Map<Language, PartialDictionary>()

// Get dictionary for a language (from cache or static)
const getDictionary = (language: Language): PartialDictionary => {
  if (language === 'pl') return plDictionary
  if (language === 'en') return enDictionary
  return loadedDictionaries.get(language) ?? enDictionary
}

// Load a language dynamically
export const loadLanguage = async (language: Language): Promise<PartialDictionary> => {
  if (language === 'pl') return plDictionary
  if (language === 'en') return enDictionary
  
  const cached = loadedDictionaries.get(language)
  if (cached) return cached
  
  const loader = localeLoaders[language]
  if (!loader) return enDictionary
  
  try {
    const module = await loader()
    const dictionary = { ...enDictionary, ...module.default }
    loadedDictionaries.set(language, dictionary)
    return dictionary
  } catch {
    return enDictionary
  }
}

const interpolate = (template: string, params?: TranslationParams) => {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''))
}

export const translate = (language: Language, key: TranslationKey, params?: TranslationParams) => {
  const dictionary = getDictionary(language)
  const template = dictionary[key] ?? enDictionary[key] ?? plDictionary[key] ?? key
  return interpolate(template, params)
}

export const useTranslation = () => {
  const language = useUIStore((state) => state.language)
  const [loaded, setLoaded] = useState(false)

  // Load language on mount and when language changes
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    
    loadLanguage(language).then(() => {
      if (!cancelled) setLoaded(true)
    })
    
    return () => { cancelled = true }
  }, [language])

  const t = useCallback((key: TranslationKey, params?: TranslationParams) => {
    return translate(language, key, params)
  }, [language])

  return useMemo(() => ({
    language,
    locale: getLocale(language),
    t,
    loaded,
  }), [language, t, loaded])
}

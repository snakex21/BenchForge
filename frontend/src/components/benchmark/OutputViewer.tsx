import React, { useMemo } from 'react'
import { MazeViewer } from './MazeViewer'
import type { OutputType } from '@/types'
import type { MazeVerifyResult } from '@/utils/mazeVerifier'
import { useTranslation } from '@/i18n'

// Lazy logo loader — cache loaded logos to avoid re-importing
const logoCache = new Map<string, string>()

const LOGO_FILES: Record<string, string> = {
  python: 'python.svg',
  javascript: 'javascript.svg',
  typescript: 'typescript.svg',
  html5: 'html5.svg',
  css3: 'css3.svg',
  json: 'json.svg',
  bash: 'bash.svg',
  powershell: 'powershell.svg',
  java: 'java.svg',
  c: 'c.svg',
  cplusplus: 'cplusplus.svg',
  csharp: 'csharp.svg',
  go: 'go.svg',
  rust: 'rust.svg',
  php: 'php.svg',
  ruby: 'ruby.svg',
  markdown: 'markdown.svg',
  swift: 'swift.svg',
  dart: 'dart.svg',
  kotlin: 'kotlin.svg',
  scala: 'scala.svg',
  r: 'r.svg',
  lua: 'lua.svg',
  perl: 'perl.svg',
  haskell: 'haskell.svg',
  elixir: 'elixir.svg',
  erlang: 'erlang.svg',
  clojure: 'clojure.svg',
  groovy: 'groovy.svg',
  objectivec: 'objectivec.svg',
  julia: 'julia.svg',
  matlab: 'matlab.svg',
  zig: 'zig.svg',
  solidity: 'solidity.svg',
  docker: 'docker.svg',
  terraform: 'terraform.svg',
  graphql: 'graphql.svg',
}

const getLogoUrl = (logoKey: string): string | undefined => {
  if (!logoKey) return undefined
  const cached = logoCache.get(logoKey)
  if (cached) return cached

  const fileName = LOGO_FILES[logoKey]
  if (!fileName) return undefined

  // Start async load — will be available on next render
  // Use Vite's glob import for reliable dynamic loading
  const logoModules = import.meta.glob('@/assets/lang-logos/*.svg', { eager: false, query: '?url', import: 'default' })
  const matchingPath = Object.keys(logoModules).find((p) => p.endsWith(`/${fileName}`))
  if (matchingPath) {
    logoModules[matchingPath]().then((url) => {
      logoCache.set(logoKey, url as string)
    }).catch(() => { /* ignore missing logos */ })
  }

  return undefined
}

interface OutputViewerProps {
  content: string
  outputType: Exclude<OutputType, 'text'>
  imageBase64?: string | null
  verifyResult?: MazeVerifyResult
  saveFileName?: string
}

const EXTENSION_MAP: Record<string, string> = {
  html: 'html',
  svg: 'svg',
  markdown: 'md',
  maze: 'txt',
  text: 'txt',
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const inlineMarkdown = (value: string) => value
  .replace(/`([^`]+)`/g, '<code class="rounded bg-slate-800 px-1 py-0.5 text-cyan-200">$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>')

const LANGUAGE_META: Record<string, { label: string; icon: string; className: string; logoKey?: string }> = {
  js: { label: 'JavaScript', icon: 'JS', logoKey: 'javascript', className: 'border-yellow-400/40 bg-yellow-400/10 text-yellow-200' },
  javascript: { label: 'JavaScript', icon: 'JS', logoKey: 'javascript', className: 'border-yellow-400/40 bg-yellow-400/10 text-yellow-200' },
  ts: { label: 'TypeScript', icon: 'TS', logoKey: 'typescript', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  typescript: { label: 'TypeScript', icon: 'TS', logoKey: 'typescript', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  tsx: { label: 'TSX', icon: 'TSX', logoKey: 'typescript', className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  jsx: { label: 'JSX', icon: 'JSX', logoKey: 'javascript', className: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' },
  py: { label: 'Python', icon: 'PY', logoKey: 'python', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' },
  python: { label: 'Python', icon: 'PY', logoKey: 'python', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' },
  html: { label: 'HTML', icon: 'HTML', logoKey: 'html5', className: 'border-orange-400/40 bg-orange-400/10 text-orange-200' },
  css: { label: 'CSS', icon: 'CSS', logoKey: 'css3', className: 'border-indigo-400/40 bg-indigo-400/10 text-indigo-200' },
  json: { label: 'JSON', icon: '{}', logoKey: 'json', className: 'border-lime-400/40 bg-lime-400/10 text-lime-200' },
  sql: { label: 'SQL', icon: 'DB', className: 'border-purple-400/40 bg-purple-400/10 text-purple-200' },
  bash: { label: 'Bash', icon: '$', logoKey: 'bash', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  sh: { label: 'Shell', icon: '$', logoKey: 'bash', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  powershell: { label: 'PowerShell', icon: 'PS', logoKey: 'powershell', className: 'border-blue-500/40 bg-blue-500/10 text-blue-200' },
  java: { label: 'Java', icon: 'JAVA', logoKey: 'java', className: 'border-red-400/40 bg-red-400/10 text-red-200' },
  c: { label: 'C', icon: 'C', logoKey: 'c', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  cpp: { label: 'C++', icon: 'C++', logoKey: 'cplusplus', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  cplusplus: { label: 'C++', icon: 'C++', logoKey: 'cplusplus', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  cs: { label: 'C#', icon: 'C#', logoKey: 'csharp', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  csharp: { label: 'C#', icon: 'C#', logoKey: 'csharp', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  go: { label: 'Go', icon: 'GO', logoKey: 'go', className: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' },
  rust: { label: 'Rust', icon: 'RS', logoKey: 'rust', className: 'border-orange-500/40 bg-orange-500/10 text-orange-200' },
  php: { label: 'PHP', icon: 'PHP', logoKey: 'php', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  ruby: { label: 'Ruby', icon: 'RB', logoKey: 'ruby', className: 'border-red-400/40 bg-red-400/10 text-red-200' },
  markdown: { label: 'Markdown', icon: 'MD', logoKey: 'markdown', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  md: { label: 'Markdown', icon: 'MD', logoKey: 'markdown', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  swift: { label: 'Swift', icon: 'SW', logoKey: 'swift', className: 'border-orange-400/40 bg-orange-400/10 text-orange-200' },
  dart: { label: 'Dart', icon: 'DART', logoKey: 'dart', className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  kotlin: { label: 'Kotlin', icon: 'KT', logoKey: 'kotlin', className: 'border-purple-400/40 bg-purple-400/10 text-purple-200' },
  kt: { label: 'Kotlin', icon: 'KT', logoKey: 'kotlin', className: 'border-purple-400/40 bg-purple-400/10 text-purple-200' },
  scala: { label: 'Scala', icon: 'SC', logoKey: 'scala', className: 'border-red-500/40 bg-red-500/10 text-red-200' },
  r: { label: 'R', icon: 'R', logoKey: 'r', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  lua: { label: 'Lua', icon: 'LUA', logoKey: 'lua', className: 'border-blue-500/40 bg-blue-500/10 text-blue-200' },
  perl: { label: 'Perl', icon: 'PL', logoKey: 'perl', className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  pl: { label: 'Perl', icon: 'PL', logoKey: 'perl', className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  haskell: { label: 'Haskell', icon: 'HS', logoKey: 'haskell', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  hs: { label: 'Haskell', icon: 'HS', logoKey: 'haskell', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  elixir: { label: 'Elixir', icon: 'EX', logoKey: 'elixir', className: 'border-purple-400/40 bg-purple-400/10 text-purple-200' },
  ex: { label: 'Elixir', icon: 'EX', logoKey: 'elixir', className: 'border-purple-400/40 bg-purple-400/10 text-purple-200' },
  erlang: { label: 'Erlang', icon: 'ERL', logoKey: 'erlang', className: 'border-red-400/40 bg-red-400/10 text-red-200' },
  erl: { label: 'Erlang', icon: 'ERL', logoKey: 'erlang', className: 'border-red-400/40 bg-red-400/10 text-red-200' },
  clojure: { label: 'Clojure', icon: 'CLJ', logoKey: 'clojure', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' },
  clj: { label: 'Clojure', icon: 'CLJ', logoKey: 'clojure', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' },
  groovy: { label: 'Groovy', icon: 'GVY', logoKey: 'groovy', className: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' },
  objectivec: { label: 'Objective-C', icon: 'OBJ-C', logoKey: 'objectivec', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  objc: { label: 'Objective-C', icon: 'OBJ-C', logoKey: 'objectivec', className: 'border-blue-400/40 bg-blue-400/10 text-blue-200' },
  julia: { label: 'Julia', icon: 'JL', logoKey: 'julia', className: 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200' },
  jl: { label: 'Julia', icon: 'JL', logoKey: 'julia', className: 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200' },
  matlab: { label: 'MATLAB', icon: 'MAT', logoKey: 'matlab', className: 'border-orange-400/40 bg-orange-400/10 text-orange-200' },
  zig: { label: 'Zig', icon: 'ZIG', logoKey: 'zig', className: 'border-yellow-400/40 bg-yellow-400/10 text-yellow-200' },
  solidity: { label: 'Solidity', icon: 'SOL', logoKey: 'solidity', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  sol: { label: 'Solidity', icon: 'SOL', logoKey: 'solidity', className: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
  dockerfile: { label: 'Dockerfile', icon: 'DOCKER', logoKey: 'docker', className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  docker: { label: 'Docker', icon: 'DOCKER', logoKey: 'docker', className: 'border-sky-400/40 bg-sky-400/10 text-sky-200' },
  hcl: { label: 'Terraform', icon: 'HCL', logoKey: 'terraform', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  terraform: { label: 'Terraform', icon: 'TF', logoKey: 'terraform', className: 'border-violet-400/40 bg-violet-400/10 text-violet-200' },
  graphql: { label: 'GraphQL', icon: 'GQL', logoKey: 'graphql', className: 'border-pink-400/40 bg-pink-400/10 text-pink-200' },
  gql: { label: 'GraphQL', icon: 'GQL', logoKey: 'graphql', className: 'border-pink-400/40 bg-pink-400/10 text-pink-200' },
}

const normalizeLanguage = (value: string) => String(value || '').trim().toLowerCase().replace(/^language-/, '').split(/\s+/)[0]

const KEYWORDS: Record<string, string[]> = {
  python: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'if', 'import', 'in', 'is', 'lambda', 'None', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield'],
  py: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'if', 'import', 'in', 'is', 'lambda', 'None', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield'],
  javascript: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'let', 'new', 'null', 'return', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'while'],
  js: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'let', 'new', 'null', 'return', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'while'],
  typescript: ['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'interface', 'let', 'new', 'null', 'private', 'protected', 'public', 'readonly', 'return', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'while'],
  ts: ['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'interface', 'let', 'new', 'null', 'private', 'protected', 'public', 'readonly', 'return', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'while'],
  java: ['abstract', 'boolean', 'break', 'case', 'catch', 'class', 'continue', 'else', 'extends', 'false', 'final', 'finally', 'for', 'if', 'implements', 'import', 'interface', 'new', 'null', 'private', 'protected', 'public', 'return', 'static', 'switch', 'this', 'throw', 'true', 'try', 'void', 'while'],
  c: ['break', 'case', 'char', 'const', 'continue', 'default', 'double', 'else', 'enum', 'float', 'for', 'if', 'int', 'long', 'return', 'short', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'void', 'while'],
  cpp: ['auto', 'bool', 'break', 'case', 'class', 'const', 'continue', 'default', 'double', 'else', 'enum', 'false', 'float', 'for', 'if', 'int', 'long', 'namespace', 'new', 'nullptr', 'private', 'protected', 'public', 'return', 'short', 'static', 'struct', 'switch', 'template', 'true', 'typedef', 'void', 'while'],
  swift: ['as', 'break', 'case', 'catch', 'class', 'continue', 'default', 'defer', 'do', 'else', 'enum', 'extension', 'false', 'for', 'func', 'guard', 'if', 'import', 'in', 'let', 'nil', 'protocol', 'return', 'self', 'struct', 'switch', 'throw', 'true', 'try', 'var', 'while'],
  dart: ['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'import', 'in', 'is', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'var', 'void', 'while'],
  kotlin: ['as', 'break', 'class', 'continue', 'data', 'do', 'else', 'false', 'for', 'fun', 'if', 'import', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'sealed', 'super', 'this', 'throw', 'true', 'try', 'val', 'var', 'when', 'while'],
  kt: ['as', 'break', 'class', 'continue', 'data', 'do', 'else', 'false', 'for', 'fun', 'if', 'import', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'sealed', 'super', 'this', 'throw', 'true', 'try', 'val', 'var', 'when', 'while'],
  scala: ['abstract', 'case', 'catch', 'class', 'def', 'do', 'else', 'extends', 'false', 'final', 'finally', 'for', 'if', 'import', 'implicit', 'lazy', 'match', 'new', 'null', 'object', 'override', 'package', 'private', 'protected', 'return', 'sealed', 'super', 'this', 'throw', 'trait', 'true', 'try', 'val', 'var', 'while', 'with', 'yield'],
  go: ['break', 'case', 'chan', 'const', 'continue', 'defer', 'else', 'fallthrough', 'false', 'for', 'func', 'go', 'if', 'import', 'interface', 'map', 'nil', 'package', 'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var'],
  rust: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'],
  php: ['abstract', 'and', 'array', 'as', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'echo', 'else', 'elseif', 'extends', 'false', 'final', 'finally', 'foreach', 'function', 'if', 'implements', 'interface', 'namespace', 'new', 'null', 'private', 'protected', 'public', 'return', 'static', 'switch', 'throw', 'trait', 'true', 'try', 'use', 'var', 'while'],
  ruby: ['begin', 'break', 'case', 'class', 'def', 'do', 'else', 'elsif', 'end', 'false', 'for', 'if', 'module', 'next', 'nil', 'return', 'self', 'super', 'then', 'true', 'unless', 'until', 'when', 'while', 'yield'],
  lua: ['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'],
  r: ['break', 'else', 'FALSE', 'for', 'function', 'if', 'in', 'Inf', 'NA', 'NaN', 'next', 'NULL', 'repeat', 'return', 'TRUE', 'while'],
}

const highlightEscapedCode = (value: string, language: string) => {
  const normalized = normalizeLanguage(language)
  const lang = normalized === 'tsx' ? 'typescript' : normalized === 'jsx' ? 'javascript' : normalized

  if (['html', 'xml', 'svg'].includes(lang)) {
    return value
      .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="text-orange-300">$2</span>')
      .replace(/([\w:-]+)=(&quot;[^&]*?&quot;|"[^"]*"|'[^']*')/g, '<span class="text-sky-300">$1</span>=<span class="text-emerald-300">$2</span>')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="text-slate-500 italic">$1</span>')
  }

  if (lang === 'json') {
    let json = value
    const placeholders: Array<{ token: string; value: string }> = []
    const protectJson = (match: string, className: string) => {
      const token = `\uE000${String.fromCharCode(0xE100 + placeholders.length)}\uE001`
      placeholders.push({ token, value: `<span class="${className}">${match}</span>` })
      return token
    }
    json = json.replace(/("[^"\n]*")(\s*:)/g, (_match, key, colon) => `${protectJson(key, 'text-sky-300')}${colon}`)
    json = json.replace(/(:\s*)("[^"\n]*")/g, (_match, prefix, val) => `${prefix}${protectJson(val, 'text-emerald-300')}`)
    json = json.replace(/\b(true|false|null)\b/g, (match) => protectJson(match, 'text-violet-300'))
    json = json.replace(/\b\d+(?:\.\d+)?\b/g, (match) => protectJson(match, 'text-amber-300'))
    placeholders.forEach(({ token, value: replacement }) => {
      json = json.split(token).join(replacement)
    })
    return json
  }

  let highlighted = value
  const placeholders: Array<{ token: string; value: string }> = []
  const protect = (match: string, className: string) => {
    const token = `\uE000${String.fromCharCode(0xE100 + placeholders.length)}\uE001`
    placeholders.push({ token, value: `<span class="${className}">${match}</span>` })
    return token
  }

  const commentPattern = ['python', 'py', 'bash', 'sh', 'powershell'].includes(lang) ? /(#.*$)/gm : /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm
  highlighted = highlighted.replace(commentPattern, (match) => protect(match, 'text-slate-500 italic'))
  highlighted = highlighted.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, (match) => protect(match, 'text-emerald-300'))

  const words = KEYWORDS[lang] || []
  if (words.length) {
    const keywordPattern = new RegExp(`\\b(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')
    highlighted = highlighted.replace(keywordPattern, (match) => protect(match, 'text-violet-300 font-semibold'))
  }

  highlighted = highlighted.replace(/\b\d+(?:\.\d+)?\b/g, (match) => protect(match, 'text-amber-300'))
  placeholders.forEach(({ token, value: replacement }) => {
    highlighted = highlighted.split(token).join(replacement)
  })
  return highlighted
}

const renderCodeBlock = (codeLines: string[], language: string, t?: (key: any, params?: Record<string, string | number | null | undefined>) => string) => {
  const normalized = normalizeLanguage(language)
  const meta = LANGUAGE_META[normalized] || { label: normalized ? normalized.toUpperCase() : (t?.('output.codeFallback') || 'Code'), icon: '&lt;/&gt;', className: 'border-slate-500/40 bg-slate-500/10 text-slate-200' }
  const logoUrl = meta.logoKey ? getLogoUrl(meta.logoKey) : undefined
  const mark = logoUrl
    ? `<span class="inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded bg-white/95 p-0.5"><img src="${logoUrl}" alt="" class="h-full w-full object-contain" /></span>`
    : `<span>${meta.icon}</span>`
  const highlightedCode = highlightEscapedCode(codeLines.join('\n'), normalized)
  return `<div class="my-3 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
    <div class="flex items-center justify-between border-b border-slate-800 bg-slate-900/70 px-3 py-2">
      <span class="inline-flex items-center gap-2 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${meta.className}">${mark}<span>${meta.label}</span></span>
      <span class="text-[10px] uppercase tracking-wide text-slate-600">code</span>
    </div>
    <pre class="overflow-auto p-3 text-sm leading-relaxed"><code>${highlightedCode}</code></pre>
  </div>`
}

function markdownToHtml(markdown: string, t?: (key: any, params?: Record<string, string | number | null | undefined>) => string) {
  const lines = escapeHtml(markdown).split(/\r?\n/)
  const html: string[] = []
  let inCode = false
  let listType: 'ul' | 'ol' | null = null
  let codeLines: string[] = []
  let codeLanguage = ''

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  const openList = (type: 'ul' | 'ol') => {
    if (listType === type) return
    closeList()
    html.push(type === 'ul'
      ? '<ul class="my-2 list-disc space-y-1 pl-5">'
      : '<ol class="my-2 list-decimal space-y-1 pl-5">')
    listType = type
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCode) {
        html.push(renderCodeBlock(codeLines, codeLanguage, t))
        codeLines = []
        codeLanguage = ''
        inCode = false
      } else {
        closeList()
        inCode = true
        codeLanguage = trimmed.replace(/^```+/, '').trim()
      }
      continue
    }

    if (inCode) {
      codeLines.push(line)
      continue
    }

    if (!trimmed) {
      closeList()
      continue
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed) || /^___+$/.test(trimmed)) {
      closeList()
      html.push('<hr class="my-4 border-slate-700/70" />')
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      const text = inlineMarkdown(heading[2])
      const classes: Record<number, string> = {
        1: 'mt-5 mb-3 text-2xl font-bold text-slate-50',
        2: 'mt-5 mb-2 text-xl font-bold text-slate-100',
        3: 'mt-4 mb-2 text-lg font-semibold text-indigo-100',
        4: 'mt-3 mb-2 text-base font-semibold text-slate-100',
        5: 'mt-3 mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300',
        6: 'mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400',
      }
      html.push(`<h${level} class="${classes[level]}">${text}</h${level}>`)
      continue
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/)
    if (unordered) {
      openList('ul')
      html.push(`<li>${inlineMarkdown(unordered[1])}</li>`)
      continue
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/)
    if (ordered) {
      openList('ol')
      html.push(`<li>${inlineMarkdown(ordered[1])}</li>`)
      continue
    }

    const quote = trimmed.match(/^&gt;\s?(.+)$/)
    if (quote) {
      closeList()
      html.push(`<blockquote class="my-2 border-l-4 border-indigo-500/50 bg-indigo-500/10 py-2 pl-3 text-slate-300">${inlineMarkdown(quote[1])}</blockquote>`)
      continue
    }

    closeList()
    html.push(`<p class="my-2 leading-relaxed">${inlineMarkdown(trimmed)}</p>`)
  }

  closeList()
  if (inCode) {
    html.push(renderCodeBlock(codeLines, codeLanguage, t))
  }

  return html.join('\n')
}

export const MarkdownViewer: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => {
  const { t } = useTranslation()
  const markdownHtml = useMemo(() => markdownToHtml(content, t), [content, t])
  return <div className={`prose prose-invert max-w-none text-sm text-slate-200 ${className}`} dangerouslySetInnerHTML={{ __html: markdownHtml }} />
}

export const SaveResponseButton: React.FC<{ content: string; outputType?: OutputType; fileName?: string }> = ({ content, outputType, fileName }) => {
  const { t } = useTranslation()
  if (!content?.trim()) return null
  const ext = EXTENSION_MAP[outputType || 'text'] || 'txt'
  const defaultFileName = fileName || `benchforge-output.${ext}`

  const handleSave = async () => {
    await window.benchforge?.saveTextFile({
      defaultFileName,
      extension: ext,
      extensionLabel: ext === 'html' ? 'HTML' : ext === 'svg' ? 'SVG' : ext === 'md' ? 'Markdown' : ext === 'txt' ? t('output.textExtension') : t('output.fileExtension'),
      content,
    })
  }

  return (
    <button
      type="button"
      onClick={() => void handleSave()}
      className="rounded-lg border border-slate-600/50 px-2.5 py-1 text-xs text-slate-400 transition hover:border-indigo-400/60 hover:bg-indigo-500/10 hover:text-indigo-300"
      title={`${t('common.save')} .${ext}`}
    >
      💾 {t('common.save')} .{ext}
    </button>
  )
}

export const OutputViewer: React.FC<OutputViewerProps> = ({ content, outputType, imageBase64, verifyResult, saveFileName }) => {
  const { t } = useTranslation()
  const markdownHtml = useMemo(() => outputType === 'markdown' ? markdownToHtml(content, t) : '', [content, outputType, t])
  const [htmlFullscreen, setHtmlFullscreen] = React.useState(false)

  const saveButton = content?.trim() ? <SaveResponseButton content={content} outputType={outputType} fileName={saveFileName} /> : null

  if (outputType === 'html') {
    return (
      <>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            {saveButton}
            <button
              type="button"
              onClick={() => setHtmlFullscreen(true)}
              className="rounded-lg border border-slate-600/50 px-2.5 py-1 text-xs text-slate-400 transition hover:border-indigo-400/60 hover:bg-indigo-500/10 hover:text-indigo-300"
              title={t('output.openFullscreenHtml')}
            >
              {t('output.fullscreenHtml')}
            </button>
          </div>
          <iframe title={t('output.htmlPreview')} srcDoc={content} sandbox="allow-scripts" className="h-[400px] w-full overflow-hidden rounded-xl border border-slate-700/50 bg-white" />
        </div>
        {htmlFullscreen && (
          <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-2" onClick={() => setHtmlFullscreen(false)}>
            <div className="flex justify-end p-2">
              <button type="button" onClick={() => setHtmlFullscreen(false)} className="rounded-lg border border-slate-600/50 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">{t('common.close')} ✕</button>
            </div>
            <iframe title={t('output.htmlPreviewFullscreen')} srcDoc={content} sandbox="allow-scripts" className="flex-1 w-full rounded-xl bg-white" onClick={(e) => e.stopPropagation()} />
          </div>
        )}
      </>
    )
  }

  if (outputType === 'svg') {
    if (content.trim().startsWith('<svg')) {
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">{saveButton}</div>
          <div className="rounded-xl border border-slate-700/50 bg-white p-4" dangerouslySetInnerHTML={{ __html: content }} />
        </div>
      )
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">{saveButton}</div>
        <pre className="max-h-[400px] overflow-auto rounded-xl border border-slate-700/50 bg-slate-950 p-3 text-xs text-slate-200">{content}</pre>
      </div>
    )
  }

  if (outputType === 'maze') {
    const viewer = imageBase64
      ? <MazeViewer imageBase64={imageBase64} pathPoints={verifyResult?.pathPoints} collisionPoint={verifyResult?.collisionPoint} verifyResult={verifyResult} />
      : <p className="text-sm text-amber-300">{t('output.mazeImageMissing')}</p>
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">{saveButton}</div>
        {viewer}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">{saveButton}</div>
      <div className="prose prose-invert max-w-none rounded-xl border border-slate-700/50 bg-slate-950 p-4 text-sm text-slate-200" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
    </div>
  )
}

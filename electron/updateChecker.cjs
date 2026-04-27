const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const { dialog } = require('electron')

const DEFAULT_REPO = 'snakex21/BenchForge'

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const b = normalizeVersion(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(a.length, b.length, 3)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function githubHeaders(token = null) {
  return {
    'user-agent': 'BenchForge-Portable-Updater',
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchJson(url, token = null) {
  const response = await fetch(url, { headers: githubHeaders(token) })
  if (!response.ok) {
    const error = new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    error.status = response.status
    error.statusText = response.statusText
    throw error
  }
  return response.json()
}

async function fetchText(url, token = null) {
  const response = await fetch(url, { headers: githubHeaders(token) })
  if (!response.ok) throw new Error(`Download error: ${response.status} ${response.statusText}`)
  return response.text()
}

async function fetchBuffer(url, token = null) {
  const response = await fetch(url, { headers: githubHeaders(token) })
  if (!response.ok) throw new Error(`Download error: ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

function mapAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    downloadUrl: asset.browser_download_url,
    contentType: asset.content_type || null,
  }
}

function chooseRecommendedAsset(assets) {
  const zip = assets.find((asset) => /BenchForge-.*-x64\.zip$/i.test(asset.name)) || assets.find((asset) => /\.zip$/i.test(asset.name)) || null
  const portable = assets.find((asset) => /Portable.*\.exe$/i.test(asset.name)) || null
  const setup = assets.find((asset) => /Setup.*\.exe$/i.test(asset.name)) || null
  const checksum = assets.find((asset) => /^SHA256SUMS\.txt$/i.test(asset.name)) || assets.find((asset) => /sha256/i.test(asset.name)) || null
  return { zip, portable, setup, checksum }
}

function selectReleaseAsset(info, assetName = null, kind = 'zip') {
  const recommended = info.recommended || {}
  const asset = assetName
    ? info.assets.find((item) => item.name === assetName)
    : kind === 'portable'
      ? recommended.portable
      : kind === 'setup'
        ? recommended.setup
        : recommended.zip

  if (!asset) throw new Error('No matching release asset found.')
  return asset
}

async function getLatestRelease({ repo = DEFAULT_REPO, token = null, currentVersion = '0.0.0' } = {}) {
  let release = null
  try {
    release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, token)
  } catch (error) {
    if (error?.status === 404) {
      return {
        ok: false,
        noRelease: true,
        repo,
        currentVersion: normalizeVersion(currentVersion),
        latestVersion: normalizeVersion(currentVersion),
        updateAvailable: false,
        tagName: null,
        name: null,
        body: '',
        htmlUrl: `https://github.com/${repo}/releases`,
        publishedAt: null,
        prerelease: false,
        draft: false,
        assets: [],
        recommended: { zip: null, portable: null, setup: null, checksum: null },
        message: 'No published GitHub Release was found for this repository. Create and publish a release first.',
      }
    }
    throw error
  }
  const assets = Array.isArray(release.assets) ? release.assets.map(mapAsset) : []
  const recommended = chooseRecommendedAsset(assets)
  const latestVersion = normalizeVersion(release.tag_name || release.name)
  return {
    ok: true,
    repo,
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    tagName: release.tag_name,
    name: release.name || release.tag_name,
    body: release.body || '',
    htmlUrl: release.html_url,
    publishedAt: release.published_at || null,
    prerelease: Boolean(release.prerelease),
    draft: Boolean(release.draft),
    assets,
    recommended,
  }
}

function parseChecksums(text) {
  const checksums = new Map()
  for (const line of String(text || '').split(/\r?\n/g)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (match) checksums.set(match[2].trim(), match[1].toLowerCase())
  }
  return checksums
}

async function downloadLatestAsset({ repo = DEFAULT_REPO, token = null, currentVersion = '0.0.0', assetName = null, kind = 'zip' } = {}) {
  const info = await getLatestRelease({ repo, token, currentVersion })
  const asset = selectReleaseAsset(info, assetName, kind)

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Download BenchForge update',
    defaultPath: asset.name,
    filters: [{ name: 'BenchForge release asset', extensions: [asset.name.split('.').pop() || '*'] }],
  })
  if (canceled || !filePath) return { canceled: true }

  return downloadReleaseAssetToPath({ info, asset, filePath, token })
}

async function downloadReleaseAssetToPath({ info, asset, filePath, token = null }) {
  const buffer = await fetchBuffer(asset.downloadUrl, token)
  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  let expectedSha256 = null
  let checksumVerified = false
  const recommended = info.recommended || {}

  if (recommended.checksum?.downloadUrl) {
    const checksumText = await fetchText(recommended.checksum.downloadUrl, token)
    expectedSha256 = parseChecksums(checksumText).get(asset.name) || null
    checksumVerified = expectedSha256 ? expectedSha256.toLowerCase() === actualSha256.toLowerCase() : false
    if (expectedSha256 && !checksumVerified) throw new Error(`SHA256 mismatch for ${asset.name}. Expected ${expectedSha256}, got ${actualSha256}.`)
  }

  await fs.writeFile(filePath, buffer)
  return {
    canceled: false,
    filePath,
    assetName: asset.name,
    size: buffer.length,
    sha256: actualSha256,
    expectedSha256,
    checksumVerified,
    release: { tagName: info.tagName, latestVersion: info.latestVersion, htmlUrl: info.htmlUrl },
  }
}

async function downloadLatestAssetToDir({ repo = DEFAULT_REPO, token = null, currentVersion = '0.0.0', assetName = null, kind = 'zip', destinationDir } = {}) {
  if (!destinationDir) throw new Error('Missing destinationDir')
  const info = await getLatestRelease({ repo, token, currentVersion })
  const asset = selectReleaseAsset(info, assetName, kind)
  await fs.mkdir(destinationDir, { recursive: true })
  const filePath = path.join(destinationDir, asset.name)
  return downloadReleaseAssetToPath({ info, asset, filePath, token })
}

module.exports = { DEFAULT_REPO, getLatestRelease, downloadLatestAsset, downloadLatestAssetToDir, compareVersions }

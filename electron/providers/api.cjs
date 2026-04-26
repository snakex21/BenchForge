function normalizeBaseUrl(baseUrl) {
  return (baseUrl || '').trim().replace(/\/$/, '')
}

const TIMEOUT_MESSAGE = 'Przekroczono czas oczekiwania na odpowiedź modelu.'

function estimateTokens(...parts) {
  const text = parts.filter(Boolean).map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join('\n')
  if (!text.trim()) return null
  return Math.max(1, Math.ceil(text.length / 4))
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(TIMEOUT_MESSAGE)
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function parseError(response) {
  try {
    const payload = await response.json()
    return payload?.error?.message || payload?.message || response.statusText
  } catch {
    return response.statusText
  }
}

function buildMessages(prompt, imageBase64) {
  if (!imageBase64) {
    return [{ role: 'user', content: prompt }]
  }

  const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/png;base64,${imageBase64}`
  return [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageUrl } },
      { type: 'text', text: prompt },
    ],
  }]
}

async function sendPrompt(modelConfig, prompt, imageBase64 = null) {
  const baseUrl = normalizeBaseUrl(modelConfig.base_url)
  if (!baseUrl) {
    throw new Error('Brak base_url dla modelu API.')
  }

  if (!modelConfig.model_id) {
    throw new Error('Brak model_id dla modelu API.')
  }

  const headers = {
    'Content-Type': 'application/json',
  }

  if (modelConfig.api_key) {
    headers.Authorization = `Bearer ${modelConfig.api_key}`
  }

  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelConfig.model_id,
      messages: buildMessages(prompt, imageBase64),
      max_tokens: 2048,
    }),
  }, 120000)

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  const payload = await response.json()
  return {
    response: payload?.choices?.[0]?.message?.content || '',
    tokens_used: payload?.usage?.total_tokens ?? estimateTokens(prompt, payload?.choices?.[0]?.message?.content || ''),
  }
}

function splitThinkingContent(text, state) {
  const normal = []
  const thinking = []
  let remaining = text || ''

  while (remaining) {
    if (state.inThink) {
      const end = remaining.indexOf('</think>')
      if (end === -1) {
        thinking.push(remaining)
        remaining = ''
      } else {
        thinking.push(remaining.slice(0, end))
        remaining = remaining.slice(end + '</think>'.length)
        state.inThink = false
      }
      continue
    }

    const start = remaining.indexOf('<think>')
    if (start === -1) {
      normal.push(remaining)
      remaining = ''
    } else {
      if (start > 0) normal.push(remaining.slice(0, start))
      remaining = remaining.slice(start + '<think>'.length)
      state.inThink = true
    }
  }

  return { normal: normal.join(''), thinking: thinking.join('') }
}

async function streamPrompt(modelConfig, prompt, onChunk, onDone, onError, imageBase64 = null, externalSignal = null, onThinkingChunk = null) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000)
  const abortFromExternalSignal = () => controller.abort()
  let fullText = ''
  let fullThinkingText = ''
  let doneSent = false
  let usageTokens = null

  const finish = (tokensUsed = null) => {
    if (doneSent) return
    doneSent = true
    onDone(fullText, tokensUsed ?? usageTokens ?? estimateTokens(prompt, fullThinkingText, fullText))
  }

  const pushThinking = (text) => {
    if (!text) return
    fullThinkingText += text
    onThinkingChunk?.(text)
  }

  try {
    if (externalSignal?.aborted) {
      throw Object.assign(new Error('Benchmark anulowany przez użytkownika.'), { name: 'AbortError' })
    }
    externalSignal?.addEventListener?.('abort', abortFromExternalSignal, { once: true })

    const baseUrl = normalizeBaseUrl(modelConfig.base_url)
    if (!baseUrl) {
      throw new Error('Brak base_url dla modelu API.')
    }

    if (!modelConfig.model_id) {
      throw new Error('Brak model_id dla modelu API.')
    }

    const headers = {
      'Content-Type': 'application/json',
    }

    if (modelConfig.api_key) {
      headers.Authorization = `Bearer ${modelConfig.api_key}`
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: modelConfig.model_id,
        messages: buildMessages(prompt, imageBase64),
        max_tokens: 2048,
        stream: true,
      }),
    })

    if (!response.ok) {
      throw new Error(await parseError(response))
    }

    if (!response.body) {
      throw new Error('Brak strumienia odpowiedzi z API.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const thinkState = { inThink: false }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue

        const data = line.slice(6).trim()
        if (!data) continue

        if (data === '[DONE]') {
          finish(null)
          return
        }

        let chunk = null
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk?.usage?.total_tokens !== undefined && chunk?.usage?.total_tokens !== null) {
          usageTokens = chunk.usage.total_tokens
        }
        const reasoningToken = chunk.choices?.[0]?.delta?.reasoning_content || chunk.choices?.[0]?.delta?.reasoning || ''
        if (reasoningToken) {
          pushThinking(reasoningToken)
        }

        const rawToken = chunk.choices?.[0]?.delta?.content || ''
        const { normal: token, thinking } = splitThinkingContent(rawToken, thinkState)
        if (thinking) pushThinking(thinking)
        if (token) {
          fullText += token
          onChunk(token)
        }
      }
    }

    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6).trim()
      if (data && data !== '[DONE]') {
        let chunk = null
        try {
          chunk = JSON.parse(data)
        } catch {
          chunk = null
        }
        if (!chunk) {
          finish(null)
          return
        }
        if (chunk?.usage?.total_tokens !== undefined && chunk?.usage?.total_tokens !== null) usageTokens = chunk.usage.total_tokens
        const reasoningToken = chunk.choices?.[0]?.delta?.reasoning_content || chunk.choices?.[0]?.delta?.reasoning || ''
        if (reasoningToken) pushThinking(reasoningToken)
        const rawToken = chunk.choices?.[0]?.delta?.content || ''
        const { normal: token, thinking } = splitThinkingContent(rawToken, thinkState)
        if (thinking) pushThinking(thinking)
        if (token) {
          fullText += token
          onChunk(token)
        }
      }
    }

    finish(null)
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? externalSignal?.aborted ? 'Benchmark anulowany przez użytkownika.' : TIMEOUT_MESSAGE
      : error instanceof Error ? error.message : 'Nieznany błąd streamingu.'
    onError(message)
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener?.('abort', abortFromExternalSignal)
  }
}

async function testConnection(modelConfig) {
  const baseUrl = normalizeBaseUrl(modelConfig.base_url)
  if (!baseUrl) {
    return { ok: false, error: 'Brak base_url dla modelu API.' }
  }

  try {
    const headers = {}
    if (modelConfig.api_key) {
      headers.Authorization = `Bearer ${modelConfig.api_key}`
    }

      const response = await fetchWithTimeout(`${baseUrl}/models`, {
        method: 'GET',
        headers,
      }, 5000)

    if (!response.ok) {
      return { ok: false, error: await parseError(response) }
    }

    return { ok: true, error: null }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Nieznany błąd połączenia.',
    }
  }
}

module.exports = {
  sendPrompt,
  streamPrompt,
  testConnection,
}

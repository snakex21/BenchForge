import { useEffect, useState } from 'react'

// Version reported by the desktop host (app:get-meta); '' until known.
export function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    let alive = true
    window.benchforge?.getMeta?.()
      .then((meta) => { if (alive && meta?.version) setVersion(meta.version) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return version
}

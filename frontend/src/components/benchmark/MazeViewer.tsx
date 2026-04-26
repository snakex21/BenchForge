import React, { useEffect, useRef } from 'react'
import type { MazeVerifyResult } from '@/utils/mazeVerifier'

interface MazeViewerProps {
  imageBase64: string
  pathPoints?: [number, number][]
  collisionPoint?: [number, number]
  verifyResult?: MazeVerifyResult
}

export const MazeViewer: React.FC<MazeViewerProps> = ({ imageBase64, pathPoints, collisionPoint, verifyResult }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageBase64) return

    const image = new Image()
    image.onload = () => {
      canvas.width = image.naturalWidth || image.width
      canvas.height = image.naturalHeight || image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0)

      if (pathPoints?.length) {
        ctx.strokeStyle = '#00ff00'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(pathPoints[0][0], pathPoints[0][1])
        pathPoints.slice(1).forEach(([x, y]) => ctx.lineTo(x, y))
        ctx.stroke()
      }

      if (collisionPoint) {
        const [x, y] = collisionPoint
        ctx.strokeStyle = '#ff0000'
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.moveTo(x - 8, y - 8)
        ctx.lineTo(x + 8, y + 8)
        ctx.moveTo(x + 8, y - 8)
        ctx.lineTo(x - 8, y + 8)
        ctx.stroke()
      }
    }
    image.src = imageBase64.startsWith('data:') ? imageBase64 : `data:image/png;base64,${imageBase64}`
  }, [imageBase64, pathPoints, collisionPoint])

  const borderClass = verifyResult ? (verifyResult.passed ? 'border-emerald-500' : 'border-red-500') : 'border-slate-700/50'

  return (
    <div className="space-y-2">
      <canvas ref={canvasRef} className={`max-h-[520px] max-w-full rounded-xl border-2 ${borderClass} bg-white`} />
      {verifyResult && <p className={verifyResult.passed ? 'text-sm text-emerald-300' : 'text-sm text-red-300'}>{verifyResult.reason}</p>}
    </div>
  )
}

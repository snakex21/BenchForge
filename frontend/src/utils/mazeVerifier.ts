export interface MazeVerifyResult {
  passed: boolean
  reason: string
  reasonKey?: string
  pathPoints: [number, number][]
  collisionPoint?: [number, number]
}

export function parseModelPath(response: string): [number, number][] | null {
  const candidates = [response]
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) candidates.unshift(fenced)
  const objectMatch = response.match(/\{[\s\S]*"path"[\s\S]*\}/)
  if (objectMatch) candidates.unshift(objectMatch[0])

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim())
      const path = parsed?.path
      if (!Array.isArray(path)) continue
      const points = path.map((point: unknown) => {
        if (!Array.isArray(point) || point.length < 2) return null
        const x = Number(point[0])
        const y = Number(point[1])
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] as [number, number] : null
      })
      if (points.every(Boolean) && points.length >= 2) return points as [number, number][]
    } catch {
      // try next candidate
    }
  }

  return null
}

export function isWalkable(imageData: ImageData, x: number, y: number, threshold = 128): boolean {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= imageData.width || py >= imageData.height) return false
  const index = (py * imageData.width + px) * 4
  const r = imageData.data[index]
  const g = imageData.data[index + 1]
  const b = imageData.data[index + 2]
  const a = imageData.data[index + 3]
  if (a < 128) return true
  return (r + g + b) / 3 > threshold
}

export function interpolatePath(points: [number, number][], step = 2): [number, number][] {
  if (points.length < 2) return points
  const interpolated: [number, number][] = [points[0]]

  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]
    const [x2, y2] = points[i]
    const distance = Math.hypot(x2 - x1, y2 - y1)
    const segments = Math.max(1, Math.ceil(distance / step))
    for (let segment = 1; segment <= segments; segment++) {
      const ratio = segment / segments
      interpolated.push([x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio])
    }
  }

  return interpolated
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not load the maze image.'))
    image.src = src.startsWith('data:') ? src : `data:image/png;base64,${src}`
  })
}

export async function verifyMazePath(
  imageBase64: string,
  modelResponse: string,
  start: [number, number],
  end: [number, number],
  tolerance = 5,
): Promise<MazeVerifyResult> {
  const image = await loadImage(imageBase64)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { passed: false, reason: 'Canvas context is unavailable.', reasonKey: 'maze.errorCanvas', pathPoints: [] }

  ctx.drawImage(image, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const pathPoints = parseModelPath(modelResponse)
  if (!pathPoints) return { passed: false, reason: 'No valid path JSON found.', reasonKey: 'maze.errorInvalidPathJson', pathPoints: [] }

  const first = pathPoints[0]
  if (Math.hypot(first[0] - start[0], first[1] - start[1]) > tolerance) {
    return { passed: false, reason: 'The path does not start at the start point.', reasonKey: 'maze.errorStartPoint', pathPoints }
  }

  const densePoints = interpolatePath(pathPoints, 2)
  for (const point of densePoints) {
    if (!isWalkable(imageData, point[0], point[1])) {
      return { passed: false, reason: 'Collision with a wall.', reasonKey: 'maze.errorWallCollision', pathPoints, collisionPoint: [Math.round(point[0]), Math.round(point[1])] }
    }
  }

  const last = pathPoints[pathPoints.length - 1]
  if (Math.hypot(last[0] - end[0], last[1] - end[1]) > tolerance) {
    return { passed: false, reason: 'The path did not reach the goal.', reasonKey: 'maze.errorGoal', pathPoints }
  }

  return { passed: true, reason: 'Path is valid.', reasonKey: 'maze.successPath', pathPoints }
}

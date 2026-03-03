import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Task = {
  id: string
  name: string
  start: number
  end: number
  lane: number
  dependencies: string[]
}

type ZoomLevel = 'day' | 'week' | 'month'

type AppState = {
  tasks: Task[]
  zoom: ZoomLevel
}

type CreateDraft = {
  startX: number
  currentX: number
  lane: number
}

type ResizeDraft = {
  taskId: string
  edge: 'start' | 'end'
}

type LinkDraft = {
  sourceTaskId: string
  x: number
  y: number
}

const DAY_MS = 86_400_000
const MIN_TASK_MS = 6 * 60 * 60 * 1000
const LANE_HEIGHT = 54
const BAR_HEIGHT = 32
const HEADER_HEIGHT = 34
const TIMELINE_DAYS = 120

const ZOOM_PX_PER_DAY: Record<ZoomLevel, number> = {
  day: 72,
  week: 24,
  month: 8,
}

const DB_NAME = 'no-gantt-mvp'
const DB_VERSION = 1
const STORE_NAME = 'kv'
const STATE_KEY = 'app-state'

function startOfDayUtc(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function restackTasks(tasks: Task[]): Task[] {
  const sorted = [...tasks].sort((a, b) => a.start - b.start)
  const laneEndTimes: number[] = []

  for (const task of sorted) {
    let lane = 0
    while (lane < laneEndTimes.length && task.start < laneEndTimes[lane]) {
      lane += 1
    }

    task.lane = lane
    laneEndTimes[lane] = task.end
  }

  return sorted
}

function buildTaskName(tasks: Task[]): string {
  return `Task ${tasks.length + 1}`
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveState(state: AppState): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(state, STATE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function loadState(): Promise<AppState | null> {
  const db = await openDb()
  const result = await new Promise<AppState | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(STATE_KEY)
    request.onsuccess = () => resolve((request.result as AppState | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return result
}

function App() {
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [zoom, setZoom] = useState<ZoomLevel>('week')
  const [loaded, setLoaded] = useState(false)

  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [resizeDraft, setResizeDraft] = useState<ResizeDraft | null>(null)
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null)

  const [timelineStart] = useState(() => startOfDayUtc(Date.now() - 7 * DAY_MS))
  const pxPerDay = ZOOM_PX_PER_DAY[zoom]
  const timelineWidth = TIMELINE_DAYS * pxPerDay

  const laneCount = useMemo(
    () => Math.max(1, tasks.reduce((maxLane, task) => Math.max(maxLane, task.lane + 1), 1)),
    [tasks],
  )
  const timelineHeight = laneCount * LANE_HEIGHT

  const toX = useCallback(
    (timeMs: number) => ((timeMs - timelineStart) / DAY_MS) * pxPerDay,
    [timelineStart, pxPerDay],
  )
  const toTime = useCallback(
    (x: number) => timelineStart + (x / pxPerDay) * DAY_MS,
    [timelineStart, pxPerDay],
  )

  useEffect(() => {
    let active = true

    loadState()
      .then((state) => {
        if (!active || !state) return
        setTasks(restackTasks(state.tasks))
        setZoom(state.zoom)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!loaded) return
    void saveState({ tasks, zoom })
  }, [tasks, zoom, loaded])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const bounds = timelineRef.current?.getBoundingClientRect()
      if (!bounds) return

      const x = Math.max(0, Math.min(timelineWidth, event.clientX - bounds.left))
      const y = Math.max(0, Math.min(HEADER_HEIGHT + timelineHeight, event.clientY - bounds.top))

      if (createDraft) {
        setCreateDraft((draft) => (draft ? { ...draft, currentX: x } : null))
      }

      if (resizeDraft) {
        setTasks((prev) => {
          const next = prev.map((task) => {
            if (task.id !== resizeDraft.taskId) return task

            const cursorTime = toTime(x)
            if (resizeDraft.edge === 'start') {
              return { ...task, start: Math.min(cursorTime, task.end - MIN_TASK_MS) }
            }

            return { ...task, end: Math.max(cursorTime, task.start + MIN_TASK_MS) }
          })

          return restackTasks(next)
        })
      }

      if (linkDraft) {
        setLinkDraft((prev) => (prev ? { ...prev, x, y } : null))
      }
    }

    const onMouseUp = () => {
      if (createDraft) {
        const x1 = Math.min(createDraft.startX, createDraft.currentX)
        const x2 = Math.max(createDraft.startX, createDraft.currentX)
        const durationMs = Math.max(toTime(x2) - toTime(x1), MIN_TASK_MS)

        const newTask: Task = {
          id: crypto.randomUUID(),
          name: '',
          start: toTime(x1),
          end: toTime(x1) + durationMs,
          lane: 0,
          dependencies: [],
        }

        setTasks((prev) => {
          const withName = { ...newTask, name: buildTaskName(prev) }
          return restackTasks([...prev, withName])
        })
      }

      setCreateDraft(null)
      setResizeDraft(null)
      setLinkDraft(null)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [createDraft, resizeDraft, linkDraft, timelineWidth, timelineHeight, toTime])

  const onGridMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.task-bar')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(timelineWidth, event.clientX - bounds.left))
    const y = Math.max(0, event.clientY - bounds.top - HEADER_HEIGHT)
    const lane = Math.max(0, Math.min(laneCount - 1, Math.floor(y / LANE_HEIGHT)))
    setCreateDraft({ startX: x, currentX: x, lane })
  }

  const updateDependency = (sourceTaskId: string, targetTaskId: string) => {
    if (sourceTaskId === targetTaskId) return

    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== sourceTaskId) return task
        if (task.dependencies.includes(targetTaskId)) return task
        return { ...task, dependencies: [...task.dependencies, targetTaskId] }
      }),
    )
  }

  const exportJson = () => {
    const payload = JSON.stringify({ tasks, zoom }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'no-gantt-state.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const ticks = useMemo(() => {
    const result: Array<{ x: number; label: string }> = []
    for (let i = 0; i <= TIMELINE_DAYS; i += 1) {
      const ts = timelineStart + i * DAY_MS
      const d = new Date(ts)

      const day = d.getUTCDate()
      const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })

      if (zoom === 'day') {
        result.push({ x: i * pxPerDay, label: `${month} ${day}` })
      } else if (zoom === 'week' && i % 7 === 0) {
        result.push({ x: i * pxPerDay, label: `${month} ${day}` })
      } else if (zoom === 'month' && day === 1) {
        result.push({ x: i * pxPerDay, label: `${month} ${d.getUTCFullYear()}` })
      }
    }
    return result
  }, [zoom, pxPerDay, timelineStart])

  return (
    <div className="app-shell">
      <header className="toolbar">
        <h1>NoGantt POC</h1>
        <div className="toolbar-actions">
          <button className={zoom === 'day' ? 'active' : ''} onClick={() => setZoom('day')}>
            Day
          </button>
          <button className={zoom === 'week' ? 'active' : ''} onClick={() => setZoom('week')}>
            Week
          </button>
          <button className={zoom === 'month' ? 'active' : ''} onClick={() => setZoom('month')}>
            Month
          </button>
          <button onClick={exportJson}>Export JSON</button>
        </div>
      </header>

      <div className="timeline-scroll">
        <div
          className="timeline"
          ref={timelineRef}
          onMouseDown={onGridMouseDown}
          style={{ width: `${timelineWidth}px`, height: `${HEADER_HEIGHT + timelineHeight}px` }}
        >
          <div className="timeline-header" style={{ height: `${HEADER_HEIGHT}px` }}>
            {ticks.map((tick) => (
              <div key={`${tick.x}-${tick.label}`} className="tick" style={{ left: `${tick.x}px` }}>
                {tick.label}
              </div>
            ))}
          </div>

          <div
            className="timeline-grid"
            style={{ top: `${HEADER_HEIGHT}px`, height: `${timelineHeight}px` }}
          >
            {Array.from({ length: laneCount }).map((_, lane) => (
              <div
                key={lane}
                className="lane"
                style={{ top: `${lane * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
              />
            ))}
          </div>

          <svg
            className="dependency-layer"
            style={{ top: `${HEADER_HEIGHT}px`, height: `${timelineHeight}px` }}
            width={timelineWidth}
            height={timelineHeight}
          >
            <defs>
              <marker
                id="arrow"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 Z" fill="#2563eb" />
              </marker>
            </defs>
            {tasks.flatMap((task) =>
              task.dependencies.map((targetId) => {
                const target = tasks.find((t) => t.id === targetId)
                if (!target) return null

                const x1 = toX(task.end)
                const y1 = task.lane * LANE_HEIGHT + BAR_HEIGHT / 2 + 10
                const x2 = toX(target.start)
                const y2 = target.lane * LANE_HEIGHT + BAR_HEIGHT / 2 + 10
                const bend = Math.max(20, Math.abs(x2 - x1) / 2)
                const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`

                return <path key={`${task.id}-${targetId}`} d={d} markerEnd="url(#arrow)" className="dependency" />
              }),
            )}
            {linkDraft && (() => {
              const source = tasks.find((task) => task.id === linkDraft.sourceTaskId)
              if (!source) return null
              const x1 = toX(source.end)
              const y1 = source.lane * LANE_HEIGHT + BAR_HEIGHT / 2 + 10
              return <line x1={x1} y1={y1} x2={linkDraft.x} y2={linkDraft.y - HEADER_HEIGHT} className="link-preview" />
            })()}
          </svg>

          <div className="bars-layer" style={{ top: `${HEADER_HEIGHT}px`, height: `${timelineHeight}px` }}>
            {tasks.map((task) => {
              const left = toX(task.start)
              const width = Math.max(8, toX(task.end) - toX(task.start))
              const top = task.lane * LANE_HEIGHT + 8

              return (
                <div
                  key={task.id}
                  className="task-bar"
                  style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${BAR_HEIGHT}px` }}
                  onMouseUp={() => {
                    if (linkDraft) updateDependency(linkDraft.sourceTaskId, task.id)
                  }}
                >
                  <button
                    className="resize-handle left"
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      setResizeDraft({ taskId: task.id, edge: 'start' })
                    }}
                    aria-label={`Resize start ${task.name}`}
                  />
                  <span>{task.name}</span>
                  <button
                    className="link-handle"
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      const bounds = timelineRef.current?.getBoundingClientRect()
                      const x = bounds ? Math.max(0, Math.min(timelineWidth, event.clientX - bounds.left)) : 0
                      const y = bounds
                        ? Math.max(0, Math.min(HEADER_HEIGHT + timelineHeight, event.clientY - bounds.top))
                        : 0
                      setLinkDraft({ sourceTaskId: task.id, x, y })
                    }}
                    aria-label={`Link from ${task.name}`}
                  />
                  <button
                    className="resize-handle right"
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      setResizeDraft({ taskId: task.id, edge: 'end' })
                    }}
                    aria-label={`Resize end ${task.name}`}
                  />
                </div>
              )
            })}

            {createDraft && (
              <div
                className="draft-bar"
                style={{
                  left: `${Math.min(createDraft.startX, createDraft.currentX)}px`,
                  top: `${createDraft.lane * LANE_HEIGHT + 8}px`,
                  width: `${Math.max(6, Math.abs(createDraft.currentX - createDraft.startX))}px`,
                  height: `${BAR_HEIGHT}px`,
                }}
              />
            )}
          </div>
        </div>
      </div>

      <p className="note">
        POC controls: drag empty grid to create, drag bar edges to resize, drag the middle dot to another bar to
        create a dependency.
      </p>
    </div>
  )
}

export default App

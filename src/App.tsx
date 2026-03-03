import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import './App.css'

type Task = {
  id: string
  name: string
  start: number
  end: number
  lane: number
  dependencies: string[]
  color: string
  description: string
}

type ZoomLevel = 'day' | 'week' | 'month'

type AppState = {
  tasks: Task[]
  zoom: ZoomLevel
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

type DragDraft = {
  taskId: string
  pointerOffsetX: number
  pointerOffsetY: number
}

type TaskEditor = {
  id: string
  name: string
  color: string
  description: string
}

type PendingCreate = {
  start: number
  lane: number
}

const DAY_MS = 86_400_000
const MIN_TASK_MS = 6 * 60 * 60 * 1000
const LANE_HEIGHT = 54
const BAR_HEIGHT = 32
const HEADER_HEIGHT = 34
const TIMELINE_DAYS = 120
const DEFAULT_TASK_COLOR = '#1d4ed8'

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

function hasLaneOverlap(tasks: Task[], target: Task, lane: number): boolean {
  return tasks.some((task) => {
    if (task.id === target.id || task.lane !== lane) return false
    return target.start < task.end && task.start < target.end
  })
}

function settleDraggedTask(tasks: Task[], taskId: string): Task[] {
  const dragged = tasks.find((task) => task.id === taskId)
  if (!dragged) return tasks

  let lane = dragged.lane
  while (hasLaneOverlap(tasks, dragged, lane)) {
    lane += 1
  }

  return tasks.map((task) => (task.id === taskId ? { ...task, lane } : task))
}

function placeTaskAtLane(tasks: Task[], task: Task, requestedLane: number): Task {
  let lane = requestedLane
  while (hasLaneOverlap(tasks, task, lane)) {
    lane += 1
  }
  return { ...task, lane }
}

function buildTaskName(tasks: Task[]): string {
  return `Task ${tasks.length + 1}`
}

function normalizeTask(
  task: Omit<Task, 'color' | 'description'> & Partial<Pick<Task, 'color' | 'description'>>,
): Task {
  return {
    ...task,
    color: task.color ?? DEFAULT_TASK_COLOR,
    description: task.description ?? '',
  }
}

function isZoomLevel(value: unknown): value is ZoomLevel {
  return value === 'day' || value === 'week' || value === 'month'
}

function parseImportedState(raw: unknown): AppState | null {
  if (!raw || typeof raw !== 'object') return null
  const state = raw as Partial<AppState>
  if (!Array.isArray(state.tasks) || !isZoomLevel(state.zoom)) return null

  const tasks: Task[] = []
  for (const candidate of state.tasks) {
    if (!candidate || typeof candidate !== 'object') return null
    const task = candidate as Partial<Task>
    if (
      typeof task.id !== 'string' ||
      typeof task.name !== 'string' ||
      typeof task.start !== 'number' ||
      typeof task.end !== 'number' ||
      typeof task.lane !== 'number' ||
      !Array.isArray(task.dependencies)
    ) {
      return null
    }
    if (!task.dependencies.every((dep) => typeof dep === 'string')) return null
    tasks.push(
      normalizeTask({
        id: task.id,
        name: task.name,
        start: task.start,
        end: task.end,
        lane: task.lane,
        dependencies: task.dependencies,
        color: task.color,
        description: task.description,
      }),
    )
  }

  return { tasks, zoom: state.zoom }
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
  const hoverTimerRef = useRef<number | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [zoom, setZoom] = useState<ZoomLevel>('week')
  const [loaded, setLoaded] = useState(false)

  const [resizeDraft, setResizeDraft] = useState<ResizeDraft | null>(null)
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null)
  const [dragDraft, setDragDraft] = useState<DragDraft | null>(null)
  const [editor, setEditor] = useState<TaskEditor | null>(null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)

  const [timelineStart] = useState(() => startOfDayUtc(Date.now() - 7 * DAY_MS))
  const pxPerDay = ZOOM_PX_PER_DAY[zoom]
  const timelineWidth = TIMELINE_DAYS * pxPerDay

  const laneCount = useMemo(
    () => Math.max(1, tasks.reduce((maxLane, task) => Math.max(maxLane, task.lane + 1), 1)),
    [tasks],
  )
  const renderLaneCount = laneCount + 1
  const timelineHeight = renderLaneCount * LANE_HEIGHT

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
        setTasks(state.tasks.map(normalizeTask))
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

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const scheduleHoverEditor = useCallback(
    (task: Task) => {
      clearHoverTimer()
      hoverTimerRef.current = window.setTimeout(() => {
        setEditor({
          id: task.id,
          name: task.name,
          color: task.color,
          description: task.description,
        })
      }, 1000)
    },
    [clearHoverTimer],
  )

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const bounds = timelineRef.current?.getBoundingClientRect()
      if (!bounds) return

      const x = Math.max(0, Math.min(timelineWidth, event.clientX - bounds.left))
      const y = Math.max(0, Math.min(HEADER_HEIGHT + timelineHeight, event.clientY - bounds.top))

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

          return next.map(normalizeTask)
        })
      }

      if (dragDraft) {
        setTasks((prev) =>
          prev.map((task) => {
            if (task.id !== dragDraft.taskId) return task

            const duration = task.end - task.start
            const rawLeft = x - dragDraft.pointerOffsetX
            const rawStart = toTime(rawLeft)
            const maxStart = toTime(timelineWidth) - duration
            const start = Math.max(timelineStart, Math.min(rawStart, maxStart))

            const laneY = y - HEADER_HEIGHT - dragDraft.pointerOffsetY + BAR_HEIGHT / 2
            const lane = Math.max(0, Math.min(renderLaneCount - 1, Math.floor(laneY / LANE_HEIGHT)))

            return { ...task, start, end: start + duration, lane }
          }),
        )
      }

      if (linkDraft) {
        setLinkDraft((prev) => (prev ? { ...prev, x, y } : null))
      }
    }

    const onMouseUp = () => {
      if (dragDraft) {
        setTasks((prev) => settleDraggedTask(prev, dragDraft.taskId))
      }

      setResizeDraft(null)
      setLinkDraft(null)
      setDragDraft(null)
      clearHoverTimer()
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [
    resizeDraft,
    dragDraft,
    linkDraft,
    timelineWidth,
    timelineHeight,
    renderLaneCount,
    timelineStart,
    toTime,
    clearHoverTimer,
  ])

  const onGridClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('.task-bar')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientY - bounds.top < HEADER_HEIGHT) return
    const x = Math.max(0, Math.min(timelineWidth, event.clientX - bounds.left))
    const y = Math.max(0, event.clientY - bounds.top - HEADER_HEIGHT)
    const lane = Math.max(0, Math.min(renderLaneCount - 1, Math.floor(y / LANE_HEIGHT)))
    setPendingCreate({ start: toTime(x), lane })
  }

  const createPendingTask = () => {
    if (!pendingCreate) return

    const newTask: Task = {
      id: crypto.randomUUID(),
      name: '',
      start: pendingCreate.start,
      end: pendingCreate.start + DAY_MS,
      lane: 0,
      dependencies: [],
      color: DEFAULT_TASK_COLOR,
      description: '',
    }

    setTasks((prev) => {
      const withName = { ...newTask, name: buildTaskName(prev) }
      const placed = placeTaskAtLane(prev, withName, pendingCreate.lane)
      return [...prev, placed]
    })
    setPendingCreate(null)
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

  const updateTask = (taskId: string, patch: Partial<Task>) => {
    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, ...patch } : task)))
  }

  const deleteTask = (taskId: string) => {
    setTasks((prev) =>
      prev
        .filter((task) => task.id !== taskId)
        .map((task) => ({
          ...task,
          dependencies: task.dependencies.filter((dependencyId) => dependencyId !== taskId),
        })),
    )
    setEditor((prev) => (prev?.id === taskId ? null : prev))
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

  const onImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const text = await file.text()
      const parsed = parseImportedState(JSON.parse(text))
      if (!parsed) {
        window.alert('Invalid JSON format for NoGantt import.')
        return
      }
      setTasks(parsed.tasks)
      setZoom(parsed.zoom)
      setEditor(null)
      setPendingCreate(null)
      setLinkDraft(null)
      setDragDraft(null)
      setResizeDraft(null)
    } catch {
      window.alert('Failed to read import file.')
    }
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
          <button onClick={() => importInputRef.current?.click()}>Import JSON</button>
          <button onClick={exportJson}>Export JSON</button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            onChange={onImportFileChange}
            style={{ display: 'none' }}
          />
        </div>
      </header>

      <div className="timeline-scroll">
        <div
          className="timeline"
          ref={timelineRef}
          onClick={onGridClick}
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
            {Array.from({ length: renderLaneCount }).map((_, lane) => (
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
              return (
                <line
                  x1={x1}
                  y1={y1}
                  x2={linkDraft.x}
                  y2={linkDraft.y - HEADER_HEIGHT}
                  className="link-preview"
                />
              )
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
                  style={{
                    left: `${left}px`,
                    top: `${top}px`,
                    width: `${width}px`,
                    height: `${BAR_HEIGHT}px`,
                    background: task.color,
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 0) return
                    const target = event.target as HTMLElement
                    if (target.closest('button')) return
                    const bounds = timelineRef.current?.getBoundingClientRect()
                    if (!bounds) return
                    event.stopPropagation()
                    clearHoverTimer()
                    setDragDraft({
                      taskId: task.id,
                      pointerOffsetX: event.clientX - bounds.left - left,
                      pointerOffsetY: event.clientY - bounds.top - HEADER_HEIGHT - top,
                    })
                  }}
                  onMouseEnter={(event) => {
                    if (resizeDraft || dragDraft || linkDraft) return
                    const target = event.target as HTMLElement
                    if (target.closest('button')) return
                    scheduleHoverEditor(task)
                  }}
                  onMouseMove={(event) => {
                    if (resizeDraft || dragDraft || linkDraft) return
                    const target = event.target as HTMLElement
                    if (target.closest('button')) {
                      clearHoverTimer()
                      return
                    }
                    scheduleHoverEditor(task)
                  }}
                  onMouseLeave={clearHoverTimer}
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
          </div>
        </div>
      </div>

      <p className="note">
        POC controls: click blank lane space to create (with confirmation), drag bar body to move lane/time, drag bar
        edges to resize, drag the middle dot to another bar to create a dependency, hover a task for 1 second to open
        details.
      </p>

      {pendingCreate && (
        <div className="dialog-overlay" onMouseDown={() => setPendingCreate(null)}>
          <div className="details-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <h2>New task?</h2>
            <p>Create a new task on this lane at the selected time.</p>
            <div className="dialog-actions">
              <button onClick={() => setPendingCreate(null)}>Cancel</button>
              <button className="primary" onClick={createPendingTask}>
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div className="dialog-overlay" onMouseDown={() => setEditor(null)}>
          <div className="details-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Task Details</h2>
            <label>
              <span>Name</span>
              <input
                value={editor.name}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
                }
              />
            </label>
            <label>
              <span>Color</span>
              <input
                type="color"
                value={editor.color}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, color: event.target.value } : prev))
                }
              />
            </label>
            <label>
              <span>Description</span>
              <textarea
                rows={4}
                value={editor.description}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, description: event.target.value } : prev))
                }
              />
            </label>
            <div className="dialog-actions">
              <button className="danger" onClick={() => deleteTask(editor.id)}>
                Delete
              </button>
              <button onClick={() => setEditor(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  updateTask(editor.id, {
                    name: editor.name.trim() || 'Untitled Task',
                    color: editor.color,
                    description: editor.description,
                  })
                  setEditor(null)
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

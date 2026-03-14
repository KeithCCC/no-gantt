import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react'
import './App.css'

type Task = {
  id: string
  name: string
  project: string
  start: number
  end: number
  lane: number
  dependencies: string[]
  color: string
  description: string
  done: boolean
}

type ZoomLevel = 'day' | 'week' | 'month' | 'year'

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
  project: string
  color: string
  description: string
  startDate: string
  endDate: string
  done: boolean
}

type PendingCreate = {
  start: number
  lane: number
}

const DAY_MS = 86_400_000
const MIN_TASK_MS = 6 * 60 * 60 * 1000
const LANE_HEIGHT = 24
const BAR_HEIGHT = 24
const HEADER_HEIGHT = 34
const TIMELINE_DAYS = 120
const TIMELINE_PADDING_DAYS = 14
const DEFAULT_TASK_COLOR = '#1d4ed8'

const ZOOM_PX_PER_DAY: Record<ZoomLevel, number> = {
  day: 72,
  week: 24,
  month: 8,
  year: 1,
}

const DB_NAME = 'no-gantt-mvp'
const DB_VERSION = 1
const STORE_NAME = 'kv'
const STATE_KEY = 'app-state'
const PRESET_TASK_COLORS = ['#1d4ed8', '#0f766e', '#b45309', '#be123c', '#4338ca']
const ALL_PROJECTS_KEY = '__all__'
const NO_PROJECT_KEY = '__none__'

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
  task: Omit<Task, 'project' | 'color' | 'description' | 'done'> &
    Partial<Pick<Task, 'project' | 'color' | 'description' | 'done'>>,
): Task {
  return {
    ...task,
    project: task.project ?? '',
    color: task.color ?? DEFAULT_TASK_COLOR,
    description: task.description ?? '',
    done: task.done ?? false,
  }
}

function isZoomLevel(value: unknown): value is ZoomLevel {
  return value === 'day' || value === 'week' || value === 'month' || value === 'year'
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
        project: task.project,
        start: task.start,
        end: task.end,
        lane: task.lane,
        dependencies: task.dependencies,
        color: task.color,
        description: task.description,
        done: task.done,
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

function toDateInputValue(ts: number): string {
  const d = new Date(ts)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function fromDateInputValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return Date.UTC(year, month - 1, day)
}

function formatDateLabel(ts: number): string {
  return toDateInputValue(ts)
}

function formatCompactDate(ts: number): string {
  const d = new Date(ts)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function toProjectFilterKey(projectName: string): string {
  return projectName.trim() === '' ? NO_PROJECT_KEY : projectName.trim()
}

function tidyTasksByProject(tasks: Task[]): Task[] {
  if (tasks.length === 0) return tasks

  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    const projectKey = task.project.trim()
    const existing = groups.get(projectKey)
    if (existing) {
      existing.push(task)
    } else {
      groups.set(projectKey, [task])
    }
  }

  const orderedGroups = Array.from(groups.entries()).sort(([projectA, tasksA], [projectB, tasksB]) => {
    const earliestA = tasksA.reduce((min, task) => Math.min(min, task.start), Number.POSITIVE_INFINITY)
    const earliestB = tasksB.reduce((min, task) => Math.min(min, task.start), Number.POSITIVE_INFINITY)
    if (earliestA !== earliestB) return earliestA - earliestB
    return projectA.localeCompare(projectB)
  })

  const tidied: Task[] = []
  let laneOffset = 0

  for (const [, projectTasks] of orderedGroups) {
    const sortedTasks = [...projectTasks].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start
      if (a.end !== b.end) return a.end - b.end
      return a.name.localeCompare(b.name)
    })

    const laneEnds: number[] = []
    for (const task of sortedTasks) {
      let laneIndex = laneEnds.findIndex((laneEnd) => laneEnd <= task.start)
      if (laneIndex === -1) {
        laneIndex = laneEnds.length
        laneEnds.push(task.end)
      } else {
        laneEnds[laneIndex] = task.end
      }

      tidied.push({
        ...task,
        lane: laneOffset + laneIndex,
      })
    }

    laneOffset += Math.max(1, laneEnds.length)
  }

  return tidied
}

function App() {
  const projectOptionsId = useId()
  const timelineScrollRef = useRef<HTMLDivElement | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const projectFilterRef = useRef<HTMLDivElement | null>(null)
  const suppressGridClickRef = useRef(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [zoom, setZoom] = useState<ZoomLevel>('week')
  const [loaded, setLoaded] = useState(false)
  const [yearViewWidth, setYearViewWidth] = useState(0)
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<string[]>([ALL_PROJECTS_KEY])
  const [projectFilterOpen, setProjectFilterOpen] = useState(false)
  const [showTaskTable, setShowTaskTable] = useState(false)

  const [resizeDraft, setResizeDraft] = useState<ResizeDraft | null>(null)
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null)
  const [dragDraft, setDragDraft] = useState<DragDraft | null>(null)
  const [editor, setEditor] = useState<TaskEditor | null>(null)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)

  const [defaultTimelineStart] = useState(() => startOfDayUtc(Date.now() - 7 * DAY_MS))
  const projectNames = useMemo(
    () =>
      Array.from(
        new Set(
          tasks
            .map((task) => task.project.trim())
            .filter((projectName) => projectName.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [tasks],
  )
  const hasBlankProject = useMemo(() => tasks.some((task) => task.project.trim() === ''), [tasks])
  const projectFilterOptions = useMemo(
    () => [
      { key: ALL_PROJECTS_KEY, label: 'All Projects' },
      ...projectNames.map((projectName) => ({ key: projectName, label: projectName })),
      ...(hasBlankProject ? [{ key: NO_PROJECT_KEY, label: 'No Project' }] : []),
    ],
    [projectNames, hasBlankProject],
  )
  const showAllProjects =
    selectedProjectKeys.length === 0 || selectedProjectKeys.includes(ALL_PROJECTS_KEY)
  const visibleTasks = useMemo(() => {
    if (showAllProjects) return tasks
    const selected = new Set(selectedProjectKeys)
    return tasks.filter((task) => selected.has(toProjectFilterKey(task.project)))
  }, [tasks, selectedProjectKeys, showAllProjects])
  const earliestTaskStart = useMemo(
    () =>
      visibleTasks.length > 0
        ? startOfDayUtc(
            visibleTasks.reduce((min, task) => Math.min(min, task.start), Number.POSITIVE_INFINITY),
          )
        : defaultTimelineStart,
    [visibleTasks, defaultTimelineStart],
  )
  const latestTaskEnd = useMemo(
    () =>
      visibleTasks.length > 0
        ? startOfDayUtc(
            visibleTasks.reduce((max, task) => Math.max(max, task.end), Number.NEGATIVE_INFINITY),
          )
        : defaultTimelineStart + TIMELINE_DAYS * DAY_MS,
    [visibleTasks, defaultTimelineStart],
  )

  const nonYearTimelineStart = Math.min(
    defaultTimelineStart,
    earliestTaskStart - TIMELINE_PADDING_DAYS * DAY_MS,
  )
  const nonYearTimelineDays = Math.max(
    TIMELINE_DAYS,
    Math.ceil((latestTaskEnd - nonYearTimelineStart) / DAY_MS) + TIMELINE_PADDING_DAYS,
  )

  const earliestTaskYear = new Date(earliestTaskStart).getUTCFullYear()
  const latestTaskYear = new Date(latestTaskEnd).getUTCFullYear()
  const yearTimelineStart = Date.UTC(earliestTaskYear, 0, 1)
  const yearTimelineEnd = Date.UTC(latestTaskYear + 1, 0, 1)
  const yearTimelineDays = Math.round((yearTimelineEnd - yearTimelineStart) / DAY_MS)

  const timelineStart = zoom === 'year' ? yearTimelineStart : nonYearTimelineStart
  const timelineDays = zoom === 'year' ? yearTimelineDays : nonYearTimelineDays
  const pxPerDay =
    zoom === 'year'
      ? Math.max(1, (yearViewWidth || 960) / yearTimelineDays)
      : ZOOM_PX_PER_DAY[zoom]
  const timelineWidth = timelineDays * pxPerDay

  const laneCount = useMemo(
    () => Math.max(1, visibleTasks.reduce((maxLane, task) => Math.max(maxLane, task.lane + 1), 1)),
    [visibleTasks],
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
    const element = timelineScrollRef.current
    if (!element) return

    const updateWidth = () => setYearViewWidth(element.clientWidth)
    updateWidth()

    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

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

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!projectFilterRef.current?.contains(event.target as Node)) {
        setProjectFilterOpen(false)
      }
    }

    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [])

  const openTaskEditor = useCallback((task: Task) => {
    setEditor({
      id: task.id,
      name: task.name,
      project: task.project,
      color: task.color,
      description: task.description,
      startDate: toDateInputValue(task.start),
      endDate: toDateInputValue(task.end - 1),
      done: task.done,
    })
  }, [])

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
      const hadPointerInteraction = Boolean(dragDraft || resizeDraft || linkDraft)
      if (dragDraft) {
        setTasks((prev) => settleDraggedTask(prev, dragDraft.taskId))
      }

      setResizeDraft(null)
      setLinkDraft(null)
      setDragDraft(null)

      if (hadPointerInteraction) {
        suppressGridClickRef.current = true
      }
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
  ])

  const onGridClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressGridClickRef.current) {
      suppressGridClickRef.current = false
      return
    }

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
      project: '',
      start: pendingCreate.start,
      end: pendingCreate.start + DAY_MS,
      lane: 0,
      dependencies: [],
      color: DEFAULT_TASK_COLOR,
      description: '',
      done: false,
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
    setTasks((prev) => {
      const currentTask = prev.find((task) => task.id === taskId)
      if (!currentTask) return prev

      const nextProject = (patch.project ?? currentTask.project).trim()
      const shouldSyncProjectColor = typeof patch.color === 'string' && nextProject.length > 0
      const inheritedProjectColor =
        typeof patch.project === 'string' && nextProject.length > 0
          ? prev.find((task) => task.id !== taskId && task.project.trim() === nextProject)?.color
          : undefined

      return prev.map((task) => {
        if (task.id === taskId) {
          const nextTask = {
            ...task,
            ...patch,
          }
          return inheritedProjectColor ? { ...nextTask, color: inheritedProjectColor } : nextTask
        }

        if (shouldSyncProjectColor && task.project.trim() === nextProject) {
          return { ...task, color: patch.color as string }
        }

        return task
      })
    })
  }

  const tidyBars = useCallback(() => {
    setTasks((prev) => tidyTasksByProject(prev))
  }, [])

  const toggleProjectFilter = useCallback((key: string) => {
    setSelectedProjectKeys((prev) => {
      if (key === ALL_PROJECTS_KEY) {
        return [ALL_PROJECTS_KEY]
      }

      const next = prev.includes(ALL_PROJECTS_KEY) ? [] : [...prev]
      const index = next.indexOf(key)
      if (index >= 0) {
        next.splice(index, 1)
      } else {
        next.push(key)
      }

      return next.length === 0 ? [ALL_PROJECTS_KEY] : next.sort((a, b) => a.localeCompare(b))
    })
  }, [])

  const updateTaskField = useCallback(
    (taskId: string, patch: Partial<Task>) => {
      updateTask(taskId, patch)
    },
    [updateTask],
  )

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
    a.download = `no-gantt-state-${formatCompactDate(Date.now())}.json`
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
    for (let i = 0; i <= timelineDays; i += 1) {
      const ts = timelineStart + i * DAY_MS
      const d = new Date(ts)

      const day = d.getUTCDate()
      const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })

      if (zoom === 'year') {
        if (day === 1) {
          result.push({
            x: i * pxPerDay,
            label: `${month}${d.getUTCMonth() === 0 ? ` ${d.getUTCFullYear()}` : ''}`,
          })
        }
      } else if (zoom === 'day') {
        result.push({ x: i * pxPerDay, label: `${month} ${day}` })
      } else if (zoom === 'week' && i % 7 === 0) {
        result.push({ x: i * pxPerDay, label: `${month} ${day}` })
      } else if (zoom === 'month' && day === 1) {
        result.push({ x: i * pxPerDay, label: `${month} ${d.getUTCFullYear()}` })
      }
    }
    return result
  }, [zoom, pxPerDay, timelineStart, timelineDays])

  const todayX = useMemo(() => toX(startOfDayUtc(Date.now())), [toX])
  const showTodayLine = todayX >= 0 && todayX <= timelineWidth
  const hoveredTask = useMemo(
    () => visibleTasks.find((task) => task.id === hoveredTaskId) ?? null,
    [visibleTasks, hoveredTaskId],
  )
  const projectFilterLabel = showAllProjects
    ? 'All Projects'
    : projectFilterOptions
        .filter((option) => selectedProjectKeys.includes(option.key))
        .map((option) => option.label)
        .join(', ')

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
          <button className={zoom === 'year' ? 'active' : ''} onClick={() => setZoom('year')}>
            Year
          </button>
          <div className="project-filter" ref={projectFilterRef}>
            <button onClick={() => setProjectFilterOpen((prev) => !prev)}>
              Projects: {projectFilterLabel}
            </button>
            {projectFilterOpen && (
              <div className="project-filter-menu">
                {projectFilterOptions.map((option) => {
                  const checked =
                    option.key === ALL_PROJECTS_KEY
                      ? showAllProjects
                      : selectedProjectKeys.includes(option.key)
                  return (
                    <label key={option.key} className="project-filter-option">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProjectFilter(option.key)}
                      />
                      <span>{option.label}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
          <button onClick={tidyBars}>Tidy Bars</button>
          <button onClick={() => setShowTaskTable((prev) => !prev)}>
            {showTaskTable ? 'Hide Task Table' : 'Show Task Table'}
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

      <div className="timeline-scroll" ref={timelineScrollRef}>
        <div
          className="timeline"
          ref={timelineRef}
          onClick={onGridClick}
          style={{ width: `${timelineWidth}px`, height: `${HEADER_HEIGHT + timelineHeight}px` }}
        >
          {showTodayLine && <div className="today-line" style={{ left: `${todayX}px` }} />}
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
            {visibleTasks.flatMap((task) =>
              task.dependencies.map((targetId) => {
                const target = visibleTasks.find((t) => t.id === targetId)
                if (!target) return null

                const x1 = toX(task.end)
                const y1 = task.lane * LANE_HEIGHT + BAR_HEIGHT / 2
                const x2 = toX(target.start)
                const y2 = target.lane * LANE_HEIGHT + BAR_HEIGHT / 2
                const bend = Math.max(20, Math.abs(x2 - x1) / 2)
                const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`

                return <path key={`${task.id}-${targetId}`} d={d} markerEnd="url(#arrow)" className="dependency" />
              }),
            )}
            {linkDraft && (() => {
              const source = visibleTasks.find((task) => task.id === linkDraft.sourceTaskId)
              if (!source) return null
              const x1 = toX(source.end)
              const y1 = source.lane * LANE_HEIGHT + BAR_HEIGHT / 2
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
            {visibleTasks.map((task) => {
              const left = toX(task.start)
              const width = Math.max(8, toX(task.end) - toX(task.start))
              const top = task.lane * LANE_HEIGHT
              const useFloatingControls = width < 92

              return (
                <div
                  key={task.id}
                  className={`task-bar ${task.done ? 'done' : ''} ${useFloatingControls ? 'compact' : ''}`}
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
                    setDragDraft({
                      taskId: task.id,
                      pointerOffsetX: event.clientX - bounds.left - left,
                      pointerOffsetY: event.clientY - bounds.top - HEADER_HEIGHT - top,
                    })
                  }}
                  onMouseEnter={() => {
                    if (resizeDraft || dragDraft || linkDraft) return
                    setHoveredTaskId(task.id)
                  }}
                  onMouseMove={() => {
                    if (resizeDraft || dragDraft || linkDraft) return
                    setHoveredTaskId(task.id)
                  }}
                  onMouseLeave={() => setHoveredTaskId((prev) => (prev === task.id ? null : prev))}
                  onMouseUp={() => {
                    if (linkDraft) updateDependency(linkDraft.sourceTaskId, task.id)
                  }}
                >
                  {!useFloatingControls && (
                    <button
                      className="resize-handle left"
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        setResizeDraft({ taskId: task.id, edge: 'start' })
                      }}
                      aria-label={`Resize start ${task.name}`}
                    />
                  )}
                  <span className="task-label">{task.name}</span>
                  <div
                    className={`task-controls ${useFloatingControls ? 'floating' : ''} ${
                      useFloatingControls && task.lane === 0 ? 'floating-below' : ''
                    }`}
                  >
                    {useFloatingControls && (
                      <button
                        className="resize-handle left"
                        onMouseDown={(event) => {
                          event.stopPropagation()
                          setResizeDraft({ taskId: task.id, edge: 'start' })
                        }}
                        aria-label={`Resize start ${task.name}`}
                      />
                    )}
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
                      className="detail-handle"
                      onClick={(event) => {
                        event.stopPropagation()
                        openTaskEditor(task)
                      }}
                      aria-label={`Open details for ${task.name}`}
                      title="Task details"
                    >
                      i
                    </button>
                    <button
                      className="resize-handle right"
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        setResizeDraft({ taskId: task.id, edge: 'end' })
                      }}
                      aria-label={`Resize end ${task.name}`}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="hover-info">
        {hoveredTask ? (
          <>
            <strong>{hoveredTask.name}</strong>
            <span>Project: {hoveredTask.project || '-'}</span>
            <span>Status: {hoveredTask.done ? 'Done' : 'Active'}</span>
            <span>Start: {formatDateLabel(hoveredTask.start)}</span>
            <span>End: {formatDateLabel(hoveredTask.end - 1)}</span>
          </>
        ) : (
          <>
            <strong>No task hovered</strong>
            <span>Project: -</span>
            <span>Status: -</span>
            <span>Start: -</span>
            <span>End: -</span>
          </>
        )}
      </div>

      {showTaskTable && (
        <section className="task-table-panel">
          <div className="task-table-header">
            <h2>Filtered Task Editor</h2>
            <span>{visibleTasks.length} task(s)</span>
          </div>
          <div className="task-table-scroll">
            <table className="task-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Done</th>
                  <th>Color</th>
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <input
                        value={task.name}
                        onChange={(event) => updateTaskField(task.id, { name: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        value={task.description}
                        onChange={(event) =>
                          updateTaskField(task.id, { description: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        value={toDateInputValue(task.start)}
                        onChange={(event) => {
                          const nextStart = fromDateInputValue(event.target.value)
                          if (nextStart === null) return
                          updateTaskField(task.id, {
                            start: nextStart,
                            end: Math.max(task.end, nextStart + MIN_TASK_MS),
                          })
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        value={toDateInputValue(task.end - 1)}
                        onChange={(event) => {
                          const nextEnd = fromDateInputValue(event.target.value)
                          if (nextEnd === null) return
                          updateTaskField(task.id, {
                            end: Math.max(nextEnd + DAY_MS, task.start + MIN_TASK_MS),
                          })
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={task.done}
                        onChange={(event) => updateTaskField(task.id, { done: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="color"
                        value={task.color}
                        onChange={(event) => updateTaskField(task.id, { color: event.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="note">
        POC controls: click blank lane space to create (with confirmation), drag bar body to move lane/time, drag bar
        edges to resize, drag the middle dot to another bar to create a dependency, click the `i` icon to open task
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
              <span>Start</span>
              <input
                type="date"
                value={editor.startDate}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, startDate: event.target.value } : prev))
                }
              />
            </label>
            <label>
              <span>End</span>
              <input
                type="date"
                value={editor.endDate}
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, endDate: event.target.value } : prev))
                }
              />
            </label>
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
              <span>Project</span>
              <input
                list={projectOptionsId}
                value={editor.project}
                placeholder="Select existing or type a new project"
                onChange={(event) =>
                  setEditor((prev) => (prev ? { ...prev, project: event.target.value } : prev))
                }
              />
              {editor.project.trim() === '' && projectNames.length > 0 && (
                <div className="project-suggestions">
                  {projectNames.map((projectName) => (
                    <button
                      key={projectName}
                      type="button"
                      className="project-chip"
                      onClick={() =>
                        setEditor((prev) => (prev ? { ...prev, project: projectName } : prev))
                      }
                    >
                      {projectName}
                    </button>
                  ))}
                </div>
              )}
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
              <div className="color-presets">
                {PRESET_TASK_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`color-swatch ${editor.color.toLowerCase() === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setEditor((prev) => (prev ? { ...prev, color } : prev))}
                    aria-label={`Select color ${color}`}
                    title={color}
                  />
                ))}
              </div>
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
              <button
                className={editor.done ? 'neutral' : 'success'}
                onClick={() => {
                  const nextDone = !editor.done
                  updateTask(editor.id, { done: nextDone })
                  setEditor((prev) => (prev ? { ...prev, done: nextDone } : prev))
                }}
              >
                {editor.done ? 'Undo Done' : 'Done'}
              </button>
              <button className="danger" onClick={() => deleteTask(editor.id)}>
                Delete
              </button>
              <button onClick={() => setEditor(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  const startTs = fromDateInputValue(editor.startDate)
                  const endTs = fromDateInputValue(editor.endDate)
                  if (startTs === null || endTs === null) {
                    window.alert('Please enter valid Start and End dates.')
                    return
                  }

                  const nextEnd = endTs + DAY_MS
                  if (startTs >= nextEnd) {
                    window.alert('End date must be on or after Start date.')
                    return
                  }

                  updateTask(editor.id, {
                    name: editor.name.trim() || 'Untitled Task',
                    project: editor.project.trim(),
                    color: editor.color,
                    description: editor.description,
                    start: startTs,
                    end: nextEnd,
                    done: editor.done,
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

      <datalist id={projectOptionsId}>
        {projectNames.map((projectName) => (
          <option key={projectName} value={projectName} />
        ))}
      </datalist>
    </div>
  )
}

export default App

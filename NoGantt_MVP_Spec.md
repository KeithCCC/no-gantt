# NoGantt MVP Specification

## 1. Overview

NoGantt is a whiteboard-first Gantt tool.

Users draw horizontal lines. Lines immediately become time bars. No
setup ceremony.

MVP scope: - Drag to create task bars - Auto-generated task names (Task
1, Task 2...) - Drag to resize start/end - Arrow to create
dependencies - Zoom levels (Day / Week / Month) - Auto lane stacking (no
overlap) - Local persistence (IndexedDB) - JSON export

------------------------------------------------------------------------

## 2. Tech Stack

-   React
-   Vite
-   TypeScript
-   Tailwind (optional styling)
-   IndexedDB for persistence

No backend. Web-only MVP.

------------------------------------------------------------------------

## 3. Data Model

``` ts
type Task = {
  id: string
  name: string
  start: number // UTC timestamp (ms)
  end: number   // UTC timestamp (ms)
  lane: number
  dependencies: string[]
}
```

Global state:

``` ts
type ZoomLevel = "day" | "week" | "month"

type AppState = {
  tasks: Task[]
  zoom: ZoomLevel
}
```

------------------------------------------------------------------------

## 4. Core Behaviors

### 4.1 Create Task (Drag Horizontal)

-   MouseDown on timeline
-   MouseMove horizontally
-   MouseUp → create Task
-   Auto name: "Task X"
-   Convert pixel width → time range
-   Assign lane automatically

------------------------------------------------------------------------

### 4.2 Resize Task

-   Drag left edge → modify start
-   Drag right edge → modify end
-   Recalculate lane if needed

------------------------------------------------------------------------

### 4.3 Auto Lane Stacking

Algorithm: 1. Sort tasks by start time 2. For each task: - Check
existing lanes - Place in first lane where no time overlap 3. Create new
lane if necessary

Overlap condition:

    A.start < B.end && B.start < A.end

------------------------------------------------------------------------

### 4.4 Zoom

Zoom levels: - Day - Week - Month

Internal time always stored as UTC ms. Zoom only affects: -
Pixel-to-time scale - Header rendering

------------------------------------------------------------------------

### 4.5 Dependencies

-   Drag from one task to another
-   Add target task ID to `dependencies[]`
-   Render arrows using SVG overlay

------------------------------------------------------------------------

### 4.6 Persistence

-   Save AppState to IndexedDB
-   Auto-save on state change
-   JSON Export:
    -   Download full AppState as .json file

------------------------------------------------------------------------

## 5. UI Structure

    App
     ├─ Toolbar (Zoom controls, Export button)
     └─ Timeline
         ├─ Header (Time scale)
         ├─ Grid
         ├─ TaskBars (absolute positioned divs)
         └─ SVG Layer (dependency arrows)

------------------------------------------------------------------------

## 6. Non-Goals (MVP)

-   No manual task renaming UI
-   No swimlanes
-   No collaboration
-   No backend sync
-   No authentication

------------------------------------------------------------------------

## 7. Performance Assumption

Target: - Smooth rendering up to 200 tasks

Rendering: - Absolute positioned divs - Avoid re-render of entire grid
on drag

------------------------------------------------------------------------

## 8. Deliverable

Ko should: 1. Scaffold Vite + React + TS project 2. Implement timeline
canvas 3. Implement drag-to-create 4. Implement auto lane stacking 5.
Implement zoom 6. Implement IndexedDB persistence 7. Implement JSON
export

# To-do.

A focused to-do list app for individuals and small teams. Personal lists stay private; teams share tasks, subtasks, and comment threads.

## Features

- Email + password accounts with “remember me” sessions
- Account settings from the sidebar account menu: change password (other devices get signed out) or delete your account
- Personal to-do lists
- Shared team lists with host/member roles
- Email invitations (accept or decline in-app)
- Two top-level views — **My task** (only your private personal tasks) and **Collaborate** (team lists; pick a team from the row underneath, and use the **+** beside Collaborate to create one)
- A day-by-day board: sticky notes for the selected day, with a calendar picker and prev/next-day controls
- Priority-colored sticky notes — low = soft green, medium = cream, high = soft red
- Drag sticky notes to rearrange them; the order is saved and remembered
- Double-click anywhere on a sticky note to open its task details and edit it (a single click does nothing)
- One-tap tags (Work, Personal, Meeting, …) plus custom tags
- An optional ideal duration per task, shown on the note and in task details
- Completed tasks move to a normal list on the right, scoped to the same day
- Create personal tasks in **My task**, or open a team in **Collaborate** — new tasks are filed into the list you are viewing
- Recurring tasks (daily, weekly, monthly, or custom weekly weekdays / nth-weekday monthly); completing one automatically creates the next occurrence
- Manual task completion progress (0–100%) with a slider, presets, and list progress bars
- Subtasks with progress tracking
- Task comments
- Light and dark themes (follows your system by default)
- Responsive layout with a slide-over task panel

## Quick start

Requires **Node.js 22.5+** (the app uses the built-in `node:sqlite` module).

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. The API runs on <http://localhost:3001>.

### Production

```bash
npm run build
npm start
```

With a built `dist/`, the Express server hosts both the API and the frontend at <http://localhost:3001>.

## How it works

- `server/` — Express 5 API. `db.ts` defines a SQLite schema (users, sessions, password resets, teams, members, invites, tasks, subtasks, comments); `auth.ts` handles hashed session/reset tokens; route files expose `/api/auth`, `/api/teams`, `/api/invites`, and `/api/tasks`.
- `src/` — React 19 + Tailwind CSS 4 frontend. `App.tsx` loads a single `/api/bootstrap` payload and handles mutations; components live in `src/components/`.
- Data is stored in `server/data/todo.db` (created automatically, git-ignored).

### Development notes

- No mail service is configured. In development, password reset codes are shown in the UI and printed to the server console.
- Session cookies are `httpOnly`; only SHA-256 hashes of session tokens are stored.
- Deleting a task requires being its creator or the team host. Comments can be deleted by their author or the host.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API + Vite dev server with hot reload |
| `npm run build` | Type-check and build the frontend |
| `npm start` | Serve the built app and API on port 3001 |
| `npm run preview` | Preview the Vite build |

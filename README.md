# Watchman Whiteboard

AI agents explain on a whiteboard that runs on your own computer. Ask a question and the agent draws its answer
like a person at a board: shapes first, then the arrows, then the words, with a short sentence for each step.

It draws diagrams, tables, timelines, math, plots, 2-D and 3-D charts, geometry, molecules, circuits, maps and music,
and it reads what you write on the board. It works with Claude Code, Codex, agy (Antigravity) and any other agent that
speaks the Model Context Protocol (MCP).

Watchman Whiteboard is built into [Watchman](https://github.com/incordai/Watchman), where it opens in a Watchman tab,
follows Watchman's light or dark look and shows Watchman's voice character. This repository is the board on its own.

Based on [gr-whiteboard](https://github.com/GoodRelax/gr-whiteboard) by GoodRelax, under the Apache License 2.0.
Powered by [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). Every change from gr-whiteboard is listed,
newest last, in [UPSTREAM](UPSTREAM).

## What you need

- Node.js 20 or later.
- A browser. Inside Watchman, the board opens in a Watchman tab; elsewhere, in your system browser.

## Install

### Claude Code

```
claude plugin marketplace add incordai/watchman-whiteboard
claude plugin install watchman-whiteboard@incordai
```

Then run `npm install` in the plugin's folder once, for the math and chemistry tools.

### Codex, agy and other MCP agents

Clone the repository, run `npm install`, and add an MCP server named `whiteboard` that runs:

```
node <this folder>/skills/talk-on-board/scripts/mcp.js
```

## What the agent can do

| Tool | What it does |
| --- | --- |
| `open_board`, `close_board`, `read_status` | Start, show and stop the board. |
| `read_board`, `read_messages`, `board_index` | Read what is on the board and what you wrote. |
| `write_answer` | Write an answer on the board. |
| `draw_mermaid`, `draw_table`, `draw_skeletons`, `draw_timeline`, `draw_cycle`, `draw_parts` | Diagrams, tables and timelines, drawn step by step. |
| `draw_math`, `check_math` | Typeset formulas, and check or compute math before it is written. |
| `draw_plot`, `draw_chart`, `draw_chart3d` | Function plots, charts and 3-D charts. |
| `draw_geometry`, `draw_molecule`, `draw_circuit`, `draw_map`, `draw_music` | Geometry, chemistry, circuits, maps and music. |
| `edit_items`, `delete_items`, `undo_operation` | Change, remove or take back a drawing. |
| `take_screenshot`, `show_activity` | Check a drawing, and show what the agent is doing. |
| `doc_list`, `doc_read`, `doc_write`, `doc_edit` | The project's documents: Markdown files under `docs/`, written and edited by any agent. A change is made only from the version the agent read, so a newer edit is never overwritten. |

Skills that come with it: `talk-on-board`, `consult-on-board`, `issue-driven`, `four-forms`, `five-whys` and
`debug-board-server`.

## Working offline

On its own, the board page loads Excalidraw, React and its chart libraries from esm.sh, so it needs internet the first
time it opens. Watchman stages all of them locally, so inside Watchman the board works with no internet.

**Known limit of the stand-alone board:** the Python-based math (SymPy through Pyodide) loads only from Watchman's
staged files, so those parts of `check_math` are not available here yet.

## Tests

```
npm install
npm test
```

## License

Apache License 2.0: see [LICENSE](LICENSE). gr-whiteboard's notice and the credits of the libraries it uses are in
[NOTICE](NOTICE).

# cereal 🥣

BitCraft game data browser — browse, search, and explore raw game data.

## Setup

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

The app will be available at `http://localhost:3000`.

## Project Structure

```
src/
  app.tsx          - Root app component (layout, providers)
  app.css          - Global styles (Tailwind + CSS variables for theming)
  entry-client.tsx - Client-side entry point
  entry-server.tsx - Server-side entry point
  components/
    Navbar.tsx     - Top navigation with search, dark mode, version switcher
    Breadcrumb.tsx - Breadcrumb navigation trail
    Footer.tsx     - App footer
    DataTable.tsx  - TanStack Table-based data table with sort/filter/paginate
    JsonViewer.tsx - Expandable JSON viewer with syntax highlighting
  lib/
    theme.tsx      - Dark/light mode context provider
    data.tsx       - Data fetching, caching, and context provider
    schema.ts      - Table metadata detection, FK mapping, utilities
    search.ts      - Global search across tables
  routes/
    index.tsx      - Home page (table listing + search)
    search.tsx     - Search results page
    table/
      [name]/
        (table).tsx  - Table view (data table for a specific table)
        [id].tsx   - Single object view (JSON + references)
data/
  static/          - Game data JSON files (served as public assets)
```

## Deployment (Cloudflare Pages)

```bash
npm run build
npm run deploy
```

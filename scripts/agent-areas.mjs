/**
 * Wem gehört welche Datei? Muss zur Tabelle „Wem gehört was“ in CLAUDE.md passen.
 * Einträge mit „/“ am Ende sind Ordner, alle anderen genaue Pfade ab Repo-Wurzel.
 * Alles, was hier nicht steht (shared/, docker-compose.yml, README.md, PLAN.md, CLAUDE.md, scripts/, .claude/,
 * .github/, docs/agents/README.md), ist gemeinsam.
 */
export const AREAS = {
  frontend: [
    'src/',
    'public/',
    'tests/',
    'index.html',
    'vite.config.ts',
    'playwright.config.ts',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.node.json',
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'nginx.conf',
    'DESIGN.md',
    'docs/agents/frontend.md',
  ],
  backend: ['server/', '.env.example', 'docs/agents/backend.md'],
};

export function ownerOf(relativePath) {
  for (const [role, entries] of Object.entries(AREAS)) {
    if (entries.some((entry) => (entry.endsWith('/') ? relativePath.startsWith(entry) : relativePath === entry))) return role;
  }
  return null;
}

# dependency-black-hole

One of the biggest issues with Node.js and npm dependencies is **transitive
dependencies**: you add one package, and it drags dozens or hundreds of —
often absurdly small — packages into your `node_modules`. Famous incidents
like [left-pad](https://en.wikipedia.org/wiki/Npm_left-pad_incident) (2016),
[event-stream](https://blog.npmjs.org/post/180565383195/details-about-the-event-stream-incident) (2018)
and the [is-promise breakage](https://medium.com/javascript-in-plain-english/what-happened-when-is-promise-broke-the-javascript-ecosystem-97e969e4b38e) (2020)
all come from this: the average npm package trusts a long tail of tiny
transitive dependencies, each one a potential point of failure or supply-chain
attack.

This repo contains:

1. **Research**: where to look up dependency counts, which initiatives fight
   dependency bloat, and which projects "blacklist" useless micro-packages
   (see below).
2. **TypeScript scripts** (zero runtime dependencies, run directly with
   Node ≥ 22.18) to do this research yourself on any `package-lock.json` or
   `yarn.lock`, on any published npm package, on the ~100 most downloaded npm
   packages, and on all [Backstage](https://backstage.io) packages.
3. **Results** of our own analysis: [results/top-100.md](results/top-100.md)
   and [results/backstage.md](results/backstage.md).

## Research

### Pages that show direct and transitive dependency counts

| Site | What it shows |
|------|---------------|
| [deps.dev](https://deps.dev/) (Google Open Source Insights) | The best one for this question: for every npm package it lists **direct and indirect dependencies** separately (e.g. [deps.dev/npm/express](https://deps.dev/npm/express)), plus dependents, licenses and security advisories. Also has a [free API](https://docs.deps.dev/api/). |
| [npmgraph.js.org](https://npmgraph.js.org/) | Interactive dependency *graph* of any package; shows the total module count and lets you spot diamond/duplicate dependencies visually. |
| [npm.anvaka.com](https://npm.anvaka.com/) | The classic npm dependency graph visualizer (2D/3D); the node count is the transitive dependency count. |
| [Bundlephobia](https://bundlephobia.com/) | Bundle size and direct dependency count of a package. |
| [Packagephobia](https://packagephobia.com/) | *Install* size of a package — a good proxy for how much the transitive tree weighs on disk. |
| [Snyk Advisor](https://snyk.io/advisor/) | Package health score including the dependency list and maintenance/security signals. |
| [Socket.dev](https://socket.dev/) | Supply-chain security scores per package, flags risky transitive dependencies and publishes a [popular packages list](https://socket.dev/npm/category/popular). |
| [Libraries.io](https://libraries.io/) | Cross-ecosystem dependency and dependent listings. |
| [npmjs.com](https://www.npmjs.com/) | The package page itself only shows **direct** dependencies and the dependents count. |
| [GitHub dependency graph](https://github.blog/changelog/2025-03-03-easily-distinguish-between-direct-and-transitive-dependencies-for-npm-packages/) | Since March 2025 GitHub labels npm dependencies as direct vs. transitive in repo dependency graphs. |
| [anvaka/npmrank](https://github.com/anvaka/npmrank) | Graph metrics over the whole npm registry: most depended-upon packages, packages with the most dependencies, PageRank ([daily-updated gist](https://gist.github.com/anvaka/8e8fa57c7ee1350e3491)). |

### Initiatives that try to bring down transitive dependencies

- **[e18e — Ecosystem Performance](https://e18e.dev/)** ([announcement](https://socket.dev/blog/javascript-community-launches-e18e-initiative-to-improve-ecosystem-performance)) —
  the biggest current initiative (backed by the ViteConf/Vite ecosystem),
  with three pillars: *cleanup* (dependency trees of popular tools),
  *speedup*, and *levelup* (modern lighter alternatives). Many popular
  projects (e.g. `tinyglobby` replacing `glob`/`fast-glob`) came out of it.
- **[module-replacements](https://github.com/es-tooling/module-replacements)** (es-tooling / e18e) —
  community-maintained manifests of bloated or obsolete modules and their
  leaner replacements (native APIs, micro-utility replacements, preferred
  packages), plus [codemods](https://github.com/es-tooling/module-replacements-codemods)
  to migrate automatically. Browsable at [e18e.dev/docs/replacements](https://e18e.dev/docs/replacements/).
- **[nolyfill](https://github.com/SukkaW/nolyfill)** — replaces ~100
  unnecessary polyfill packages (the `es-shims`/`call-bind`/`side-channel`
  universe that e.g. `eslint-plugin-import` drags in) with no-op
  implementations via package overrides/resolutions.
- **Node.js core catching up** — built-in `fetch`, `node:test`, `structuredClone`,
  `fs.glob`, `util.parseArgs`, `util.styleText` … remove the need for whole
  dependency families (`node-fetch`, `jest`, `glob`, `yargs`, `chalk`).
  This repo's scripts use that: they run on plain Node with **zero runtime
  dependencies** (even TypeScript runs natively via type stripping).
- **[unjs](https://unjs.io/)** and **[tinylibs](https://github.com/tinylibs)** —
  ecosystems of small, modern, (mostly) zero-dependency building blocks
  intended to replace heavy legacy utility chains.
- **Zero/low-dependency policies** of individual projects — e.g.
  [Hono](https://hono.dev/) (zero dependencies), `fastify`'s and `esbuild`'s
  minimal trees — often advertised explicitly as a feature since left-pad.

### Projects that blacklist useless dependencies (like `is-odd`)

- **[eslint-plugin-depend](https://github.com/es-tooling/eslint-plugin-depend)** —
  the [`depend/ban-dependencies`](https://github.com/es-tooling/eslint-plugin-depend/blob/main/docs/rules/ban-dependencies.md)
  rule fails your lint when the project depends on blacklisted packages. Its
  presets: `native` (packages replaceable by built-ins), `microutilities`
  (one-liners like `is-odd`, `is-even`, `is-number`) and `preferred`
  (packages with leaner alternatives); custom blacklists are supported.
- **[@e18e/eslint-plugin](https://www.npmjs.com/package/@e18e/eslint-plugin)** —
  e18e's own ESLint plugin built on the module-replacements manifests.
- **[module-replacements manifests](https://github.com/es-tooling/module-replacements)** —
  the machine-readable blacklist itself (JSON manifests), usable in your own
  tooling.
- **[nolyfill](https://github.com/SukkaW/nolyfill)** — effectively a
  blacklist of ~100 unnecessary polyfill packages, enforced via overrides.
- **[You-Dont-Need-Lodash-Underscore](https://github.com/you-dont-need/You-Dont-Need-Lodash-Underscore)**
  (with its own ESLint plugin) and
  [You-Dont-Need-Momentjs](https://github.com/you-dont-need/You-Dont-Need-Momentjs) —
  curated lists of utility imports replaceable by native code.
- Adjacent: **[depcheck](https://github.com/depcheck/depcheck)** and
  **[knip](https://knip.dev/)** find dependencies you declare but don't use
  at all.

## The scripts

All scripts are TypeScript, executed directly by Node.js (≥ 22.18, via
native type stripping) — no build step, no runtime dependencies. Only
`typescript` + `@types/node` are dev dependencies for `npm run typecheck`.

Shared table options: `--sort name|direct|transitive`, `--asc`/`--desc`,
`--limit N`, `--filter STR`, `--json`. "direct + indirect" counts *distinct*
`name@version` packages reachable through production (+ optional)
dependencies; dev and peer dependencies of dependencies are excluded
(`--include-peers` exists for lockfile analysis). Cycles are handled via
strongly-connected components.

### 1. Analyze a local `package-lock.json` or `yarn.lock`

```sh
npm run analyze:lockfile -- path/to/project --sort transitive --limit 20
npm run analyze:lockfile -- path/to/yarn.lock --sort name
```

Shows, for **every package in the lockfile**, its direct dependency count
and its total (direct + indirect) dependency count. Supports npm lockfile
v1/v2/v3, classic yarn.lock (v1) and yarn Berry lockfiles.

```
| package              | version | direct | direct + indirect |
|----------------------|---------|-------:|------------------:|
| express              | 5.2.1   |     28 |                65 |
| body-parser          | 2.3.0   |      9 |                39 |
| ...                  |         |        |                   |
```

### 2. Analyze any published package — without installing it

```sh
npm run analyze:package -- express jest webpack is-odd
```

**Do we have to `yarn install` every package into a tmp folder? No.** That
would download and extract every tarball. Instead the script runs
`npm install <pkg> --package-lock-only --ignore-scripts` in an empty tmp
directory: npm resolves the complete, exact dependency tree and writes a
`package-lock.json`, but downloads no tarballs and creates no
`node_modules`. The lockfile then goes through the same analyzer as above.
Other alternatives, if you don't want to resolve anything yourself:
the [deps.dev API](https://docs.deps.dev/api/) (precomputed graphs), or
yarn Berry's `yarn install --mode=update-lockfile`.

### 3. Analyze the ~100 most downloaded npm packages

```sh
npm run analyze:top100
```

The candidate list (`data/top-100-packages.json`, compiled from public npm
download rankings — npm has no official "top downloads" API) is re-ranked
with live weekly download counts from `api.npmjs.org`, every package's tree
is resolved as in (2), and the report is written to
[results/top-100.md](results/top-100.md) / `results/top-100.json`.

### 4. Analyze all Backstage packages

```sh
npm run analyze:backstage                     # latest release
npm run analyze:backstage -- --release 1.56.2 # specific release
```

The package list comes from the official
[backstage/versions](https://github.com/backstage/versions) release
manifests (`v1/releases/<version>/manifest.json`, served at
`versions.backstage.io`). Report:
[results/backstage.md](results/backstage.md) / `results/backstage.json`.
